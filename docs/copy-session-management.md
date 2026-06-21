# Copy-Session Management API (KAN-157) — Active list + on-chain Revoke (non-custodial, pre-GA)

> Backend API for the UX `Copy0-Active` overview + `Copy-Revoke-Confirm` (SPEC_COPY_session.md). Reuses the
> C-series `CopySessionRegistry` + the proven `/v1/userop/build`+`/submit` primitives. Final response shape pins
> with Dev-1 at integration. Loopback-only (the Kotlin User-Service is the caller; it has the user JWT).

## 0. Create-follow = `POST /v1/copy/session/prepare` (no separate create-follow endpoint)
The App goes from (trader + budget + chain + allocation + copy-direction) to a session by calling **`prepare`
directly with the scope** — the prepared session (its `permissionId`) IS the follow handle. There is no separate
create-follow endpoint. Request body:
```
{ chainId,
  source,            // ← the followed Trader (S1)
  capTotalBudget,    // ← Budget cap (S2), cumulative, in `token` (decimal string)
  token,             // the spend-budget token
  follower,          // the follower SCA (= owner EOA, 7702 same-address)
  router, selector,  // the allowlisted DEX router + swap selector (UniversalRouter / 0x3593564c)
  windowStart, windowEnd,        // session validity window (unix s)
  tokenOut, feeTier,             // copy-direction (what to buy + V3 pool fee) — REQUIRED for the webhook to mirror
  allocationBps?,    // ← Allocation: % of each source spend to mirror (bps; default 10_000 = full match, cap-clamped)
  slippageBps? }     // slippage tolerance for amountOutMin (mainnet gate)
```
Response = the **EnableInputs** (sessionPublicKey, sessionValidator, sessionValidatorInitData, salt,
userOpPolicies, **actions**, permissionId, smartSession) the App feeds into the enable build (see
`copy-trading-enable-submit-contract.md`). `tokenOut`/`feeTier`/`slippageBps`/`allocationBps` are mirror-time
params — they do NOT affect the `permissionId`/enable digest. Then: build+owner-sign+submit the enable
(approach B) → `POST /v1/copy/session/grant {permissionId}` marks it active.

## 1. Active list — `GET /v1/copy/sessions?follower=0x…`
Returns the follower's **granted** (active or paused) copy sessions as the UX rows — `prepared` (not yet enabled)
and `revoked` (ended) are excluded. Response:
```
{ follower, sessions: [ {
    permissionId, chainId,
    source,            // followed trader (advisory — not a guarantee, per the Confirm trust pattern)
    token,             // spend-budget token (cap/used/remaining denomination)
    cap, used, remaining,  // decimal strings; remaining = cap − used (clamped ≥ 0); off-chain Q7 accounting
    status,            // "active" (granted+unpaused) | "paused" (kill-switch)
    since,             // unix s — "following since" (grantedAt, createdAt fallback)
    router
} ] }
```
Backed by `CopySessionRegistry.viewByFollower(follower)`. `createdAt` is set at `prepare`, `grantedAt` at `grant`.

## 2. On-chain Revoke — non-custodial, owner-signed on-device (ADR-0009)
The permanent revoke is an **on-chain `SmartSessions.removeSession(permissionId)`** (not just an off-chain mark) —
after it the session is gone on-chain: no further mirror is possible, and the remaining budget never moved. It is
**owner-authorized** (Kernel root), so the owner signs on-device; the backend only builds + relays (approach B).

- **Phase 1 — `POST /v1/copy/session/revoke/build` `{ permissionId }`** → `getRemoveSessionAction(permissionId)`
  (`SmartSessions.removeSession`) built into a sponsored userOp via `buildUserOp(follower, [removeSessionCall])`.
  Returns `{ permissionId, userOp, userOpHash, digestToSign, authorizationToSign? }`. The owner raw-signs
  `digestToSign = hashMessage(userOpHash)` (same digest convention as the DCA/enable path).
- **Phase 2 — `POST /v1/copy/session/revoke/submit` `{ permissionId, userOp, signature, authorization? }`** →
  `submitUserOp(...)`; on success marks the session `revoked` (defense-in-depth on top of the on-chain removal).
  Returns `{ permissionId, status, userOpHash }`.

The off-chain `pause`/`resume` (`/v1/copy/session/pause|resume`) remain the instant kill-switch (mirrors stop
immediately via the SubmitGate); revoke is the permanent on-chain end.

**`verifyRevokeUserOp` vector (KAN-157, no-blind):** `removeSession` is a single Kernel-root op, so the App
recomputes the userOpHash + verifies the calldata before the owner signs. `scripts/revoke-userop-vector.mjs`
emits the canonical PackedUserOperation + userOpHash + digestToSign (single call → `SmartSessions.removeSession(
permissionId)`; permissionId is the verify INPUT, example `0x1c3f76fa…`; sender `0xf39F…2266`, nonce 0):
- **ETH(1):** `userOpHash 0x5fbcdaa3ed2713784493834ce101458ebdd0e1f1d13ec757aa9e6e7cd8f24bc0` · `digestToSign 0x955f183aea16d3003d25406bed8bf4b835eef026b096506b30745fcd011f4ea9`
- **Base(8453):** `userOpHash 0x3ad2adb8a4465e9dce47d5795bb4455f31cda3d52a34d97bbb4a2424dc782ec5` · `digestToSign 0xccc72c94a0462389a3dc32a0c5d95f5bc2fee566766a53fca336545a4a542810`

## Proof (Base Sepolia, `c7-revoke-e2e.mjs`, through production code)
prepare → enable → grant → **pre-revoke USE mirror succeeds** (`0x33bc34b2…`) → `revoke/build` (removeSession) →
owner raw-signs `digestToSign` → `revoke/submit` → **REVOKE receipt `0xbd7ee57b…`** → **`isSessionEnabled == false`**
+ a USE-mode mirror is now **rejected** (session unusable). `KAN-157 REVOKE E2E ALL PASS`. Unit: `viewByFollower`
(active/paused only, used/remaining, since, per-follower scoping) in `copysession.test.mjs`.

Status: **KAN-157 ✅** (List + on-chain Revoke, on-chain proven). Response shape final-pin with Dev-1 at integration.
