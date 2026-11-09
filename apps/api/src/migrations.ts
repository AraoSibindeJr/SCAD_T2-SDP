import { pools, regions } from './db.js';

export async function applyMvpMigrations(): Promise<void> {
  for (const region of regions) {
    await pools[region].query(`CREATE TABLE IF NOT EXISTS stock_receipts (
      order_id UUID NOT NULL, product_id TEXT NOT NULL, region TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0), received_by TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (order_id, product_id)
    )`);
  }
  await pools.north.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'system'");
  await pools.north.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS origin_region TEXT');
}
