import { z } from 'zod';
import type { Region } from './db.js';

export const purchaseInput = z.object({
  supplierId: z.enum(['SUP-REST', 'SUP-SOAP']),
  batchId: z.string().min(3).max(150).regex(/^[A-Za-z0-9_:\-.]+$/),
  items: z.array(z.object({
    region: z.enum(['south', 'center', 'north']),
    productId: z.string().min(2).max(40),
    quantity: z.number().int().positive().max(500),
  })).min(1).max(15),
}).superRefine((v, ctx) => {
  const names = v.items.map(i => `${i.region}:${i.productId}`);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Repeated region/product items are not allowed' });
  }
});

export type PurchaseInput = z.infer<typeof purchaseInput>;
export type StockRow = {
  region: Region;
  product_id: string;
  sku: string;
  name: string;
  supplier_id: string;
  on_hand: number;
  minimum_stock: number;
  target_stock: number;
  incoming_qty: number;
  reorder_cycle: number;
};

export type OrderRow = {
  id: string;
  supplier_id: string;
  batch_id: string;
  items: PurchaseInput['items'];
  status: string;
  external_order_id: string | null;
  invoice_path: string | null;
  last_error: string | null;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
};

export function automaticBatches(stocks: StockRow[]): PurchaseInput[] {
  const grouped = new Map<string, StockRow[]>();
  for (const s of stocks) {
    if (s.on_hand + s.incoming_qty > s.minimum_stock) continue;
    const key = `${s.supplier_id}:${s.product_id}`;
    grouped.set(key, [...(grouped.get(key) || []), s]);
  }
  return Array.from(grouped.values(), rows => {
    const sorted = [...rows].sort((a, b) => a.region.localeCompare(b.region));
    const signature = sorted.map(s => `${s.region}-${s.reorder_cycle}`).join(':');
    return {
      supplierId: sorted[0].supplier_id as PurchaseInput['supplierId'],
      batchId: `AUTO-${sorted[0].product_id}-${signature}`,
      items: sorted.map(s => ({
        region: s.region,
        productId: s.product_id,
        quantity: s.target_stock - s.on_hand - s.incoming_qty,
      })).filter(i => i.quantity > 0),
    };
  }).filter(b => b.items.length > 0);
}
