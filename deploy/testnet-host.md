# Operator: separate Testnet host (PRD-09 network-switching, KAN-174)

Network-switching (Scope B) lets the app point at **mainnet** or **testnet (Base Sepolia)** per the user's choice.
The backend safety-floor under that is a **HOST SPLIT**: the production money-path host **never** serves testnet,
and a **separate, dedicated testnet host** serves Base Sepolia. The app selects the backend by env.

## Why a split (not one host with both)

`AA_ALLOW_TESTNET` is a single process-wide gate (`addresses.ts`): when `0` (the default) the aa-trigger's
`CHAINS` is **ETH + Base only**, and `requireChain()` **rejects** any testnet chainId at every endpoint — so a
production host **cannot route a testnet op even if asked**. Flipping the same prod host to `1` to "also do
testnet" would erase that guarantee. Two hosts keep the floor: prod stays `0` forever; testnet is a separate
deployment. The boot **address-gate** (`verifyAddressesOnChain`) independently asserts EntryPoint + SmartSessions
carry code on every enabled chain on each host (testnet host additionally checks Base Sepolia).

## The two hosts

| | **Prod money-path host** | **Testnet host** |
|---|---|---|
| `AA_ALLOW_TESTNET` | **`0`** (or unset) | **`1`** |
| Serves chains | ETH (1) + Base (8453) | + Base Sepolia (84532) |
| `PIMLICO_API_KEY` | mainnet-enabled key | **testnet-enabled key** (distinct) |
| `PIMLICO_SPONSORSHIP_POLICY_ID` | mainnet policy | a policy allowing **Base Sepolia** |
| Reachability | public (app's mainnet backend URL) | **public** (app's testnet backend URL) |
| Postgres / user-service | prod DB | separate DB (never shared with prod) |

Everything else (binary, ports, the bring-up order, the loopback contract) is identical — see
[`docs/testnet-setup.md`](../docs/testnet-setup.md) for the per-host `.env` knobs + start commands. The testnet
host is literally a second deployment of the same stack with `AA_ALLOW_TESTNET=1` and testnet Pimlico creds.

## App wiring (per-env backend URL)

The app carries the backend base URL **per active environment** (Dev-2's KAN-173/175 half): switching the network
in-app switches the backend host. Operator provides two URLs:
- `https://<prod-host>` → the mainnet stack (`AA_ALLOW_TESTNET=0`)
- `https://<testnet-host>` → the testnet stack (`AA_ALLOW_TESTNET=1`)

Per-net session lists are correct across the switch via the new **`?chainId=`** filter (KAN-174) on
`GET /v1/copy/sessions`, `GET /v1/strategy/sessions`, and user-service `GET /v1/me/sessions` — the app passes the
active chainId so a switched view never shows the other net's rows. (Omitting it returns all nets, back-compat.)

## Acceptance checks (run after deploy)

1. **Prod host rejects testnet** — against the prod host:
   ```
   curl -s "https://<prod-host>/v1/userop/<any>?chainId=84532" → 400 "unsupported chainId 84532 (supported: 1,8453)"
   ```
   (and prod boot log: "addresses verified on ETH + Base" — no Base Sepolia.)
2. **Testnet host validates** — testnet host boots past the address-gate with `AA_ALLOW_TESTNET=1` and serves 84532
   (the `c9`/`c11`/`c12` smoke harnesses land receipts against it).
3. **Endpoints filter by chainId** — `GET .../v1/strategy/sessions?account=0x..&chainId=84532` returns only 84532
   rows; an invalid `chainId` → 400.
4. **No shared state** — prod and testnet use distinct Pimlico keys, sponsorship policies, and Postgres DBs.

## Hard rules

- The prod money-path host's `AA_ALLOW_TESTNET` is **never** set to `1`. Treat it as immutable infra config.
- Testnet Pimlico creds + DB are **separate** from prod — never cross-wire (a shared sponsorship policy or DB is a
  cross-net leak).
- `PIMLICO_API_KEY` is a host secret on each host (host env / gitignored `.env`), never committed or echoed.
