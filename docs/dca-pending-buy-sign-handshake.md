# DCA recurring-buy on-device-sign handshake (KAN-163) — for Dev-1's app-sign half

> The backend scheduler BUILDS each due recurring buy (USE-mode, sponsored) and parks it; the app fetches its
> pending buys, signs the digest **on-device**, and submits the signature. The backend relays the parked userOp +
> signature to the bundler. This is the DCA counterpart of the copy auto-mirror, split for on-device signing (Q1).
>
> 🔑 Auth ≠ Custody: the backend never holds the DCA signing key. The DCA session's OwnableValidator owner is the
> user's on-device key, so the app signs the **RAW userOpHash** (the C3 USE-lock — NOT the EIP-191
> `hashMessage` form the *enable* path uses). Dev-1's `verifyBuyUserOp` (byte-pinned vs `dca-buy-userop-vector.mjs`)
> recomputes the userOpHash before signing.

## Endpoints (User-Service, JWT-gated, `account` = caller's own SCA)
### `POST /v1/me/dca/schedules` — create a recurring schedule (one-time setup)
Request: `{ chainId, account, tokenIn, tokenOut, amountIn, router, intervalSeconds, permissionId, feeTier, amountOutMin? }`
(uint256s as decimal strings; `permissionId` = the enabled DCA session the buys run under; `intervalSeconds ≥ 3600`).
Response `201`: `{ scheduleId }`. The scheduler then builds buys for it each tick.

### `GET /v1/me/dca/pending` — fetch built, unsigned buys
Response: `{ pending: [ { id, chainId, account, tokenIn, amountIn, userOpHash, digestToSign, userOp } ] }`.
`digestToSign == userOpHash` (RAW). **🔒 no-blind (PO decision (b)):** the full `userOp` (serialized v0.7 UserOperation
object) ships so the app **recomputes** the userOpHash from it, binds its signature to that, and **scope-checks the
calls** (Dev-1's `verifyBuyUserOp`) BEFORE signing — the app must NOT trust `digestToSign`. Rationale: the on-chain
SmartSessions policy binds only cap+router+selector, NOT tokenOut/amount/timing, so blind-signing the digest alone
would let a hostile backend front-load the cap into a worthless token. The app rejects if its recompute ≠ `userOpHash`
or the decoded calls fall outside the session scope it granted.

### `POST /v1/me/dca/{id}/submit` — submit the signature
Request: `{ signature }` (65-byte `0x` hex, raw secp256k1 over `digestToSign`).
Backend: re-gate (kill-switch/Q7) → relay the parked `userOp` + signature to aa-trigger `/v1/dca/submit` →
record the spend (Q7 cumulative) → mark submitted. Response `200`: `{ userOpHash }` (the bundler hash; poll the
receipt via the existing userOp status path). `400` no-such-pending / bad signature; `403` gated; `502` bundler/submit failed.

## Signing (app)
The owner raw-signs `digestToSign` (== userOpHash) with the on-device key — the SAME primitive as the DCA-buy
vector (`owner.sign({ hash: userOpHash })`), NOT `hashMessage`. The signature is wrapped USE-mode server-side
(`getOwnableValidatorSignature` + `encodeSmartSessionSignature(USE, permissionId)`) in `submitDcaBuy`.

## Flow
```
(setup)  app → POST /v1/me/sessions {config}          → session registered (permissionId)
         app → POST /v1/me/dca/schedules {…,permissionId} → schedule created
(loop)   scheduler tick → /v1/dca/build → park PendingBuy   (gated: kill-switch + Q7)
(buy)    app → GET /v1/me/dca/pending                  → [{id, userOpHash, digestToSign, …}]
         app: verifyBuyUserOp + owner.sign(raw userOpHash)
         app → POST /v1/me/dca/{id}/submit {signature} → backend → /v1/dca/submit → {userOpHash}
         app: poll receipt
```

## Server config
`AA_TRIGGER_URL` (loopback aa-trigger base URL) enables the scheduler loop + submit relay; `DCA_TICK_SECONDS`
(default 60) is the tick cadence. Absent → no loop (the service still serves profiles/sessions). The on-chain
buy money-path itself is proven by aa-trigger `c9-dca-buy-e2e.mjs` (receipt `0x2e6b976c…`).
