import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";

/**
 * Copy-Trading detection (PRD-06 / KAN-149 C5) — turn an Alchemy Address-Activity webhook into scaled mirror
 * intents. Pure + deterministic (no network): HMAC verify (fail-closed) → parse followed-source→router token
 * spends → scale. The gated submit (SubmitGate + submitMirror, C4) + the per-router swap-calldata adapter +
 * ENABLE-mode-on-first-use are wired on top (C6).
 *
 * 🔒 Security: HMAC fail-closed (no signing key / bad sig ⇒ reject); router ALLOWLIST (an unknown router is
 * ignored — never a blind mirror); idempotency is the SubmitGate's job (per sourceTxHash).
 */

/** Allowlisted DEX routers per chain (Q-C: Uniswap Universal Router first; additive). Lower-cased. */
export const ROUTER_ALLOWLIST: Record<number, Set<string>> = {
  1: new Set(["0x66a9893cc07d91d95644aedd05d03f95e1dba8af"]),    // UniversalRouter (Ethereum)
  8453: new Set(["0x6ff5693b99212da76ad316178a184ab56d299b43"]), // UniversalRouter (Base)
};

export function isAllowlistedRouter(chainId: number, router: string): boolean {
  return ROUTER_ALLOWLIST[chainId]?.has(router.toLowerCase()) ?? false;
}

/**
 * TEST-ONLY: allowlist an extra router for an E2E (e.g. a no-code test router so the full pipeline can land a
 * receipt without DEX liquidity). Production routers live in the static ROUTER_ALLOWLIST above; the `__` prefix
 * marks this test-only — never call it on a production code path.
 */
export function __allowTestRouter(chainId: number, router: string): void {
  (ROUTER_ALLOWLIST[chainId] ??= new Set()).add(router.toLowerCase());
}

/**
 * Verify the Alchemy webhook HMAC (`x-alchemy-signature` = hex HMAC-SHA256 of the RAW body with the webhook's
 * signing key). Fail-closed: missing key/signature or any length/》value mismatch ⇒ false. Timing-safe compare.
 */
export function verifyAlchemySignature(rawBody: string, signature: string | undefined, signingKey: string | undefined): boolean {
  if (!signingKey || !signature) return false;
  const expected = createHmac("sha256", signingKey).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature.toLowerCase().replace(/^0x/, ""), "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A detected followed-trader spend = the input leg of a swap (an ERC-20 transfer source→router). */
export interface DetectedSpend {
  source: Address;        // the followed trader (activity.fromAddress)
  router: Address;        // the allowlisted DEX router (activity.toAddress)
  tokenIn: Address;       // the spent ERC-20 (activity.rawContract.address)
  amountIn: bigint;       // raw token amount spent
  sourceTxHash: string;   // the source tx (idempotency key for the mirror)
  chainId: number;
}

/** Alchemy network slug → chainId (the subset we mirror on). */
const NETWORK_CHAIN: Record<string, number> = {
  ETH_MAINNET: 1, BASE_MAINNET: 8453, BASE_SEPOLIA: 84532,
};

/**
 * Parse an Alchemy Address-Activity payload into the followed-source→allowlisted-router ERC-20 spends. Anything
 * else (external transfers, non-followed source, unknown/non-allowlisted router, missing token/amount) is
 * dropped — no blind mirror. Pure; the caller supplies `isFollowed` (the set of followed source addresses).
 */
export function parseFollowedSpends(payload: unknown, isFollowed: (addr: string) => boolean): DetectedSpend[] {
  const p = payload as { event?: { network?: string; activity?: unknown[] } };
  const chainId = NETWORK_CHAIN[p.event?.network ?? ""] ?? 0;
  if (!chainId) return [];
  const out: DetectedSpend[] = [];
  for (const aRaw of p.event?.activity ?? []) {
    const a = aRaw as {
      category?: string; fromAddress?: string; toAddress?: string; hash?: string;
      rawContract?: { address?: string; rawValue?: string };
    };
    if (a.category !== "token") continue;                       // ERC-20 transfers only
    const { fromAddress: from, toAddress: to, hash } = a;
    const token = a.rawContract?.address;
    const rawValue = a.rawContract?.rawValue;
    if (!from || !to || !hash || !token || !rawValue) continue;
    if (!isFollowed(from)) continue;                            // must originate from a followed trader
    if (!isAllowlistedRouter(chainId, to)) continue;            // must go to an allowlisted router
    let amountIn: bigint;
    try { amountIn = BigInt(rawValue); } catch { continue; }
    if (amountIn <= 0n) continue;
    out.push({
      source: getAddress(from), router: getAddress(to), tokenIn: getAddress(token),
      amountIn, sourceTxHash: hash, chainId,
    });
  }
  return out;
}

/**
 * Scale a source spend to the follower's mirror size: `mirror = amountIn × allocationBps / 10_000`, clamped to
 * the session's remaining on-chain cap (`remainingCap = capTotalBudget − spentTotal`). Returns 0n if nothing is
 * mirrorable (allocation 0 or cap exhausted) — the caller skips a 0 mirror.
 */
export function scaleMirror(amountIn: bigint, allocationBps: number, remainingCap: bigint): bigint {
  if (allocationBps <= 0 || remainingCap <= 0n) return 0n;
  const scaled = (amountIn * BigInt(Math.floor(allocationBps))) / 10_000n;
  return scaled > remainingCap ? remainingCap : scaled;
}
