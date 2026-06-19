# Backend Hardening & Secrets Runbook (PRD-08)

Extends the key-proxy posture ([ADR-0021](../Cyppie/docs/adr/0021-server-side-api-key-proxy.md) /
[ADR-0022](../Cyppie/docs/adr/0022-proxy-deployment-hosting.md)) to the platform backend. Same host
(Oakhost Mac Mini), same TLS edge (Caddy), same rule: **secrets live in the host environment, never in
the repo** (PRD-08 F6).

## 🔑 Auth ≠ Custody (the invariant)

The backend never receives, stores, or signs wallet seeds or private keys. Keycloak federates *address
ownership* via a SIWE signature produced on-device; the backend only ever sees a public address + a
signature it verifies. Any change that would put key material server-side is a hard no.

## Secrets

| Secret | Source (prod) | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | host env / chmod-600 `.env` | shared by Keycloak + User-Service DB roles (split into least-privilege roles = follow-up) |
| `KC_ADMIN` / `KC_ADMIN_PASSWORD` | host env | **bootstrap only** — create a named admin, then disable/rotate the bootstrap account |
| Keycloak realm/client secrets | Keycloak DB + host env | never commit a realm export containing secrets (`.gitignore` blocks `*-realm-export.json`) |
| JWT signing keys | Keycloak-managed (realm keys) | rotated in Keycloak; the gateway/User-Service only hold the **public** JWKS |

- `.env` is gitignored; `.env.example` carries placeholders only. In prod, prefer launchd
  `EnvironmentVariables` / a `chmod 600` host file sourced before `docker compose up` over a `.env` on disk.
- Never echo secrets into logs, build output, or Discord.

## Network posture

- All container ports bind to `127.0.0.1` — **Caddy is the only public edge** (TLS). Postgres/Keycloak/
  User-Service are never directly internet-reachable.
- Gateway separation (F4): the key-proxy route stays auth-free/read-only; platform `/v1` routes require a
  valid Keycloak JWT; **separate rate-limit buckets** (different abuse profiles).

## Data protection (F3 — GDPR; EU host)

- Postgres holds real PII (email, display name, social graph later) → encrypt at rest (host FDE +
  column-level for sensitive PII), encrypted backups + retention policy, documented delete/access paths
  (GDPR Art. 15/17). The wallet address is a public identifier, but profile PII is in scope.

## Rotation / runbook (TODO as auth lands)

- [ ] Replace the bootstrap Keycloak admin with a named account; rotate the bootstrap password.
- [ ] Split Postgres into per-service least-privilege roles (keycloak / userservice).
- [ ] Document the realm export/import hygiene (sanitized exports only).
- [ ] Key-rotation cadence for the realm signing keys.
