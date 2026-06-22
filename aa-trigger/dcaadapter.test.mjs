// KAN-163 DCA buy-calldata adapter KAT — byte-correct SwapRouter02 approve + multicall(exactInputSingle). No network.
//   node dcaadapter.test.mjs
import { decodeFunctionData, parseAbi, getAddress, slice } from "viem";
import { buildDcaBuyCalls, dcaRequiredActions, APPROVE_SELECTOR, MULTICALL_DEADLINE_SELECTOR, EXACT_INPUT_SINGLE_SELECTOR } from "./dist/dcaAdapter.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";   // tokenIn (spend)
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";   // tokenOut (accumulate)
const FOLLOWER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const plan = {
  chainId: 1, router: ROUTER, tokenIn: USDC, tokenOut: WETH, amountIn: 30000000n, amountOutMin: 9000000000000000n,
  feeTier: 500, recipient: FOLLOWER, deadline: 1893456000n,
};

console.log("KAN-163: buildDcaBuyCalls — SwapRouter02 2-call shape");
const calls = buildDcaBuyCalls(plan);
ok(calls.length === 2, `two calls (approve → multicall) (got ${calls.length})`);

// Call 1: tokenIn.approve(router, amountIn) — the SpendingLimits CAP action
ok(getAddress(calls[0].to) === getAddress(USDC), "call1 target = tokenIn (cap action on the spend token)");
ok(slice(calls[0].data, 0, 4).toLowerCase() === APPROVE_SELECTOR, "call1 selector = approve");
{
  const { args } = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: calls[0].data });
  ok(getAddress(args[0]) === getAddress(ROUTER), "call1 spender = SwapRouter02 (direct, no Permit2)");
  ok(args[1] === plan.amountIn, "call1 amount = per-buy amountIn");
}

// Call 2: router.multicall(deadline, [exactInputSingle]) — the time-boxed swap action
ok(getAddress(calls[1].to) === getAddress(ROUTER), "call2 target = router");
ok(slice(calls[1].data, 0, 4).toLowerCase() === MULTICALL_DEADLINE_SELECTOR, "call2 selector = multicall(uint256,bytes[])");
{
  const { args } = decodeFunctionData({ abi: parseAbi(["function multicall(uint256,bytes[])"]), data: calls[1].data });
  ok(args[0] === plan.deadline, "multicall deadline");
  ok(args[1].length === 1, "exactly one inner call (exactInputSingle)");
  ok(slice(args[1][0], 0, 4).toLowerCase() === EXACT_INPUT_SINGLE_SELECTOR, "inner selector = exactInputSingle");
  const inner = decodeFunctionData({
    abi: parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))"]),
    data: args[1][0],
  });
  const p = inner.args[0];
  ok(getAddress(p.tokenIn) === getAddress(USDC), "exactInputSingle.tokenIn = USDC");
  ok(getAddress(p.tokenOut) === getAddress(WETH), "exactInputSingle.tokenOut = WETH");
  ok(Number(p.fee) === plan.feeTier, "exactInputSingle.fee = feeTier");
  ok(getAddress(p.recipient) === getAddress(FOLLOWER), "exactInputSingle.recipient = follower SCA");
  ok(p.amountIn === plan.amountIn, "exactInputSingle.amountIn = amountIn");
  ok(p.amountOutMinimum === plan.amountOutMin, "exactInputSingle.amountOutMinimum = slippage floor");
  ok(p.sqrtPriceLimitX96 === 0n, "exactInputSingle.sqrtPriceLimitX96 = 0 (no limit)");
}

console.log("KAN-163: dcaRequiredActions — 2-action scope (cap on approve, window on multicall)");
const acts = dcaRequiredActions({ token: USDC, router: ROUTER });
ok(acts.length === 2, "two actions");
ok(acts[0].actionTargetSelector === APPROVE_SELECTOR && getAddress(acts[0].actionTarget) === getAddress(USDC) && acts[0].policy === "cap", "action0 = approve on token → cap");
ok(acts[1].actionTargetSelector === MULTICALL_DEADLINE_SELECTOR && getAddress(acts[1].actionTarget) === getAddress(ROUTER) && acts[1].policy === "window", "action1 = multicall on router → window");

try { buildDcaBuyCalls({ ...plan, amountIn: 0n }); ok(false, "zero amountIn rejected"); } catch { ok(true, "zero amountIn rejected"); }

console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
