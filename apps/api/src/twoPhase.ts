import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pools, regions, type Region } from './db.js';
import { allTransactions, saveTx, type TxRecord } from './coordination.js';
import { purchaseInput, type PurchaseInput, type OrderRow } from './models.js';

function gid(txId: string, region: Region): string {
  // Ambos são gerados pela aplicação, sem interpolação de input externo.
  return `scad_${txId.replaceAll('-', '_')}_${region}`;
}

export class DomainError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function preparedExists(region: Region, transactionGid: string): Promise<boolean> {
  const result = await pools[region].query('SELECT 1 FROM pg_prepared_xacts WHERE gid = $1', [transactionGid]);
  return (result.rowCount || 0) > 0;
}

async function finishPrepared(record: TxRecord, decision: 'COMMIT' | 'ABORT'): Promise<void> {
  for (const region of record.participants) {
    const name = gid(record.txId, region);
    if (!(await preparedExists(region, name))) continue;
    // PostgreSQL não aceita parâmetros bind para identificadores de prepared xact.
    await pools[region].query(`${decision === 'COMMIT' ? 'COMMIT' : 'ROLLBACK'} PREPARED '${name}'`);
  }
  if (decision === 'COMMIT') {
    // Bloqueia envio ao fornecedor até todos os participantes confirmarem o 2PC.
    const updated = await pools.north.query(
      `UPDATE purchase_orders SET status='PENDING_SUPPLIER', updated_at=now()
       WHERE id=$1 AND status='TX_COMMITTING' RETURNING id`, [record.orderId],
    );
    if (updated.rowCount) {
      await pools.north.query(
        `INSERT INTO audit_events(order_id,event_type,details)
         VALUES($1,'TX_COMMITTED',$2)`, [record.orderId, JSON.stringify({ transactionId: record.txId })],
      );
    }
  }
  record.status = 'DONE';
  await saveTx(record);
}

export async function recoverTransactions(onStartup = false): Promise<void> {
  for (const rec of await allTransactions()) {
    if (rec.status === 'DONE') continue;
    // Não abortar um 2PC em curso. Um PREPARING órfão pode ser abortado após 2 minutos.
    const expired = Date.now() - Date.parse(rec.updatedAt) > 120_000;
    if (rec.status === 'PREPARING' && (onStartup || expired)) {
      rec.status = 'ABORT';
      await saveTx(rec);
    }
    if (rec.status === 'COMMIT' || rec.status === 'ABORT') {
      try { await finishPrepared(rec, rec.status); }
      catch (error) { console.error('2PC recovery pending:', rec.txId, error); }
    }
  }
}

export async function executeDistributedPurchase(input: PurchaseInput, metadata: {createdBy:string; originRegion?:string} = {createdBy:'system'}): Promise<OrderRow> {
  purchaseInput.parse(input);
  const existing = await pools.north.query<OrderRow>(
    'SELECT * FROM purchase_orders WHERE supplier_id=$1 AND batch_id=$2',
    [input.supplierId, input.batchId],
  );
  if (existing.rows[0]) {
    const oldItems = [...existing.rows[0].items].sort((a,b) => `${a.region}:${a.productId}`.localeCompare(`${b.region}:${b.productId}`));
    const newItems = [...input.items].sort((a,b) => `${a.region}:${a.productId}`.localeCompare(`${b.region}:${b.productId}`));
    if (JSON.stringify(oldItems) !== JSON.stringify(newItems)) throw new DomainError('Same supplier/batch has a different payload', 409);
    return existing.rows[0];
  }

  const txId = randomUUID();
  const orderId = randomUUID();
  // North é participante mesmo quando não há items do Norte: ali está o catálogo de ordens.
  const participants = regions.filter(r => r === 'north' || input.items.some(i => i.region === r));
  const record: TxRecord = { txId, orderId, participants, status: 'PREPARING', updatedAt: new Date().toISOString() };
  const clients = new Map<Region, PoolClient>();
  const prepared = new Set<Region>();
  let commitDecided = false;
  let decisionMayBeDurable = false;

  await saveTx(record);
  try {
    for (const region of participants) {
      const client = await pools[region].connect();
      clients.set(region, client);
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='15s'");
    }
    for (const item of input.items) {
      const client = clients.get(item.region)!;
      const result = await client.query(
        `UPDATE stock_positions SET incoming_qty=incoming_qty+$1, updated_at=now()
         WHERE product_id=$2 AND supplier_id=$3 RETURNING product_id`,
        [item.quantity, item.productId, input.supplierId],
      );
      if (result.rowCount !== 1) {
        throw new DomainError(`Product ${item.productId} not found in ${item.region} for ${input.supplierId}`, 422);
      }
    }
    await clients.get('north')!.query(
      `INSERT INTO purchase_orders(id,supplier_id,batch_id,items,status,created_by,origin_region)
       VALUES($1,$2,$3,$4::jsonb,'TX_COMMITTING',$5,$6)`,
      [orderId, input.supplierId, input.batchId, JSON.stringify(input.items), metadata.createdBy, metadata.originRegion ?? null],
    );

    // Fase PREPARE: transacções tornam-se duráveis e deixam as sessões.
    for (const region of participants) {
      await clients.get(region)!.query(`PREPARE TRANSACTION '${gid(txId, region)}'`);
      prepared.add(region);
    }
    // Ponto de decisão irrecuperável: o COMMIT é escrito de forma durável antes dos commits locais.
    record.status = 'COMMIT';
    decisionMayBeDurable = true; // A escrita pode ser aceite no etcd e falhar no cliente por timeout.
    await saveTx(record);
    commitDecided = true;
  } catch (error) {
    // Se o cliente perdeu a resposta ao PUT COMMIT, a decisão pode já estar durável.
    // NUNCA emitir ABORT neste cenário; recovery consultará o estado no etcd.
    if (decisionMayBeDurable) {
      console.error('2PC decision uncertain; waiting for authoritative recovery:', txId, error);
      throw new DomainError(`2PC decision pending recovery; transactionId=${txId}`, 503);
    }
    // Antes do ponto de decisão COMMIT, o abort é seguro.
    try { record.status = 'ABORT'; await saveTx(record); } catch (err) { console.error('Cannot persist ABORT:', err); }
    for (const [region, client] of clients) {
      try {
        if (prepared.has(region)) await pools[region].query(`ROLLBACK PREPARED '${gid(txId, region)}'`);
        else await client.query('ROLLBACK');
      } catch (err) { console.error('Rollback pending:', region, err); }
    }
    // Registo ABORT é conservado para recuperação, sem marcação DONE forçada.
    throw error;
  } finally {
    for (const client of clients.values()) client.release();
  }

  if (commitDecided) {
    try { await finishPrepared(record, 'COMMIT'); }
    catch (err) {
      console.error('2PC COMMIT decided; completion pending recovery:', txId, err);
      throw new DomainError(`Commit accepted but pending recovery; transactionId=${txId}`, 503);
    }
  }
  const row = await pools.north.query<OrderRow>('SELECT * FROM purchase_orders WHERE id=$1', [orderId]);
  if (!row.rows[0]) throw new Error('Purchase missing after committed transaction');
  return row.rows[0];
}
