# Keycloak + SIWE (PRD-08 / ADR-0026 / KAN-137)

Custom Keycloak image with the **SIWE Authenticator-SPI** provider baked in, so the platform login is
Sign-In-With-Ethereum (EIP-4361) — no password. 🔑 Auth ≠ Custody: only a public address + a signature
are ever handled; never a key.

## Layout
```
Dockerfile                 stock Keycloak 26.1 + the SIWE provider → `kc build` (optimized image)
realm/cyppie-realm.json    cyppie realm: public PKCE client + SIWE direct-grant flow (DRAFT)
siwe-provider/             the Gradle provider module (Authenticator-SPI + nonce resource)
```

## What is verified

✅ **Unit (headless):** provider compiles/builds vs Keycloak 26.1.0 SPI + `siwe-java` 1.0.8; the SIWE
crypto path is unit-tested 6/6 (recovery, domain-binding, chain-id, nonce, tampered-sig) against a real
web3j-signed EIP-4361 fixture — which caught the latent `int`/`Long` chain-id bug. Deps pruned 88→44 +
sha256 supply-chain pinned.

✅ **Live — verified natively against Keycloak 26.1.0** (`kc.sh start-dev`, no container engine needed):
- `kc build` augments cleanly with the provider; both SPIs register (`siwe-authenticator`, `siwe`).
- **No BouncyCastle/Jackson classloader conflict** — the feared dedup blocker did not materialise. (One
  cosmetic web3j split-package warning: `org.web3j.crypto`/`utils` span core+crypto+utils jars; harmless,
  a future prune-refinement.)
- Realm `cyppie` imports; `GET /realms/cyppie/siwe/nonce` returns a single-use nonce.
- **Full e2e: nonce → on-device sign → `POST .../token` → a real RS256 JWT** (the SIWE authenticator
  consumes the nonce single-use, recovers the address, federates the user, KC issues the token).

### ⚠️ Realm setup gotcha (verified) — disable VERIFY_PROFILE
A wallet identity has no email/name, so Keycloak's default **VERIFY_PROFILE** required action otherwise
blocks token issuance with `"Account is not fully set up"`. The realm JSON sets it `enabled:false`, **but
Keycloak's realm import does not honour that for built-in required actions** — disable it post-import
(idempotent), e.g.:
```bash
kcadm.sh config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN" --password "$KC_ADMIN_PASSWORD"
kcadm.sh update authentication/required-actions/VERIFY_PROFILE -r cyppie -s enabled=false
```
(See `bootstrap-realm.sh`.) Other findings the live run fixed: the realm JSON must not contain unknown
fields (a `_comment` key fails import); the client's `direct_grant` flow binding override needs the
flow's **id** (not its alias) — the flow carries a fixed `id` referenced by the client.

## Still pending
- **launchd-native migration** (ADR-0023 re-amend): replace `docker-compose.yml` with launchd plists +
  native KC/Postgres/User-Service runbook (RAM-constrained Mac Mini; no Docker).
- **Block 3:** User-Service Postgres/Flyway wiring + JWT validation (Caddy + service) → flip `/v1/me` live.

## End-to-end flow (once live)
1. `GET https://auth.cyppie.example/realms/cyppie/siwe/nonce` → `{ "nonce": "…" }` (single-use, 5-min TTL).
2. Client builds the EIP-4361 message (incl. that nonce, `domain=auth.cyppie.example`, `chainId`) and
   signs it on-device.
3. `POST …/realms/cyppie/protocol/openid-connect/token` with `grant_type=password`,
   `client_id=cyppie-app`, `siwe_message=…`, `siwe_signature=…` → Keycloak runs the SIWE direct-grant
   flow → issues the JWT. (The nonce is consumed single-use = replay protection.)

## Build / run (Mac Mini, colima/podman)
```bash
colima start
docker compose build keycloak       # runs the multi-stage Dockerfile + kc build
docker compose up -d                 # postgres + keycloak (imports the cyppie realm) + user-service
```
⚠️ Host prerequisite: the Mac Mini needs colima or podman installed (flagged to the user alongside the
proxy deploy). Secrets via host env / `.env` (chmod 600) — never committed.
