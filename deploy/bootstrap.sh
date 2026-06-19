#!/usr/bin/env bash
#
# Cyppie Backend — turnkey launchd-native deploy on the Mac Mini (PRD-08 / ADR-0023).
# One command: builds + installs Postgres, Keycloak (+ SIWE provider, kc build), and the User-Service as
# launchd services, imports the realm, and disables VERIFY_PROFILE. Idempotent — safe to re-run.
#
#   POSTGRES_PASSWORD=… KC_ADMIN_PASSWORD=… KC_HOSTNAME=https://auth.cyppie.example \
#     ./deploy/bootstrap.sh
#
# 🔒 Secrets come from the environment; nothing is written to the repo. The generated launchd plists
#    (with secrets) live under ~/Library/LaunchAgents and are chmod 600.
# 🔑 Auth ≠ Custody: this stack holds platform identity only; never wallet seeds/keys.
set -euo pipefail

# ── Config (override via env) ───────────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CYPPIE_HOME="${CYPPIE_HOME:-/opt/cyppie}"
KC_VERSION="${KC_VERSION:-26.1.0}"
PG_FORMULA="${PG_FORMULA:-postgresql@16}"
JDK_FORMULA="${JDK_FORMULA:-openjdk@21}"
DB_USER="${POSTGRES_USER:-cyppie}"
KC_ADMIN="${KC_ADMIN:-admin}"
KC_HTTP_PORT="${KC_HTTP_PORT:-8082}"   # 8080 is the key-proxy (ADR-0022); KC on 8082, both behind Caddy
LA_DIR="$HOME/Library/LaunchAgents"

# Required secrets (fail fast if unset).
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
: "${KC_ADMIN_PASSWORD:?set KC_ADMIN_PASSWORD}"
: "${KC_HOSTNAME:?set KC_HOSTNAME, e.g. https://auth.cyppie.example}"

log() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }

# ── 0. Preflight ──────────────────────────────────────────────────────────────────────────────────────
preflight() {
  log "Preflight"
  command -v brew >/dev/null || { echo "Homebrew required"; exit 1; }
  brew list "$JDK_FORMULA" >/dev/null 2>&1 || brew install "$JDK_FORMULA"
  brew list "$PG_FORMULA"  >/dev/null 2>&1 || brew install "$PG_FORMULA"
  export JAVA_HOME; JAVA_HOME="$(brew --prefix "$JDK_FORMULA")"
  export PATH="$(brew --prefix "$PG_FORMULA")/bin:$PATH"
  mkdir -p "$CYPPIE_HOME"/{keycloak,user-service,log}
}

# ── 1. Postgres (role + databases) ──────────────────────────────────────────────────────────────────
setup_postgres() {
  log "Postgres"
  brew services start "$PG_FORMULA" >/dev/null
  for _ in $(seq 1 30); do pg_isready -h localhost -q && break; sleep 1; done
  psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
    || psql -d postgres -c "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$POSTGRES_PASSWORD';"
  for db in keycloak userservice; do
    psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
      || createdb -O "$DB_USER" "$db"
  done
}

# ── 2. Keycloak (dist + SIWE provider + kc build + realm) ─────────────────────────────────────────────
setup_keycloak() {
  log "Keycloak + SIWE provider"
  local kc="$CYPPIE_HOME/keycloak"
  if [ ! -x "$kc/bin/kc.sh" ]; then
    curl -fsSL "https://github.com/keycloak/keycloak/releases/download/$KC_VERSION/keycloak-$KC_VERSION.tar.gz" \
      | tar xz -C /tmp
    cp -R "/tmp/keycloak-$KC_VERSION/." "$kc/"
  fi
  ( cd "$REPO_DIR/keycloak/siwe-provider" && ./gradlew --no-daemon build copyProviderLibs )
  cp "$REPO_DIR"/keycloak/siwe-provider/build/libs/siwe-provider-*.jar "$kc/providers/"
  cp "$REPO_DIR"/keycloak/siwe-provider/build/providers-libs/*.jar      "$kc/providers/"
  mkdir -p "$kc/data/import"
  cp "$REPO_DIR/keycloak/realm/cyppie-realm.json" "$kc/data/import/"
  ( cd "$kc" && KC_DB=postgres ./bin/kc.sh build )
}

# ── 3. User-Service fat jar ─────────────────────────────────────────────────────────────────────────
setup_user_service() {
  log "User-Service"
  ( cd "$REPO_DIR/user-service" && ./gradlew --no-daemon buildFatJar )
  cp "$REPO_DIR"/user-service/build/libs/user-service-all.jar "$CYPPIE_HOME/user-service/"
}

# Render a launchd plist from the template, substituting paths + secrets, into LaunchAgents (chmod 600).
install_plist() {
  local name="$1"; shift
  mkdir -p "$LA_DIR"
  local out="$LA_DIR/$name.plist"
  sed -e "s#/opt/cyppie#$CYPPIE_HOME#g" \
      -e "s#/opt/homebrew/opt/openjdk@21#$JAVA_HOME#g" \
      -e "s#https://auth.cyppie.example#$KC_HOSTNAME#g" \
      "$REPO_DIR/deploy/launchd/$name.plist" >"$out"
  # Substitute the __SET_ON_HOST__ secret placeholders in order of appearance.
  for value in "$@"; do
    python3 - "$out" "$value" <<'PY'
import sys
p, v = sys.argv[1], sys.argv[2]
s = open(p).read().replace("__SET_ON_HOST__", v, 1)
open(p, "w").write(s)
PY
  done
  chmod 600 "$out"
  launchctl unload "$out" 2>/dev/null || true
  launchctl load "$out"
}

# ── 4. launchd services ──────────────────────────────────────────────────────────────────────────────
install_services() {
  log "launchd services"
  # keycloak plist secrets in template order: KC_DB_USERNAME, KC_DB_PASSWORD, KC_BOOTSTRAP_ADMIN_USERNAME,
  # KC_BOOTSTRAP_ADMIN_PASSWORD (KC_HOSTNAME is substituted from the template default — edit if different).
  install_plist com.cyppie.keycloak "$DB_USER" "$POSTGRES_PASSWORD" "$KC_ADMIN" "$KC_ADMIN_PASSWORD"
  # user-service plist secrets in order: CYPPIE_DB_USER, CYPPIE_DB_PASSWORD.
  install_plist com.cyppie.user-service "$DB_USER" "$POSTGRES_PASSWORD"
}

# ── 5. Post-import realm config (VERIFY_PROFILE) ──────────────────────────────────────────────────────
bootstrap_realm() {
  log "Realm bootstrap (VERIFY_PROFILE)"
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://localhost:$KC_HTTP_PORT/realms/cyppie" && break; sleep 2
  done
  KC_HOME="$CYPPIE_HOME/keycloak" KC_URL="http://localhost:$KC_HTTP_PORT" \
    KC_ADMIN="$KC_ADMIN" KC_ADMIN_PASSWORD="$KC_ADMIN_PASSWORD" \
    "$REPO_DIR/keycloak/bootstrap-realm.sh"
}

preflight
setup_postgres
setup_keycloak
setup_user_service
install_services
bootstrap_realm
log "Done. Run deploy/healthcheck.sh to verify, and merge caddy/Caddyfile.snippet into the Oakhost Caddy."
