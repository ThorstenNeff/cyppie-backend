import { createPublicClient, http, hashMessage, type Address, type Chain, type Hex } from "viem";
import { toAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { CHAINS, type SupportedChainId } from "./addresses.js";
import { SPONSORSHIP_POLICY_ID, pimlicoUrl } from "./config.js";

function chainCfg(chainId: SupportedChainId) {
  const cfg = CHAINS[chainId];
  if (!cfg) throw new Error(`chain ${chainId} is not enabled (set AA_ALLOW_TESTNET=1 for Base Sepolia)`);
  return cfg;
}

export function publicClientFor(chainId: SupportedChainId) {
  const cfg = chainCfg(chainId);
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
 * 🔒 The exact digest Dev-1's app must raw-sign on-device (KERNEL-WRAPPING-LOCK, verified on Base Sepolia
 * against permissionless.js `account.signUserOperation`). Kernel's 7702 root/ECDSA validator recovers from
 * the **EIP-191 (`hashMessage`) form of the userOpHash** — NOT the raw userOpHash. So the aa-trigger returns
 * `digestToSign(userOpHash)` and the app raw-secp256k1-signs THAT 32-byte digest → 65-byte r‖s‖v.
 */
export function digestToSign(userOpHash: Hex): Hex {
  return hashMessage({ raw: userOpHash });
}

/**
 * Wrap the app's raw 65-byte signature into Kernel's userOp signature. VERIFIED passthrough: with the
 * digest above ({@link digestToSign}), the 65-byte ECDSA signature IS the final `userOp.signature` — the
 * Kernel root validator adds no envelope bytes (refSig from permissionless is exactly 65 bytes). The
 * "wrapping" lives entirely in the EIP-191 digest, not the signature.
 */
export function wrapKernelSignature(rawSignatureOverDigest: Hex): Hex {
  return rawSignatureOverDigest;
}

// ── Chain context (decouples the money-path from the prod chain map so it's testnet-verifiable) ────────
export interface ChainCtx {
  chain: Chain;
  bundlerUrl: string; // Pimlico bundler+paymaster
  publicRpc: string;
}

export function chainCtxFor(chainId: SupportedChainId): ChainCtx {
  const cfg = chainCfg(chainId);
  return { chain: cfg.chain, bundlerUrl: pimlicoUrl(chainId), publicRpc: cfg.rpc };
}

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/** A UserOp serialized for the build→sign→submit boundary (all bigints as hex strings; JSON-safe). */
export type SerializedUserOp = Record<string, string>;

/** The unsigned EIP-7702 authorization the app must sign on-device on the FIRST op (delegate → Kernel impl). */
export interface AuthorizationToSign {
  chainId: number;
  address: Address; // Kernel implementation
  nonce: number;
}

/** The app's signed authorization, passed back to {@link submitUserOp}. */
export interface SignedAuthorization {
  chainId: number;
  address: Address;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

export interface BuiltUserOp {
  userOpHash: Hex;
  digestToSign: Hex; // = hashMessage(userOpHash); the app raw-signs THIS (DIGEST-LOCK)
  userOp: SerializedUserOp;
  authorizationToSign?: AuthorizationToSign; // present only when the account isn't yet 7702-upgraded
}

/** Watch-only owner: the backend has the address, NEVER the device key — signing throws (fail-closed). */
function watchOwner(address: Address) {
  return toAccount({
    address,
    async signMessage() { throw new Error("watch-only owner: signing happens on-device"); },
    async signTransaction() { throw new Error("watch-only owner: signing happens on-device"); },
    async signTypedData() { throw new Error("watch-only owner: signing happens on-device"); },
  });
}

const OP_BIGINT_FIELDS = [
  "nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas",
  "maxFeePerGas", "maxPriorityFeePerGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit",
] as const;
const OP_HEX_FIELDS = ["sender", "callData", "factory", "factoryData", "paymaster", "paymasterData"] as const;

function serializeOp(op: Record<string, unknown>): SerializedUserOp {
  const out: SerializedUserOp = {};
  for (const f of OP_BIGINT_FIELDS) if (op[f] !== undefined) out[f] = "0x" + (op[f] as bigint).toString(16);
  for (const f of OP_HEX_FIELDS) if (op[f] !== undefined) out[f] = op[f] as string;
  return out;
}

function deserializeOp(s: SerializedUserOp): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of OP_BIGINT_FIELDS) if (s[f] !== undefined) out[f] = BigInt(s[f]);
  for (const f of OP_HEX_FIELDS) if (s[f] !== undefined) out[f] = s[f];
  return out;
}

async function kernelAccount(ctx: ChainCtx, owner: ReturnType<typeof watchOwner>) {
  const client = createPublicClient({ chain: ctx.chain, transport: http(ctx.publicRpc) });
  return to7702KernelSmartAccount({
    client, owner,
    entryPoint: { address: entryPoint07Address, version: "0.7" },
    version: "0.3.3",
  });
}

/**
 * Build a fully-populated, **sponsored, unsigned** UserOperation and return the digest the app must sign.
 *
 * The backend holds only the owner ADDRESS (watch-only) — never the device key. Gas is estimated and the
 * Pimlico paymaster (sponsorship policy) is applied during prepare, so the returned `userOp` is final and
 * `userOpHash` is stable. `digestToSign = hashMessage(userOpHash)` (DIGEST-LOCK, proven vs permissionless).
 * On the first op (account not yet 7702-upgraded) it also returns the authorization the app must sign.
 */
export async function buildUserOp(ctx: ChainCtx, ownerAddress: Address, calls: Call[]): Promise<BuiltUserOp> {
  const publicClient = createPublicClient({ chain: ctx.chain, transport: http(ctx.publicRpc) });
  const account = await kernelAccount(ctx, watchOwner(ownerAddress));
  const pimlico = createPimlicoClient({ transport: http(ctx.bundlerUrl) });
  const sac = createSmartAccountClient({
    account, chain: ctx.chain, bundlerTransport: http(ctx.bundlerUrl),
    paymaster: pimlico,
    paymasterContext: { sponsorshipPolicyId: SPONSORSHIP_POLICY_ID },
    userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
  });
  const prepared = await sac.prepareUserOperation({ calls });
  const userOpHash = getUserOperationHash({
    userOperation: prepared as never, entryPointAddress: entryPoint07Address,
    entryPointVersion: "0.7", chainId: ctx.chain.id,
  });
  const code = await publicClient.getCode({ address: ownerAddress });
  const upgraded = !!code && code.toLowerCase().startsWith("0xef0100");
  let authorizationToSign: AuthorizationToSign | undefined;
  if (!upgraded) {
    const nonce = await publicClient.getTransactionCount({ address: ownerAddress });
    authorizationToSign = { chainId: ctx.chain.id, address: account.authorization.address as Address, nonce };
  }
  return { userOpHash, digestToSign: digestToSign(userOpHash), userOp: serializeOp(prepared as Record<string, unknown>), authorizationToSign };
}

/**
 * Submit the app-signed UserOp. The op from {@link buildUserOp} is sent **verbatim** (the userOpHash was
 * computed over it) with only the signature attached (passthrough — DIGEST-LOCK) plus, on the first op,
 * the app-signed 7702 authorization. No re-preparation, no re-signing (sender provided, not an account).
 */
export async function submitUserOp(
  ctx: ChainCtx, op: SerializedUserOp, signature: Hex, signedAuthorization?: SignedAuthorization,
): Promise<{ userOpHash: Hex }> {
  const bundler = createBundlerClient({ chain: ctx.chain, transport: http(ctx.bundlerUrl) });
  const request: Record<string, unknown> = {
    ...deserializeOp(op),
    signature: wrapKernelSignature(signature),
    entryPointAddress: entryPoint07Address,
  };
  if (signedAuthorization) {
    request.authorization = {
      address: signedAuthorization.address, chainId: signedAuthorization.chainId,
      nonce: signedAuthorization.nonce, r: signedAuthorization.r, s: signedAuthorization.s,
      yParity: signedAuthorization.yParity,
    };
  }
  const userOpHash = await bundler.sendUserOperation(request as never);
  return { userOpHash };
}

/** Poll a UserOp receipt (status only — does not block forever). */
export async function userOpReceipt(
  ctx: ChainCtx, userOpHash: Hex,
): Promise<{ found: boolean; success?: boolean; transactionHash?: Hex; blockNumber?: string }> {
  const bundler = createBundlerClient({ chain: ctx.chain, transport: http(ctx.bundlerUrl) });
  try {
    const r = await bundler.getUserOperationReceipt({ hash: userOpHash });
    if (!r) return { found: false };
    return { found: true, success: r.success, transactionHash: r.receipt.transactionHash, blockNumber: r.receipt.blockNumber.toString() };
  } catch {
    return { found: false };
  }
}
