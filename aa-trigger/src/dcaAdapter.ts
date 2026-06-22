import { encodeFunctionData, encodeAbiParameters, parseAbi, getAddress, type Address, type Hex } from "viem";
import type { Call } from "./userop.js";

/**
 * DCA buy-calldata builder (KAN-163 / PRD-05) — the recurring-buy swap for a scoped DCA Smart-Session.
 *
 * The DCA session is scoped to **Uniswap SwapRouter02** (`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` etc.) and
 * the `multicall(uint256,bytes[])` selector `0x5ae401dc` (the §2 vector / KAN-150 placement) — a DIFFERENT router
 * than the copy UniversalRouter path (no Permit2; SwapRouter02 pulls directly via the ERC-20 approve). A buy is
 * TWO calls, matching the C3-corrected 2-action DCA scope: `tokenIn.approve(router, amountIn)` (the SpendingLimits
 * CAP action) + `router.multicall(deadline, [exactInputSingle])` (the time-boxed swap action). Pure +
 * deterministic — byte-KAT-locked (dcaadapter.test.mjs), independent of testnet liquidity.
 */

/** SwapRouter02 selectors. */
export const APPROVE_SELECTOR: Hex = "0x095ea7b3"; // ERC-20 approve(address,uint256)
export const MULTICALL_DEADLINE_SELECTOR: Hex = "0x5ae401dc"; // multicall(uint256 deadline, bytes[] data)
export const EXACT_INPUT_SINGLE_SELECTOR: Hex = "0x04e45aaf"; // exactInputSingle((...))

const ERC20_APPROVE = parseAbi(["function approve(address spender, uint256 amount)"]);
const MULTICALL = parseAbi(["function multicall(uint256 deadline, bytes[] data)"]);
// SwapRouter02 exactInputSingle — NB: no deadline in the struct (the deadline lives on the multicall wrapper).
const EXACT_INPUT_SINGLE = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)",
]);

export interface DcaBuyPlan {
  chainId: number;
  router: Address;        // SwapRouter02 (the session's scoped swap router)
  tokenIn: Address;       // the spend (budget) token
  tokenOut: Address;      // the token being accumulated
  amountIn: bigint;       // the per-buy amount (≤ the per-window cap)
  amountOutMin: bigint;   // slippage floor
  feeTier: number;        // Uniswap V3 pool fee (e.g. 500 / 3000 / 10000)
  recipient: Address;     // the follower SCA (receives tokenOut)
  deadline: bigint;       // swap deadline (unix s)
}

/**
 * Build the DCA buy calls: `[ tokenIn.approve(router, amountIn), router.multicall(deadline, [exactInputSingle]) ]`.
 * The approve carries the SpendingLimits cap (target = token); the multicall is the time-boxed router action.
 */
export function buildDcaBuyCalls(plan: DcaBuyPlan): Call[] {
  if (plan.amountIn <= 0n) throw new Error("DCA amountIn must be > 0");
  const exactInputSingle = encodeFunctionData({
    abi: EXACT_INPUT_SINGLE,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: getAddress(plan.tokenIn), tokenOut: getAddress(plan.tokenOut), fee: plan.feeTier,
      recipient: getAddress(plan.recipient), amountIn: plan.amountIn, amountOutMinimum: plan.amountOutMin,
      sqrtPriceLimitX96: 0n,
    }],
  });
  const multicall = encodeFunctionData({ abi: MULTICALL, functionName: "multicall", args: [plan.deadline, [exactInputSingle]] });
  return [
    { to: getAddress(plan.tokenIn), value: 0n, data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [getAddress(plan.router), plan.amountIn] }) },
    { to: getAddress(plan.router), value: 0n, data: multicall },
  ];
}

/** The session actions the DCA buy touches — the (target, selector) set the §2 session must enable (cap + window). */
export function dcaRequiredActions(scope: { token: Address; router: Address }): Array<{ actionTarget: Address; actionTargetSelector: Hex; policy: "cap" | "window" }> {
  return [
    { actionTarget: getAddress(scope.token), actionTargetSelector: APPROVE_SELECTOR, policy: "cap" },
    { actionTarget: getAddress(scope.router), actionTargetSelector: MULTICALL_DEADLINE_SELECTOR, policy: "window" },
  ];
}

// Re-export the ABI param encoder used by the KAT to decode the inner exactInputSingle (struct) bytes.
export { encodeAbiParameters };
