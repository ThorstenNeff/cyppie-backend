// Live verification harness for the AA UserOp pipeline (KAN-139 Inc.3), Base Sepolia.
//   node --env-file=../.env verify-live.mjs            -> the Kernel DIGEST-LOCK (no chain spend)
//   RUN_SEND=1 node --env-file=../.env verify-live.mjs -> + full on-chain receipt (needs sponsorship/funds)
//
// Proves the wrapping-lock: the app raw-signs hashMessage(userOpHash); the passthrough signature equals
// permissionless.signUserOperation == Kernel's expected userOp.signature (Dev-1's exact contract).
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { digestToSign, wrapKernelSignature } from "./dist/userop.js";

const key = process.env.PIMLICO_API_KEY;
if (!key) throw new Error("PIMLICO_API_KEY not set (node --env-file=../.env verify-live.mjs)");
const url = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${key}`;
const client = createPublicClient({ chain: baseSepolia, transport: http("https://base-sepolia-rpc.publicnode.com") });
// A FRESH key (no existing 7702 delegation) so viem attaches OUR signed authorization and the first
// sponsored UserOp delegates the EOA to our Kernel impl. (Well-known test keys like 0x0123.. are already
// delegated to foreign impls on Base Sepolia → isDeployed()=true → our auth is skipped → bundler error.)
const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
const account = await to7702KernelSmartAccount({ client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
console.log("7702 account (== owner):", account.address, "| kernel impl:", account.authorization.address);

const op = { sender: account.address, nonce: 0n, callData: "0x", callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: "0x" };
const uoh = getUserOperationHash({ userOperation: op, entryPointAddress: entryPoint07Address, entryPointVersion: "0.7", chainId: baseSepolia.id });
const ref = (await account.signUserOperation(op)).toLowerCase();
const mine = wrapKernelSignature(await owner.sign({ hash: digestToSign(uoh) })).toLowerCase();
console.log("DIGEST-LOCK (digestToSign + passthrough) == permissionless:", mine === ref);

if (process.env.RUN_SEND === "1") {
  // Sponsorship policy (user-owned in Pimlico): testnet gas is sponsored, no balance needed.
  const sponsorshipPolicyId = process.env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "sp_next_micromax";
  const pimlico = createPimlicoClient({ transport: http(url) });
  const sac = createSmartAccountClient({
    account, chain: baseSepolia, bundlerTransport: http(url),
    paymaster: pimlico,
    paymasterContext: { sponsorshipPolicyId },   // -> pm_sponsorUserOperation params[2]
    userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
  });
  // Explicitly sign the EIP-7702 authorization (delegate the fresh EOA to our Kernel impl) so we control
  // chainId + nonce — permissionless's auto-signed stub recovered to the wrong signer. viem uses a provided
  // `authorization` object verbatim (no stub).
  const authNonce = await client.getTransactionCount({ address: owner.address });
  const authorization = await owner.signAuthorization({
    contractAddress: account.authorization.address,   // our Kernel impl 0xd6CEDD..
    chainId: baseSepolia.id,
    nonce: authNonce,
  });
  console.log("sponsorshipPolicyId:", sponsorshipPolicyId, "| authNonce:", authNonce, "| delegate->", account.authorization.address);
  const h = await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: "0x" }], authorization });
  console.log("userOpHash:", h);
  const r = await sac.waitForUserOperationReceipt({ hash: h });
  console.log("RECEIPT tx:", r.receipt.transactionHash, "| success:", r.success, "| block:", r.receipt.blockNumber);
}
