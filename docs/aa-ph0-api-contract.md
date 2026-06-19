# AA Phase-0 contract (KAN-139 / Epic KAN-138)

The shared groundwork the App (Dev-1/Dev-2) and Backend build against — **module addresses**, the
**session-config schema**, and the **Kotlin ↔ Node `aa-trigger` loopback API** + the DCA-on-device sign
flow. Stack per ADR-0024: Kernel (ERC-7579) + Rhinestone Smart Sessions + EIP-7702 + Pimlico, ETH + Base.

🔑 The main key never leaves the device. For DCA (Q1 = on-device) the **app signs**; the backend only
builds + submits. The backend holds scoped session keys for **Copy/Vaults only** (Ph2).

## 1. Module addresses (pinned in `aa-trigger` config; confirm in Phase 0)

| Contract | ETH mainnet | Base | Source |
|---|---|---|---|
| **EntryPoint v0.7** | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | same | canonical (all chains) |
| **Kernel** impl (7702 mode) | `<pin>` | `<pin>` | ZeroDev Kernel deployment registry (versioned) |
| **Smart Sessions** module | `<pin>` | `<pin>` | `erc7579/smartsessions` deployments (CREATE2 → identical across chains) |

Pin exact versioned addresses in the `aa-trigger` config + a checksum check at boot. (CREATE2 means the
module address is the **same on ETH + Base**; confirm the Kernel impl version + the Smart Sessions
release tag against the registries before wiring.)

## 2. Session-config schema (shared App ↔ Backend)

The canonical model the app builds on-device (grant UX) and the backend stores in the registry. Limits map
1:1 to Smart Sessions policies (Q7: per-op + rolling-window + total-exposure).

```jsonc
{
  "sessionId": "uuid",              // backend-assigned; ties registry ↔ on-chain session
  "chainId": 8453,                  // 1 (ETH) | 8453 (Base)
  "account": "0x<scaAddress>",      // = the SIWE-identity EOA upgraded via 7702 (same address)
  "signer": "on-device" | "backend",// DCA = on-device; Copy/Vaults = backend (Ph2, HSM/KMS)
  "actions": [
    {
      "target": "0x<router>",       // allowed contract (ScopedAction.target)
      "selector": "0x38ed1739",     // allowed function (ScopedAction.selector)
      "spendingLimits": [ { "token": "0x<usdc>", "cap": "1000000000" } ],  // per-token cap (base units)
      "rollingWindowSeconds": 86400, // rolling-window for the cap
      "usageLimit": 30,             // max ops over the session
      "validUntil": 1781990000      // unix expiry
    }
  ],
  "totalExposureCap": { "token": "0x<usdc>", "cap": "5000000000" }  // Q7: aggregate across this user's sessions (backend-enforced)
}
```
On-chain (Smart Sessions) enforces per-session `spendingLimits`/time/usage (hard gate, reverts out-of-policy).
`totalExposureCap` is the **backend** cross-session aggregate (off-chain pre-check before submit).

## 3. `aa-trigger` loopback API (Node/TS ↔ Kotlin User-Service)

`aa-trigger` runs on `127.0.0.1:8090` (loopback only, not internet-exposed; the Kotlin User-Service is the
sole caller — it has already validated the user JWT). All bodies JSON.

| Method · Path | Purpose | Phase |
|---|---|---|
| `POST /v1/userop/build` | Build an **unsigned** UserOp for an action; returns the userOpHash to sign | 1 |
| `POST /v1/userop/submit` | Attach a signature + submit via Pimlico | 1 |
| `GET /v1/userop/{chainId}/{hash}` | Status / receipt | 1 |
| `POST /v1/session/trigger` | **Backend-scoped**: `aa-trigger` signs with the stored session key + submits (within limits) | 2 |
| `GET /healthz` | liveness | 1 |

```jsonc
// POST /v1/userop/build
// req:
{ "chainId": 8453, "account": "0x..", "action":
    { "kind": "dca", "tokenIn": "0x..", "tokenOut": "0x..", "amountIn": "100000000", "router": "0x..", "minOut": "0" },
  "sessionId": "uuid?" }            // sessionId for backend-scoped; omitted for on-device owner-signed DCA
// res:
{ "userOpHash": "0x..", "userOp": { /* unsigned ERC-4337 v0.7 UserOp incl. paymaster */ }, "validUntil": 1781990000 }

// POST /v1/userop/submit
// req:  { "chainId": 8453, "userOp": { /* the unsigned op from build */ }, "signature": "0x.." }
// res:  { "userOpHash": "0x..", "status": "submitted" }

// GET /v1/userop/8453/0x..
// res:  { "status": "pending" | "included" | "failed", "txHash": "0x..?" }
```

## 4. DCA on-device sign flow (Ph1 — backend signs nothing)

1. Backend **DCA scheduler** fires for user U → User-Service `POST aa-trigger /v1/userop/build` → `{userOpHash, userOp}`.
2. User-Service surfaces the pending DCA (push / next foreground) to the **app**.
3. **App signs `userOpHash` on-device** with the 7702-SCA owner key → `POST /v1/me/dca/{id}/signature` (JWT) on the User-Service.
4. User-Service → `POST aa-trigger /v1/userop/submit {userOp, signature}` → Pimlico bundler.
5. Status via `GET /v1/userop/...`. (Copy/Vaults Ph2: step 3 is `aa-trigger`'s stored session key, no app round-trip.)

## 5. Ownership / what unblocks what

- **Backend (me, Ph1):** the `aa-trigger` service (build/submit/status + Pimlico), the DCA scheduler/signal,
  the **session registry + exposure** (Postgres `V2__aa_sessions.sql`, Q7 aggregate), the **kill-switch**
  (global pause flag honored by `aa-trigger`), and the User-Service DCA endpoints (`/v1/me/dca/...`).
- **App (Dev-1/Dev-2, dispatched by PO once this contract is fixed):** the 7702 upgrade (EOA→Kernel SCA at
  the SIWE address), the Smart-Session **grant UX** (build a §2 session, sign-enable on-device), and the
  **on-device userOpHash signing** for DCA (step 3).

## 6. Deploy / supply-chain notes (PO)

- **Node runtime is a new deploy dependency** → add `node`/`npm` (brew) + the `aa-trigger` build + a
  `com.cyppie.aa-trigger` launchd plist to `bootstrap.sh` / RUNBOOK / GO-LIVE (loopback :8090).
- **npm supply-chain:** commit `package-lock.json` + run `npm audit` in CI; the AA libs are money-adjacent
  → same care as the Java sha256 pinning. Pimlico API keys = host env, never repo.
