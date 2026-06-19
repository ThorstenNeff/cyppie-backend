import { createPublicClient, http, type Address, type Hex } from "viem";
import { CHAINS, type SupportedChainId } from "./addresses.js";

export function publicClientFor(chainId: SupportedChainId) {
  const cfg = CHAINS[chainId];
  return createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
}

/**
 * EIP-7702 same-address invariant: the smart-account address IS the owner EOA address (= the SIWE
 * identity, [[0026]]). No new address, no fund migration. (Verifiable now without Pimlico.)
 */
export function sca7702Address(owner: Address): Address {
  return owner;
}

/**
 * Is the EOA already upgraded to the Kernel SCA via EIP-7702? A 7702-delegated account carries code of
 * the form `0xef0100 ‖ <implementation address>` (the EIP-7702 delegation designator). Verifiable on
 * both chains with a public RPC — no Pimlico, no bundler.
 */
export async function isUpgraded(chainId: SupportedChainId, owner: Address): Promise<boolean> {
  const code = await publicClientFor(chainId).getCode({ address: owner });
  return !!code && code.toLowerCase().startsWith("0xef0100");
}

/**
 * Wrap the app's raw 65-byte ECDSA signature (over the userOpHash) into Kernel's validator envelope
 * (the format Kernel's root/ECDSA validator recovers from). Dev-1's app only ever produces the raw
 * 65-byte; the exact envelope bytes are LOCKED in the live pass by comparing this against
 * permissionless.js `account.signUserOperation` on a deterministic dummy op (no Pimlico needed for that
 * comparison — the userOpHash + signing are deterministic). Until locked, this is the passthrough shape.
 */
export function wrapKernelSignature(rawSignature: Hex): Hex {
  // TODO(live-pass): lock the exact Kernel v3/7702 root-validator envelope vs permissionless.signUserOperation.
  return rawSignature;
}

export interface DcaAction {
  kind: "dca";
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  router: Address;
  minOut?: bigint;
}

/**
 * Build an unsigned UserOperation for an action and return the userOpHash (= Dev-1's `digestToSign`).
 *
 * ⚠️ Pimlico-dependent: the gas fields (callGasLimit/verificationGasLimit/preVerificationGas/fees) come
 * from the bundler's `estimateUserOperationGas`, and the userOpHash includes them — so a correct digest
 * requires the Pimlico client. Implemented in the live pass (PIMLICO_API_KEY + Base Sepolia). The call
 * encoding + the account wiring (to7702KernelSmartAccount) are structured here.
 */
export async function buildUserOp(
  _chainId: SupportedChainId,
  _account: Address,
  _action: DcaAction,
): Promise<{ userOpHash: Hex; userOp: unknown }> {
  throw new Error("buildUserOp: live pass — needs PIMLICO_API_KEY (bundler gas estimation)");
}
