// KAN-159 DCA-enable-userOp KAT — byte-exact reference for Dev-2's app-built DCA enable (userOp layer on Vektor-D).
//   node scripts/dca-enable-userop-vector.mjs
//
// Same mechanism as the copy enable (enable-userop-vector.mjs) — install SmartSessions + enableSessions, via the
// generic /v1/userop/build (the App builds the calls; /build just wraps gas/nonce, keyless). The ONLY difference
// is the DCA SESSION CONFIG inside enableSessions: the C3-corrected 2-ACTION shape (NO Permit2) —
//   userOpPolicies = [TimeFrame window]; actions = [ USDC.approve→[SpendingLimits cap], router.swap→[TimeFrame] ].
// Reproduces Vektor-D (permissionId 0x82bc…b698b0, sanity-gated) and emits the full v0.7 PackedUserOperation,
// userOpHash, digestToSign for ETH(1)+Base(8453). FIXED gas/nonce so it's deterministic + pinnable.
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex, hashMessage } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import {
  getOwnableValidator, getSpendingLimitsPolicy, getTimeFramePolicy, getEnableSessionsAction,
  getSmartSessionsValidator, getPermissionId, GLOBAL_CONSTANTS, SMART_SESSIONS_ADDRESS,
} from "@rhinestone/module-sdk";

const ENTRYPOINT = entryPoint07Address;
// ── DCA Vektor-D session fields (Dev-2) ──
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // follower SCA = sender (7702 same-address)
const SALT = "0x0000000000000000000000000000000000000000000000000000000000000001";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // spend token (6 dec)
const CAP = 1_000_000n;
const DEX_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const APPROVE_SELECTOR = "0x095ea7b3", SWAP_SELECTOR = "0x5ae401dc";
const VALID_AFTER = 1748966016, VALID_UNTIL = 1752958208;
const EXPECTED_PERMISSION_ID = "0x82bc397553fc6577974c762cd42958d860cd838a55f55f245ee5f6debab698b0";

const FIXED = { nonce: 0n, callGasLimit: 600000n, verificationGasLimit: 1500000n, preVerificationGas: 200000n,
  maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n,
  paymaster: "0x0000000000000039cd5e8aE05257CE51C473ddd1", paymasterVerificationGasLimit: 400000n, paymasterPostOpGasLimit: 100000n, paymasterData: "0x" };

// The DCA session (the module-sdk Session struct passed to enableSessions) — Vektor-D, C3-corrected 2-action.
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

// Sanity-gate: must reproduce Vektor-D's permissionId before emitting the userOp.
const permissionId = getPermissionId({ session });
if (permissionId.toLowerCase() !== EXPECTED_PERMISSION_ID.toLowerCase()) {
  console.error("✗ permissionId MISMATCH — session config does not reproduce Vektor-D:", permissionId, "expected", EXPECTED_PERMISSION_ID);
  process.exit(1);
}
console.log("permissionId =", permissionId, "✓ == Vektor-D (sanity-gated)");

// The two enable calls: installModule(SmartSessions) on self + enableSessions(session) on the module.
const installInitData = encodePacked(["address", "bytes"], ["0x0000000000000000000000000000000000000001",
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [getSmartSessionsValidator({}).initData ?? "0x", "0x", "0xe9ae5c53"])]);
const installCallData = encodeFunctionData({ abi: parseAbi(["function installModule(uint256 t, address m, bytes d)"]), args: [1n, SMART_SESSIONS_ADDRESS, installInitData] });
const enableAction = getEnableSessionsAction({ sessions: [session] });

const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
const account = await to7702KernelSmartAccount({ client, owner: privateKeyToAccount(generatePrivateKey()), entryPoint: { address: ENTRYPOINT, version: "0.7" }, version: "0.3.3" });
const callData = await account.encodeCalls([
  { to: ACCOUNT, value: 0n, data: installCallData },
  { to: enableAction.to, value: 0n, data: enableAction.callData },
]);

for (const chainId of [1, 8453]) {
  const userOperation = {
    sender: ACCOUNT, nonce: FIXED.nonce, callData,
    callGasLimit: FIXED.callGasLimit, verificationGasLimit: FIXED.verificationGasLimit, preVerificationGas: FIXED.preVerificationGas,
    maxFeePerGas: FIXED.maxFeePerGas, maxPriorityFeePerGas: FIXED.maxPriorityFeePerGas,
    paymaster: FIXED.paymaster, paymasterVerificationGasLimit: FIXED.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: FIXED.paymasterPostOpGasLimit, paymasterData: FIXED.paymasterData, signature: "0x",
  };
  const packed = toPackedUserOperation(userOperation);
  const userOpHash = getUserOperationHash({ userOperation, entryPointAddress: ENTRYPOINT, entryPointVersion: "0.7", chainId });
  const digestToSign = hashMessage({ raw: userOpHash });
  console.log(`\n──────── chain ${chainId} ${chainId === 1 ? "(Ethereum)" : "(Base)"} · EntryPoint ${ENTRYPOINT} ────────`);
  console.log("sender              :", userOperation.sender, "| nonce:", toHex(userOperation.nonce));
  console.log("callData            :", callData);
  console.log("accountGasLimits    :", packed.accountGasLimits, "(verif<<128 | call)");
  console.log("preVerificationGas  :", toHex(packed.preVerificationGas));
  console.log("gasFees             :", packed.gasFees, "(maxPrio<<128 | maxFee)");
  console.log("paymasterAndData    :", packed.paymasterAndData);
  console.log("userOpHash          :", userOpHash);
  console.log("digestToSign        :", digestToSign, "(= hashMessage(userOpHash), EIP-191)");
}
console.log("\nDCA enable = install(SmartSessions)+enableSessions(DCA session, 2-action no-Permit2). Same /v1/userop/build|submit + verifyEnableUserOp/verify7702 as copy; only the session config differs. permissionId pin 0x82bc…b698b0.");
