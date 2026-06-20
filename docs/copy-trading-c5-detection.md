# Copy-Trading C5 — Alchemy webhook detection · KAN-149

> Turn an Alchemy Address-Activity push into **gated, scaled mirror intents**. This increment is the
> detection/verification/scaling/gating pipeline — pure + deterministic, no network, fully unit-tested. The
> money-path execution legs (per-router swap-calldata adapter + the gated submit with ENABLE-mode-on-first-use)
> are C6.

## Endpoint

`POST /v1/copy/webhook` (loopback / Alchemy):
1. **HMAC verify (fail-closed):** `x-alchemy-signature` = hex HMAC-SHA256 of the **raw** body with
   `ALCHEMY_WEBHOOK_SIGNING_KEY` (host env). Missing key/sig or any mismatch ⇒ **401**, timing-safe compare.
2. **Parse** (`parseFollowedSpends`): keep only `category:"token"` transfers **from a followed source** **to an
   allowlisted router** with a token + non-zero amount. Everything else is dropped — **no blind mirror**.
3. **Fan out** (`findBySource`): for each spend, the granted+unpaused sessions following that source on that chain.
4. **Scale** (`scaleMirror`): `mirror = amountIn × allocationBps / 10_000`, clamped to the session's remaining
   on-chain cap (`capTotalBudget − spentTotal`). Q-B fixed-cap match defaults `allocationBps = 10_000`.
5. **Gate** (`assertMirrorable`, C4): each mirror gets a verdict (`"ok"` or the GateError reason —
   kill-switch / Q7 / idempotency). Returns `{ detected, mirrors:[{permissionId, tokenIn, amount, sourceTxHash, router, gate}] }`.

## Security (fail-closed by construction)

- HMAC fail-closed: no signing key / bad sig ⇒ reject before any parsing.
- Router **allowlist** (`ROUTER_ALLOWLIST`, Q-C: Uniswap Universal Router first, additive) — an unknown router
  is ignored, never mirrored.
- Idempotency per `sourceTxHash` is the SubmitGate's job (C4) — no double-mirror on webhook retry.

## Tests

`copywebhook.test.mjs` (deterministic, no network): HMAC accept/tamper/missing-key/missing-sig/length-mismatch;
router allowlist; parse (followed→allowlisted kept, non-followed / unknown-router / non-token / zero-amount /
unknown-network dropped); scale (proportional + cap clamp + zero cases). All green.

## Next (C6 — execution + integration)

- **Per-router swap-calldata adapter:** build the follower's mirror `calls` (token `approve(router, mirror)` +
  the scaled router swap) from the parsed source spend. Router-specific (Universal Router commands).
- **Gated submit + ENABLE-mode-on-first-use:** the webhook calls `submitMirror` (C4) per mirrorable plan;
  `submitMirror` becomes auto USE/ENABLE via `encodeUseOrEnableSmartSessionSignature` + the stored owner
  `enableSignature` (per the PO: the backend triggers 24/7, so the atomic enable+use belongs in the first
  mirror, not a separate app submit).
- E2E on testnet: source swap → webhook → mirror receipt; kill-switch/revoke/Q7 paths.

Status: C1 ✅ · C2 ✅ · C3 ✅ · C4 ✅ · **C5 ✅ (detection core)**. Next: C6 (swap adapter + gated submit + ENABLE-fold + E2E).
