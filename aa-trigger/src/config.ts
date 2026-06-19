import type { SupportedChainId } from "./addresses.js";

/** Loopback port — the Kotlin User-Service is the only caller (it has already validated the user JWT). */
export const PORT = Number(process.env.AA_TRIGGER_PORT ?? 8090);
export const HOST = "127.0.0.1";

/** Pimlico bundler+paymaster URL per chain. The API key is a host secret (never in the repo). */
export function pimlicoUrl(chainId: SupportedChainId): string {
  const key = process.env.PIMLICO_API_KEY;
  if (!key) throw new Error("PIMLICO_API_KEY not set");
  const network = chainId === 1 ? "ethereum" : "base";
  return `https://api.pimlico.io/v2/${network}/rpc?apikey=${key}`;
}
