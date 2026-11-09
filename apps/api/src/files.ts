import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import type { OrderRow } from './models.js';

const root = process.env.FILES_DIR || '/files';

export async function ensureFileDirs(): Promise<void> {
  await fs.promises.mkdir(path.join(root, 'invoices'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'logs'), { recursive: true });
}

export async function appendOperationLog(event: string, details: object): Promise<void> {
  await fs.promises.appendFile(path.join(root, 'logs', 'operations.jsonl'),
    JSON.stringify({ event, details, occurredAt: new Date().toISOString() }) + '\n');
}

export async function createInvoicePdf(order: OrderRow, externalId: string): Promise<string> {
  const name = `invoice-${order.id}.pdf`;
  const target = path.join(root, 'invoices', name);
  await new Promise<void>((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 44 });
    const out = fs.createWriteStream(target);
    pdf.pipe(out);
    pdf.fontSize(19).text('SCAD - Factura simulada', { align: 'center' });
    pdf.moveDown().fontSize(11);
    pdf.text(`Ordem SCAD: ${order.id}`);
    pdf.text(`Ordem do fornecedor: ${externalId}`);
    pdf.text(`Fornecedor: ${order.supplier_id}`);
    pdf.text(`Data (UTC): ${new Date().toISOString()}`);
    pdf.moveDown().text('Itens de reposição:');
    for (const item of order.items) pdf.text(`${item.region} / ${item.productId} - ${item.quantity} unidades`);
    pdf.moveDown().fontSize(9).text('Documento de laboratório. Não constitui factura fiscal real.');
    pdf.end();
    out.on('finish', resolve);
    out.on('error', reject);
    pdf.on('error', reject);
  });
  return `invoices/${name}`;
}

export function invoiceFullPath(relative: string): string {
  if (!/^invoices\/invoice-[a-f0-9-]+\.pdf$/.test(relative)) throw new Error('Invalid invoice path');
  return path.join(root, relative);
}
