# Copy-Trading enable-submit contract (KAN-156 P1-4 / GAP-B, approach B) — for Dev-2's `FollowGrantService`

> The owner-present, **one-time** on-chain enable for a copy session, via the EXISTING, C6-proven `/v1/userop/build`
> + `/v1/userop/submit`. The enable userOp runs through the **Kernel ROOT validator** (full owner authority), so the
> App MUST recompute the `userOpHash` on-device, bind its signature to it, and `verifyGrant` the calldata BEFORE the
> owner signs — never blind-sign a root op. No smart-session ENABLE-mode; no separately-stored enable signature.

## Flow
1. Backend `/v1/copy/session/prepare` → returns the `EnableInputs` (session pubkey, validator, initData, salt,
   userOpPolicies, **actions**, permissionId, smartSession). *(unchanged)*
2. App builds the two enable calls (below), calls **`/v1/userop/build`** with them → gets the sponsored unsigned
   `userOp` + `userOpHash` + `digestToSign` + (first op) `authorizationToSign`.
3. App **recomputes** `userOpHash` on-device from the returned `userOp` (byte-exact, §c) and asserts it == the
   returned `userOpHash`; **`verifyGrant`** the `enableSessions` calldata decodes to the expected `permissionId`
   (§b); asserts the op has EXACTLY these two calls and `sender == follower SCA`.
4. Owner raw-signs `digestToSign` via `AaSigner` (§d). First op: also sign `authorizationToSign` (EIP-7702).
5. App → **`/v1/userop/submit`** (userOp + signature + first-op authorization) → backend relays to Pimlico.
6. App polls the receipt; on success → `POST /v1/copy/session/grant {permissionId}` (marks the session active).

## (a) `/v1/userop/build` contract  (`src/userop.ts` `buildUserOp` / `src/server.ts`)
**Request** `POST /v1/userop/build` (loopback): `{ chainId: number, owner: <follower EOA = SCA, 7702 same-addr>, calls: [{ to, value?: "0x..", data }] }`.
**Response** `BuiltUserOp`:
- `userOp`: a serialized v0.7 UserOperation — fields as hex strings: `sender, nonce, factory?, factoryData?, callData, callGasLimit, verificationGasLimit, preVerificationGas, maxFeePerGas, maxPriorityFeePerGas, paymaster?, paymasterVerificationGasLimit?, paymasterPostOpGasLimit?, paymasterData?`. It is **final** (gas estimated + Pimlico paymaster applied), so `userOpHash` is stable — submit it **verbatim**.
- `userOpHash`: `0x…32` — what the owner authorizes.
- `digestToSign`: `= hashMessage({ raw: userOpHash })` (EIP-191) — the 32 bytes the owner RAW-signs (§d).
- `authorizationToSign?`: present only when the SCA isn't yet 7702-upgraded — `{ chainId, address: <Kernel impl>, nonce }`. Sign it as an EIP-7702 authorization and pass it on the FIRST op.

## (b) `userOp.callData` = two self-calls (install + enable)  — what `verifyGrant` decodes
The Kernel `callData` is the account's batch-execute of EXACTLY these two calls (both `to = sender = follower SCA`):
1. **installModule** — `installModule(uint256 moduleTypeId=1, address module=SMART_SESSIONS_ADDRESS, bytes initData)`
   where, for **Kernel v3.3**, `initData = abi.encodePacked(hook, abi.encode(validatorData, hookData, selectorData))`:
   - `hook = 0x0000000000000000000000000000000000000001` (no-hook sentinel)
   - `validatorData = getSmartSessionsValidator({}).initData`
   - `hookData = 0x`
   - `selectorData = 0xe9ae5c53` (grants the SmartSessions validator the Kernel `execute` selector — without it Kernel rejects it `InvalidValidator 0x682a6e7c`)
   *(Kernel emits the 3-field layout; module-sdk's `encodeModuleInstallationData` emits the 2-field v3.0 layout — do NOT use it here.)*
2. **enableSessions** — `getEnableSessionsAction({ sessions: [session] })` → `{ to: SMART_SESSIONS_ADDRESS, callData }`.
   The `session` is built byte-exactly by the backend `buildSession(sessionPubkey, salt, scope)` =
   `assembleEnableInputs` fields: `{ sessionValidator, sessionValidatorInitData, salt, userOpPolicies, erc7739Policies, actions, permitERC4337Paymaster: true }`. **`verifyGrant`** decodes the `enableSessions` arg and recomputes
   `getPermissionId({ session })` → MUST equal the prepared `permissionId`. The `actions` are the **adapter-driven
   3-action UniversalRouter shape** (KAN-154): `token.approve→SpendingLimits`, `Permit2.approve(0x87517c45)→TimeFrame`,
   `router.execute(0x3593564c)→TimeFrame` (Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`). Pin the same
   `(target,selector)` set the backend `requiredActions` produces — see `scripts/copy-vector.mjs`.

## (c) `userOpHash` recompute (the security-critical part)
EntryPoint **v0.7**, address `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. Compute exactly as viem's
`getUserOperationHash({ userOperation, entryPointAddress, entryPointVersion: "0.7", chainId })`:
`userOpHash = keccak256(abi.encode(keccak256(packedUserOp), entryPoint, chainId))` over the v0.7 **PackedUserOperation**
(packed `accountGasLimits = verificationGasLimit‖callGasLimit`, `gasFees = maxPriorityFeePerGas‖maxFeePerGas`,
`paymasterAndData = paymaster‖paymasterVerificationGasLimit‖paymasterPostOpGasLimit‖paymasterData`, and the hashed
`initCode`/`callData`/`paymasterAndData`). The App recomputes this from the returned `userOp` and asserts equality
before signing — so a tampered op can't be blind-signed. (The 7702 `authorization` is NOT part of the userOpHash.)

## (d) digest + signing — confirm
- `digestToSign = hashMessage({ raw: userOpHash })` (EIP-191 personal-sign of the 32-byte hash). **Confirmed** —
  this is the Kernel-root/ECDSA validator's digest (the same `digestToSign` Dev-2 already uses from `src/userop.ts`
  for DCA; the copy USE-mode raw-userOpHash path is a *different*, session-key path — do not cross-wire).
- The owner raw-secp256k1-signs `digestToSign` → 65-byte `r‖s‖v`; that IS the final `userOp.signature` (Kernel root
  adds no envelope — `wrapKernelSignature` is a passthrough). EIP-2 low-S applies (AaSigner already enforces).

## Deterministic reference vector (`scripts/enable-userop-vector.mjs`) — pin against these
Run `node scripts/enable-userop-vector.mjs` — it emits, for the canonical scope (same inputs as `copy-vector.mjs`),
the real install+enableSessions `callData` (via permissionless `encodeCalls` = production bytes), the full v0.7
PackedUserOperation fields, `userOpHash`, and `digestToSign`, with FIXED gas/nonce so the hash is reproducible.
Dev-2's `verifyEnableUserOp` recompute must hit these byte-exact; at runtime it feeds the ACTUAL `/v1/userop/build`
fields through the same packing/hashing. Canonical results (EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032`,
`sender=0xf39F…2266`, `nonce=0`, no factory, `permissionId=0x1c3f76fac3f146c12a665114ff61d6d257653434d854ecb3570c6b2c32e96b55`):
- **callData** starts `0xe9ae5c53…` (Kernel `execute` batch of the two calls) — full bytes in the script output.
- **accountGasLimits** `0x…0016e360…000927c0` (verif 1_500_000 ‖ call 600_000); **gasFees** `0x…3b9aca00…3b9aca00`
  (1 gwei ‖ 1 gwei); **paymasterAndData** `0x0000000000000039cd5e8aE05257CE51C473ddd1 ‖ 00061a80 ‖ 000186a0` (fixed placeholder pm).
- **ETH(1):** `userOpHash 0xc4d1510e7efadce1ca010db75fe501d2ae685f14b8c27c4fe364ed1d0170dfe9` · `digestToSign 0xe7d07e62aba236625113c51e2c9b24b7cda6ff8d23157f3ae9f9d793e1e4e118`
- **Base(8453):** `userOpHash 0x7fa6707b20e07e1ed55c1fa9f4eb5893efb46497b8f007c198b28ea6a928c194` · `digestToSign 0x1af0767764637fc2ba38cae9b0a72a85951ac1d1a952ead6dd58f23e2105c415`

## Backend guarantees / asks
- `/v1/userop/build` builds + sponsors + returns the stable hash for ARBITRARY `calls` — no copy-specific endpoint
  needed. The App constructs the two calls (§b); the backend does not interpret them.
- **App MUST assert** (the build endpoint is generic): the op has exactly the install+enableSessions calls, nothing
  else, and `sender == follower SCA`. (Backend-side: the existing `/v1/userop/build` is loopback + per-the-owner;
  it does not add calls.)
- After a successful enable receipt, `POST /v1/copy/session/grant {permissionId}` flips the session to `granted`
  (no signature body — approach B).
