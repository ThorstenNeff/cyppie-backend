import { createPublicClient, http, type Address, type Hex } from "viem";
import { entryPoint07Address, getUserOperationHash, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getOwnableValidatorMockSignature, encodeSmartSessionSignature, SmartSessionMode } from "@rhinestone/module-sdk";
import { chainCtxFor, watchOwner, type Call, type ChainCtx } from "./userop.js";
import { SPONSORSHIP_POLICY_ID } from "./config.js";
import { buildUseModeUserOpSignature, smartSessionUseModeNonceKey, type CopyRecord } from "./copySession.js";
import type { SessionKeySigner } from "./sessionKeySigner.js";

/**
 * Submit a Copy-Trading mirror UserOp (PRD-06 / KAN-149 C4 — the money-path trigger).
 *
 * 🔑 Auth ≠ Custody: signed ONLY by the backend-held, scoped Smart-Session key (never the follower's main
 * key). USE-mode through the Smart Session — the on-chain Router/Selector/Cap/Window policies are the hard
 * bound; the SubmitGate (kill-switch + Q7) is the off-chain fail-fast in front of it.
 *
 * Assembly is the C3-proven path (Kernel 7702, Base Sepolia receipts): validator-nonce vtype=0x01 read from
 * the EntryPoint; explicit generous gas (the session-validator hard-reverts on a mock sig, so mock-sig gas
 * estimation is unusable; sponsored ⇒ over-estimation is free); the real session signature over the RAW
 * userOpHash; sponsored paymaster data from the prepare path.
 */
export const ENTRYPOINT_GETNONCE_ABI = [
  { type: "function", name: "getNonce", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint192" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * P2-1 (KAN-156): poll a submitted mirror's on-chain OUTCOME so the registry charges on INCLUSION, not on
 * bundler-accept. Returns "success" / "reverted" once a receipt lands, or "pending" after the window (the caller
 * then leaves the reservation booked + logs for reconcile — never under-counts the cap on a maybe-landed op).
 */
export async function waitMirrorOutcome(
  chainId: 1 | 8453 | 84532, userOpHash: Hex, { tries = 20, delayMs = 3000 }: { tries?: number; delayMs?: number } = {},
): Promise<"success" | "reverted" | "pending"> {
  const ctx = chainCtxFor(chainId);
  const bundler = createBundlerClient({ chain: ctx.chain, transport: http(ctx.bundlerUrl) });
  for (let i = 0; i < tries; i++) {
    const r = await bundler.getUserOperationReceipt({ hash: userOpHash }).catch(() => null);
    if (r) return r.success ? "success" : "reverted";
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return "pending";
}

export async function submitMirror(record: CopyRecord, signer: SessionKeySigner, calls: Call[], nonceKey = 0): Promise<{ userOpHash: Hex }> {
  const ctx: ChainCtx = chainCtxFor(record.scope.chainId as 1 | 8453 | 84532);
  const follower = record.scope.follower as Address;
  const publicClient = createPublicClient({ chain: ctx.chain, transport: http(ctx.publicRpc) });
  const account = await to7702KernelSmartAccount({
    client: publicClient, owner: watchOwner(follower),
    entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3",
  });
  const pimlico = createPimlicoClient({ transport: http(ctx.bundlerUrl) });
  const sac = createSmartAccountClient({
    account, chain: ctx.chain, bundlerTransport: http(ctx.bundlerUrl),
    paymaster: pimlico, paymasterContext: { sponsorshipPolicyId: SPONSORSHIP_POLICY_ID },
    userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
  });
  const bundler = createBundlerClient({ chain: ctx.chain, transport: http(ctx.bundlerUrl) });

  // Route to the Smart Sessions validator (vtype=0x01); read the nonce from the EntryPoint directly.
  const nonce = await publicClient.readContract({
    address: entryPoint07Address, abi: ENTRYPOINT_GETNONCE_ABI, functionName: "getNonce",
    args: [follower, smartSessionUseModeNonceKey(nonceKey)], // P1-1: distinct lane per concurrent op for this follower
  });
  // Explicit generous gas (skips the mock-sig estimation the session-validator would hard-revert) + sponsored
  // paymaster data via the prepare path. The USE stub is a placeholder; replaced by the real sig below.
  const useStub = encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId: record.permissionId, signature: getOwnableValidatorMockSignature({ threshold: 1 }) });
  const op = await sac.prepareUserOperation({
    calls, nonce,
    callGasLimit: 600_000n, verificationGasLimit: 1_500_000n, preVerificationGas: 200_000n,
    paymasterVerificationGasLimit: 400_000n, paymasterPostOpGasLimit: 100_000n,
    signature: useStub,
  });
  const userOpHash = getUserOperationHash({ userOperation: op, entryPointAddress: entryPoint07Address, entryPointVersion: "0.7", chainId: ctx.chain.id });
  op.signature = await buildUseModeUserOpSignature(signer, userOpHash, record.permissionId); // raw userOpHash (C3 lock)
  const submitted = await bundler.sendUserOperation({ ...op, entryPointAddress: entryPoint07Address });
  return { userOpHash: submitted };
}
