package com.tneff.cyppie.backend.user

import java.math.BigInteger
import javax.sql.DataSource

/** A BUILT-but-unsigned recurring DCA buy, parked for the app to sign on-device and submit (KAN-163). */
data class PendingBuy(
    val id: String,
    val scheduleId: String,
    val userId: String,
    val chainId: Long,
    val account: String,
    val tokenIn: String,
    val amountIn: BigInteger,
    val permissionId: String,
    val userOp: String,        // opaque serialized v0.7 UserOperation (submit verbatim with the app signature)
    val userOpHash: String,
    val digest: String,        // == userOpHash (RAW — the C3 USE-lock; the app raw-signs THIS, NOT the EIP-191 form)
)

/**
 * The on-device-sign handshake store (KAN-163). The scheduler [add]s a built buy; the app [listPending]s its
 * own, raw-signs the digest, and the submit endpoint [get]s it, relays to aa-trigger, then [markSubmitted].
 * A narrow port so [DcaScheduler] is unit-testable with an in-memory fake.
 */
interface PendingBuys {
    /** Park a built buy. Idempotent per schedule: a second open build for the same schedule is dropped (false). */
    fun add(b: PendingBuy): Boolean
}

class PendingBuyRepository(private val dataSource: DataSource) : PendingBuys {

    /** Insert a pending buy; the partial unique index drops a duplicate open build per schedule (ON CONFLICT). */
    override fun add(b: PendingBuy): Boolean {
        val sql = """
            INSERT INTO dca_pending_buy
              (schedule_id, user_id, chain_id, account, token_in, amount_in, permission_id, user_op, user_op_hash, digest)
            VALUES (?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
            ON CONFLICT (schedule_id) WHERE status = 'pending' DO NOTHING
        """.trimIndent()
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.setString(1, b.scheduleId)
                ps.setString(2, b.userId)
                ps.setLong(3, b.chainId)
                ps.setString(4, b.account.lowercase())
                ps.setString(5, b.tokenIn.lowercase())
                ps.setBigDecimal(6, b.amountIn.toBigDecimal())
                ps.setString(7, b.permissionId)
                ps.setString(8, b.userOp)
                ps.setString(9, b.userOpHash)
                ps.setString(10, b.digest)
                return ps.executeUpdate() > 0
            }
        }
    }

    /** The caller's open (unsigned) buys — what `GET /v1/me/dca/pending` returns. */
    fun listPending(userId: String): List<PendingBuy> {
        val sql = """
            SELECT id, schedule_id, user_id, chain_id, account, token_in, amount_in, permission_id, user_op::text, user_op_hash, digest
            FROM dca_pending_buy WHERE user_id = ?::uuid AND status = 'pending' ORDER BY created_at
        """.trimIndent()
        val out = ArrayList<PendingBuy>()
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.setString(1, userId)
                ps.executeQuery().use { rs ->
                    while (rs.next()) out.add(rowToPending(rs))
                }
            }
        }
        return out
    }

    /** A single pending buy owned by [userId] (for the submit endpoint). Null if missing or not theirs/not open. */
    fun getPendingForUser(id: String, userId: String): PendingBuy? {
        val sql = """
            SELECT id, schedule_id, user_id, chain_id, account, token_in, amount_in, permission_id, user_op::text, user_op_hash, digest
            FROM dca_pending_buy WHERE id = ?::uuid AND user_id = ?::uuid AND status = 'pending'
        """.trimIndent()
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.setString(1, id)
                ps.setString(2, userId)
                ps.executeQuery().use { rs -> return if (rs.next()) rowToPending(rs) else null }
            }
        }
    }

    fun markSubmitted(id: String) = setStatus(id, "submitted")
    fun markFailed(id: String) = setStatus(id, "failed")

    private fun setStatus(id: String, status: String) {
        val ts = if (status == "submitted") ", submitted_at = now()" else ""
        dataSource.connection.use { c ->
            c.prepareStatement("UPDATE dca_pending_buy SET status = ?$ts WHERE id = ?::uuid").use { ps ->
                ps.setString(1, status)
                ps.setString(2, id)
                ps.executeUpdate()
            }
        }
    }

    private fun rowToPending(rs: java.sql.ResultSet) = PendingBuy(
        id = rs.getString(1), scheduleId = rs.getString(2), userId = rs.getString(3), chainId = rs.getLong(4),
        account = rs.getString(5), tokenIn = rs.getString(6), amountIn = rs.getBigDecimal(7).toBigInteger(),
        permissionId = rs.getString(8), userOp = rs.getString(9), userOpHash = rs.getString(10), digest = rs.getString(11),
    )
}
