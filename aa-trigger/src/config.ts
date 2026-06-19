import type { SupportedChainId } from "./addresses.js";

/** Loopback port — the Kotlin User-Service is the only caller (it has already validated the user JWT). */
export const PORT = Number(process.env.AA_TRIGGER_PORT ?? 8090);
export const HOST = "127.0.0.1";

/** Pimlico bundler+paymaster URL per chain. The API key is a host secret (never in the repo). */
export function pimlicoUrl(chainId: SupportedChainId): string {
  const key = process.env.PIMLICO_API_KEY;
  if (!key) throw new Error("PIMLICO_API_KEY not set");
  const network = chainId === 1 ? "ethereum" : chainId === 84532 ? "base-sepolia" : "base";
  return `https://api.pimlico.io/v2/${network}/rpc?apikey=${key}`;
}

/**
 * Pimlico sponsorship-policy id (the user owns the policy in the Pimlico dashboard; not a secret, but
 * environment-specific). Passed as `paymasterContext.sponsorshipPolicyId` → `pm_sponsorUserOperation`
 * params[2]; the paymaster only sponsors gas for ops matching the policy (chain/spend caps live there).
 */
export const SPONSORSHIP_POLICY_ID = process.env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "sp_next_micromax";

/** The paymaster context the smart-account client passes to Pimlico for gas sponsorship. */
export function paymasterContext(): { sponsorshipPolicyId: string } {
  return { sponsorshipPolicyId: SPONSORSHIP_POLICY_ID };
}
