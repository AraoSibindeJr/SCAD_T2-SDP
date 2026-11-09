import pg from 'pg';

// Um processo independente por armazém: lê apenas o respectivo fragmento.
const region = process.env.REGION || '';
if (!['south', 'center', 'north'].includes(region)) throw new Error('Invalid agent REGION');
const pool = new pg.Pool({
  host: process.env.DB_HOST || `pg-${region}`,
  database: 'scad', user: 'scad', password: process.env.POSTGRES_PASSWORD || 'scad_dev_password',
  max: 2, connectionTimeoutMillis: 5000,
});
const api = process.env.API_URL || 'http://api:3000';
const delay = Math.max(5000, Number(process.env.AGENT_INTERVAL_MS || '15000'));
let busy = false;
async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const result = await pool.query<{ product_id:string }>(
      'SELECT product_id FROM stock_positions WHERE on_hand + incoming_qty <= minimum_stock',
    );
    for (const row of result.rows) {
      const response = await fetch(`${api}/api/alerts`, {
        method: 'POST', headers: { 'content-type':'application/json','x-scad-agent-secret':process.env.SCAD_AGENT_SECRET || '' },
        body: JSON.stringify({ region, productId: row.product_id }), signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`coordinator returned ${response.status}`);
      console.info(`[${region}] stock alert sent: ${row.product_id}`);
    }
  } catch (error) { console.warn(`[${region}] retry on next cycle:`, (error as Error).message); }
  finally { busy = false; }
}
console.info(`Regional stock agent ${region} started; polling each ${delay}ms`);
void poll();
const interval = setInterval(() => void poll(), delay);
process.on('SIGTERM', () => { clearInterval(interval); void pool.end().then(() => process.exit(0)); });
