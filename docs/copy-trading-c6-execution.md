# Copy-Trading C6 — money-execution (swap adapter + gated submit + webhook→receipt E2E) · KAN-149

> C6 turns C5's detected, scaled, gated mirror PLANS into **submitted on-chain mirror swaps**. Proven E2E on
> Base Sepolia: a real HMAC-signed Alchemy webhook → the production `/v1/copy/webhook` handler → swap-calldata
> adapter → `submitMirror` (USE-mode) → a real sponsored **mirror receipt**.

## What ships

### 1. Per-router swap-calldata adapter (`src/swapAdapter.ts`)
`buildMirrorCalls(plan)` builds the follower SCA's `Call[]` for a scaled mirror. Uniswap **UniversalRouter** (the
C5-allowlisted router) pulls funds via **Permit2**, so a mirror is THREE calls, in the exact scope-action order:
1. `tokenIn.approve(PERMIT2, amountIn)` — the **SpendingLimits CAP** action (C3 finding: the cap sits on the
   ERC-20 approve, target = token).
2. `PERMIT2.approve(tokenIn, router, amountIn, expiration)` — the router's Permit2 allowance.
3. `router.execute([V3_SWAP_EXACT_IN], [input], deadline)` — the time-boxed swap; input =
   `abi.encode(recipient=MSG_SENDER, amountIn, amountOutMin, path=tokenIn‖fee‖tokenOut, payerIsUser=true)`.

The adapter is the **single source of truth** for both the calls AND the actions the session must enable
(`requiredActions`): `assembleEnableInputs` is now adapter-driven, so the session enables exactly the
(target, selector)s the backend later submits — a "submit a call the session didn't enable" mismatch is
impossible by construction. An unregistered router is fail-closed (no blind mirror). Byte-correctness is
KAT-locked in `swapadapter.test.mjs` (no network needed — independent of testnet liquidity).

### 2. Gated submit wiring (`/v1/copy/webhook`, `src/server.ts`)
The webhook now (per detected spend × following session): scale → **SubmitGate** (`assertMirrorable`:
kill-switch / Q7 exposure / idempotency) → `buildMirrorCalls` → `submitMirror` (USE-mode, the backend session
key) → `recordMirror` (Q7 + idempotency). Each mirror is **fail-closed and independent** — one bad mirror never
sinks the batch; the response lists each as `submitted` / `gated` / `skipped` / `error`.

**Slippage is fail-closed** (`minOutFor`): Base Sepolia (no MEV) allows a 0 floor; **mainnet requires a
quote-derived `amountOutMin`** (QuoterV2 × `slippageBps`) which is **not yet wired**, so mainnet mirrors are
SKIPPED rather than submitted with no slippage protection. → **Follow-up: wire the QuoterV2 slippage floor to
unblock mainnet.**

### 3. E2E proof (`c6-e2e.mjs`, Base Sepolia)
Drives the **real production `handle`** in-process: prepare → on-chain enable (owner-present install +
enableSessions) → grant → **HMAC webhook → parse → fan-out → gate → adapter → submitMirror → real mirror
receipt** → record; then bad-HMAC→401, idempotent-replay→gated, kill-switch→no-mirror. `C6 E2E ALL PASS ✓`.

Liquidity boundary (documented, like the parked mainnet-Pimlico top-up): a fresh sponsored testnet SCA has no
DEX liquidity, so the **receipt** leg uses a no-code test router (test-only adapter → a safe `approve(0)`); the
real UniversalRouter swap-calldata bytes are KAT-proven separately. A real-liquidity testnet swap needs a funded
account + a live pool.

## ENABLE-mode-on-first-use — finding (NOT shipped; fast-follow)

The PO's ENABLE-mode-on-first-use (fold the session enable into the first mirror via the owner's off-chain
signature, so no separate owner enable tx) was driven on-chain in `c6-enable-probe.mjs`. Architecture **fully
mapped**:
1. Setup must install **SmartSessions + an `OwnableValidator(owner)`** as a real Kernel validator.
2. `enableValidatorAddress` = the installed `OwnableValidator(owner)` → routing reaches the enable-sig check
   (error moves from Kernel `InvalidValidator 0x682a6e7c` → SmartSession `InvalidEnableSignature 0x3ca8ef0c`).
3. `permissionEnableHash` from `getEnableSessionDetails` is correct (matches the error's hash).

**Last mile:** the owner enable-sig must be the OwnableValidator's **ERC-7739 nested digest** (a raw / EIP-191
sig over `permissionEnableHash` recovers the wrong address), and `eip712Domain()` **reverts** on the validator,
so the 7739 domain isn't discoverable without the validator source. Per money-path discipline (don't ship
unproven money code), `submitMirror` stays **USE-mode** (enable at the owner-present grant — C3/C4-proven). The
security posture is identical either way (scoped/capped/revocable session + owner consent); ENABLE-on-first-use
is an owner-UX optimization. → **Fast-follow: nail the ERC-7739 enable-sig digest (validator source / 7739
domain), then flip `submitMirror` to `encodeUseOrEnableSmartSessionSignature`.**

## On-chain proof (Base Sepolia, EntryPoint v0.7, sp_next_micromax)
- enable (install+enableSessions): `0x33d0a2785fe527f742fe35aca3080079e86e23c79114a21beaf9ab5c5aa6331e`
- webhook-driven mirror RECEIPT: `0xb7b592af68212f22e154a496d91499cbe76cf2a3e944cc99ebb71fc3ecf94238` (success)

## Tests / harnesses
- `swapadapter.test.mjs` — adapter byte-correctness KAT (UniversalRouter V3 exact-in + Permit2, 3-call shape, path/fee/recipient/payerIsUser, fail-closed router).
- `copysession.test.mjs` — C2 now asserts the adapter-driven 3-action shape (token.approve cap / Permit2.approve / router.execute).
- `c6-e2e.mjs` — the full webhook→receipt E2E (on-chain).
- `c6-enable-probe.mjs` — the ENABLE-mode-on-first-use research probe (the finding above).

Status: C1 ✅ · C2 ✅ · C3 ✅ · C4 ✅ · C5 ✅ · **C6 ✅ (swap adapter + gated submit + webhook→receipt E2E)**.
Fast-follows: (a) QuoterV2 slippage floor → mainnet mirrors; (b) ERC-7739 enable-sig → ENABLE-mode-on-first-use;
(c) real-liquidity testnet swap (funded account + pool).
