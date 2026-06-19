package com.tneff.cyppie.backend.user

import java.math.BigInteger

sealed interface GateResult {
    data object Allowed : GateResult
    data class Blocked(val reason: String) : GateResult
}

/**
 * Pre-submit gate for AA UserOps (ADR-0024): the global **kill-switch** + the **Q7 cross-session
 * exposure cap**, checked by the User-Service before it calls the `aa-trigger` to submit. The on-chain
 * Smart-Sessions policy is the hard gate (reverts out-of-policy); this is the backend incident-response
 * pause + the aggregate-exposure guard the on-chain per-session caps can't see.
 */
class SubmitGate(private val sessions: AaSessionRepository) {

    fun check(userId: String, chainId: Long, token: String, amount: BigInteger): GateResult {
        if (sessions.isPaused()) {
            return GateResult.Blocked("kill-switch engaged")
        }
        if (!sessions.withinExposureCap(userId, chainId, token, amount)) {
            return GateResult.Blocked("Q7 total-exposure cap would be exceeded")
        }
        return GateResult.Allowed
    }
}
