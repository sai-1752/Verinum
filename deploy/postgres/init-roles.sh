#!/bin/sh
# Runs once, when the Postgres container first initialises its data directory.
# Creates the owner role (migrations) and the least-privilege runtime role (the API).
set -eu
: "${VN_OWNER_PASSWORD:?VN_OWNER_PASSWORD is required}"
: "${VN_APP_PASSWORD:?VN_APP_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
create role verinum_owner login password '${VN_OWNER_PASSWORD}';
create role verinum_app   login password '${VN_APP_PASSWORD}' nosuperuser nobypassrls nocreatedb nocreaterole;
alter database ${POSTGRES_DB} owner to verinum_owner;
EOSQL
