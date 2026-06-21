import { encodeFunctionData, encodePacked, encodeAbiParameters, parseAbi, getAddress, type Address, type Hex } from "viem";
import type { Call } from "./userop.js";

/**
 * Copy-Trading per-router swap-calldata adapter (PRD-06 / KAN-149 C6).
 *
 * Turns a scaled mirror plan into the follower SCA's `Call[]` that the on-chain Smart-Session policies accept.
 * Router-specific (the calldata + the spender that pulls funds differ per DEX). Pure + deterministic — the byte
 * encoding is KAT-locked (swapadapter.test.mjs), so a wrong-bytes regression is caught without on-chain spend.
 *
 * 🔑 Auth ≠ Custody: these calls are signed by the BACKEND session key (USE/ENABLE-mode), bounded by the
 * on-chain action policies — the spend cap sits on the ERC-20 `approve` (C3 finding: SpendingLimitsPolicy parses
 * the approve/transfer on the TOKEN target). The adapter therefore ALWAYS emits an `approve` to the puller +
 * the router swap, in the exact (target, selector) shape the session was enabled for.
 */

/** Uniswap Permit2 (canonical CREATE2 address, identical on every chain). The UniversalRouter pulls via Permit2. */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** UniversalRouter command bytes (one per op). V3_SWAP_EXACT_IN = 0x00. */
const CMD_V3_SWAP_EXACT_IN = "0x00";
/** UniversalRouter recipient sentinel: MSG_SENDER (the SCA itself receives the output). */
const RECIPIENT_MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";

const ERC20_APPROVE = parseAbi(["function approve(address spender, uint256 amount)"]);
const PERMIT2_APPROVE = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const UNIVERSAL_ROUTER_EXECUTE = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

/** Selectors the adapter emits — also the (action target) selectors the session scope must enable. */
export const APPROVE_SELECTOR: Hex = "0x095ea7b3"; // ERC-20 approve(address,uint256)
export const PERMIT2_APPROVE_SELECTOR: Hex = "0x87517c45"; // Permit2 approve(address,address,uint160,uint48)
export const UNIVERSAL_ROUTER_EXECUTE_SELECTOR: Hex = "0x3593564c"; // execute(bytes,bytes[],uint256)

/**
 * A scaled mirror to encode: the follower copies the source's input leg (`tokenIn`/`amountIn`, already scaled +
 * cap-clamped by {@link scaleMirror}) into `tokenOut` on `router`. `tokenOut`/`feeTier`/`amountOutMin` are the
 * copy-direction + slippage decision (carried by the strategy layer, not derivable from the input leg alone).
 */
export interface MirrorPlan {
  chainId: number;
  router: Address;       // the allowlisted DEX router (UniversalRouter)
  tokenIn: Address;      // the spent ERC-20 (= source input leg)
  tokenOut: Address;     // what the follower buys (copy-direction)
  amountIn: bigint;      // scaled, cap-clamped mirror size
  amountOutMin: bigint;  // slippage floor (0 only acceptable in tests)
  feeTier: number;       // Uniswap V3 pool fee (e.g. 500 / 3000 / 10000)
  recipient?: Address;   // default MSG_SENDER (the SCA)
  deadline: bigint;      // swap deadline (unix s)
  permit2Expiration?: number; // Permit2 allowance expiry (unix s); default = deadline
}

/** The on-chain policy bound to a scope action: `cap` = SpendingLimits (the spend budget), `window` = TimeFrame. */
export type PolicyKind = "cap" | "window";

/** One Smart-Session action the scope must enable: a (target, selector) the mirror calls, + its policy kind. */
export interface RequiredAction {
  actionTarget: Address;
  actionTargetSelector: Hex;
  policy: PolicyKind;
}

/** A per-router calldata builder. Keyed by the (lower-cased) router address so each DEX can differ. */
export interface SwapAdapter {
  /** Build the follower's mirror calls for this plan (approve(s) + the router swap), in scope-action order. */
  buildMirrorCalls(plan: MirrorPlan): Call[];
  /**
   * The Smart-Session actions this adapter's calls touch — the SINGLE source of truth for what the session must
   * enable. `assembleEnableInputs` enables exactly these, so a "submit a call the session didn't enable" mismatch
   * is impossible by construction (same target/selector set in both directions).
   */
  requiredActions(scope: { token: Address; router: Address }): RequiredAction[];
}

/**
 * Encode a Uniswap UniversalRouter V3 exact-in swap path: tokenIn ‖ fee(uint24) ‖ tokenOut (packed, 43 bytes).
 */
export function encodeV3Path(tokenIn: Address, feeTier: number, tokenOut: Address): Hex {
  return encodePacked(["address", "uint24", "address"], [getAddress(tokenIn), feeTier, getAddress(tokenOut)]);
}

/**
 * Uniswap UniversalRouter adapter (Q-C: allowlisted first). The router pulls funds via Permit2, so a mirror is
 * THREE calls in scope order:
 *   1. tokenIn.approve(PERMIT2, amountIn)                       — the SpendingLimits CAP action (target=token)
 *   2. PERMIT2.approve(tokenIn, router, amountIn, expiration)   — grant the router the Permit2 allowance
 *   3. router.execute([V3_SWAP_EXACT_IN], [input], deadline)    — the scoped, time-boxed swap action
 * The V3_SWAP_EXACT_IN input = abi.encode(recipient, amountIn, amountOutMin, path, payerIsUser=true).
 */
export const universalRouterAdapter: SwapAdapter = {
  buildMirrorCalls(plan: MirrorPlan): Call[] {
    const recipient = plan.recipient ?? RECIPIENT_MSG_SENDER;
    const expiration = plan.permit2Expiration ?? Number(plan.deadline);
    if (plan.amountIn <= 0n) throw new Error("mirror amountIn must be > 0");
    if (plan.amountIn > 0xffffffffffffffffffffffffffffffffffffffffn) throw new Error("amountIn exceeds Permit2 uint160");

    const path = encodeV3Path(plan.tokenIn, plan.feeTier, plan.tokenOut);
    const swapInput = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
      [recipient, plan.amountIn, plan.amountOutMin, path, true], // payerIsUser=true → the SCA pays via Permit2
    );
    const executeData = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_EXECUTE,
      functionName: "execute",
      args: [CMD_V3_SWAP_EXACT_IN, [swapInput], plan.deadline],
    });

    return [
      { to: getAddress(plan.tokenIn), value: 0n, data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [PERMIT2_ADDRESS, plan.amountIn] }) },
      { to: PERMIT2_ADDRESS, value: 0n, data: encodeFunctionData({ abi: PERMIT2_APPROVE, functionName: "approve", args: [getAddress(plan.tokenIn), getAddress(plan.router), plan.amountIn, expiration] }) },
      { to: getAddress(plan.router), value: 0n, data: executeData },
    ];
  },
  requiredActions({ token, router }): RequiredAction[] {
    // EXACT (target, selector) order of buildMirrorCalls: cap on the token approve (C3), then the time-boxed
    // Permit2 allowance + the router swap. The session enables precisely the calls the adapter will submit.
    return [
      { actionTarget: getAddress(token), actionTargetSelector: APPROVE_SELECTOR, policy: "cap" },
      { actionTarget: PERMIT2_ADDRESS, actionTargetSelector: PERMIT2_APPROVE_SELECTOR, policy: "window" },
      { actionTarget: getAddress(router), actionTargetSelector: UNIVERSAL_ROUTER_EXECUTE_SELECTOR, policy: "window" },
    ];
  },
};

/** Allowlisted router → adapter. Mirrors C5's ROUTER_ALLOWLIST (UniversalRouter on ETH + Base). Lower-cased keys. */
const ADAPTERS: Record<string, SwapAdapter> = {
  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af": universalRouterAdapter, // UniversalRouter (Ethereum)
  "0x6ff5693b99212da76ad316178a184ab56d299b43": universalRouterAdapter, // UniversalRouter (Base)
};

/** Resolve the swap adapter for a router, or null if none is registered (caller must NOT mirror — fail-closed). */
export function adapterFor(router: Address): SwapAdapter | null {
  return ADAPTERS[router.toLowerCase()] ?? null;
}

/**
 * TEST-ONLY: register an adapter for a router (e.g. a no-code test router) so the full webhook→submit path can be
 * exercised on-chain WITHOUT DEX liquidity. Production routers are registered in the static table above.
 *
 * P2-4 (KAN-156): hard fail-closed in prod — this mutates the SHARED production adapter singleton, so it throws
 * unless `COPY_TEST_HOOKS=1` is set (E2E harnesses only). It ships in the bundle but cannot alter prod routing.
 */
export function __registerTestAdapter(router: Address, adapter: SwapAdapter): void {
  if (process.env.COPY_TEST_HOOKS !== "1") throw new Error("__registerTestAdapter is test-only (set COPY_TEST_HOOKS=1)");
  ADAPTERS[router.toLowerCase()] = adapter;
}

/**
 * Build the follower's mirror calls for a plan, fail-closed: an unregistered router (one not in the adapter
 * table) throws rather than mirroring blind. Registering a router here is the deliberate, reviewed step that
 * lets the backend submit swaps to it.
 */
export function buildMirrorCalls(plan: MirrorPlan): Call[] {
  const adapter = adapterFor(plan.router);
  if (!adapter) throw new Error(`no swap adapter for router ${plan.router} — refusing to mirror`);
  return adapter.buildMirrorCalls(plan);
}
