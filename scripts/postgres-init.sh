#!/bin/bash
# Postgres entrypoint hook — creates the additional databases needed
# by the vault and inbox services alongside the main runtime DB. Runs
# once on first container start (before any data is committed); ignored
# on subsequent starts. Existing dev volumes need a one-off createdb
# (see bootstrap.sh hint) or a `docker compose down -v` to re-run.

set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE trusty_squire_vault;
  CREATE DATABASE trusty_squire_inbox;
  CREATE DATABASE trusty_squire_registry;
  GRANT ALL PRIVILEGES ON DATABASE trusty_squire_vault TO $POSTGRES_USER;
  GRANT ALL PRIVILEGES ON DATABASE trusty_squire_inbox TO $POSTGRES_USER;
  GRANT ALL PRIVILEGES ON DATABASE trusty_squire_registry TO $POSTGRES_USER;
EOSQL
