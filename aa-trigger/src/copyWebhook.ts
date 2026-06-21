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
 * KAN-161 dynamic-mode `tokenOut` allowlist — the CURATED (not permissionless) set of established, deep-V3-pool
 * tokens the dynamic copy may buy, per chain. In DYNAMIC mode the webhook mirrors ONLY when the derived
 * `tokenOutDetected` is on the chain's list; off-list ⇒ fail-closed skip (bounds rug/honeypot/illiquid exposure,
 * ADR-0024). Does NOT apply to FIXED mode (the user pre-committed to a trusted token). Addresses verified
 * on-chain via symbol(); extend HERE (single source). Initial set is PO-reviewed.
 */
export const TOKENOUT_ALLOWLIST: Record<number, Set<string>> = {
  1: new Set([
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
  ]),
  8453: new Set([
    "0x4200000000000000000000000000000000000006", // WETH
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
    "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", // cbETH
  ]),
};

export function isAllowlistedTokenOut(chainId: number, token: string): boolean {
  return TOKENOUT_ALLOWLIST[chainId]?.has(token.toLowerCase()) ?? false;
}

/**
 * TEST-ONLY: allowlist an extra router for an E2E (e.g. a no-code test router so the full pipeline can land a
 * receipt without DEX liquidity). Production routers live in the static ROUTER_ALLOWLIST above.
 *
 * P2-4 (KAN-156): hard fail-closed in prod — mutates the SHARED production allowlist, so it throws unless
 * `COPY_TEST_HOOKS=1` (E2E only). Ships in the bundle but cannot widen the prod allowlist.
 */
export function __allowTestRouter(chainId: number, router: string): void {
  if (process.env.COPY_TEST_HOOKS !== "1") throw new Error("__allowTestRouter is test-only (set COPY_TEST_HOOKS=1)");
  (ROUTER_ALLOWLIST[chainId] ??= new Set()).add(router.toLowerCase());
}

/** TEST-ONLY (KAN-161): allowlist a tokenOut for an E2E (e.g. a testnet chain). Throws unless COPY_TEST_HOOKS=1. */
export function __allowTestTokenOut(chainId: number, token: string): void {
  if (process.env.COPY_TEST_HOOKS !== "1") throw new Error("__allowTestTokenOut is test-only (set COPY_TEST_HOOKS=1)");
  (TOKENOUT_ALLOWLIST[chainId] ??= new Set()).add(token.toLowerCase());
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
  sourceTxHash: string;   // the source tx hash
  logIndex: number;       // the on-chain log index within the tx (P2-2: a multi-swap tx has distinct legs)
  chainId: number;
  // KAN-161 dynamic mode: the token the trader RECEIVED in the same tx (output leg) — used as the mirror's
  // tokenOut when the session's scope.tokenOut is null (dynamic). Absent if no unambiguous output leg was seen.
  tokenOutDetected?: Address;
  amountOutDetected?: bigint;
}

/** P2-2 (KAN-156): the idempotency key for a mirror — `txHash:logIndex`, so each leg of a multi-swap tx mirrors. */
export function spendKey(s: { sourceTxHash: string; logIndex: number }): string {
  return `${s.sourceTxHash.toLowerCase()}:${s.logIndex}`;
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
/**
 * KAN-161 dynamic mode: derive the OUTPUT leg of a source swap = the unique token the `source` RECEIVED in the
 * same tx (an ERC-20 transfer to `source`, in `hash`, distinct from `tokenIn`). Returns null if there's no such
 * leg or it's ambiguous (>1 distinct received token) — the caller then fail-closes the dynamic mirror (no blind
 * guess of what to buy). Pure; scans the same webhook payload.
 */
function deriveOutputLeg(activities: unknown[], hash: string, source: string, tokenIn: string): { tokenOut: Address; amountOut: bigint } | null {
  const s = source.toLowerCase(), tin = tokenIn.toLowerCase();
  const received = new Map<string, bigint>();
  for (const aRaw of activities) {
    try {
      const a = aRaw as { category?: string; toAddress?: string; hash?: string; rawContract?: { address?: string; rawValue?: string } };
      if (a.category !== "token" || a.hash !== hash || (a.toAddress ?? "").toLowerCase() !== s) continue;
      const tok = a.rawContract?.address; const raw = a.rawContract?.rawValue;
      if (!tok || !raw) continue;
      const t = tok.toLowerCase();
      if (t === tin) continue; // not the input token
      const amt = BigInt(raw);
      if (amt <= 0n) continue;
      received.set(t, (received.get(t) ?? 0n) + amt);
    } catch { continue; }
  }
  if (received.size !== 1) return null; // none or ambiguous → dynamic fail-closed
  const entry = [...received.entries()][0]!;
  return { tokenOut: getAddress(entry[0]), amountOut: entry[1] };
}

export function parseFollowedSpends(payload: unknown, isFollowed: (addr: string) => boolean): DetectedSpend[] {
  const p = payload as { event?: { network?: string; activity?: unknown[] } };
  const chainId = NETWORK_CHAIN[p.event?.network ?? ""] ?? 0;
  if (!chainId) return [];
  const activities = p.event?.activity ?? [];
  const out: DetectedSpend[] = [];
  for (const aRaw of activities) {
    // P2-3 (KAN-156): guard EACH activity — one malformed entry (bad address → getAddress throws) must not 500 the
    // webhook (→ Alchemy retry storm + the valid spends in the same batch lost). Drop the bad one, keep the rest.
    try {
      const a = aRaw as {
        category?: string; fromAddress?: string; toAddress?: string; hash?: string;
        rawContract?: { address?: string; rawValue?: string }; log?: { logIndex?: string | number };
      };
      if (a.category !== "token") continue;                       // ERC-20 transfers only
      const { fromAddress: from, toAddress: to, hash } = a;
      const token = a.rawContract?.address;
      const rawValue = a.rawContract?.rawValue;
      if (!from || !to || !hash || !token || !rawValue) continue;
      if (!isFollowed(from)) continue;                            // must originate from a followed trader
      if (!isAllowlistedRouter(chainId, to)) continue;            // must go to an allowlisted router
      const amountIn = BigInt(rawValue);
      if (amountIn <= 0n) continue;
      const li = a.log?.logIndex;                                 // P2-2: on-chain log index (hex or number); 0 if absent
      const logIndex = li != null && Number.isFinite(Number(li)) ? Number(li) : 0;
      const outLeg = deriveOutputLeg(activities, hash, from, token); // KAN-161: what the trader received (dynamic mode)
      out.push({
        source: getAddress(from), router: getAddress(to), tokenIn: getAddress(token),
        amountIn, sourceTxHash: hash, logIndex, chainId,
        tokenOutDetected: outLeg?.tokenOut, amountOutDetected: outLeg?.amountOut,
      });
    } catch {
      continue; // malformed activity — drop it, never let it sink the batch
    }
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
