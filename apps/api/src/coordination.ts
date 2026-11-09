import { Etcd3 } from 'etcd3';
import type { Region } from './db.js';

export const etcd = new Etcd3({
  hosts: (process.env.ETCD_ENDPOINTS || 'etcd1:2379,etcd2:2379,etcd3:2379').split(','),
});

export type TxRecord = {
  txId: string;
  orderId: string;
  participants: Region[];
  status: 'PREPARING' | 'COMMIT' | 'ABORT' | 'DONE';
  updatedAt: string;
};

const key = (id: string) => `/scad/transactions/${id}`;
export async function saveTx(record: TxRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  await etcd.put(key(record.txId)).value(JSON.stringify(record));
}
export async function allTransactions(): Promise<TxRecord[]> {
  const values = await etcd.getAll().prefix('/scad/transactions/').strings();
  return Object.values(values).map(value => JSON.parse(value) as TxRecord);
}
export async function withBatchLock<T>(supplierId: string, batchId: string, action: () => Promise<T>): Promise<T> {
  const resource = `/scad/locks/${supplierId}/${batchId}`;
  // TTL curto limita bloqueios órfãos; a UNIQUE(supplier_id,batch_id) é a segunda barreira.
  return etcd.lock(resource).ttl(120).do(action);
}
