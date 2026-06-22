// KAN-163 DCA-BUY-userOp KAT — byte-exact reference for Dev-2's `verifyBuyUserOp` (the recurring-buy userOp layer).
//   node scripts/dca-buy-userop-vector.mjs
//
// This is the USE-mode counterpart to dca-enable-userop-vector.mjs. The ENABLE vector installs the session; THIS
// vector is the actual recurring BUY that runs THROUGH the enabled session. Three things make a buy op different
// from an enable op — and Dev-2 must reproduce all three byte-for-byte:
//
//   1. callData  = account.encodeCalls( buildDcaBuyCalls(plan) ) — the C3-corrected 2-call DCA buy:
//                    [ tokenIn.approve(router, amountIn),  router.multicall(deadline, [exactInputSingle]) ]
//                    (SwapRouter02 0x68b3…, multicall 0x5ae401dc; NO Permit2 — SwapRouter02 pulls via the approve).
//   2. nonce KEY = the SMART-SESSION USE-mode lane  smartSessionUseModeNonceKey(0):
//                    uint192 = [1B mode 0x00][1B vtype 0x01][20B SmartSessions][2B nonceKey].  vtype MUST be 0x01,
//                    else Kernel routes to the root validator and reverts InvalidValidator (0x682a6e7c).
//                    Full EntryPoint nonce = key<<64 | seq;  fresh session ⇒ seq 0 ⇒ nonce = key<<64.
//   3. 🔒 digestToSign = the RAW userOpHash  — NOT hashMessage(userOpHash)/EIP-191.  The OwnableValidator
//                    session-validator recovers the signer over the RAW hash (C3 USE-lock). The DCA session's
//                    OwnableValidator owner is the user's ON-DEVICE key, so the app raw-secp256k1-signs THIS.
//                    (Contrast the enable vector, whose digest IS the EIP-191 form — keep the two paths separate.)
//
// Mirrors production buildDcaBuy() exactly (same encodeCalls, same USE-mode nonce). FIXED gas/nonce/paymaster ⇒
// deterministic + pinnable, no network. The session permissionId reproduces DCA Vektor-D (sanity-gated) so the buy
// is provably the one running under that enabled session. The buy itself is on-chain proven separately by
// c9-dca-buy-e2e.mjs (receipt 0x2e6b976c…). Emits the full v0.7 PackedUserOperation for ETH(1)+Base(8453).
import { createPublicClient, http, toHex, hashMessage } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import {
  getOwnableValidator, getSpendingLimitsPolicy, getTimeFramePolicy, getPermissionId,
  GLOBAL_CONSTANTS, SMART_SESSIONS_ADDRESS,
} from "@rhinestone/module-sdk";
import { buildDcaBuyCalls } from "../dist/dcaAdapter.js";
import { smartSessionUseModeNonceKey } from "../dist/copySession.js";

const ENTRYPOINT = entryPoint07Address;
// ── DCA Vektor-D session fields (same as dca-enable-userop-vector.mjs) — the session the buy runs under ──
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // follower SCA = sender (7702 same-address) = recipient
const SALT = "0x0000000000000000000000000000000000000000000000000000000000000001";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // spend (budget) token, 6 dec — tokenIn
const CAP = 1_000_000n;
const DEX_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02 (the scoped swap router)
const APPROVE_SELECTOR = "0x095ea7b3", SWAP_SELECTOR = "0x5ae401dc";
const VALID_AFTER = 1748966016, VALID_UNTIL = 1752958208;
const EXPECTED_PERMISSION_ID = "0x82bc397553fc6577974c762cd42958d860cd838a55f55f245ee5f6debab698b0";

// ── The buy PLAN (the per-tick recurring buy inputs Dev-2 reconstructs) ──
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // tokenOut (the accumulated token) — fixed KAT address
const AMOUNT_IN = 1_000_000n;     // 1 USDC per buy (≤ CAP)
const AMOUNT_OUT_MIN = 0n;        // slippage floor (testnet 0; mainnet a real min)
const FEE_TIER = 500;             // Uniswap V3 pool fee
const DEADLINE = 1893456000n;     // swap deadline (unix s)
const NONCE_KEY = 0;              // smart-session nonce lane index

const FIXED = { callGasLimit: 600000n, verificationGasLimit: 1500000n, preVerificationGas: 200000n,
  maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n,
  paymaster: "0x0000000000000039cd5e8aE05257CE51C473ddd1", paymasterVerificationGasLimit: 400000n, paymasterPostOpGasLimit: 100000n, paymasterData: "0x" };

// ── Sanity-gate: reproduce DCA Vektor-D's permissionId so the buy is provably under that enabled session ──
const ov = getOwnableValidator({ threshold: 1, owners: [ACCOUNT] });
const spend = getSpendingLimitsPolicy([{ token: USDC, limit: CAP }]);
const time = getTimeFramePolicy({ validAfter: VALID_AFTER, validUntil: VALID_UNTIL });
const timePolicy = { policy: GLOBAL_CONSTANTS.TIME_FRAME_POLICY_ADDRESS, initData: time.initData };
const session = {
  sessionValidator: ov.address, sessionValidatorInitData: ov.initData, salt: SALT,
  userOpPolicies: [timePolicy],
  erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
  actions: [
    { actionTargetSelector: APPROVE_SELECTOR, actionTarget: USDC, actionPolicies: [{ policy: GLOBAL_CONSTANTS.SPENDING_LIMITS_POLICY_ADDRESS, initData: spend.initData }] },
    { actionTargetSelector: SWAP_SELECTOR, actionTarget: DEX_ROUTER, actionPolicies: [timePolicy] },
  ],
  permitERC4337Paymaster: true,
};
const permissionId = getPermissionId({ session });
if (permissionId.toLowerCase() !== EXPECTED_PERMISSION_ID.toLowerCase()) {
  console.error("✗ permissionId MISMATCH — session config does not reproduce Vektor-D:", permissionId, "expected", EXPECTED_PERMISSION_ID);
  process.exit(1);
}
console.log("session permissionId =", permissionId, "✓ == DCA Vektor-D (the buy runs under this enabled session)");

// ── The buy callData (production buildDcaBuy uses exactly this encodeCalls over buildDcaBuyCalls) ──
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
const account = await to7702KernelSmartAccount({ client, owner: privateKeyToAccount(generatePrivateKey()), entryPoint: { address: ENTRYPOINT, version: "0.7" }, version: "0.3.3" });
const calls = buildDcaBuyCalls({
  chainId: 1, router: DEX_ROUTER, tokenIn: USDC, tokenOut: WETH,
  amountIn: AMOUNT_IN, amountOutMin: AMOUNT_OUT_MIN, feeTier: FEE_TIER, recipient: ACCOUNT, deadline: DEADLINE,
});
const callData = await account.encodeCalls(calls);

// ── The USE-mode smart-session nonce lane (vtype 0x01). Fresh session ⇒ sequence 0. ──
const nonceKeyU192 = smartSessionUseModeNonceKey(NONCE_KEY);
const nonce = nonceKeyU192 << 64n; // EntryPoint nonce = key<<64 | seq; seq 0 for a fresh session

console.log("\nbuy plan: approve(USDC →", DEX_ROUTER, AMOUNT_IN, ") + multicall(", DEADLINE, ", [exactInputSingle USDC→WETH fee", FEE_TIER, "]) ");
console.log("nonce key (uint192) :", toHex(nonceKeyU192), "= [00][01][SmartSessions][nonceKey] (USE-mode lane, vtype 0x01)");

for (const chainId of [1, 8453]) {
  const userOperation = {
    sender: ACCOUNT, nonce, callData,
    callGasLimit: FIXED.callGasLimit, verificationGasLimit: FIXED.verificationGasLimit, preVerificationGas: FIXED.preVerificationGas,
    maxFeePerGas: FIXED.maxFeePerGas, maxPriorityFeePerGas: FIXED.maxPriorityFeePerGas,
    paymaster: FIXED.paymaster, paymasterVerificationGasLimit: FIXED.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: FIXED.paymasterPostOpGasLimit, paymasterData: FIXED.paymasterData, signature: "0x",
  };
  const packed = toPackedUserOperation(userOperation);
  const userOpHash = getUserOperationHash({ userOperation, entryPointAddress: ENTRYPOINT, entryPointVersion: "0.7", chainId });
  console.log(`\n──────── chain ${chainId} ${chainId === 1 ? "(Ethereum)" : "(Base)"} · EntryPoint ${ENTRYPOINT} ────────`);
  console.log("sender              :", userOperation.sender);
  console.log("nonce               :", toHex(userOperation.nonce), "(key<<64 | 0)");
  console.log("callData            :", callData);
  console.log("accountGasLimits    :", packed.accountGasLimits, "(verif<<128 | call)");
  console.log("preVerificationGas  :", toHex(packed.preVerificationGas));
  console.log("gasFees             :", packed.gasFees, "(maxPrio<<128 | maxFee)");
  console.log("paymasterAndData    :", packed.paymasterAndData);
  console.log("userOpHash          :", userOpHash);
  console.log("digestToSign        :", userOpHash, "🔒 == RAW userOpHash (C3 USE-lock — NOT EIP-191)");
  console.log("  (for contrast, the EIP-191 form would be", hashMessage({ raw: userOpHash }), "— the ENABLE path; do NOT sign this for a buy)");
}
console.log("\nDCA buy = USE-mode through the session: app raw-signs userOpHash → getOwnableValidatorSignature → encodeSmartSessionSignature(USE, permissionId 0x82bc…b698b0). callData = approve+multicall (SwapRouter02, no Permit2). Same /v1/dca/build|submit; on-chain proven by c9 (0x2e6b976c…).");
