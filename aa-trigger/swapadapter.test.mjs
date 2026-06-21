// C6.1 swap-calldata adapter KAT (KAN-149) — byte-correct UniversalRouter V3 exact-in + Permit2. No network.
//   node swapadapter.test.mjs
import { decodeFunctionData, decodeAbiParameters, parseAbi, getAddress, slice, size } from "viem";
import { buildMirrorCalls, adapterFor, encodeV3Path, PERMIT2_ADDRESS,
  APPROVE_SELECTOR, PERMIT2_APPROVE_SELECTOR, UNIVERSAL_ROUTER_EXECUTE_SELECTOR } from "./dist/swapAdapter.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const ROUTER_BASE = "0x6fF5693b99212Da76ad316178A184AB56D299b43"; // UniversalRouter (Base) — allowlisted
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC (Base)
const plan = {
  chainId: 8453, router: ROUTER_BASE, tokenIn: WETH, tokenOut: USDC,
  amountIn: 250000000000000000n, amountOutMin: 900000000n, feeTier: 500,
  deadline: 1893456000n, permit2Expiration: 1893456000,
};

console.log("C6.1: buildMirrorCalls — UniversalRouter 3-call shape");
const calls = buildMirrorCalls(plan);
ok(calls.length === 3, `three calls (approve → permit2.approve → execute) (got ${calls.length})`);

// Call 1: tokenIn.approve(PERMIT2, amountIn) — the SpendingLimits CAP action (target = token)
ok(getAddress(calls[0].to) === getAddress(WETH), "call1 target = tokenIn (cap action on the token)");
ok(slice(calls[0].data, 0, 4).toLowerCase() === APPROVE_SELECTOR, "call1 selector = approve");
{
  const { args } = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: calls[0].data });
  ok(getAddress(args[0]) === getAddress(PERMIT2_ADDRESS), "call1 spender = Permit2");
  ok(args[1] === plan.amountIn, "call1 amount = mirror amountIn");
}

// Call 2: PERMIT2.approve(tokenIn, router, amountIn, expiration)
ok(getAddress(calls[1].to) === getAddress(PERMIT2_ADDRESS), "call2 target = Permit2");
ok(slice(calls[1].data, 0, 4).toLowerCase() === PERMIT2_APPROVE_SELECTOR, "call2 selector = permit2.approve");
{
  const { args } = decodeFunctionData({ abi: parseAbi(["function approve(address,address,uint160,uint48)"]), data: calls[1].data });
  ok(getAddress(args[0]) === getAddress(WETH), "call2 token = tokenIn");
  ok(getAddress(args[1]) === getAddress(ROUTER_BASE), "call2 spender = router");
  ok(args[2] === plan.amountIn, "call2 amount = mirror amountIn");
  ok(Number(args[3]) === plan.permit2Expiration, "call2 expiration");
}

// Call 3: router.execute([V3_SWAP_EXACT_IN], [input], deadline)
ok(getAddress(calls[2].to) === getAddress(ROUTER_BASE), "call3 target = router");
ok(slice(calls[2].data, 0, 4).toLowerCase() === UNIVERSAL_ROUTER_EXECUTE_SELECTOR, "call3 selector = execute");
{
  const { args } = decodeFunctionData({ abi: parseAbi(["function execute(bytes,bytes[],uint256)"]), data: calls[2].data });
  ok(args[0] === "0x00", "commands = single V3_SWAP_EXACT_IN (0x00)");
  ok(args[1].length === 1, "exactly one input");
  ok(args[2] === plan.deadline, "deadline");
  const [recipient, amountIn, amountOutMin, path, payerIsUser] = decodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }], args[1][0],
  );
  ok(getAddress(recipient) === getAddress("0x0000000000000000000000000000000000000001"), "recipient = MSG_SENDER");
  ok(amountIn === plan.amountIn, "input amountIn = mirror amountIn");
  ok(amountOutMin === plan.amountOutMin, "input amountOutMin = slippage floor");
  ok(payerIsUser === true, "payerIsUser = true (the SCA pays via Permit2)");
  // path = tokenIn ‖ fee(3) ‖ tokenOut  (43 bytes)
  ok(size(path) === 43, `V3 path is 43 bytes (got ${size(path)})`);
  ok(getAddress(slice(path, 0, 20)) === getAddress(WETH), "path[0] = tokenIn");
  ok(getAddress(slice(path, 23, 43)) === getAddress(USDC), "path[1] = tokenOut");
  ok(Number(slice(path, 20, 23)) === plan.feeTier, "path fee = feeTier");
  ok(path === encodeV3Path(WETH, plan.feeTier, USDC), "path matches encodeV3Path");
}

console.log("C6.1: fail-closed router resolution");
ok(adapterFor(ROUTER_BASE) !== null, "allowlisted router resolves an adapter");
ok(adapterFor("0x9999999999999999999999999999999999999999") === null, "unknown router → null (no blind mirror)");
let threw = false;
try { buildMirrorCalls({ ...plan, router: "0x9999999999999999999999999999999999999999" }); } catch { threw = true; }
ok(threw, "buildMirrorCalls throws for an unregistered router");
try { buildMirrorCalls({ ...plan, amountIn: 0n }); ok(false, "zero amountIn rejected"); } catch { ok(true, "zero amountIn rejected"); }

console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
