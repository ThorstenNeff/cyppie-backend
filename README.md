# Cyppie Platform Backend (PRD-08)

Minimal platform backend & auth for the Cyppie super-app — the identity/profile layer the data-driven
slices (PRD 04–07) sit behind. **v1 blueprint: [ADR-0023](../Cyppie/docs/adr/0023-minimal-backend-prd08-v1.md).**

> 🔑 **Auth ≠ Custody.** This backend holds *platform identity* only. It **never** receives, stores, or
> signs wallet seeds or private keys — those stay on-device (PRD-01 / [ADR-0005](../Cyppie/docs/adr/0005-non-custodial-security.md)).
> Identity = the user's EVM address, proven on-device via **SIWE** (Sign-In-With-Ethereum).

## Stack (v1 — minimal, on the Oakhost Mac Mini behind the shared Caddy, [ADR-0022](../Cyppie/docs/adr/0022-proxy-deployment-hosting.md))

| Component | Choice | Notes |
|---|---|---|
| Runtime | **Docker-Compose** (license-free **colima**/**podman** on the Mac Mini) | Key-proxy stays launchd-native + separate |
| Auth | **Keycloak** | OIDC/JWT; **SIWE** login (own mini-ADR before the auth build) |
| API Gateway | **Caddy** (`forward_auth`/JWT → Keycloak) | reuse the existing Caddy; separate routes + rate-limit buckets. No Kong/Envoy in v1 |
| User-Service | **Ktor / Kotlin-JVM** | consistent with Cyppie `:server` (Kotlin 2.4.0, Ktor 3.5.0) |
| Database | **Postgres 16** | separate `keycloak` + `userservice` DBs; PII encrypted at rest (F3) |

**Deferred** (PRD-08 §4 / ADR-0023): Kafka, Redis, ClickHouse, Kubernetes/GCP.

## Layout

```
docker-compose.yml          Postgres + Keycloak + User-Service (loopback-only; Caddy is the edge)
.env.example                env template — copy to .env (chmod 600, gitignored), or host env in prod
caddy/Caddyfile.snippet     gateway routes to merge into the Oakhost Caddyfile (auth + platform API)
db/init/                    one-time Postgres bootstrap (creates the keycloak + userservice databases)
user-service/               Ktor/Kotlin User-Service (Gradle, fat jar + Dockerfile)
  └ src/main/resources/db/migration/V1__init.sql   profile/settings schema (Flyway, applied later)
HARDENING.md                secrets + hardening runbook (extends the key-proxy posture)
```

## Run (local / Mac Mini)

```bash
cp .env.example .env && chmod 600 .env     # fill in real secrets (or provide via host env)
colima start                                # or: ensure Docker/podman is up
docker compose up -d                        # postgres + keycloak + user-service
docker compose ps                           # health
curl localhost:8081/health                  # → {"status":"ok",...}
```

The User-Service alone (skeleton, no DB needed):

```bash
cd user-service && ./gradlew run            # serves :8081  (./gradlew test  ./gradlew buildFatJar)
```

## Status (v1 skeleton)

- ✅ Infra scaffold: compose (Postgres + Keycloak + User-Service), Caddy gateway routes, DB bootstrap + schema migration, secrets posture.
- ✅ User-Service skeleton: Ktor app, `/health` + `/ready` green, `/v1/me` fail-closed `501` until auth lands. Compiles + tests pass + fat jar builds.
- ⏭️ Next: **SIWE-Keycloak mini-ADR** (decided with the PO) → realm + SIWE authenticator → JWT validation at the gateway + User-Service → Postgres/Flyway wiring + profile API.
