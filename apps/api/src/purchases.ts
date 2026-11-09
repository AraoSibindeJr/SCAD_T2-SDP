import { pools, regions } from './db.js';
import { withBatchLock } from './coordination.js';
import { automaticBatches, type OrderRow, type PurchaseInput, type StockRow } from './models.js';
import { executeDistributedPurchase } from './twoPhase.js';

export async function readStocks(): Promise<StockRow[]> {
  const chunks = await Promise.all(regions.map(async r => {
    const result = await pools[r].query<StockRow>('SELECT * FROM stock_positions ORDER BY product_id');
    return result.rows;
  }));
  return chunks.flat();
}

export async function createPurchase(input: PurchaseInput, metadata: {createdBy:string; originRegion?:string} = {createdBy:'system'}): Promise<OrderRow> {
  return withBatchLock(input.supplierId, input.batchId, () => executeDistributedPurchase(input, metadata));
}

let monitorBusy = false;
export async function runMonitor(): Promise<Array<{ batchId: string; orderId?: string; error?: string }>> {
  if (monitorBusy) return [];
  monitorBusy = true;
  try {
    const stock = await readStocks();
    const batches = automaticBatches(stock);
    const results: Array<{ batchId: string; orderId?: string; error?: string }> = [];
    for (const batch of batches) {
      try {
        const order = await createPurchase(batch);
        results.push({ batchId: batch.batchId, orderId: order.id });
      } catch (error) {
        results.push({ batchId: batch.batchId, error: (error as Error).message });
      }
    }
    return results;
  } finally { monitorBusy = false; }
}
