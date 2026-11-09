#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
API="${API:-http://localhost:8080}"
command -v jq >/dev/null || { echo 'Instala jq antes de executar'; exit 1; }
if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${SCAD_ADMIN_PASSWORD:?Define SCAD_ADMIN_PASSWORD em .env}"
TOKEN=$(jq -n --arg u admin --arg p "$SCAD_ADMIN_PASSWORD" '{username:$u,password:$p}' | curl -fsS -X POST -H 'Content-Type: application/json' -d @- "$API/api/auth/login" | jq -er '.data.token')
request(){ curl -fsS -H "Authorization: Bearer $TOKEN" "$@"; }
echo '=== STOCK REGIONAL ==='
request "$API/api/stocks" | jq
echo '=== MONITORIZAÇÃO ==='
request -X POST "$API/api/monitor/run" | jq
sleep 5
echo '=== COMPRAS ==='
request "$API/api/purchases" | jq
echo '=== RÉPLICAS / CLUSTER ==='
request "$API/api/cluster" | jq
echo '=== AUDITORIA ==='
request "$API/api/audit" | jq
