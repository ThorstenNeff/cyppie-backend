import {
  getOwnableValidator, getSpendingLimitsPolicy, getTimeFramePolicy, getPermissionId,
  SMART_SESSIONS_ADDRESS,
} from "@rhinestone/module-sdk";
import { type Address, type Hex } from "viem";
import {
  PERMIT2_ADDRESS, APPROVE_SELECTOR, PERMIT2_APPROVE_SELECTOR, UNIVERSAL_ROUTER_EXECUTE_SELECTOR,
} from "./swapAdapter.js";
import type { SupportedChainId } from "./addresses.js";

/**
 * Vaults-B Strategy session (KAN-164 / PRD-07) — a backend-held, scoped, revocable Smart-Session that lets the
 * strategy engine rebalance a BASKET of M tokens through the UniversalRouter on a schedule, without the device
 * main key. It is the **M-token generalization of the copy session** ({@link buildSession}): a copy session is
 * the M=1 special case (one sell-token cap + Permit2 + UR). Same module/policy/selector machinery, so Dev-2's
 * verify reuses the copy primitives.
 *
 * 🔑 Auth ≠ Custody: the OwnableValidator owner is the BACKEND session key (NOT the device main key). The hard
 * on-chain bounds are: a per-token CUMULATIVE SpendingLimits CAP on every sell-able token (each basket member +
 * the budget token) — so the engine can never pull more than the user granted per token — plus one TimeFrame
 * window, plus router-scope to the UniversalRouter `execute`. Revocable via removeSession (same as copy).
 *
 * 🧩 Action layout — pinned with the PO as `[M Caps, Permit2, UR]`:
 *   actions[0..M-1] = tokenᵢ.approve(095ea7b3) → [SpendingLimits cap_i]   (one Sell-Cap per sell-able token)
 *   actions[M]      = Permit2.approve(87517c45) → [TimeFrame window]       (single shared allowance grant)
 *   actions[M+1]    = UniversalRouter.execute(3593564c) → [TimeFrame]      (single shared, time-boxed swap)
 *   userOpPolicies  = [TimeFrame window]
 * The cap sits on each token's `approve` (the C3 finding: SpendingLimitsPolicy is an IActionPolicy that parses
 * the ERC-20 approve/transfer on the action TARGET = the token). Permit2 + UR are single shared actions because
 * their (target, selector) is token-independent — one each covers every basket leg. This is exactly the copy
 * 3-action shape with the single cap action fanned out to M.
 */

/** One sell-able token in the basket (or the budget token) + its CUMULATIVE spend cap over the session. */
export interface StrategyLeg {
  token: Address; // a sell-able ERC-20 (basket member or the budget token)
  cap: bigint;    // CUMULATIVE SpendingLimits cap for THIS token over the whole session (not per-trade)
}

/**
 * The on-chain scope of a strategy session — the part that determines the permissionId / enable digest. The
 * `legs` ORDER is significant (it fixes the action order, hence the permissionId), so it must be canonicalized
 * before assembly (see {@link sortLegs}). Execution-time inputs (target weights, slippage, per-rebalance sizes)
 * are NOT here: like the copy mirror params, they shape the `execute` calldata at run time and do NOT change the
 * permissionId.
 */
export interface StrategyScope {
  chainId: SupportedChainId;
  legs: StrategyLeg[];   // M sell-caps: every basket token + the budget token, canonical-ordered
  router: Address;       // UniversalRouter (the Permit2-pulling swap router)
  windowStart: number;   // validAfter (unix s)
  windowEnd: number;     // validUntil (unix s)
  account: Address;      // the strategy SCA (= owner EOA, 7702 same-address) — the sender
}

/** The ENABLE inputs the app builds the Strategy Smart-Session enable from (mirrors copy `EnableInputs`). */
export interface StrategyEnableInputs {
  sessionPublicKey: Address; // the backend session key — owners[0] in the OwnableValidator
  sessionValidator: Address;
  sessionValidatorInitData: Hex;
  salt: Hex;
  userOpPolicies: { policy: Address; initData: Hex }[]; // [TimeFrame window]
  actions: { actionTargetSelector: Hex; actionTarget: Address; actionPolicies: { policy: Address; initData: Hex }[] }[]; // [M caps, Permit2, UR]
  erc7739Policies: { allowedERC7739Content: never[]; erc1271Policies: never[] };
  permitERC4337Paymaster: true;
  permissionId: Hex;
  smartSession: Address;
  legCount: number; // M — how many leading cap actions (the rest are Permit2 + UR)
}

/**
 * Canonical leg order: ascending by lower-cased token address, deduped (last-cap-wins on a duplicate token). The
 * permissionId depends on the action order, so the app and the backend MUST canonicalize identically — sorting by
 * address is order-independent of how the user listed the basket.
 */
export function sortLegs(legs: StrategyLeg[]): StrategyLeg[] {
  const byToken = new Map<string, StrategyLeg>();
  for (const leg of legs) byToken.set(leg.token.toLowerCase(), { token: leg.token, cap: leg.cap });
  return [...byToken.values()].sort((a, b) => (a.token.toLowerCase() < b.token.toLowerCase() ? -1 : 1));
}

/**
 * The module-sdk `Session` for a strategy scope — the SINGLE definition (permissionId + app enable digest +
 * enableSessions data all derive from this). Actions are `[M caps, Permit2, UR]` (see file header).
 */
export function buildStrategySession(sessionPublicKey: Address, salt: Hex, scope: StrategyScope) {
  if (scope.legs.length === 0) throw new Error("strategy needs at least one sell-cap leg");
  const ov = getOwnableValidator({ threshold: 1, owners: [sessionPublicKey] });
  const time = getTimeFramePolicy({ validAfter: scope.windowStart, validUntil: scope.windowEnd });
  const timePolicy = { policy: time.policy as Address, initData: time.initData as Hex };
  const legs = sortLegs(scope.legs);

  // [M Caps] — one SpendingLimits cap action per sell-able token, on its `approve`.
  const capActions = legs.map((leg) => {
    const spend = getSpendingLimitsPolicy([{ token: leg.token, limit: leg.cap }]);
    return {
      actionTargetSelector: APPROVE_SELECTOR,
      actionTarget: leg.token,
      actionPolicies: [{ policy: spend.policy as Address, initData: spend.initData as Hex }],
    };
  });
  // [Permit2, UR] — single shared, time-boxed actions (token-independent).
  const sharedActions = [
    { actionTargetSelector: PERMIT2_APPROVE_SELECTOR, actionTarget: PERMIT2_ADDRESS, actionPolicies: [timePolicy] },
    { actionTargetSelector: UNIVERSAL_ROUTER_EXECUTE_SELECTOR, actionTarget: scope.router, actionPolicies: [timePolicy] },
  ];

  return {
    sessionValidator: ov.address as Address,
    sessionValidatorInitData: ov.initData as Hex,
    salt,
    userOpPolicies: [timePolicy],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: [...capActions, ...sharedActions],
    permitERC4337Paymaster: true as const,
    chainId: BigInt(scope.chainId),
  };
}

/** Assemble the canonical Strategy ENABLE inputs (pure; the byte-exact target for the app + Dev-2's verify). */
export function assembleStrategyEnableInputs(sessionPublicKey: Address, salt: Hex, scope: StrategyScope): StrategyEnableInputs {
  const session = buildStrategySession(sessionPublicKey, salt, scope);
  const permissionId = getPermissionId({ session }) as Hex;
  return {
    sessionPublicKey,
    sessionValidator: session.sessionValidator,
    sessionValidatorInitData: session.sessionValidatorInitData,
    salt,
    userOpPolicies: session.userOpPolicies,
    actions: session.actions,
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    permitERC4337Paymaster: true,
    permissionId,
    smartSession: SMART_SESSIONS_ADDRESS as Address,
    legCount: sortLegs(scope.legs).length,
  };
}
