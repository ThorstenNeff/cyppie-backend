# Vaults-B Strategy enable + scope contract (KAN-164) — for Dev-2's `StrategyGrantService` + DTO-reconcile (KAN-165)

> The owner-present, **one-time** on-chain enable for a **basket strategy session**, via the same C6-proven
> `/v1/userop/build` + `/v1/userop/submit` + EIP-7702 mechanics as the copy enable. **A strategy session is the
> M-token generalization of a copy session** — so EVERYTHING in `copy-trading-enable-submit-contract.md` applies
> verbatim (the 2-call install+enable batch, root-validator recompute, `verifyGrant`, 7702 first-op authorization,
> `/v1/userop/build|submit` shapes, the `digestToSign = hashMessage(userOpHash)` EIP-191 enable digest). This doc
> states ONLY the deltas: the scope schema and the `[M Caps, Permit2, UR]` action set Dev-2 must build + verify.
>
> 🔑 Auth ≠ Custody: the strategy `OwnableValidator` owner is the **backend session key** (so the strategy engine
> can rebalance on a schedule without the device main key), scoped by **per-token Sell-Caps + one TimeFrame window
> + UniversalRouter-scope**, revocable via `removeSession` (same as copy KAN-157).

## Byte-reference
`scripts/strategy-enable-userop-vector.mjs` — deterministic enable userOp (ETH+Base), FIXED gas/nonce. Source of
truth: `src/strategySession.ts` (`buildStrategySession` / `assembleStrategyEnableInputs` / `sortLegs`). KAT:
`strategysession.test.mjs`. The copy enable vector is the **M=1** case of this.

## (1) `/v1/strategy/session/prepare` → `StrategyEnableInputs`
Backend assembles + returns (mirrors copy `/v1/copy/session/prepare`):
```
{ sessionPublicKey, sessionValidator, sessionValidatorInitData, salt,
  userOpPolicies: [ {policy: TimeFrame, initData} ],          // [window]
  actions: [ ...M cap actions, Permit2 action, UR action ],   // see §3 — EXACT order
  erc7739Policies: {allowedERC7739Content: [], erc1271Policies: []},
  permitERC4337Paymaster: true,
  permissionId, smartSession,
  legCount }                                                  // M (count of leading cap actions)
```

## (2) Scope schema (`StrategyScope`) — what the user grants
```
chainId   : 1 | 8453 | 84532
legs      : [ { token, cap } ]   // M Sell-Caps: EVERY basket token + the budget token; cap = CUMULATIVE per-token
                                 //   limit over the whole session (NOT per-rebalance). Order-INsignificant: the
                                 //   backend canonicalizes via sortLegs (ascending lower-cased token address,
                                 //   dedup last-cap-wins). App MUST canonicalize identically before verify.
router    : UniversalRouter (ETH 0x66a9…8Af / Base 0x6fF5…b43)   // the Permit2-pulling swap router
windowStart / windowEnd : validAfter / validUntil (unix s)        // one TimeFrame window for the whole session
account   : the strategy SCA (= owner EOA, 7702 same-address) = the userOp sender
```
Execution-time inputs (target weights, per-rebalance sizes, slippage) are **NOT** in the scope — like the copy
mirror params, they shape the `execute` calldata at run time and do not change the permissionId or the enable.

## (3) The `[M Caps, Permit2, UR]` action set — what `enableSessions` carries + verify asserts
For a canonical-sorted `legs[0..M-1]`:
```
actions[0..M-1] : { actionTarget: legs[i].token,   actionTargetSelector: 0x095ea7b3 (approve),
                    actionPolicies: [ SpendingLimits([{token: legs[i].token, limit: legs[i].cap}]) ] }   // Sell-Cap
actions[M]      : { actionTarget: 0x000000000022D473030F116dDEE9F6B43aC78BA3 (Permit2),
                    actionTargetSelector: 0x87517c45 (approve), actionPolicies: [ TimeFrame(window) ] }
actions[M+1]    : { actionTarget: <UniversalRouter>, actionTargetSelector: 0x3593564c (execute),
                    actionPolicies: [ TimeFrame(window) ] }
userOpPolicies  : [ TimeFrame(window) ]
```
Single shared Permit2 + UR actions cover every leg (their target/selector is token-independent). The cap sits on
each **token's** `approve` (C3 finding: SpendingLimitsPolicy is an `IActionPolicy` that parses the ERC-20
approve/transfer on the action TARGET). Policy addresses: SpendingLimits `0x000000000033212e272655d8a22402db819477a6`,
TimeFrame `0x0000000000D30f611fA3bf652ac6879428586930`, OwnableValidator `0x000000000013fdB5234E4E3162a810F54d9f7E98`.

## (4) 🔒 `verifyStrategyEnableUserOp` (KAN-165) — what the App MUST assert before the owner signs
permissionId = `keccak(OwnableValidator, initData(sessionKey), salt)` **only** — it does NOT encode the basket,
caps, router, or window (it is identical across chains for the same session key+salt). **The grant lives entirely
in the enableSessions ACTIONS** inside the root-op callData. So `verifyStrategyEnableUserOp` must decode the
`enableSessions` calldata and assert:
1. the op is the EXACT 2-call batch (install SmartSessions on `sender` + `enableSessions` on the SmartSessions
   module), `sender == strategy SCA` (same as copy §b);
2. exactly **M cap actions** (selector `095ea7b3`), targets == the user's canonical-sorted basket tokens, each
   `SpendingLimits` limit == the per-token cap the user approved in the UI;
3. then **Permit2.approve** (`87517c45` @ Permit2) + **UR.execute** (`3593564c` @ the canonical UniversalRouter),
   each with the TimeFrame window; `userOpPolicies == [TimeFrame(window)]`;
4. NO extra/unexpected actions (no token outside the user's basket can be a cap target).
Do **not** trust the permissionId to bind the grant — verify the actions. Then recompute `userOpHash` byte-exact
(copy §c) and bind the owner signature to `digestToSign = hashMessage(userOpHash)` (EIP-191, root-validator path).

## (5) Open (for the USE-mode rebalance, not this enable)
The recurring rebalance BUY (engine-driven, USE-mode through the session) is the copy UniversalRouter mirror, per
leg — backend-signed by the scoped session key over the **RAW userOpHash** (the C3 USE-lock, like the DCA buy). A
separate strategy-BUY userOp vector follows when the engine + KAN-165 USE path land (KAN-164 scheduler increment).
