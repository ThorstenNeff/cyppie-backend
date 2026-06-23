# Running the Cyppie AA stack against Base Sepolia (testnet)

Concrete, step-by-step setup to run the backend AA stack (aa-trigger + user-service + Postgres) against **Base
Sepolia (chainId 84532)** — the exact configuration used by the on-chain e2e proofs (`c9`/`c11`/`c12`). Every var
and command below is real and verified against the code.

> 🔒 Testnet is gated: **`AA_ALLOW_TESTNET=1` is required** or the aa-trigger refuses chain 84532 (prod default =
> ETH + Base only, so production can never accidentally route to testnet). All ops are **Pimlico-sponsored** — you
> need a testnet Pimlico key + a sponsorship policy; no real capital moves.

---

## 0. Prerequisites

- **Node** ≥ 20 (tested on v24) for `aa-trigger`.
- **JDK 21** for `user-service`. This repo's e2e used the Gradle-managed Corretto 21:
  ```
  export JAVA_HOME=/Users/customer/.gradle/jdks/amazon_com_inc_-21-aarch64-os_x.2/amazon-corretto-21.jdk/Contents/Home
  ```
- **PostgreSQL 16** binaries on PATH (`initdb`, `pg_ctl`, `psql`) — only for `user-service` persistence. No Docker
  needed (the e2e used a throwaway local cluster).
- A **Pimlico account** with: a **testnet-enabled API key**, and a **sponsorship policy** (default id
  `sp_next_micromax`) that allows **Base Sepolia** + the gas you'll spend. You own this in the Pimlico dashboard.
- A funded-by-paymaster is NOT needed (gas is sponsored); the **owner EOA** needs no ETH on testnet either (the
  EIP-7702 + UserOp gas is paid by the paymaster).

---

## 1. Secrets — `Backend/.env`

The aa-trigger reads its secrets via `node --env-file=../.env` (i.e. **`Backend/.env`**, never committed):

```dotenv
# --- required ---
PIMLICO_API_KEY=pim_xxxxxxxxxxxxxxxxxxxxxxxx     # a TESTNET-enabled Pimlico key (host secret)
AA_ALLOW_TESTNET=1                               # enables chain 84532 (Base Sepolia); without it, 84532 is rejected

# --- optional (sensible defaults shown) ---
PIMLICO_SPONSORSHIP_POLICY_ID=sp_next_micromax   # your Pimlico sponsorship policy id (must allow Base Sepolia)
AA_TRIGGER_PORT=8090                             # loopback port the aa-trigger listens on
BASE_SEPOLIA_RPC_URL=https://base-sepolia-rpc.publicnode.com   # 84532 RPC
ETH_RPC_URL=https://ethereum-rpc.publicnode.com               # used by the boot address-gate (see §4)
BASE_RPC_URL=https://base-rpc.publicnode.com                  # used by the boot address-gate (see §4)
```

> ⚠️ The boot **address-gate** (`verifyAddressesOnChain`) checks that the EntryPoint + SmartSessions module carry
> code on **every enabled chain** — with `AA_ALLOW_TESTNET=1` that is ETH + Base + Base Sepolia. So the host needs
> outbound access to all three RPCs at startup. The public RPCs above work out of the box.

`PIMLICO_API_KEY` is a **host secret** — keep it in `Backend/.env` (gitignored) or the host env; never echo or commit it.

---

## 2. Postgres (for `user-service` only)

The aa-trigger itself is stateless (in-memory + JSON registries); only the user-service needs Postgres. Throwaway
local cluster (exactly as the c-series e2e ran it):

```bash
PGDATA=/tmp/cyppie-pg PGPORT=55432
initdb -D "$PGDATA" -U postgres --auth=trust -E UTF8
pg_ctl -D "$PGDATA" -o "-p $PGPORT -k /tmp -c listen_addresses='127.0.0.1'" -l /tmp/cyppie-pg.log start
PGHOST=127.0.0.1 psql -p $PGPORT -U postgres -c "CREATE DATABASE cyppie;"
# → DB URL: jdbc:postgresql://127.0.0.1:55432/cyppie  (trust auth, user "postgres", no password)
```
(`pg_ctl -D "$PGDATA" stop` to tear down; `rm -rf "$PGDATA"` to wipe.) Schema migrations (Flyway-style V1..V4) run
**automatically** on user-service boot — no manual migrate step.

---

## 3. Bring up the stack (order matters)

**(a) aa-trigger** — the AA money-path service (build + submit UserOps via Pimlico):
```bash
cd Backend/aa-trigger
npm install
npm run build                      # tsc → dist/
AA_ALLOW_TESTNET=1 node --env-file=../.env dist/server.js
# → "aa-trigger listening on 127.0.0.1:8090 — addresses verified on ETH + Base"
```
(`AA_ALLOW_TESTNET=1` on the command line is fine even though it's also in `.env` — either works.)

**(b) user-service** — profiles/sessions/DCA-scheduler (calls aa-trigger over loopback):
```bash
cd Backend/user-service
export JAVA_HOME=...                                  # see §0
CYPPIE_DB_URL=jdbc:postgresql://127.0.0.1:55432/cyppie \
CYPPIE_DB_USER=postgres \
AA_TRIGGER_URL=http://127.0.0.1:8090 \
DCA_TICK_SECONDS=60 \
USER_SERVICE_PORT=8081 \
  ./gradlew run
# → boots on :8081, runs migrations, starts the DCA scheduler loop (needs DB + AA_TRIGGER_URL set)
```
user-service env vars (all read via `System.getenv`):

| Var | Purpose | Default |
|---|---|---|
| `CYPPIE_DB_URL` / `CYPPIE_DB_USER` / `CYPPIE_DB_PASSWORD` | Postgres (absent ⇒ no DB, `/v1/me` echoes token only) | — |
| `AA_TRIGGER_URL` | loopback aa-trigger base URL (enables the DCA scheduler + submit relay) | — |
| `DCA_TICK_SECONDS` | DCA scheduler tick cadence | `60` |
| `USER_SERVICE_PORT` | HTTP port | `8081` |
| `CYPPIE_OIDC_ISSUER` | Keycloak realm issuer — gates `/v1/*` (see §5) | unset ⇒ `/v1/*` fail-closed |

---

## 4. On-chain config the aa-trigger uses (Base Sepolia)

Addresses are sourced from the audited SDKs (`@rhinestone/module-sdk`, `viem/account-abstraction`) and
**cross-checked on-chain at boot** — not hand-typed. CREATE2 ⇒ the module addresses are identical across chains.

| Contract | Address |
|---|---|
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Kernel v3.3 delegate (EIP-7702 impl) | `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28` |
| SmartSessions validator | `0x00000000008bDABA73cD9815d79069c247Eb4bDA` |
| OwnableValidator | `0x000000000013fdB5234E4E3162a810F54d9f7E98` |
| SpendingLimits policy | `0x000000000033212e272655d8a22402db819477a6` |
| TimeFrame policy | `0x0000000000D30f611fA3bf652ac6879428586930` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Uniswap QuoterV2 (84532) | `0xC5290058841028F1614F3A6F0F5816cAd0df5E27` |

Common Base Sepolia tokens used in the e2e: USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, WETH
`0x4200000000000000000000000000000000000006`.

**Sponsorship:** every UserOp is sent with `paymasterContext.sponsorshipPolicyId = $PIMLICO_SPONSORSHIP_POLICY_ID`
(`sp_next_micromax` by default). Your Pimlico policy must permit Base Sepolia or the bundler rejects the op.

---

## 5. What works WITHOUT Keycloak (service-layer) vs what needs the live JWT edge

The `/v1/*` endpoints on the **user-service** are **JWT-gated** (Keycloak, PRD-08). The endpoints on the
**aa-trigger** are **loopback-only, NOT JWT-gated** (the user-service is the trusted caller; it validates the JWT
first).

**Works against testnet TODAY without Keycloak (the service layer — exactly how the e2e proofs run):**
- All **aa-trigger loopback endpoints** directly: `/v1/userop/build|submit`, `/v1/copy/session/*`,
  `/v1/dca/build|submit`, `/v1/strategy/session/prepare|grant|revoke|pause|resume`, `GET /v1/copy|strategy/sessions`,
  `/v1/copy/webhook`, `/v1/session/trigger`.
- user-service **`/health`** + **`/ready`** (always).
- The full money-path lifecycles end-to-end (enable → grant → buy/rebalance → revoke), driven at the service layer —
  see the runnable e2e harnesses in §6.

**Requires Keycloak / PRD-08 auth (deferred — not testable end-to-end yet):**
- The live **app → gateway → user-service** JWT path: `GET/POST /v1/me`, `/v1/me/sessions`, `/v1/me/dca/*`. With
  `CYPPIE_OIDC_ISSUER` unset these return **501 Not Implemented** (fail-closed by design). Set it to a Keycloak realm
  issuer to enable them — but the full Keycloak SIWE-federation stack is PRD-08 and not part of this testnet setup.

So: the user can exercise the **entire AA money-path against Base Sepolia today via the service layer / aa-trigger
endpoints**; the only piece pending is the live JWT-authenticated HTTP front door (PRD-08).

---

## 6. Smoke-test the stack (optional, sponsored on-chain)

The committed e2e harnesses double as smoke tests (each sends one sponsored testnet UserOp; `RUN_SEND=1` arms the
on-chain send, omit it for a dry/offline assembly check):
```bash
cd Backend/aa-trigger && npm run build
AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=../.env c9-dca-buy-e2e.mjs            # DCA recurring buy → receipt
AA_ALLOW_TESTNET=1 COPY_TEST_HOOKS=1 RUN_SEND=1 node --env-file=../.env c11-strategy-rebalance-e2e.mjs   # rebalance → receipt
AA_ALLOW_TESTNET=1 COPY_TEST_HOOKS=1 RUN_SEND=1 node --env-file=../.env c12-strategy-lifecycle-e2e.mjs   # prepare→enable→grant→revoke
```
`COPY_TEST_HOOKS=1` is a **test-only** flag (hard fail-closed in prod) that lets the strategy harnesses run without
live DEX pools (test-injected quote / test-allowlisted tokenOut). The full `register→scheduler→buy` orchestration
(incl. Postgres + the Kotlin DcaScheduler) is `user-service`'s `DcaOrchestrationE2eTest` (gated by `RUN_DCA_E2E=1`).
