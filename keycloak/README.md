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

## What is verified vs. pending

✅ **Verified (headless, no Keycloak needed):**
- The provider compiles + builds against Keycloak 26.1.0 SPI + `siwe-java` 1.0.8.
- **SIWE crypto path is unit-tested** (`siwe-provider` `./gradlew test`, 6/6): signature recovery,
  domain-binding, chain-id binding, nonce match, tampered-sig rejection — against a real web3j-signed
  EIP-4361 fixture. (This is how the latent `int`/`Long` chain-id bug was caught.)
- Dependency set pruned (AWS SDK + RPC stack out, 88→44) + **sha256 supply-chain pinned**
  (`siwe-provider/gradle/verification-metadata.xml`).

⛔ **Pending — needs a live Keycloak (the Mac Mini; no container engine in the dev env):**
1. The image build itself (`kc build`) + provider load.
2. **BouncyCastle / Jackson dedup**: the collected `providers/` libs still include `bcprov`/`jackson`
   that overlap Keycloak's bundled versions — confirm no classloader conflict, then drop the duplicates
   (exclude in `siwe-provider/build.gradle.kts`).
3. Realm import (the custom direct-grant flow binding + `authenticatorConfig` may need alias→id fixups).
4. End-to-end SIWE: fetch nonce → sign → token endpoint → JWT.

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
