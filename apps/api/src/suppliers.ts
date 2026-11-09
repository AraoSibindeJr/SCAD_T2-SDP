import { XMLParser } from 'fast-xml-parser';
import { pools } from './db.js';
import { appendOperationLog, createInvoicePdf } from './files.js';
import type { OrderRow } from './models.js';

const REST_URL = process.env.REST_SUPPLIER_URL || 'http://supplier-mock:4000/api/orders';
const SOAP_URL = process.env.SOAP_SUPPLIER_URL || 'http://supplier-mock:4000/soap';

const escapeXml = (s: string) => s.replace(/[<>&"']/g, ch => ({
  '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;',
})[ch]!);

async function submitToSupplier(order: OrderRow): Promise<string> {
  if (order.supplier_id === 'SUP-REST') {
    const response = await fetch(REST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': order.id },
      body: JSON.stringify({ orderId: order.id, batchId: order.batch_id, items: order.items }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`REST supplier returned HTTP ${response.status}`);
    const result = await response.json() as { externalOrderId?: string };
    if (!result.externalOrderId) throw new Error('REST supplier response missing externalOrderId');
    return result.externalOrderId;
  }
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><CreatePurchaseOrder xmlns="urn:scad:supplier">` +
    `<OrderId>${escapeXml(order.id)}</OrderId><BatchId>${escapeXml(order.batch_id)}</BatchId>` +
    `<ItemsJson>${escapeXml(JSON.stringify(order.items))}</ItemsJson>` +
    `</CreatePurchaseOrder></soap:Body></soap:Envelope>`;
  const response = await fetch(SOAP_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: 'CreatePurchaseOrder' },
    body: xml,
    signal: AbortSignal.timeout(5000),
  });
  const parsed = new XMLParser({ removeNSPrefix: true }).parse(await response.text());
  const body = parsed?.Envelope?.Body;
  if (!response.ok || body?.Fault) {
    throw new Error(`SOAP supplier fault: ${body?.Fault?.faultstring || response.status}`);
  }
  const externalId = body?.CreatePurchaseOrderResponse?.ExternalOrderId;
  if (!externalId) throw new Error('SOAP supplier missing ExternalOrderId');
  return String(externalId);
}

let dispatchBusy = false;
export async function dispatchPendingOrders(): Promise<void> {
  if (dispatchBusy) return;
  dispatchBusy = true;
  try {
    // Se o worker morrer em SENDING, o claim expira e outra execução pode continuar.
    const candidates = await pools.north.query<OrderRow>(
      `SELECT * FROM purchase_orders
       WHERE (status='PENDING_SUPPLIER' AND next_retry_at<=now())
          OR (status='SENDING' AND updated_at < now()-interval '2 minutes')
       ORDER BY created_at LIMIT 10`,
    );
    for (const candidate of candidates.rows) {
      const claimed = await pools.north.query<OrderRow>(
        `UPDATE purchase_orders
         SET status='SENDING', updated_at=now()
         WHERE id=$1 AND ((status='PENDING_SUPPLIER' AND next_retry_at<=now())
                         OR (status='SENDING' AND updated_at < now()-interval '2 minutes'))
         RETURNING *`, [candidate.id],
      );
      const order = claimed.rows[0];
      if (!order) continue;
      try {
        const externalOrderId = await submitToSupplier(order);
        let invoicePath: string | null = null;
        try { invoicePath = await createInvoicePdf(order, externalOrderId); }
        catch (err) { console.error('Invoice generation failed; order remains confirmed:', err); }
        await pools.north.query(
          `UPDATE purchase_orders SET status='CONFIRMED', external_order_id=$2,
           invoice_path=$3, last_error=NULL, updated_at=now() WHERE id=$1`,
          [order.id, externalOrderId, invoicePath],
        );
        await pools.north.query('INSERT INTO audit_events(order_id,event_type,details) VALUES($1,$2,$3)',
          [order.id, 'SUPPLIER_CONFIRMED', JSON.stringify({ externalOrderId, invoicePath })]);
        await appendOperationLog('SUPPLIER_CONFIRMED', { orderId: order.id, externalOrderId });
      } catch (err) {
        const reason = (err as Error).message;
        await pools.north.query(
          `UPDATE purchase_orders SET status='PENDING_SUPPLIER', retry_count=retry_count+1,
           last_error=$2, next_retry_at=now()+ interval '10 seconds' * LEAST(64, POWER(2, LEAST(6,retry_count))),
           updated_at=now() WHERE id=$1`, [order.id, reason],
        );
        console.warn('Supplier delivery pending retry:', order.id, reason);
        await appendOperationLog('SUPPLIER_RETRY', { orderId: order.id, reason });
      }
    }
  } finally { dispatchBusy = false; }
}
