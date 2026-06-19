#!/usr/bin/env bash
#
# Cyppie Backend — post-deploy healthcheck (PRD-08 / ADR-0023). Verifies each launchd service is up and
# the SIWE endpoints respond. Exits non-zero if any check fails (usable from monitoring / CI smoke).
set -uo pipefail

KC_HTTP_PORT="${KC_HTTP_PORT:-8082}"   # KC on 8082 (8080 = key-proxy, ADR-0022)
US_PORT="${USER_SERVICE_PORT:-8081}"
PG_PREFIX="${PG_PREFIX:-/opt/homebrew/opt/postgresql@16/bin}"
fail=0

ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
bad()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; fail=1; }

# Postgres
if "$PG_PREFIX/pg_isready" -h localhost -q 2>/dev/null; then ok "postgres accepting connections"; else bad "postgres not ready"; fi
for db in keycloak userservice; do
  if "$PG_PREFIX/psql" -d "$db" -tAc "SELECT 1" >/dev/null 2>&1; then ok "db '$db' reachable"; else bad "db '$db' unreachable"; fi
done

# Keycloak realm + SIWE nonce endpoint
if curl -fsS -o /dev/null "http://localhost:$KC_HTTP_PORT/realms/cyppie"; then ok "keycloak realm cyppie up"; else bad "keycloak realm cyppie down"; fi
if curl -fsS "http://localhost:$KC_HTTP_PORT/realms/cyppie/siwe/nonce" | grep -q '"nonce"'; then
  ok "SIWE nonce endpoint serving"
else
  bad "SIWE nonce endpoint not serving (provider not loaded?)"
fi

# User-Service
if curl -fsS -o /dev/null "http://localhost:$US_PORT/health"; then ok "user-service /health"; else bad "user-service /health down"; fi
if curl -fsS -o /dev/null "http://localhost:$US_PORT/ready"; then ok "user-service /ready (DB ok)"; else bad "user-service /ready failing (DB?)"; fi
# /v1/me must reject an unauthenticated call (fail-closed)
code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$US_PORT/v1/me")"
if [ "$code" = "401" ]; then ok "/v1/me fail-closed (401 without token)"; else bad "/v1/me not fail-closed (got $code)"; fi

# aa-trigger (PRD-05 AA) — present only when the AA service is deployed (Pimlico key configured)
AA_PORT="${AA_TRIGGER_PORT:-8090}"
if curl -fsS -o /dev/null "http://localhost:$AA_PORT/healthz" 2>/dev/null; then
  ok "aa-trigger /healthz"
else
  printf '· aa-trigger not deployed (PRD-05 / no Pimlico key) — skipped\n'
fi

if [ "$fail" -eq 0 ]; then printf '\033[1;32mAll checks passed.\033[0m\n'; else printf '\033[1;31mHealthcheck FAILED.\033[0m\n'; fi
exit "$fail"
