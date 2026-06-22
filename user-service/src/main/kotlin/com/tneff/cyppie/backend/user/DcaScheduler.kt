package com.tneff.cyppie.backend.user

import java.math.BigInteger

/** The scheduler's view of the session registry — narrow port for unit-testing (see [AaSessionRepository]). */
interface DcaSessions {
    fun listByUser(userId: String): List<AaSession>
}

/**
 * DCA scheduler loop (KAN-163 / PRD-05 — the activation that makes a registered DCA session actually buy).
 *
 * One [tick] processes every DUE `dca_schedule`: require an active registered AA session covering its
 * chain+account (the on-chain enable already happened, approach B), run the [SubmitGate] (kill-switch + Q7
 * cross-session exposure), BUILD the recurring-buy UserOp via the [AaTriggerClient] (loopback to aa-trigger
 * `/v1/dca/build`), PARK it in the [PendingBuys] store for on-device signing, and advance `next_run_at`.
 *
 * 🔑 Auth ≠ Custody: the loop never holds keys — it gates + builds; the owner signs the RAW userOpHash
 * on-device (Q1, the C3 USE-lock) and submits out-of-band (`POST /v1/me/dca/{id}/submit`).
 */
class DcaScheduler(
    private val schedules: DcaSchedules,
    private val sessions: DcaSessions,
    private val gate: SubmitGate,
    private val aa: AaTriggerClient,
    private val pending: PendingBuys,
) {
    /**
     * Process all due schedules at [nowEpoch]. For each: skip (and advance, so it doesn't hot-loop) when there's
     * no active session or the gate blocks (kill-switch / Q7); otherwise build the buy, park it, and advance.
     * Returns how many buys were built+parked. Each schedule is independent — one failure never sinks the tick.
     */
    fun tick(nowEpoch: Long): Int {
        var built = 0
        for (s in schedules.dueSchedules(nowEpoch)) {
            try {
                val active = sessions.listByUser(s.userId).any {
                    it.status == "active" && it.chainId == s.chainId && it.account.equals(s.account, ignoreCase = true)
                }
                if (!active) { schedules.markRun(s.id, nowEpoch); continue }   // no registered session → skip the slot
                when (gate.check(s.userId, s.chainId, s.tokenIn, s.amountIn)) {
                    is GateResult.Blocked -> { schedules.markRun(s.id, nowEpoch); continue } // kill-switch / Q7 → skip
                    GateResult.Allowed -> {
                        val b = aa.buildDcaBuy(
                            s.chainId, s.account, s.permissionId, s.tokenIn, s.tokenOut,
                            s.amountIn, s.amountOutMin, s.feeTier, s.router,
                        )
                        val parked = pending.add(
                            PendingBuy(
                                id = "", scheduleId = s.id, userId = s.userId, chainId = s.chainId, account = s.account,
                                tokenIn = s.tokenIn, amountIn = s.amountIn, permissionId = s.permissionId,
                                userOp = b.userOp, userOpHash = b.userOpHash, digest = b.digestToSign,
                            )
                        )
                        if (parked) built++
                        schedules.markRun(s.id, nowEpoch) // advance now; the app signs+submits the parked buy out-of-band
                    }
                }
            } catch (e: Exception) {
                // a single build/RPC failure must not sink the tick — leave next_run_at so it retries next tick.
                continue
            }
        }
        return built
    }
}

/**
 * A built DCA buy from aa-trigger (`/v1/dca/build`). The buy is USE-mode through the scoped session, so the
 * digest the owner raw-signs on-device is the **RAW userOpHash** (the C3 USE-lock — NOT the EIP-191
 * `hashMessage(userOpHash)` form the enable path uses). `digestToSign == userOpHash`.
 */
data class BuiltBuy(val userOpHash: String, val digestToSign: String, val userOp: String)

/**
 * Loopback client to the `aa-trigger` Node service (the proven /v1/dca build/submit + DCA SwapRouter02 calldata).
 * The DCA buy targets the recurring-buy router (SwapRouter02, selector 0x5ae401dc) — the DCA-specific build, not
 * the copy UniversalRouter path. HTTP impl: [KtorAaTriggerClient].
 */
interface AaTriggerClient {
    /** Build a USE-mode recurring buy → `/v1/dca/build`. Returns the userOp + the RAW userOpHash digest to sign. */
    fun buildDcaBuy(
        chainId: Long, account: String, permissionId: String, tokenIn: String, tokenOut: String,
        amountIn: BigInteger, amountOutMin: BigInteger, feeTier: Int, router: String,
    ): BuiltBuy

    /** Submit an app-signed buy → `/v1/dca/submit`. Returns the bundler userOpHash. */
    fun submitDcaBuy(chainId: Long, permissionId: String, userOp: String, signature: String): String
}
