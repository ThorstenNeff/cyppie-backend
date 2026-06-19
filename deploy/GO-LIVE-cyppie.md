# Go-Live Runbook — `cyppie.com`

Bring the Cyppie backend live on the registered domain. **One Mac Mini (Oakhost), one Caddy, two TLS
hosts.** 🔒 No secrets in this doc — every secret is a placeholder you set in the host environment.

## Topology / port map

| Public host | Caddy (TLS, :443) → | loopback | Service | Source |
|---|---|---|---|---|
| `api.cyppie.com`  | reverse_proxy | `127.0.0.1:8080` | **Key-Proxy** (`:server`, Alchemy/RPC, auth-free, read/broadcast-only) | ADR-0021 / ADR-0022 |
| `auth.cyppie.com` | reverse_proxy | `127.0.0.1:8082` | **Keycloak** (OIDC + SIWE) | PRD-08 / ADR-0026 |
| `auth.cyppie.com` `/v1/*` | reverse_proxy | `127.0.0.1:8081` | **User-Service** (JWT-gated platform API) | PRD-08 |

(`cyppie.com` root → landing page, separate/later.) Loopback ports are **not** internet-exposed — only
Caddy's :80/:443 are. KC on **8082** so it doesn't collide with the key-proxy on 8080 (same host).

## 1. DNS

Create **A records** at the registrar → the Mac Mini's **public IP** (`<PUBLIC_IP>`):
```
api.cyppie.com    A   <PUBLIC_IP>
auth.cyppie.com   A   <PUBLIC_IP>
```
Wait for propagation (`dig +short api.cyppie.com` returns `<PUBLIC_IP>`). Caddy needs :80 reachable from
the internet for the ACME HTTP-01 challenge. (Root `cyppie.com` / `www` → landing, handled separately.)

## 2. Router / firewall
- Forward **80 + 443** from the public IP to the Mac Mini (ACME + HTTPS).
- Do **not** expose 8080/8081/8082 (loopback only). Harden SSH (ADR-0022 D).

## 3. Merged Caddyfile

One Caddyfile, both hosts, automatic TLS (Let's Encrypt) + HTTP→HTTPS for each named host:
```caddyfile
{
    email ops@cyppie.com        # ACME contact (set a real ops address)
}

# ── Key-Proxy (ADR-0021/0022): auth-free, read/broadcast-only Alchemy/RPC transport ──
api.cyppie.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080 {
        header_up X-Forwarded-For {remote_host}   # ADR-0022 B: :server rate-limits on the real client IP
    }
}

# ── Platform Auth + API (PRD-08) ──
auth.cyppie.com {
    encode zstd gzip

    # Keycloak: OIDC token/JWKS/authorize + the SIWE nonce endpoint (/realms/cyppie/siwe/nonce)
    @kc path /realms/* /resources/* /admin/*
    handle @kc {
        reverse_proxy 127.0.0.1:8082 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Forwarded-Host {host}
        }
    }

    # Platform API — User-Service validates the Keycloak JWT itself (defense-in-depth)
    handle /v1/* {
        reverse_proxy 127.0.0.1:8081
    }
    handle /health {
        reverse_proxy 127.0.0.1:8081
    }

    handle { respond "Cyppie auth" 200 }
}
```
> Reuse the **existing** Oakhost Caddy if the key-proxy already runs there — just add the two host blocks
> above (separate hosts; the proxy block may already exist). Keep the key-proxy route untouched (F4).

## 4. Deploy sequence (on the Mac Mini)

**(a) Key-Proxy** (if not already live) — prod-hardened per **ADR-0022** + its `HARDENING.md`: launchd
service on `127.0.0.1:8080`, Alchemy key from host env / `~/.gradle/gradle.properties` (`alchemyApiKey`)
or `$ALCHEMY_API_KEY` — **never in the repo**. `/healthz` for monitoring.

**(b) PRD-08 backend** — one command (idempotent), secrets from the environment:
```bash
cd cyppie-backend
POSTGRES_PASSWORD='<DB_PASSWORD>' \
KC_ADMIN_PASSWORD='<KC_ADMIN_PASSWORD>' \
KC_HOSTNAME='https://auth.cyppie.com' \
  ./deploy/bootstrap.sh        # Postgres + Keycloak(+SIWE,kc build,:8082) + User-Service(:8081) + realm
```

**(c) Caddy** — write the merged Caddyfile (§3), then `caddy reload` (or `brew services restart caddy`).

**(d) Verify**:
```bash
./deploy/healthcheck.sh                              # local: postgres, realm, SIWE nonce, /v1/me 401
curl https://auth.cyppie.com/realms/cyppie/siwe/nonce   # public: {"nonce":...}
curl -o /dev/null -w '%{http_code}\n' https://auth.cyppie.com/v1/me   # → 401 (fail-closed)
curl https://api.cyppie.com/healthz                  # key-proxy up
```

## 5. Environment variables (set on the host; placeholders only)

| Var | For | Value |
|---|---|---|
| `POSTGRES_PASSWORD` | bootstrap / KC / User-Service DB | `<DB_PASSWORD>` |
| `KC_ADMIN_PASSWORD` | Keycloak bootstrap admin (rotate after 1st login) | `<KC_ADMIN_PASSWORD>` |
| `KC_HOSTNAME` | Keycloak public URL | `https://auth.cyppie.com` |
| `alchemyApiKey` / `ALCHEMY_API_KEY` | key-proxy upstream (ADR-0021) | `<ALCHEMY_KEY>` — host env, never repo |

(Optional overrides: `KC_ADMIN`, `CYPPIE_HOME`, `KC_HTTP_PORT`, `USER_SERVICE_PORT`.)

## 6. Post-go-live
- Rotate the Keycloak bootstrap admin → a named admin; rotate the bootstrap password (HARDENING.md).
- Confirm Caddy auto-renews both certs (`caddy` handles it; check logs after ~60 days).
- Point the iOS/Android client config at `https://api.cyppie.com` (proxy) — `AlchemyProxyConfig.proxyBaseUrl`.
- **Availability:** single Mac Mini = one point (ADR-0022). Clients degrade to `Approximate`/stale on
  outage (FR-4), not crash. Uptime-monitor `https://api.cyppie.com/healthz` + `auth.cyppie.com/health`.

## 7. Rollback
- `launchctl unload ~/Library/LaunchAgents/com.cyppie.{keycloak,user-service}.plist` stops the 08 stack;
  the key-proxy (`api.cyppie.com`) is independent and keeps serving.
- Remove the `auth.cyppie.com` block from the Caddyfile + reload to take auth offline while keeping the proxy.
