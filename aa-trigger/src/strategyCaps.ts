import { getAddress, type Address } from "viem";
import type { StrategyLeg } from "./strategySession.js";

/**
 * Vaults-B per-token Sell-Cap derivation (KAN-164 (B)) — the SINGLE SOURCE the PO pinned: the `prepare` engine
 * computes the caps from the user's intent so the cap-formula == the envelope the rebalance engine operates in
 * (the app does NOT derive them → no formula duplication / drift). The same {@link deriveSellCaps} output feeds
 * BOTH the strategy ENABLE (the on-chain Sell-Caps, via {@link sellCapsToScopeLegs}) AND the rebalance clamp
 * (via {@link sellCapsToClampMap}). Σ caps = the worst-case sellable, the security envelope.
 *
 * Formula (PO):  cap_i = ceil( budget × weight_i × turnover / price_i^snapshot )   [in token_i base units]
 *  - `price_i^snapshot` is a ONE-TIME QuoterV2 view-call snapshot at prepare (no live oracle, no running
 *    dependency). It enters here as a quote PAIR {amountIn (token_i base), amountOut (budgetToken base)} so the
 *    formula stays pure + unit-correct: token_i-per-budgetToken = amountIn / amountOut. After prepare the caps are
 *    STATIC token-unit values, pinned into the enable and enforced on-chain in token units.
 *  - `turnover` is a conservative constant (default 2, ADR-0024-tight) — the cumulative-cap buffer (SpendingLimits
 *    is cumulative, like copy capTotalBudget). Additively loosenable.
 *  - `ceil` (round UP) so the cap never rounds BELOW the intended max sell and blocks a legitimate rebalance.
 *  - The BUDGET token is the source (it funds the basket): its cap = budget × turnover (price 1 — the whole budget
 *    can rotate out of it). If the budget token is also a basket member, the larger (source) cap wins.
 */
export const TURNOVER_DEFAULT = 2;

/** A QuoterV2 snapshot for one basket token: a quote of `amountIn` token_i → `amountOut` budgetToken (base units). */
export interface CapQuote {
  token: Address;
  amountIn: bigint;  // reference amount of token_i (token_i base units) that was quoted
  amountOut: bigint; // the quote result in budgetToken base units (MUST be > 0 — a dead pool is rejected upstream)
}

/** The intent the user grants (the on-chain-scope-determining part). */
export interface StrategyIntent {
  budgetToken: Address;
  budget: bigint; // total capital, in budgetToken base units
  basket: { token: Address; weightBps: number }[]; // target allocation; SHOULD sum to 10_000
}

/** A derived per-token Sell-Cap (FR-6 wire shape: capBaseUnits is a base-unit decimal string). */
export interface SellCap {
  token: Address;
  capBaseUnits: string;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("deriveSellCaps: non-positive divisor (dead quote?)");
  return (a + b - 1n) / b;
}

/**
 * Derive the per-token Sell-Caps from the intent + the QuoterV2 snapshot. Pure + deterministic (KAT-locked) —
 * the network QuoterV2 read happens upstream and enters as `quotes`. Returns one cap per sell-able token (every
 * basket token + the budget token), canonical-ordered by address (matching the strategy session's leg order).
 */
export function deriveSellCaps(intent: StrategyIntent, quotes: CapQuote[], turnover: number = TURNOVER_DEFAULT): SellCap[] {
  if (intent.budget <= 0n) throw new Error("deriveSellCaps: budget must be > 0");
  if (!Number.isInteger(turnover) || turnover < 1) throw new Error("deriveSellCaps: turnover must be an integer >= 1");
  const t = BigInt(turnover);
  const quoteByToken = new Map(quotes.map((q) => [q.token.toLowerCase(), q]));
  const caps = new Map<string, bigint>(); // tokenLower -> cap (base units)

  // Basket tokens: cap_i = ceil(budget × weightBps_i × turnover × amountIn_i / (10000 × amountOut_i)).
  for (const { token, weightBps } of intent.basket) {
    if (weightBps < 0) throw new Error("deriveSellCaps: weightBps must be >= 0");
    if (weightBps === 0) continue;
    const q = quoteByToken.get(token.toLowerCase());
    if (!q) throw new Error(`deriveSellCaps: no price snapshot for basket token ${token}`);
    const cap = ceilDiv(intent.budget * BigInt(weightBps) * t * q.amountIn, 10_000n * q.amountOut);
    const k = getAddress(token).toLowerCase();
    if (cap > (caps.get(k) ?? 0n)) caps.set(k, cap);
  }

  // The budget token is the source — the whole budget can rotate out of it: cap = budget × turnover (price 1).
  // (max-wins if it is also a weighted basket member.)
  {
    const k = getAddress(intent.budgetToken).toLowerCase();
    const sourceCap = intent.budget * t;
    if (sourceCap > (caps.get(k) ?? 0n)) caps.set(k, sourceCap);
  }

  return [...caps.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1)) // canonical address order (matches sortLegs in the enable)
    .map(([token, cap]) => ({ token: getAddress(token), capBaseUnits: cap.toString() }));
}

/** SINGLE-SOURCE: the derived caps → the strategy session's Sell-Cap legs (the ENABLE side). */
export function sellCapsToScopeLegs(caps: SellCap[]): StrategyLeg[] {
  return caps.map((c) => ({ token: c.token, cap: BigInt(c.capBaseUnits) }));
}

/** SINGLE-SOURCE: the derived caps → the rebalance clamp map (the EXECUTION side). Keyed by lower-cased token. */
export function sellCapsToClampMap(caps: SellCap[]): Map<string, bigint> {
  return new Map(caps.map((c) => [c.token.toLowerCase(), BigInt(c.capBaseUnits)]));
}
