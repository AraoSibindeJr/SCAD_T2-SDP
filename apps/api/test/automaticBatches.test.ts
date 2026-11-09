import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticBatches, type StockRow } from '../src/models.js';

const item = (region: 'south'|'center'|'north', onHand: number, incoming = 0): StockRow => ({
  region, product_id: 'RICE25', sku: 'RICE-25KG', name: 'Arroz', supplier_id: 'SUP-REST',
  on_hand: onHand, minimum_stock: 5, target_stock: 20, incoming_qty: incoming, reorder_cycle: 1,
});

test('consolida duas regiões com stock mínimo', () => {
  const batches = automaticBatches([item('south', 3), item('center', 4), item('north', 12)]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].items.reduce((t, i) => t+i.quantity, 0), 33);
  assert.deepEqual(batches[0].items.map(i => i.region), ['center', 'south']);
});
test('não repõe novamente stock com chegada pendente', () => {
  assert.equal(automaticBatches([item('south', 3, 17)]).length, 0);
});
