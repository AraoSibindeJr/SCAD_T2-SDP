import pg from 'pg';

export const regions = ['south', 'center', 'north'] as const;
export type Region = typeof regions[number];

const password = process.env.POSTGRES_PASSWORD || 'scad_dev_password';
export const pools = Object.fromEntries(regions.map(region => [region, new pg.Pool({
  host: process.env[`DB_${region.toUpperCase()}_HOST`] || `pg-${region}`,
  port: 5432,
  user: 'scad',
  password,
  database: 'scad',
  max: 8,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 15000,
})])) as Record<Region, pg.Pool>;

export async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      await Promise.all(regions.map(region => pools[region].query('SELECT 1')));
      return;
    } catch (err) {
      console.warn(`DB startup attempt ${attempt}:`, (err as Error).message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error('Unable to reach all three regional PostgreSQL primaries');
}

export async function closeDatabase(): Promise<void> {
  await Promise.all(regions.map(r => pools[r].end()));
}
