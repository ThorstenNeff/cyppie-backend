package com.tneff.cyppie.backend.user

import java.math.BigInteger

/**
 * DCA scheduler loop (KAN-163 / PRD-05 — the activation that makes a registered DCA session actually buy).
 *
 * One [tick] processes every DUE `dca_schedule`: require an active registered AA session covering its
 * chain+account (the on-chain enable already happened, approach B), run the [SubmitGate] (kill-switch + Q7
 * cross-session exposure), build the recurring-buy UserOp via the [AaTriggerClient] (loopback to aa-trigger
 * `/v1/userop/build`), and advance `next_run_at`. DCA signer = on-device (Q1): the loop BUILDS the buy +
 * surfaces the digest; the app signs on-device + submits (then `recordSpend` on success).
 *
 * 🔑 Auth ≠ Custody: the loop never holds keys — it gates + builds; the owner signs the userOpHash on-device.
 */
class DcaScheduler(
    private val schedules: DcaScheduleRepository,
    private val sessions: AaSessionRepository,
    private val gate: SubmitGate,
    private val aa: AaTriggerClient,
) {
    /** A built, owner-unsigned DCA buy — the app fetches it, signs `digestToSign` on-device, and submits. */
    data class BuyIntent(
        val scheduleId: String,
        val chainId: Long,
        val account: String,
        val amountIn: BigInteger,
        val tokenIn: String,
        val userOpHash: String,
        val digestToSign: String,
    )

    /**
     * Process all due schedules at [nowEpoch]. For each: skip (and advance, so it doesn't hot-loop) when there's
     * no active session or the gate blocks (kill-switch / Q7); otherwise build the buy + advance. Returns the
     * built buys for the app to sign. Each schedule is independent — one failure never sinks the tick.
     */
    fun tick(nowEpoch: Long): List<BuyIntent> {
        val out = ArrayList<BuyIntent>()
        for (s in schedules.dueSchedules(nowEpoch)) {
            try {
                val active = sessions.listByUser(s.userId).any {
                    it.status == "active" && it.chainId == s.chainId && it.account.equals(s.account, ignoreCase = true)
                }
                if (!active) { schedules.markRun(s.id, nowEpoch); continue }   // no registered session → skip the slot
                when (gate.check(s.userId, s.chainId, s.tokenIn, s.amountIn)) {
                    is GateResult.Blocked -> { schedules.markRun(s.id, nowEpoch); continue } // kill-switch / Q7 → skip
                    GateResult.Allowed -> {
                        val built = aa.buildDcaBuy(s.chainId, s.account, s.tokenIn, s.tokenOut, s.amountIn, s.router)
                        out.add(BuyIntent(s.id, s.chainId, s.account, s.amountIn, s.tokenIn, built.userOpHash, built.digestToSign))
                        schedules.markRun(s.id, nowEpoch) // advance now; the app signs+submits the built buy out-of-band
                    }
                }
            } catch (e: Exception) {
                // a single build/RPC failure must not sink the tick — leave next_run_at so it retries next tick.
                continue
            }
        }
        return out
    }
}

/** A built DCA buy from aa-trigger — the digest the owner raw-signs on-device (= hashMessage(userOpHash)). */
data class BuiltBuy(val userOpHash: String, val digestToSign: String)

/**
 * Loopback client to the `aa-trigger` Node service (the proven /v1/userop build/submit + DCA swap calldata).
 * The DCA buy targets the recurring-buy router (SwapRouter02, selector 0x5ae401dc) — a DCA-specific build, not
 * the copy UniversalRouter path. Interface here; the HTTP impl + the aa-trigger `/v1/dca/build` endpoint + the
 * on-device-sign handshake (pending-buy fetch + submit) land with the testnet e2e (register→scheduler→buy).
 */
interface AaTriggerClient {
    fun buildDcaBuy(chainId: Long, account: String, tokenIn: String, tokenOut: String, amountIn: BigInteger, router: String): BuiltBuy
}
