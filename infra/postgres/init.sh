#!/bin/sh
set -eu
: "${REGION:?REGION is required}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD is required}"
case "$REGION" in south|center|north) ;; *) echo "Invalid region" >&2; exit 1;; esac
# Apenas ambiente de laboratório; em produção usar secrets e redes restritas.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v replica_pw="$REPLICATION_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD %L', :'replica_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') \gexec
SQL
printf '\nhost replication replicator 0.0.0.0/0 scram-sha-256\n' >> "$PGDATA/pg_hba.conf"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /schema.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v region="$REGION" <<'SQL'
INSERT INTO stock_positions (product_id, sku, name, supplier_id, region, on_hand, minimum_stock, target_stock)
VALUES
('RICE25', 'RICE-25KG', 'Arroz 25kg', 'SUP-REST', :'region',
 CASE :'region' WHEN 'south' THEN 3 WHEN 'center' THEN 4 ELSE 12 END, 5, 20),
('OIL1L', 'OIL-1L', 'Óleo 1L', 'SUP-SOAP', :'region',
 CASE :'region' WHEN 'south' THEN 15 WHEN 'center' THEN 2 ELSE 3 END, 6, 16)
ON CONFLICT (product_id) DO NOTHING;
SQL
