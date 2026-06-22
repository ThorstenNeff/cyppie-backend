import { createPublicClient, http, type Address, type Hex } from "viem";
import { entryPoint07Address, getUserOperationHash, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getOwnableValidatorMockSignature, getOwnableValidatorSignature, encodeSmartSessionSignature, SmartSessionMode } from "@rhinestone/module-sdk";
import { chainCtxFor, watchOwner, serializeOp, deserializeOp, type Call, type SerializedUserOp } from "./userop.js";
import { SPONSORSHIP_POLICY_ID } from "./config.js";
import { smartSessionUseModeNonceKey } from "./copySession.js";
import { ENTRYPOINT_GETNONCE_ABI } from "./mirror.js";
import { buildDcaBuyCalls, type DcaBuyPlan } from "./dcaAdapter.js";

/**
 * DCA recurring-buy build/submit (KAN-163) — USE-mode through the scoped DCA Smart-Session, **owner-signed
 * on-device** (Q1). Mirrors the copy `submitMirror` money-path but SPLIT for on-device signing:
 *   build  → prepare the sponsored USE-mode buy op (smart-session nonce, explicit gas) + return the digest;
 *   submit → wrap the app's signature USE-mode and send.
 *
 * 🔒 The DCA session's OwnableValidator owner is the user's on-device key, so the app signs the **RAW userOpHash**
 * (the C3 USE-mode lock — the OwnableValidator session-validator recovers raw, NOT the EIP-191 form the Kernel
 * root / enable path uses). `digestToSign === userOpHash`. The on-chain SpendingLimits/TimeFrame policies are the
 * hard bound; the User-Service SubmitGate (kill-switch + Q7) gates before this is ever called.
 */
export interface DcaBuilt {
  userOpHash: Hex;
  digestToSign: Hex; // == userOpHash (RAW — the app raw-secp256k1-signs THIS on-device for the OwnableValidator)
  userOp: SerializedUserOp;
}

/** Build the sponsored USE-mode DCA buy op for a scoped session; returns the raw-userOpHash digest to sign. */
export async function buildDcaBuy(
  chainId: 1 | 8453 | 84532, account: Address, permissionId: Hex, plan: Omit<DcaBuyPlan, "chainId" | "recipient">, nonceKey = 0,
): Promise<DcaBuilt> {
  const ctx = chainCtxFor(chainId);
  const publicClient = createPublicClient({ chain: ctx.chain, transport: http(ctx.publicRpc) });
  const acct = await to7702KernelSmartAccount({ client: publicClient, owner: watchOwner(account), entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
  const pimlico = createPimlicoClient({ transport: http(ctx.bundlerUrl) });
  const sac = createSmartAccountClient({
    account: acct, chain: ctx.chain, bundlerTransport: http(ctx.bundlerUrl), paymaster: pimlico,
    paymasterContext: { sponsorshipPolicyId: SPONSORSHIP_POLICY_ID },
    userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
  });
  const calls: Call[] = buildDcaBuyCalls({ ...plan, chainId, recipient: account });
  const nonce = await publicClient.readContract({
    address: entryPoint07Address, abi: ENTRYPOINT_GETNONCE_ABI, functionName: "getNonce",
    args: [account, smartSessionUseModeNonceKey(nonceKey)], // smart-session validator lane (vtype=0x01)
  });
  // Explicit generous gas (the session-validator hard-reverts on a mock sig, so mock-sig estimation is unusable;
  // sponsored ⇒ over-estimation is free). USE stub for the sponsored prepare; replaced by the app sig on submit.
  const useStub = encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature: getOwnableValidatorMockSignature({ threshold: 1 }) });
  const op = await sac.prepareUserOperation({
    calls, nonce,
    callGasLimit: 600_000n, verificationGasLimit: 1_500_000n, preVerificationGas: 200_000n,
    paymasterVerificationGasLimit: 400_000n, paymasterPostOpGasLimit: 100_000n, signature: useStub,
  });
  const userOpHash = getUserOperationHash({ userOperation: op, entryPointAddress: entryPoint07Address, entryPointVersion: "0.7", chainId: ctx.chain.id });
  return { userOpHash, digestToSign: userOpHash, userOp: serializeOp(op as Record<string, unknown>) };
}

/** Submit a built DCA buy with the app's on-device signature (raw over userOpHash) — wrapped USE-mode. */
export async function submitDcaBuy(chainId: 1 | 8453 | 84532, permissionId: Hex, userOp: SerializedUserOp, appSignature: Hex): Promise<{ userOpHash: Hex }> {
  const ctx = chainCtxFor(chainId);
  const bundler = createBundlerClient({ chain: ctx.chain, transport: http(ctx.bundlerUrl) });
  const op = deserializeOp(userOp);
  const ownableSig = getOwnableValidatorSignature({ signatures: [appSignature] }) as Hex;
  op.signature = encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature: ownableSig });
  const userOpHash = await bundler.sendUserOperation({ ...(op as Record<string, unknown>), entryPointAddress: entryPoint07Address } as never);
  return { userOpHash };
}
