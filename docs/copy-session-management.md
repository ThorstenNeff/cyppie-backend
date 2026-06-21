# Copy-Session Management API (KAN-157) — Active list + on-chain Revoke (non-custodial, pre-GA)

> Backend API for the UX `Copy0-Active` overview + `Copy-Revoke-Confirm` (SPEC_COPY_session.md). Reuses the
> C-series `CopySessionRegistry` + the proven `/v1/userop/build`+`/submit` primitives. Final response shape pins
> with Dev-1 at integration. Loopback-only (the Kotlin User-Service is the caller; it has the user JWT).

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

## Proof (Base Sepolia, `c7-revoke-e2e.mjs`, through production code)
prepare → enable → grant → **pre-revoke USE mirror succeeds** (`0x33bc34b2…`) → `revoke/build` (removeSession) →
owner raw-signs `digestToSign` → `revoke/submit` → **REVOKE receipt `0xbd7ee57b…`** → **`isSessionEnabled == false`**
+ a USE-mode mirror is now **rejected** (session unusable). `KAN-157 REVOKE E2E ALL PASS`. Unit: `viewByFollower`
(active/paused only, used/remaining, since, per-follower scoping) in `copysession.test.mjs`.

Status: **KAN-157 ✅** (List + on-chain Revoke, on-chain proven). Response shape final-pin with Dev-1 at integration.
