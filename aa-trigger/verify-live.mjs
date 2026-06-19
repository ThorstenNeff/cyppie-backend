// Live verification harness for the AA UserOp pipeline (KAN-139 Inc.3), Base Sepolia.
//   node --env-file=../.env verify-live.mjs            -> the Kernel DIGEST-LOCK (no chain spend)
//   RUN_SEND=1 node --env-file=../.env verify-live.mjs -> + full on-chain receipt (needs sponsorship/funds)
//
// Proves the wrapping-lock: the app raw-signs hashMessage(userOpHash); the passthrough signature equals
// permissionless.signUserOperation == Kernel's expected userOp.signature (Dev-1's exact contract).
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { digestToSign, wrapKernelSignature } from "./dist/userop.js";

const key = process.env.PIMLICO_API_KEY;
if (!key) throw new Error("PIMLICO_API_KEY not set (node --env-file=../.env verify-live.mjs)");
const url = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${key}`;
const client = createPublicClient({ chain: baseSepolia, transport: http("https://base-sepolia-rpc.publicnode.com") });
const owner = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const account = await to7702KernelSmartAccount({ client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
console.log("7702 account (== owner):", account.address, "| kernel impl:", account.authorization.address);

const op = { sender: account.address, nonce: 0n, callData: "0x", callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: "0x" };
const uoh = getUserOperationHash({ userOperation: op, entryPointAddress: entryPoint07Address, entryPointVersion: "0.7", chainId: baseSepolia.id });
const ref = (await account.signUserOperation(op)).toLowerCase();
const mine = wrapKernelSignature(await owner.sign({ hash: digestToSign(uoh) })).toLowerCase();
console.log("DIGEST-LOCK (digestToSign + passthrough) == permissionless:", mine === ref);

if (process.env.RUN_SEND === "1") {
  const pimlico = createPimlicoClient({ transport: http(url) });
  const sac = createSmartAccountClient({ account, chain: baseSepolia, bundlerTransport: http(url), paymaster: pimlico, userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast } });
  const h = await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: "0x" }] });
  const r = await sac.waitForUserOperationReceipt({ hash: h });
  console.log("RECEIPT tx:", r.receipt.transactionHash, "| success:", r.success);
}
