import express from 'express';
import { z } from 'zod';
import { pools, regions, waitForDatabase, closeDatabase, type Region } from './db.js';
import { etcd } from './coordination.js';
import { ensureFileDirs, invoiceFullPath } from './files.js';
import { purchaseInput, type OrderRow } from './models.js';
import { createPurchase, readStocks, runMonitor } from './purchases.js';
import { dispatchPendingOrders } from './suppliers.js';
import { DomainError, recoverTransactions } from './twoPhase.js';
import { login, authenticate, adminOnly, currentUser, enforceRegion, validateAgentSecret } from './auth.js';
import { applyMvpMigrations } from './migrations.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); next(); });
const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
const regionSchema = z.enum(['south', 'center', 'north']);
const orderIdSchema = z.string().uuid();

// Endpoints públicos estritamente necessários. As restantes operações exigem autenticação.
app.get('/api/health', wrap(async (_req, res) => {
  await Promise.all([pools.north.query('SELECT 1'), etcd.get('/scad/health').string()]);
  res.json({ success: true, status: 'ok', now: new Date().toISOString() });
}));
app.post('/api/auth/login', wrap(async (req,res) => {
  const credentials = z.object({username:z.string().min(3).max(64),password:z.string().min(1).max(256)}).parse(req.body);
  res.json({success:true,data:login(credentials.username, credentials.password)});
}));
// O endpoint dos agentes não aceita credenciais dos compradores.
app.post('/api/alerts', wrap(async (req, res) => {
  validateAgentSecret(req);
  const alert = z.object({ region: regionSchema, productId: z.string().min(2).max(40) }).parse(req.body);
  console.info('Regional low-stock alert:', alert.region, alert.productId);
  res.json({ success: true, data: await runMonitor() });
}));

app.use('/api', authenticate);
app.get('/api/auth/me', (req,res) => res.json({success:true,data:currentUser(req)}));
app.get('/api/stocks', wrap(async (req, res) => {
  const user = currentUser(req);
  const all = await readStocks();
  res.json({ success: true, data: user.role === 'admin' ? all : all.filter(s=>s.region===user.region) });
}));
app.post('/api/stocks/:region/:productId/adjust', adminOnly, wrap(async (req, res) => {
  const region = regionSchema.parse(req.params.region);
  const { onHand } = z.object({ onHand: z.number().int().min(0).max(100000) }).parse(req.body);
  const result = await pools[region].query(
    `UPDATE stock_positions
     SET reorder_cycle=CASE WHEN (on_hand+incoming_qty)>minimum_stock AND ($2+incoming_qty)<=minimum_stock
                            THEN reorder_cycle+1 ELSE reorder_cycle END,
         on_hand=$2, updated_at=now()
     WHERE product_id=$1 RETURNING *`, [req.params.productId, onHand],
  );
  if (!result.rowCount) throw new DomainError('Produto não encontrado', 404);
  res.json({ success: true, data: result.rows[0] });
}));
app.post('/api/products', adminOnly, wrap(async (req,res) => {
  const data = z.object({
    region:regionSchema,
    productId:z.string().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),
    sku:z.string().min(2).max(40),
    name:z.string().min(3).max(120),
    supplierId:z.enum(['SUP-REST','SUP-SOAP']),
    onHand:z.number().int().min(0).max(100000),
    minimumStock:z.number().int().min(0).max(100000),
    targetStock:z.number().int().positive().max(100000),
  }).refine(v=>v.targetStock>v.minimumStock,{message:'O stock objectivo deve exceder o mínimo'}).parse(req.body);
  const result = await pools[data.region].query(
    `INSERT INTO stock_positions(product_id,sku,name,supplier_id,region,on_hand,minimum_stock,target_stock)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [data.productId,data.sku,data.name,data.supplierId,data.region,data.onHand,data.minimumStock,data.targetStock],
  );
  res.status(201).json({success:true,data:result.rows[0]});
}));
app.post('/api/monitor/run', adminOnly, wrap(async (_req, res) => {
  res.json({ success: true, data: await runMonitor() });
}));
app.post('/api/purchases', wrap(async (req, res) => {
  const user = currentUser(req);
  const input = purchaseInput.parse(req.body);
  if (user.role === 'buyer') input.items.forEach(item=>enforceRegion(user,item.region));
  const order = await createPurchase(input,{createdBy:user.id,originRegion:user.region || undefined});
  res.status(201).json({ success: true, data: order });
}));
app.get('/api/purchases', wrap(async (req, res) => {
  const user = currentUser(req);
  const result = user.role==='admin'
    ? await pools.north.query('SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT 200')
    : await pools.north.query(
      `SELECT * FROM purchase_orders
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(items) AS line WHERE line->>'region'=$1)
       ORDER BY created_at DESC LIMIT 200`, [user.region],
    );
  const rows = user.role === 'buyer' ? result.rows.map(order=>({
    ...order, items: (order.items as Array<{region:Region}>).filter(item=>item.region===user.region),
  })) : result.rows;
  res.json({ success: true, data: rows });
}));
async function accessibleOrder(req:express.Request): Promise<OrderRow> {
  const id = orderIdSchema.parse(req.params.id);
  const result = await pools.north.query<OrderRow>('SELECT * FROM purchase_orders WHERE id=$1',[id]);
  const order = result.rows[0];
  if (!order) throw new DomainError('Encomenda não encontrada',404);
  const user=currentUser(req);
  if (user.role==='buyer' && !order.items.some(i=>i.region===user.region)) {
    throw new DomainError('Encomenda não encontrada neste centro',404);
  }
  if (user.role==='buyer') return {...order,items:order.items.filter(i=>i.region===user.region)};
  return order;
}
app.get('/api/purchases/:id', wrap(async(req,res)=>res.json({success:true,data:await accessibleOrder(req)})));
app.get('/api/purchases/:id/invoice', wrap(async (req, res) => {
  const order = await accessibleOrder(req);
  if (!order.invoice_path) throw new DomainError('Factura ainda não disponível', 404);
  res.download(invoiceFullPath(order.invoice_path));
}));
app.get('/api/receipts', wrap(async (req,res)=>{
  const user = currentUser(req);
  const visible = user.role === 'admin' ? regions : [user.region!];
  const rows = await Promise.all(visible.map(async region => {
    const result = await pools[region].query('SELECT * FROM stock_receipts ORDER BY received_at DESC LIMIT 150');
    return result.rows;
  }));
  res.json({success:true,data:rows.flat().sort((a,b)=>new Date(b.received_at).getTime()-new Date(a.received_at).getTime())});
}));
// Recepção de mercadoria local e idempotente. Não inclui transacção entre shards.
app.post('/api/purchases/:id/receive', wrap(async (req,res) => {
  const user = currentUser(req);
  const {region} = z.object({region:regionSchema}).parse(req.body);
  enforceRegion(user, region);
  const order = await accessibleOrder(req);
  if (order.status !== 'CONFIRMED') throw new DomainError('Só são recepcionadas encomendas confirmadas pelo fornecedor',409);
  const items=order.items.filter(item=>item.region===region);
  if (!items.length) throw new DomainError('Encomenda sem itens para este centro',422);
  const client=await pools[region].connect();
  let newlyReceived=0;
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const insert=await client.query(
        `INSERT INTO stock_receipts(order_id,product_id,region,quantity,received_by)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING product_id`,
        [order.id,item.productId,region,item.quantity,user.id],
      );
      if (!insert.rowCount) continue;
      const change=await client.query(
        `UPDATE stock_positions
         SET on_hand=on_hand+$1,incoming_qty=incoming_qty-$1,updated_at=now()
         WHERE product_id=$2 AND incoming_qty >= $1 RETURNING product_id`,
        [item.quantity,item.productId],
      );
      if (change.rowCount!==1) throw new DomainError(`Stock pendente insuficiente para ${item.productId}`,409);
      newlyReceived++;
    }
    await client.query('COMMIT');
  } catch(err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  // Auditoria no catálogo de ordens: best effort depois do commit regional.
  if (newlyReceived) {
    try {
      await pools.north.query(
        'INSERT INTO audit_events(order_id,event_type,details) VALUES($1,$2,$3)',
        [order.id,'STOCK_RECEIVED',JSON.stringify({region,items:newlyReceived,actor:user.id})],
      );
    } catch(err) { console.error('Receipt audit pending manual reconciliation:',err); }
  }
  res.json({success:true,data:{orderId:order.id,region,receivedItems:newlyReceived,alreadyReceived:newlyReceived===0}});
}));
app.get('/api/audit', adminOnly, wrap(async (_req, res) => {
  const result = await pools.north.query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 100');
  res.json({ success: true, data: result.rows });
}));
app.get('/api/cluster', adminOnly, wrap(async (_req, res) => {
  const data = await Promise.all(regions.map(async r => {
    const out = await pools[r].query(
      `SELECT pg_is_in_recovery() AS standby,
              (SELECT count(*)::int FROM pg_stat_replication WHERE state='streaming') AS streaming_replicas,
              (SELECT count(*)::int FROM pg_prepared_xacts) AS prepared_transactions`,
    );
    return { region: r, ...out.rows[0] };
  }));
  res.json({ success: true, data });
}));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, message: 'Dados inválidos', issues: err.issues });
  if (err instanceof DomainError) return res.status(err.status).json({ success: false, message: err.message });
  if (typeof err==='object' && err!==null && 'code' in err && (err as {code?:string}).code==='23505') {
    return res.status(409).json({ success:false,message:'Já existe um registo com estes identificadores' });
  }
  console.error('API error:', err);
  return res.status(500).json({ success: false, message: 'Erro interno do servidor' });
});

async function main(): Promise<void> {
  await waitForDatabase();
  await ensureFileDirs();
  for (let n = 0; n < 40; n++) {
    try { await etcd.put('/scad/health').value('ready'); break; }
    catch (err) {
      if (n === 39) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  await recoverTransactions(true);
  // Migrar depois da recuperação: DDL não deve aguardar indefinidamente por xacts preparadas.
  await applyMvpMigrations();
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => console.log(`SCAD API listening on ${port}`));
  const monitorMs = Math.max(5000, Number(process.env.MONITOR_INTERVAL_MS || 20000));
  const background = setInterval(() => {
    void (async () => {
      try { await recoverTransactions(); await runMonitor(); await dispatchPendingOrders(); }
      catch (err) { console.error('Background job error:', err); }
    })();
  }, monitorMs);
  const shutdown = async () => {
    clearInterval(background);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeDatabase();
    etcd.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}
main().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
