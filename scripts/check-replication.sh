#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for region in south center north; do
  printf '\n===== %s PRIMARY =====\n' "$region"
  docker compose exec -T "pg-$region" psql -U scad -d scad -c \
    "SELECT application_name, state, sync_state, sent_lsn, replay_lsn FROM pg_stat_replication;"
  printf '===== %s STANDBY =====\n' "$region"
  docker compose exec -T "pg-$region-replica" psql -U scad -d scad -c \
    "SELECT pg_is_in_recovery() AS is_replica, pg_last_wal_replay_lsn() AS replay_lsn;"
done
