# Cyppie Backend — launchd-native runbook (PRD-08 / ADR-0023)

v1 runs **launchd-native** on the Oakhost Mac Mini (RAM-constrained → no Docker/colima; ADR-0023 Update 2).
Components: **Postgres** (Homebrew) · **Keycloak** native dist + the SIWE provider (`kc build`) · **User-Service**
Ktor fat jar · **Caddy** (already native, ADR-0022). 🔑 Auth ≠ Custody. 🔒 Secrets in host env, never in repo.

> The full SIWE auth chain (SIWE → KC JWT → User-Service `/v1/me`) is verified e2e natively — see
> `keycloak/README.md`. This runbook is how it's installed as persistent launchd services.

## Turnkey (one command)

```bash
POSTGRES_PASSWORD=… KC_ADMIN_PASSWORD=… KC_HOSTNAME=https://auth.cyppie.example \
  ./deploy/bootstrap.sh        # idempotent: brew deps, Postgres, KC + SIWE provider + kc build,
                               # User-Service fat jar, launchd load, realm import + VERIFY_PROFILE
./deploy/healthcheck.sh        # verify: postgres, realm, SIWE nonce, /v1/me fail-closed
```
Then merge `caddy/Caddyfile.snippet` into the Oakhost Caddy. The steps below are the manual reference
for what `bootstrap.sh` automates / for troubleshooting.

## 0. Prerequisites
```bash
brew install openjdk@21 postgresql@16
sudo mkdir -p /opt/cyppie/{keycloak,user-service,log} && sudo chown -R "$USER" /opt/cyppie
```

## 1. Postgres
```bash
brew services start postgresql@16
createdb keycloak && createdb userservice           # or: psql -f db/init/00-databases.sql
# create the app role + password (store the password in the host secret store, not here):
psql -d postgres -c "CREATE ROLE cyppie LOGIN PASSWORD '…'; GRANT ALL ON DATABASE keycloak,userservice TO cyppie;"
```

## 2. Keycloak (native dist + SIWE provider)
```bash
# fetch the dist once
curl -fsSL https://github.com/keycloak/keycloak/releases/download/26.1.0/keycloak-26.1.0.tar.gz | tar xz
mv keycloak-26.1.0/* /opt/cyppie/keycloak/
# build + drop the SIWE provider
( cd keycloak/siwe-provider && ./gradlew build copyProviderLibs )
cp keycloak/siwe-provider/build/libs/siwe-provider-*.jar         /opt/cyppie/keycloak/providers/
cp keycloak/siwe-provider/build/providers-libs/*.jar             /opt/cyppie/keycloak/providers/
cp keycloak/realm/cyppie-realm.json                              /opt/cyppie/keycloak/data/import/
( cd /opt/cyppie/keycloak && KC_DB=postgres bin/kc.sh build )    # augment with the provider
```
Then the launchd service + the one-time realm bootstrap:
```bash
cp deploy/launchd/com.cyppie.keycloak.plist ~/Library/LaunchAgents/   # fill paths/secrets, chmod 600
launchctl load ~/Library/LaunchAgents/com.cyppie.keycloak.plist
# once up — disable VERIFY_PROFILE so passwordless wallet identities can get tokens (see keycloak/README):
KC_HOME=/opt/cyppie/keycloak KC_URL=http://localhost:8080 KC_ADMIN=… KC_ADMIN_PASSWORD=… keycloak/bootstrap-realm.sh
```

## 3. User-Service
```bash
( cd user-service && ./gradlew buildFatJar )
cp user-service/build/libs/user-service-all.jar /opt/cyppie/user-service/
cp deploy/launchd/com.cyppie.user-service.plist ~/Library/LaunchAgents/   # fill secrets, chmod 600
launchctl load ~/Library/LaunchAgents/com.cyppie.user-service.plist
```

## 4. Caddy (gateway routes)
Merge `caddy/Caddyfile.snippet` into the Oakhost Caddyfile (auth + platform-API routes, separate from the
key-proxy route — ADR-0022/F4) and reload Caddy.

## 5. Verify
```bash
curl localhost:8081/health                          # user-service liveness
curl localhost:8080/realms/cyppie/siwe/nonce        # SIWE nonce endpoint
# full e2e (nonce → sign → token → /v1/me): see keycloak/README.md
```

## Notes
- launchd manage: `launchctl unload/load …`; logs under `/opt/cyppie/log/`.
- **Cloud-exit:** `deploy/cloud/docker-compose.yml` re-containerizes the same stack for a future K8s/GCP
  migration (ADR-0023) — not used in v1.
