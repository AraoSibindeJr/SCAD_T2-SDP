#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
API="${API:-http://localhost:8080}"
command -v jq >/dev/null || { echo 'O script necessita de jq'; exit 1; }
command -v docker >/dev/null || { echo 'O script necessita de Docker'; exit 1; }
if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${SCAD_ADMIN_PASSWORD:?Configura SCAD_ADMIN_PASSWORD em .env}"
: "${SCAD_BUYER_SOUTH_PASSWORD:?Configura SCAD_BUYER_SOUTH_PASSWORD em .env}"
log_in() {
  local username="$1" password="$2"
  jq -n --arg username "$username" --arg password "$password" '{username:$username,password:$password}' |
    curl --fail-with-body -sS "$API/api/auth/login" -X POST -H 'Content-Type: application/json' -d @- |
    jq -er '.data.token'
}
ADMIN_TOKEN=$(log_in admin "$SCAD_ADMIN_PASSWORD")
SOUTH_TOKEN=$(log_in buyer-south "$SCAD_BUYER_SOUTH_PASSWORD")
get_admin() { curl --fail-with-body -sS -H "Authorization: Bearer $ADMIN_TOKEN" "$API$1"; }
get_south() { curl --fail-with-body -sS -H "Authorization: Bearer $SOUTH_TOKEN" "$API$1"; }
post_admin() { curl --fail-with-body -sS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "$2" "$API$1"; }
echo '1/7: API e autenticação'
curl --fail --silent "$API/api/health" | jq -e '.success==true' >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/stocks")
[[ "$code" == '401' ]] || { echo "ERRO: acesso sem token deu HTTP $code (esperado 401)"; exit 1; }
get_admin /api/stocks | jq -e '(.data|length)>=6' >/dev/null
get_south /api/stocks | jq -e '(.data|length)>0 and all(.data[]; .region=="south")' >/dev/null
echo '2/7: Comprador Sul não pode criar ordens Centro'
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/purchases" \
  -H "Authorization: Bearer $SOUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"supplierId":"SUP-REST","batchId":"FORBIDDEN-CENTER-01","items":[{"region":"center","productId":"RICE25","quantity":1}]}')
[[ "$code" == '403' ]] || { echo "ERRO: comprador Sul conseguiu escrever no Centro (HTTP $code)"; exit 1; }
echo '3/7: Verificar streaming replication'
for region in south center north; do
  replicas=0
  for _ in $(seq 1 20); do
    replicas=$(docker compose exec -T "pg-$region" psql -U scad -d scad -Atc \
      "SELECT count(*) FROM pg_stat_replication WHERE state='streaming'" | tr -d '\r')
    [[ "${replicas:-0}" -ge 1 ]] && break
    sleep 2
  done
  [[ "${replicas:-0}" -ge 1 ]] || { echo "ERRO: sem réplica $region"; exit 1; }
done
echo '4/7: Dez pedidos concorrentes para o mesmo lote'
BATCH="RACE-$(date +%s)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for i in $(seq 1 10); do
  curl -sS --max-time 35 -X POST "$API/api/purchases" -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"supplierId\":\"SUP-REST\",\"batchId\":\"$BATCH\",\"items\":[{\"region\":\"south\",\"productId\":\"RICE25\",\"quantity\":1},{\"region\":\"center\",\"productId\":\"RICE25\",\"quantity\":1}]}" >"$TMP/$i.json" &
done
wait
count=$(get_admin /api/purchases | jq --arg b "$BATCH" '[.data[]|select(.batch_id==$b)]|length')
[[ "$count" -eq 1 ]] || { echo "ERRO: $count ordens para $BATCH"; exit 1; }
echo '5/7: Transacções preparadas terminadas'
for region in south center north; do
  prepared=$(docker compose exec -T "pg-$region" psql -U scad -d scad -Atc \
    "SELECT count(*) FROM pg_prepared_xacts WHERE gid LIKE 'scad_%'" | tr -d '\r')
  [[ "$prepared" -eq 0 ]] || { echo "ERRO: $region possui $prepared transacções preparadas"; exit 1; }
done
echo '6/7: Integração REST e SOAP'
post_admin /api/monitor/run '{}' >/dev/null
for _ in $(seq 1 30); do
  result=$(get_admin /api/purchases)
  rest=$(echo "$result"|jq '[.data[]|select(.supplier_id=="SUP-REST" and .status=="CONFIRMED")]|length')
  soap=$(echo "$result"|jq '[.data[]|select(.supplier_id=="SUP-SOAP" and .status=="CONFIRMED")]|length')
  [[ "$rest" -ge 1 && "$soap" -ge 1 ]] && break
  sleep 3
done
[[ "$rest" -ge 1 && "$soap" -ge 1 ]] || { echo 'AVISO: não foi possível confirmar REST e SOAP'; exit 1; }
echo '7/7: Recepção idempotente em Maputo'
# Recupera a encomenda concorrente assim que estiver confirmada.
for _ in $(seq 1 12); do
  result=$(get_admin /api/purchases)
  order_id=$(echo "$result"|jq -r --arg b "$BATCH" '.data[]|select(.batch_id==$b and .status=="CONFIRMED")|.id'|head -1)
  [[ -n "$order_id" ]] && break
  sleep 3
done
[[ -n "$order_id" ]] || { echo 'ERRO: encomenda de teste não confirmada'; exit 1; }
receipt1=$(curl --fail-with-body -sS -X POST "$API/api/purchases/$order_id/receive" -H "Authorization: Bearer $SOUTH_TOKEN" -H 'Content-Type: application/json' -d '{"region":"south"}')
receipt2=$(curl --fail-with-body -sS -X POST "$API/api/purchases/$order_id/receive" -H "Authorization: Bearer $SOUTH_TOKEN" -H 'Content-Type: application/json' -d '{"region":"south"}')
echo "$receipt1" | jq -e '.data.receivedItems==1 or .data.alreadyReceived==true' >/dev/null
echo "$receipt2" | jq -e '.data.alreadyReceived==true' >/dev/null
echo 'PASSOU: autenticação, autorização regional, replicação, concorrência, 2PC, fornecedores, recepção idempotente'
