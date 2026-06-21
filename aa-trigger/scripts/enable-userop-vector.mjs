// Enable-userOp KAT (KAN-156 P1-4 / GAP-B) — byte-exact reference for Dev-2's shared `verifyEnableUserOp`
// on-device recompute (blocks Copy KAN-154 + DCA KAN-159). Run: node scripts/enable-userop-vector.mjs
//
// Emits, for the canonical copy scope on ETH(1) + Base(8453): the REAL enable-userOp callData (install
// SmartSessions + enableSessions, encoded by permissionless's Kernel account = exactly what /v1/userop/build
// produces) with FIXED gas/nonce (so the hash is deterministic + pinnable), the full v0.7 PackedUserOperation
// fields, the `userOpHash`, and `digestToSign = hashMessage(userOpHash)`. Dev-2 pins their packing/hashing
// against these; at runtime they feed the ACTUAL /v1/userop/build fields through the same logic.
//
// Packing recap (EntryPoint v0.7): accountGasLimits = verificationGasLimit<<128 | callGasLimit;
// gasFees = maxPriorityFeePerGas<<128 | maxFeePerGas; paymasterAndData = paymaster ‖ pmVerifGas(16B) ‖
// pmPostOpGas(16B) ‖ pmData. userOpHash = keccak256(abi.encode(keccak256(packed), entryPoint, chainId)).
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { getSmartSessionsValidator, getEnableSessionsAction, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { hashMessage } from "viem";
import { buildSession } from "../dist/copySession.js";

const ENTRYPOINT = entryPoint07Address; // 0x0000000071727De22E5E9d8BAf0edAc6f37da032 (v0.7, both chains)

// ── Canonical KAT inputs (SAME as scripts/copy-vector.mjs — pin identically on the app side) ──
const SESSION_PUBKEY = "0x489ccacAC8836C71Ad5B20Bf61e0b885425b227e";
const SALT = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const FOLLOWER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // follower SCA (= owner EOA, 7702 same-address) = sender
const SOURCE = "0x1111111111111111111111111111111111111111";
const WINDOW = { windowStart: 0, windowEnd: 1893456000 };
const UR = { 1: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af", 8453: "0x6fF5693b99212Da76ad316178A184AB56D299b43" };
const USDC = { 1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const WETH = { 1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 8453: "0x4200000000000000000000000000000000000006" };

// FIXED userOp envelope (canonical — the deterministic part of the vector; real values come from /v1/userop/build).
const FIXED = {
  nonce: 0n, // first op, root-validator lane (key 0)
  callGasLimit: 600000n, verificationGasLimit: 1500000n, preVerificationGas: 200000n,
  maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n,
  paymaster: "0x0000000000000039cd5e8aE05257CE51C473ddd1", // a fixed Pimlico-style paymaster (placeholder for packing)
  paymasterVerificationGasLimit: 400000n, paymasterPostOpGasLimit: 100000n, paymasterData: "0x",
};

// Kernel v3.3 install initData = abi.encodePacked(hook=addr(1), abi.encode(validatorData, hookData, selectorData=execute))
const KERNEL_NO_HOOK = "0x0000000000000000000000000000000000000001";
const KERNEL_EXECUTE_SELECTOR = "0xe9ae5c53";
const installInitData = encodePacked(["address", "bytes"], [KERNEL_NO_HOOK,
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [getSmartSessionsValidator({}).initData ?? "0x", "0x", KERNEL_EXECUTE_SELECTOR])]);
const installCallData = encodeFunctionData({ abi: parseAbi(["function installModule(uint256 t, address m, bytes d)"]), args: [1n, SMART_SESSIONS_ADDRESS, installInitData] });

// permissionless Kernel account — used ONLY for `encodeCalls` (pure ERC-7579 batch encoding, independent of owner
// + chainId), so the callData byte-matches what /v1/userop/build emits. No network needed for the encoding.
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
const account = await to7702KernelSmartAccount({ client, owner: privateKeyToAccount(generatePrivateKey()), entryPoint: { address: ENTRYPOINT, version: "0.7" }, version: "0.3.3" });

for (const chainId of [1, 8453]) {
  const scope = {
    chainId, token: USDC[chainId], capTotalBudget: 1000000000n, router: UR[chainId], selector: "0x3593564c",
    ...WINDOW, follower: FOLLOWER, source: SOURCE, tokenOut: WETH[chainId], feeTier: 500,
  };
  const session = buildSession(SESSION_PUBKEY, SALT, scope);
  const enableAction = getEnableSessionsAction({ sessions: [session] });
  // The two enable calls (install on the SCA self + enableSessions on the SmartSessions module) → Kernel callData.
  const calls = [
    { to: FOLLOWER, value: 0n, data: installCallData },
    { to: enableAction.to, value: 0n, data: enableAction.callData },
  ];
  const callData = await account.encodeCalls(calls);

  const userOperation = {
    sender: FOLLOWER, nonce: FIXED.nonce, callData,
    callGasLimit: FIXED.callGasLimit, verificationGasLimit: FIXED.verificationGasLimit, preVerificationGas: FIXED.preVerificationGas,
    maxFeePerGas: FIXED.maxFeePerGas, maxPriorityFeePerGas: FIXED.maxPriorityFeePerGas,
    paymaster: FIXED.paymaster, paymasterVerificationGasLimit: FIXED.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: FIXED.paymasterPostOpGasLimit, paymasterData: FIXED.paymasterData, signature: "0x",
  };
  const packed = toPackedUserOperation(userOperation);
  const userOpHash = getUserOperationHash({ userOperation, entryPointAddress: ENTRYPOINT, entryPointVersion: "0.7", chainId });
  const digestToSign = hashMessage({ raw: userOpHash });

  console.log(`\n──────── chain ${chainId} ${chainId === 1 ? "(Ethereum)" : "(Base)"} · EntryPoint ${ENTRYPOINT} ────────`);
  console.log("sender (follower SCA):", userOperation.sender);
  console.log("nonce               :", toHex(userOperation.nonce));
  console.log("factory/factoryData :", packed.factory ?? "0x (none — 7702, no factory)");
  console.log("callData            :", callData);
  console.log("accountGasLimits    :", packed.accountGasLimits, "(verif<<128 | call)");
  console.log("preVerificationGas  :", toHex(packed.preVerificationGas));
  console.log("gasFees             :", packed.gasFees, "(maxPrio<<128 | maxFee)");
  console.log("paymasterAndData    :", packed.paymasterAndData, "(paymaster ‖ verifGas16 ‖ postOpGas16 ‖ data)");
  console.log("permissionId        :", session && (await import("@rhinestone/module-sdk")).getPermissionId({ session }));
  console.log("userOpHash          :", userOpHash);
  console.log("digestToSign        :", digestToSign, "(= hashMessage(userOpHash), EIP-191)");
}
console.log("\nDev-2: recompute userOpHash from the PackedUserOperation above (v0.7 packing) → must equal `userOpHash`; then digestToSign = hashMessage(raw: userOpHash). callData decodes to install(SmartSessions)+enableSessions(session) → verifyGrant getPermissionId == 0x1c3f76fa… (per copy-vector.mjs).");
