#!/bin/sh
# Runs once, when the Postgres volume is created for the first time (like the dev script
# infra/docker/postgres/init/01-roles.sql). It makes the same three roles, but the passwords come
# from the server's .env instead of being written here. Keep the two files in step: a role or a
# grant added to one must be added to the other.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_password="$MIGRATOR_DB_PASSWORD" \
  -v app_password="$APP_DB_PASSWORD" \
  -v worker_password="$WORKER_DB_PASSWORD" <<'SQL'
-- Runs the migrations and owns the schema
CREATE ROLE omnivo_migrator WITH LOGIN PASSWORD :'migrator_password' CREATEDB CREATEROLE;
GRANT ALL PRIVILEGES ON DATABASE omnivo TO omnivo_migrator;
ALTER DATABASE omnivo OWNER TO omnivo_migrator;

-- The API and the worker's jobs. NOBYPASSRLS: every query goes through row-level security
CREATE ROLE omnivo_app WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE omnivo TO omnivo_app;
GRANT USAGE ON SCHEMA public TO omnivo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omnivo_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnivo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omnivo_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO omnivo_app;

-- The worker's outbox relay. Its rights come from the migrations (0012 and later)
CREATE ROLE omnivo_worker WITH LOGIN PASSWORD :'worker_password' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE omnivo TO omnivo_worker;
GRANT USAGE ON SCHEMA public TO omnivo_worker;
SQL
