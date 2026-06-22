import { getAddress, type Address, type Hex } from "viem";
import { universalRouterAdapter, type MirrorPlan } from "./swapAdapter.js";
import { submitUseModeOp } from "./mirror.js";
import { isAllowlistedTokenOut } from "./copyWebhook.js";
import type { Call } from "./userop.js";
import type { SessionKeySigner } from "./sessionKeySigner.js";

/**
 * Vaults-B strategy rebalance execution (KAN-164 runtime) — the drift-triggered counterpart of the copy mirror
 * (C5/C6). A drifted basket is rebalanced by selling over-weight legs into under-weight legs through the same
 * UniversalRouter path the copy mirror uses; the swap is signed by the BACKEND strategy session key (USE-mode,
 * RAW userOpHash — the C3 lock) and is hard-bounded on-chain by the session's M Sell-Caps + window + UR scope.
 *
 *   drift  → computeRebalanceLegs (which legs to swap, clamped to each sell-token's per-token cap)
 *   build  → universalRouterAdapter.buildMirrorCalls (the SAME [approve→Permit2→UR.execute] the session enables)
 *   submit → submitUseModeOp (the SAME proven USE-mode submit as the copy mirror)
 *
 * 🔑 Auth ≠ Custody: scoped session key only; the engine can never exceed the per-token caps the user granted.
 * NB (v1 scope): the drift math runs in a single ACCOUNTING UNIT (e.g. the budget token / a USD base unit). The
 * value→token-amount conversion for a non-accounting sell-leg is an oracle concern, deferred — the runtime proof
 * here is the trigger → cap-bounded execution path, not the pricing. `amountIn` is in the sell-token's units.
 */

/** A basket position valued in the common accounting unit (base units). */
export interface Position {
  token: Address;
  value: bigint; // current value of the holding, in the accounting unit
}

/** A target allocation (basis points of the total). The targets SHOULD sum to 10_000. */
export interface Target {
  token: Address;
  weightBps: number;
}

/** A rebalance swap leg: sell `amountIn` of `tokenIn` (an over-weight token) into `tokenOut` (under-weight). */
export interface RebalanceLeg {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint; // in the sell-token's units (= the accounting unit in v1)
}

/**
 * Compute the rebalance legs for a drifted basket (pure + deterministic — KAT-locked).
 *
 * v1 rule: value the basket, find each token's drift = current − target. Only act when the MAX absolute drift
 * exceeds `driftThresholdBps` of the total (else return [] — no churn). Then greedily pair the largest over-weight
 * (sell) with the largest under-weight (buy), moving `min(over, under)` value per leg, until no over-weight
 * remains. Each leg's `amountIn` is clamped to the sell-token's remaining per-token cap (the on-chain Sell-Cap is
 * the hard bound; this clamp keeps the engine from even attempting an out-of-policy pull).
 */
export function computeRebalanceLegs(
  positions: Position[], targets: Target[], driftThresholdBps: number, caps?: Map<string, bigint>,
): RebalanceLeg[] {
  const total = positions.reduce((s, p) => s + p.value, 0n);
  if (total <= 0n) return [];
  const weight = new Map<string, number>();
  for (const t of targets) weight.set(t.token.toLowerCase(), t.weightBps);

  // drift (signed value delta) per token: current − target. >0 = over-weight (sell), <0 = under-weight (buy).
  const drift = positions.map((p) => {
    const targetValue = (total * BigInt(weight.get(p.token.toLowerCase()) ?? 0)) / 10_000n;
    return { token: getAddress(p.token), delta: p.value - targetValue };
  });

  // No churn unless the worst drift exceeds the threshold (bps of total).
  const maxAbs = drift.reduce((m, d) => { const a = d.delta < 0n ? -d.delta : d.delta; return a > m ? a : m; }, 0n);
  if (maxAbs * 10_000n <= BigInt(Math.floor(driftThresholdBps)) * total) return [];

  const overs = drift.filter((d) => d.delta > 0n).sort((a, b) => (b.delta > a.delta ? 1 : -1));
  const unders = drift.filter((d) => d.delta < 0n).map((d) => ({ token: d.token, need: -d.delta })).sort((a, b) => (b.need > a.need ? 1 : -1));

  const legs: RebalanceLeg[] = [];
  let ui = 0;
  for (const over of overs) {
    let sell = over.delta;
    while (sell > 0n && ui < unders.length) {
      const under = unders[ui];
      if (!under) break;
      let move = sell < under.need ? sell : under.need;
      const cap = caps?.get(over.token.toLowerCase());
      if (cap !== undefined && move > cap) move = cap; // clamp to the on-chain Sell-Cap
      if (move > 0n) {
        legs.push({ tokenIn: over.token, tokenOut: under.token, amountIn: move });
        sell -= move;
        under.need -= move;
      }
      if (under.need <= 0n) ui++;
      if (cap !== undefined && move === cap) break; // this sell-token's cap is exhausted for the tick
    }
  }
  return legs;
}

/** Swap params for a rebalance leg that aren't part of the drift decision (mirror the copy MirrorPlan extras). */
export interface RebalanceSwapParams {
  feeTier: number;
  amountOutMin: bigint;
  deadline: bigint;
  permit2Expiration?: number;
}

/** Fail-closed guardrail violation — the caller SKIPS the leg (never submits) on this, like the copy webhook. */
export class RebalanceGuardError extends Error {}

/**
 * Off-chain guardrails the rebalance buy-leg INHERITS from copy-dynamic (PO Vaults-B point 3 — the practical
 * mitigation for the advisory-output worst-case, since the on-chain policy is sell-side-only, no output constraint):
 *  - tokenOut MUST be on the curated allowlist ({@link isAllowlistedTokenOut}, single source with copy) — else
 *    fail-closed SKIP (a hostile/buggy drift can't buy an arbitrary token);
 *  - a real slippage floor: `amountOutMin` is never backend-free/0 on mainnet (testnet 84532 has no MEV → 0 OK).
 * Fail-closed: throws {@link RebalanceGuardError}; the engine skips that leg rather than submit unprotected.
 */
export function assertRebalanceGuardrails(chainId: number, tokenOut: Address, amountOutMin: bigint): void {
  if (!isAllowlistedTokenOut(chainId, tokenOut)) {
    throw new RebalanceGuardError(`rebalance tokenOut ${tokenOut} not allowlisted on chain ${chainId} — skip (fail-closed)`);
  }
  if (chainId !== 84532 && amountOutMin <= 0n) {
    throw new RebalanceGuardError("rebalance requires amountOutMin > 0 on mainnet (no backend-free slippage floor)");
  }
}

/** Build the UniversalRouter calls for one rebalance leg — the SAME 3-call shape the strategy session enables. */
export function buildRebalanceCalls(chainId: number, router: Address, account: Address, leg: RebalanceLeg, p: RebalanceSwapParams): Call[] {
  const plan: MirrorPlan = {
    chainId, router, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut, amountIn: leg.amountIn,
    amountOutMin: p.amountOutMin, feeTier: p.feeTier, recipient: account, deadline: p.deadline, permit2Expiration: p.permit2Expiration,
  };
  return universalRouterAdapter.buildMirrorCalls(plan);
}

/**
 * Execute one rebalance leg: build the UR calls + submit USE-mode with the strategy session key. The on-chain
 * Sell-Cap + window + UR scope are the hard bound; `computeRebalanceLegs` already clamped to the cap.
 */
export async function submitRebalanceLeg(
  chainId: 1 | 8453 | 84532, account: Address, permissionId: Hex, signer: SessionKeySigner,
  router: Address, leg: RebalanceLeg, p: RebalanceSwapParams, nonceKey = 0,
): Promise<{ userOpHash: Hex }> {
  assertRebalanceGuardrails(chainId, leg.tokenOut, p.amountOutMin); // inherit copy-dynamic guardrails (fail-closed)
  const calls = buildRebalanceCalls(chainId, router, account, leg, p);
  return submitUseModeOp(chainId, account, permissionId, signer, calls, nonceKey);
}
