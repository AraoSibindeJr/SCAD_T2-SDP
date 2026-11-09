import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const app = express();
const file = process.env.SUPPLIER_DATA_FILE || '/data/orders.json';
app.use(express.json());
app.use(express.text({ type: ['text/xml', 'application/soap+xml'], limit: '128kb' }));

type RecordItem = { externalOrderId: string; orderId: string; batchId: string; createdAt: string };
let orders: Record<string, RecordItem> = {};
try { orders = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primeira inicialização */ }
let failMode: 'off'|'once'|'unavailable' = 'off';
const escapeXml = (s: string): string => s.replace(/[<>&"']/g, c => ({
  '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;',
})[c]!);
const envelope = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>` +
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<soap:Body>${body}</soap:Body></soap:Envelope>`;
function unavailable(): boolean {
  if (failMode === 'off') return false;
  if (failMode === 'once') failMode = 'off';
  return true;
}
function accept(orderId: string, batchId: string): RecordItem {
  if (orders[orderId]) return orders[orderId];
  const record = { orderId, batchId, externalOrderId: `EXT-${randomUUID()}`, createdAt: new Date().toISOString() };
  orders[orderId] = record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, file);
  return record;
}
app.get('/health', (_req, res) => res.json({ ok: true, mode: failMode }));
// Endpoint de administração apenas para demonstração; não exposto por porta no host.
app.post('/admin/failure-mode', (req, res) => {
  const mode = req.body?.mode;
  if (!['off','once','unavailable'].includes(mode)) return res.status(400).json({ error: 'Invalid failure mode' });
  failMode = mode;
  return res.json({ mode: failMode });
});
app.post('/api/orders', (req, res) => {
  if (unavailable()) return res.status(503).json({ error: 'Supplier unavailable (simulated)' });
  const orderId = req.body?.orderId;
  const batchId = req.body?.batchId;
  if (typeof orderId !== 'string' || typeof batchId !== 'string' || req.header('idempotency-key') !== orderId) {
    return res.status(400).json({ error: 'Invalid order or idempotency key' });
  }
  return res.status(201).json({ status: 'ACCEPTED', ...accept(orderId, batchId) });
});
app.get('/api/orders/:orderId', (req, res) => {
  const record = orders[req.params.orderId];
  if (!record) return res.status(404).json({ error: 'Not found' });
  return res.json({ status: 'ACCEPTED', ...record });
});
app.get('/soap', (req, res) => {
  if (!('wsdl' in req.query)) return res.status(400).send('Use ?wsdl');
  const wsdlFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supplier.wsdl');
  return res.type('text/xml').send(fs.readFileSync(wsdlFile, 'utf8'));
});
app.post('/soap', (req, res) => {
  if (unavailable()) return res.status(503).type('text/xml').send(envelope(
    '<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Supplier unavailable</faultstring></soap:Fault>'));
  try {
    const xml = new XMLParser({ removeNSPrefix: true }).parse(req.body);
    const body = xml?.Envelope?.Body?.CreatePurchaseOrder;
    const orderId = body?.OrderId;
    const batchId = body?.BatchId;
    if (typeof orderId !== 'string' || typeof batchId !== 'string') throw new Error('Invalid SOAP request');
    const order = accept(orderId, batchId);
    return res.type('text/xml').send(envelope(
      `<CreatePurchaseOrderResponse xmlns="urn:scad:supplier"><ExternalOrderId>${escapeXml(order.externalOrderId)}</ExternalOrderId>` +
      `<Status>ACCEPTED</Status></CreatePurchaseOrderResponse>`));
  } catch (err) {
    return res.status(400).type('text/xml').send(envelope(
      `<soap:Fault><faultcode>soap:Client</faultcode><faultstring>${escapeXml((err as Error).message)}</faultstring></soap:Fault>`));
  }
});
const port = Number(process.env.PORT || 4000);
app.listen(port, '0.0.0.0', () => console.log(`REST/SOAP supplier mock on ${port}`));
