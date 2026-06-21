// KAN-157 REVOKE-userOp KAT — byte-exact reference for Dev-2's `verifyRevokeUserOp` (revoke no-blind primitive).
//   node scripts/revoke-userop-vector.mjs
//
// The on-chain revoke (KAN-157) is a single owner-authorized (Kernel root) call: SmartSessions.removeSession(
// permissionId), built via the proven /v1/copy/session/revoke/build (= buildUserOp). It runs through the ROOT
// validator (full authority), so the App recomputes the userOpHash on-device + verifyGrant's the calldata before
// the owner signs (same no-blind pattern as enable/7702). This emits the canonical PackedUserOperation +
// userOpHash + digestToSign so Dev-2 pins verifyRevokeUserOp byte-exact. permissionId is the verify INPUT — the
// example below uses the copy canonical pin 0x1c3f76fa… (chain-agnostic). FIXED gas/nonce → deterministic.
import { createPublicClient, http, encodeFunctionData, parseAbi, toHex, hashMessage, slice } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { getRemoveSessionAction, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";

const ENTRYPOINT = entryPoint07Address;
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // follower SCA = sender (7702 same-address)
const PERMISSION_ID = "0x1c3f76fac3f146c12a665114ff61d6d257653434d854ecb3570c6b2c32e96b55"; // example (verify INPUT)
const FIXED = { nonce: 0n, callGasLimit: 300000n, verificationGasLimit: 600000n, preVerificationGas: 100000n,
  maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n,
  paymaster: "0x0000000000000039cd5e8aE05257CE51C473ddd1", paymasterVerificationGasLimit: 300000n, paymasterPostOpGasLimit: 100000n, paymasterData: "0x" };

// The single revoke call: SmartSessions.removeSession(permissionId) — owner/root-authorized.
const remove = getRemoveSessionAction({ permissionId: PERMISSION_ID });
console.log("removeSession call  : to", remove.to, "| selector", slice(remove.callData, 0, 4), "| permissionId", PERMISSION_ID);
console.log("  (to == SMART_SESSIONS_ADDRESS", SMART_SESSIONS_ADDRESS + ")");

const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
const account = await to7702KernelSmartAccount({ client, owner: privateKeyToAccount(generatePrivateKey()), entryPoint: { address: ENTRYPOINT, version: "0.7" }, version: "0.3.3" });
const callData = await account.encodeCalls([{ to: remove.to, value: 0n, data: remove.callData }]); // single call (Kernel execute)

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
  console.log("callData            :", callData, "(Kernel execute, single removeSession call)");
  console.log("accountGasLimits    :", packed.accountGasLimits, "(verif<<128 | call)");
  console.log("preVerificationGas  :", toHex(packed.preVerificationGas));
  console.log("gasFees             :", packed.gasFees, "(maxPrio<<128 | maxFee)");
  console.log("paymasterAndData    :", packed.paymasterAndData);
  console.log("userOpHash          :", userOpHash);
  console.log("digestToSign        :", digestToSign, "(= hashMessage(userOpHash), EIP-191)");
}
console.log("\nverifyRevokeUserOp: recompute userOpHash from the PackedUserOperation (v0.7); callData decodes to ONE call → SmartSessions.removeSession(permissionId) → assert permissionId == expected + sender == follower SCA, no extra calls. digestToSign = hashMessage(userOpHash), owner raw-signs.");
