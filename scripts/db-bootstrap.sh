#!/usr/bin/env bash
# Creates the two database roles Verinum needs and the databases for development and tests.
# Safe to run more than once. Needs a Postgres superuser (defaults to the local "postgres" user).
#
#   verinum_owner  owns the schema; runs migrations; never used by the running API
#   verinum_app    the API's runtime role: owns nothing, cannot bypass row-level security
#
# Usage:  PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=... ./scripts/db-bootstrap.sh
set -euo pipefail

OWNER_PW="${VN_OWNER_PASSWORD:-owner_dev_pw}"
APP_PW="${VN_APP_PASSWORD:-app_dev_pw}"
DBS="${VN_DATABASES:-verinum verinum_test}"
PSQL=(psql -v ON_ERROR_STOP=1 -X -q --dbname postgres)

"${PSQL[@]}" <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'verinum_owner') then
    create role verinum_owner login password '${OWNER_PW}' createdb;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'verinum_app') then
    create role verinum_app login password '${APP_PW}' nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end \$\$;
SQL

for db in $DBS; do
  if [ -z "$("${PSQL[@]}" -tAc "select 1 from pg_database where datname = '$db'")" ]; then
    "${PSQL[@]}" -c "create database $db owner verinum_owner"
    echo "created database $db"
  fi
done
echo "roles and databases are ready"
