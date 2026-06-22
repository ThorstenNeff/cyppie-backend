import { createPublicClient, http, parseAbi, getAddress, type Address } from "viem";
import { chainCtxFor } from "./userop.js";
import type { CapQuote } from "./strategyCaps.js";

/**
 * One-time Uniswap QuoterV2 price snapshot for the Vaults-B cap derivation (KAN-164 (B)). A `view`/`eth_call`
 * snapshot at `prepare` ONLY — NOT a live oracle / no running dependency. The result feeds {@link deriveSellCaps}
 * as quote pairs, after which the caps are static token-unit values pinned into the enable + enforced on-chain.
 *
 * 🔒 Least-privilege: the quoter is read from a fixed per-chain ALLOWLIST (the canonical Uniswap QuoterV2), so a
 * caller can't point the snapshot at an attacker contract that fakes a price (which would inflate a Sell-Cap).
 */
const QUOTER_V2: Record<number, Address> = {
  1: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",      // Ethereum
  8453: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",   // Base
  84532: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",  // Base Sepolia
};

const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const ERC20_DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

/**
 * Snapshot, for each basket token, a quote of `1 token` → budgetToken (the reference amount = 10^decimals, so the
 * amountIn/amountOut ratio is a clean per-token price). Skips the budget token (price 1 — handled in deriveSellCaps).
 * Rejects a dead pool (amountOut == 0). `feeTier` is the V3 pool fee to quote through.
 */
export async function snapshotSellQuotes(
  chainId: 1 | 8453 | 84532, budgetToken: Address, basketTokens: Address[], feeTier: number,
): Promise<CapQuote[]> {
  const quoter = QUOTER_V2[chainId];
  if (!quoter) throw new Error(`no allowlisted QuoterV2 for chain ${chainId}`);
  const ctx = chainCtxFor(chainId);
  const client = createPublicClient({ chain: ctx.chain, transport: http(ctx.publicRpc) });

  const out: CapQuote[] = [];
  for (const token of basketTokens) {
    if (token.toLowerCase() === budgetToken.toLowerCase()) continue; // source token: price 1, no quote
    const decimals = await client.readContract({ address: getAddress(token), abi: ERC20_DECIMALS_ABI, functionName: "decimals" });
    const amountIn = 10n ** BigInt(decimals); // 1 whole token_i
    const { result } = await client.simulateContract({
      address: quoter, abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
      args: [{ tokenIn: getAddress(token), tokenOut: getAddress(budgetToken), amountIn, fee: feeTier, sqrtPriceLimitX96: 0n }],
    });
    const amountOut = result[0];
    if (amountOut <= 0n) throw new Error(`dead pool: no liquidity quoting ${token} → ${budgetToken} (fee ${feeTier})`);
    out.push({ token: getAddress(token), amountIn, amountOut });
  }
  return out;
}
