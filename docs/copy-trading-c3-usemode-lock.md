# Copy-Trading C3 — USE-mode-Sign-LOCK + on-chain Mirror-Receipt (KAN-149)

> The money-path gate for PRD-06 Copy-Trading, analog zum DCA-Inc.3-Beweis. A **backend-held, scoped session
> key** signs a USE-mode mirror UserOp through a Smart Session and lands a **real sponsored receipt on Base
> Sepolia** (Kernel 7702, EntryPoint v0.7, `sp_next_micromax`). Harness: `aa-trigger/c3-usemode-lock.mjs`
> (`AA_ALLOW_TESTNET=1 RUN_SEND=1 [POLICY=sudo|prod] node --env-file=../.env c3-usemode-lock.mjs`).

## Proof (on-chain, Base Sepolia)

| Layout | op1 install+enable (owner-signed) | op2 USE-mode mirror (session-key-signed) |
|---|---|---|
| `sudo`  (isolates the lock) | `0x924c6853…f43bf4` ✓ | **`0x877f603afaca03dbaf62134608bd270a0e5ba93fc05757a40bfc1bd05de74a4b`** ✓ blk 43083007 |
| `prod`  (real copy scope)   | `0x8c9351fb…2f42` ✓   | **`0xb410b43b0bbb97bc2fce719aec65446600cbb8e3ffd7f564cbd96bc66c138903`** ✓ blk 43083056 |

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

## Policy placement — C2 correctness fix (on-chain finding)

The `SpendingLimitsPolicy` implements **only `IActionPolicy`** → SmartSession rejects it in the `userOpPolicies`
slot (`UnsupportedPolicy 0x6a01dd01`). Corrected in `assembleEnableInputs` (`copySession.ts`):

- **`userOpPolicies` = [TimeFrame]** (window; `IUserOpPolicy`).
- **action `[router+selector]` policies = [SpendingLimits]** (the cumulative cap = total budget, N3; `IActionPolicy`).

Both placements enable + USE-validate on-chain (the `prod` receipt). The cap is actively enforced (a
non-matching call reverts `PolicyViolation 0x3b577361`). The DCA enable-spec (`smart-sessions-enable-spec.md`
PIN#4 / Vector D) put SpendingLimits as a userOpPolicy — that is digest-valid but **on-chain-invalid**; the
app-built enable for copy (and DCA, if it adds a spend cap) must use the action-policy placement.

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
