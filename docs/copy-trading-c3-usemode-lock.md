# Copy-Trading C3 — USE-mode-Sign-LOCK + on-chain Mirror-Receipt (KAN-149)

> The money-path gate for PRD-06 Copy-Trading, analog zum DCA-Inc.3-Beweis. A **backend-held, scoped session
> key** signs a USE-mode mirror UserOp through a Smart Session and lands a **real sponsored receipt on Base
> Sepolia** (Kernel 7702, EntryPoint v0.7, `sp_next_micromax`). Harness: `aa-trigger/c3-usemode-lock.mjs`
> (`AA_ALLOW_TESTNET=1 RUN_SEND=1 [POLICY=sudo|prod] node --env-file=../.env c3-usemode-lock.mjs`).

## Proof (on-chain, Base Sepolia)

| Layout | op2 USE-mode mirror (session-key-signed) — Base Sepolia |
|---|---|
| `sudo` (Sudo policies — isolates the lock) | **`0x877f603afaca03dbaf62134608bd270a0e5ba93fc05757a40bfc1bd05de74a4b`** ✓ blk 43083007 |
| `prod` (TimeFrame userOp + SpendingLimits on token transfer) | **`0xb410b43b0bbb97bc2fce719aec65446600cbb8e3ffd7f564cbd96bc66c138903`** ✓ blk 43083056 |
| `dca`  (two-action: SpendingLimits on token **approve** + time-boxed swap) | **`0xc19e5e42811b701941375ebe8bfab3091a515fb4b17736b81f1a67e67e9db63d`** ✓ blk 43083468 |

Each run uses a FRESH follower owner EOA + a FRESH backend session key. The session key is the ONLY signer of
op2 — the owner/main key never signs the mirror (Auth ≠ Custody). op1 (install Smart Sessions + enable the
scoped session) is the one-time owner consent; in production that enable is the app's owner-signed ENABLE
(verifyGrant), here it is an equivalent owner-authorized `enableSessions` call — op2's session-key path is
identical either way.

## 🔒 The LOCK — which digest the session key signs

**The backend session signer signs the RAW `userOpHash`** (no transform), wrapped as a threshold-1
OwnableValidator signature and packed USE-mode (`0x00 ‖ permissionId ‖ ownableSig`).

- This is the **inverse of DCA**: the Kernel ROOT validator recovers the **EIP-191** `hashMessage(userOpHash)`
  (`userop.ts` `digestToSign`); the OwnableValidator **session**-validator recovers the **raw** `userOpHash`.
- Proven two ways: (1) gas-free against the deployed OwnableValidator `validateSignatureWithData` — it
  recovers raw, no internal EIP-191; (2) end-to-end with the receipts above.
- Codified: `copySession.ts` `buildUseModeUserOpSignature(signer, userOpHash, permissionId)` + KAT in
  `copysession.test.mjs` (recovers the session key over raw, NOT over EIP-191). The signer is the C1
  `SessionKeySigner` (EIP-2 low-S), so the YubiHSM2 drop-in is unchanged.

## Policy placement — correctness fix for BOTH copy AND DCA (on-chain finding)

The `SpendingLimitsPolicy` implements **only `IActionPolicy`** AND its `checkAction(id, account, target, value,
callData)` parses an **ERC-20 transfer/approve on the action TARGET (the token)** — `getPolicyData` returns
`spendingLimit / alreadySpent / approvedAmount`. Two consequences, both proven on-chain:

1. It is **rejected in the `userOpPolicies` slot** (`UnsupportedPolicy 0x6a01dd01`) — where the original copy
   `assembleEnableInputs` **and** the DCA enable-vectors (B/C/D) put it.
2. On a **non-token action** (a DEX router multicall, or `WETH.deposit()`) it reverts at USE with
   `PolicyViolation 0x3b577361` — so it cannot cap a router swap directly.

**Correct shape (copy + DCA), proven on-chain (enable + USE receipts):**
- **`userOpPolicies` = [TimeFrame]** (the window; `IUserOpPolicy`).
- **two actions:** `token.approve` → **[SpendingLimits cap]** (caps what the router can pull = the account's
  own spend authorization; cumulative cap = total budget, N3) **+** `router.swap` → **[TimeFrame]** (time-boxed).

Applied to `assembleEnableInputs` (`copySession.ts`) and the DCA enable-vectors (`scripts/enable-vector.mjs`
B/C/D, regenerated — Vector D digests changed; permissionId stable since it depends only on validator+salt).
The DCA-enable-spec (`smart-sessions-enable-spec.md` PIN#4) cap-placement is corrected the same way → KAN-150
(app-side fix Dev-1/Dev-2). `prod` (cap on token transfer) and `dca` (cap on token approve + swap) receipts both
land; the cap is actively enforced (PolicyViolation on a non-matching call).

## Kernel v3.3 integration gotchas (for C4 — the `/v1/session/trigger` USE path)

The USE op must be assembled by hand (permissionless does not route to a non-root validator). Pins:

1. **Validator-nonce key (uint192):** `[1B mode 0x00][1B vtype 0x01 VALIDATOR][20B SmartSessions][2B nonceKey]`.
   `vtype` MUST be `0x01` — module-sdk's `encodeValidatorNonce` emits `0x00` (routes to the root ECDSA
   validator → `InvalidSignature 0x8baa579f`). Helper: `smartSessionUseModeNonceKey()`.
2. **Read the nonce from the EntryPoint** (`getNonce(sender, key)`) — permissionless's
   `to7702KernelSmartAccount.getNonce({key})` ignores the key.
3. **Install SmartSessions with `selectorData` granting the Kernel `execute` selector** (`0xe9ae5c53`) and
   **hook = `address(1)`** (the "no-hook" sentinel); else `InvalidValidator 0x682a6e7c`. Kernel 3.3 install
   initData = `abi.encodePacked(hook, abi.encode(validatorData, hookData, selectorData))` (3 fields; module-sdk
   emits the 2-field 3.0 layout).
4. **Gas:** the session-validator hard-reverts on a non-matching signature, so mock-signature gas estimation is
   unusable — use explicit generous gas (sponsored ⇒ free) and the real session signature; the prepared op
   carries valid sponsored paymaster data.

## Status

C1 ✅ · C2 ✅ (+ policy fix) · **C3 ✅ (USE-mode-LOCK + 2 mirror receipts)**. Next: C4 `/v1/session/trigger`
(reuse SubmitGate/Kill-Switch/Q7 + `buildUseModeUserOpSignature` + the nonce/install pins above), C5 Alchemy
webhook detection, C6 integration.
