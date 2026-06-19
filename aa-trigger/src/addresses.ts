import { createPublicClient, http, type Address } from "viem";
import { mainnet, base } from "viem/chains";
import { entryPoint07Address } from "viem/account-abstraction";
import { SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";

// Module addresses are sourced from the audited SDKs (one authoritative source) and cross-checked on-chain
// by the boot gate below (the second source). They are NOT hand-typed literals — a wrong module/account
// address would send funds to the wrong contract (ADR-0024, catastrophic).
export const ENTRYPOINT_V07: Address = entryPoint07Address;
export const SMART_SESSIONS_MODULE: Address = SMART_SESSIONS_ADDRESS as Address;

export const CHAINS = {
  1: { chain: mainnet, rpc: process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com" },
  8453: { chain: base, rpc: process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com" },
} as const;

export type SupportedChainId = keyof typeof CHAINS;

/**
 * Boot-checksum gate (ADR-0024 highest-care): refuse to start unless the SDK-pinned addresses carry
 * deployed code on BOTH ETH + Base. CREATE2 ⇒ the Smart Sessions module address is identical across
 * chains; we assert code exists at it on each. This is the runtime guard behind the SDK sourcing.
 */
export async function verifyAddressesOnChain(): Promise<void> {
  const targets: Array<readonly [string, Address]> = [
    ["EntryPoint v0.7", ENTRYPOINT_V07],
    ["SmartSessions module", SMART_SESSIONS_MODULE],
  ];
  for (const [chainId, cfg] of Object.entries(CHAINS)) {
    const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
    for (const [name, addr] of targets) {
      const code = await client.getCode({ address: addr });
      if (!code || code === "0x") {
        throw new Error(`[address-gate] ${name} (${addr}) has NO code on chain ${chainId} — refusing to start`);
      }
    }
  }
}
