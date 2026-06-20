# Copy-Trading C4 — `/v1/session/trigger` (the mirror money-path) · KAN-149

> The steady-state copy trade: a webhook-detected source swap (C5) becomes a scaled mirror UserOp, gated by the
> SubmitGate (kill-switch + Q7 + idempotency), built USE-mode, signed by the backend session key, and submitted.
> Built on the C3-proven assembly. End-to-end verified on Base Sepolia through the production code.

## Endpoints (aa-trigger, loopback)

- `POST /v1/session/trigger` `{ permissionId, chainId, calls[], spend, sourceTxHash }` →
  **SubmitGate** (`assertMirrorable`) → **`submitMirror`** (USE-mode build + session-key sign + submit) →
  **`recordMirror`** (Q7 + idempotency). Returns `{ userOpHash }`. Gate failure → **409** (`GateError`), never a 500.
- `POST /v1/copy/session/pause|resume` `{ permissionId }` — kill-switch.
- `POST /v1/copy/session/revoke` `{ permissionId }` — mark on-chain-revoked (no further mirrors).

## SubmitGate (`CopySessionRegistry`, double-gated with the on-chain policies)

`assertMirrorable(permissionId, spend, sourceTxHash)` throws `GateError` on:
- **not granted / revoked / paused** (kill-switch — independent of the on-chain revoke);
- **duplicate `sourceTxHash`** (idempotency — no double-mirror on webhook retry);
- **exposure breach** (Q7: `spentTotal + spend > capTotalBudget`) — fail fast before paying to submit a doomed op.

The on-chain SpendingLimits cap is the **hard** bound; this backend accounting is the fail-fast + cross-op
aggregate (N3/Q7, rest-trust). `recordMirror` accrues `spentTotal` + the source hash **after** a successful submit.

## `submitMirror` (`src/mirror.ts`) — the C3-proven USE path

Signed ONLY by the backend session key (never the follower's main key). Reuses the C3 pins: validator-nonce
**vtype=0x01** read from the EntryPoint; **explicit generous gas** (the session-validator hard-reverts on a mock
sig, so mock-sig estimation is unusable; sponsored ⇒ free); the real session signature over the **RAW userOpHash**
(`buildUseModeUserOpSignature`); sponsored paymaster data via the prepare path.

## Proof

- **End-to-end (Base Sepolia, production code path):** prepare → on-chain enable (owner consent) → grant →
  SubmitGate → `submitMirror` → **mirror receipt `0xb0a8814adb5e2b165375be6f651ac8cae68b26f28947486a77388093655964c2`** ✓ (blk 43083805) → `recordMirror`; then the three gate rejections fire (idempotency / kill-switch / Q7).
  Harness: `c4-trigger.mjs` (`AA_ALLOW_TESTNET=1 RUN_SEND=1`).
- **Deterministic (no network):** SubmitGate unit tests in `copysession.test.mjs` (mirrorable / accrual /
  idempotency / kill-switch / Q7 over-and-exactly-at cap / revoked).

## Boundary / next

- **Enable submission (C4↔grant):** `submitMirror` is steady-state **USE-mode** — it assumes the session is
  enabled on-chain. The one-time enable (owner-signed ENABLE) is the grant's job: the app submits it, or a
  follow-up adds backend ENABLE-mode-on-first-use (`encodeUseOrEnableSmartSessionSignature` + the stored
  `enableSignature`). The C4 harness enables via an owner op to stand in for that step.
- **C5** Alchemy webhook → swap-parse → scale → builds the `calls` + `spend` for this endpoint (idempotency via
  `sourceTxHash`). **C6** integration/hardening.

Status: C1 ✅ · C2 ✅ · C3 ✅ · **C4 ✅** (trigger + SubmitGate + USE-mode mirror, on-chain + unit verified). Next: C5.
