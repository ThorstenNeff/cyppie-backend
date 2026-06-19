-- Bootstrap the two databases on the shared Postgres (runs once, on an empty data volume, via the
-- postgres image's docker-entrypoint-initdb.d). Both are owned by POSTGRES_USER for v1 simplicity;
-- least-privilege per-service roles are a hardening follow-up (HARDENING.md).
--
-- Auth ≠ Custody: these databases hold platform identity + profile data only — never wallet secrets.

CREATE DATABASE keycloak;
CREATE DATABASE userservice;
