#!/bin/sh
set -eu
: "${PRIMARY_HOST:?PRIMARY_HOST required}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD required}"
: "${REPLICA_NAME:?REPLICA_NAME required}"
export PGPASSWORD="$REPLICATION_PASSWORD"
mkdir -p "$PGDATA"
chown -R postgres:postgres /var/lib/postgresql/data
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h "$PRIMARY_HOST" -U scad -d scad; do sleep 2; done
  # -X stream inclui WAL durante o backup inicial.
  su-exec postgres pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U replicator -D "$PGDATA" -Fp -Xs -P
  touch "$PGDATA/standby.signal"
  printf "primary_conninfo = 'host=%s port=5432 user=replicator password=%s application_name=%s'\n" \
    "$PRIMARY_HOST" "$REPLICATION_PASSWORD" "$REPLICA_NAME" >> "$PGDATA/postgresql.auto.conf"
  chown -R postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"
fi
exec su-exec postgres postgres -D "$PGDATA" -c max_prepared_transactions=100 -c max_connections=100 -c hot_standby=on
