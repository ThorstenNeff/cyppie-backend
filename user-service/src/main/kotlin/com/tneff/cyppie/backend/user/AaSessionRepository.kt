package com.tneff.cyppie.backend.user

import java.math.BigInteger
import java.sql.Timestamp
import java.sql.Types
import javax.sql.DataSource

/** A scoped Smart-Session on a user's 7702 SCA (PRD-05 / ADR-0024). Metadata only — no key material. */
data class AaSession(
    val id: String,
    val userId: String,
    val chainId: Long,
    val account: String,
    val signer: String,
    val status: String,
    val config: String,
    val validUntilEpoch: Long?,
)

/**
 * AA session registry + Q7 cross-session exposure + the global kill-switch (ADR-0024). The session-key
 * material (Copy/Vaults) lives in HSM/KMS (Ph2), never here — this is scopes + accounting.
 */
class AaSessionRepository(private val dataSource: DataSource) {

    // ── Kill-switch (incident response) ──────────────────────────────────────────────────────────────
    fun isPaused(): Boolean = dataSource.connection.use { c ->
        c.prepareStatement("SELECT paused FROM aa_killswitch WHERE id = 1").use { ps ->
            ps.executeQuery().use { rs -> rs.next() && rs.getBoolean(1) }
        }
    }

    fun setPaused(paused: Boolean, reason: String?) = dataSource.connection.use { c ->
        c.prepareStatement("UPDATE aa_killswitch SET paused = ?, reason = ?, updated_at = now() WHERE id = 1").use { ps ->
            ps.setBoolean(1, paused)
            ps.setString(2, reason)
            ps.executeUpdate()
        }
        Unit
    }

    // ── Sessions ─────────────────────────────────────────────────────────────────────────────────────
    fun createSession(
        userId: String, chainId: Long, account: String, signer: String,
        configJson: String, validUntilEpoch: Long?,
    ): String {
        val sql = """
            INSERT INTO aa_session (user_id, chain_id, account, signer, config, valid_until)
            VALUES (?::uuid, ?, ?, ?, ?::jsonb, ?)
            RETURNING id
        """.trimIndent()
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.setString(1, userId)
                ps.setLong(2, chainId)
                ps.setString(3, account.lowercase())
                ps.setString(4, signer)
                ps.setString(5, configJson)
                if (validUntilEpoch != null) ps.setTimestamp(6, Timestamp(validUntilEpoch * 1000)) else ps.setNull(6, Types.TIMESTAMP)
                ps.executeQuery().use { rs -> check(rs.next()); return rs.getString(1) }
            }
        }
    }

    /** The user's sessions (newest first) — for the app's session list + the DCA scheduler's session lookup. */
    fun listByUser(userId: String): List<AaSession> {
        val sql = """
            SELECT id, user_id, chain_id, account, signer, status, config::text, EXTRACT(EPOCH FROM valid_until)::bigint
            FROM aa_session WHERE user_id = ?::uuid ORDER BY created_at DESC
        """.trimIndent()
        val out = ArrayList<AaSession>()
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.setString(1, userId)
                ps.executeQuery().use { rs ->
                    while (rs.next()) {
                        val vu = rs.getLong(8); val validUntil = if (rs.wasNull()) null else vu
                        out.add(AaSession(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getString(4), rs.getString(5), rs.getString(6), rs.getString(7), validUntil))
                    }
                }
            }
        }
        return out
    }

    fun revoke(sessionId: String) = dataSource.connection.use { c ->
        c.prepareStatement("UPDATE aa_session SET status = 'revoked', updated_at = now() WHERE id = ?::uuid").use { ps ->
            ps.setString(1, sessionId)
            ps.executeUpdate()
        }
        Unit
    }

    // ── Q7 total-exposure ────────────────────────────────────────────────────────────────────────────
    /**
     * Would spending [amount] of [token] push the user's cumulative exposure over the cap? Allowed when
     * under the cap or no cap is set. Pre-check only — call [recordSpend] after a successful UserOp.
     */
    fun withinExposureCap(userId: String, chainId: Long, token: String, amount: BigInteger): Boolean =
        dataSource.connection.use { c ->
            c.prepareStatement("SELECT spent, cap FROM aa_exposure WHERE user_id = ?::uuid AND chain_id = ? AND token = ?").use { ps ->
                ps.setString(1, userId)
                ps.setLong(2, chainId)
                ps.setString(3, token.lowercase())
                ps.executeQuery().use { rs ->
                    if (!rs.next()) return true                         // no spend yet → allowed
                    val spent = rs.getBigDecimal(1).toBigInteger()
                    val cap = rs.getBigDecimal(2)?.toBigInteger() ?: return true   // no cap
                    return spent.add(amount) <= cap
                }
            }
        }

    /** Record a successful spend (upsert cumulative). */
    fun recordSpend(userId: String, chainId: Long, token: String, amount: BigInteger) {
        val sql = """
            INSERT INTO aa_exposure (user_id, chain_id, token, spent)
            VALUES (?::uuid, ?, ?, ?)
            ON CONFLICT (user_id, chain_id, token)
            DO UPDATE SET spent = aa_exposure.spent + EXCLUDED.spent, updated_at = now()
        """.trimIndent()
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.setString(1, userId)
                ps.setLong(2, chainId)
                ps.setString(3, token.lowercase())
                ps.setBigDecimal(4, amount.toBigDecimal())
                ps.executeUpdate()
            }
        }
    }
}
