package com.tneff.cyppie.backend.user

import java.math.BigInteger
import java.sql.Timestamp
import javax.sql.DataSource

data class DcaSchedule(
    val id: String,
    val userId: String,
    val chainId: Long,
    val account: String,
    val tokenIn: String,
    val tokenOut: String,
    val amountIn: BigInteger,
    val router: String,
    val intervalSeconds: Long,
    // Mapping (V4): the build parameters beyond the recurring config — the enabled session + swap fee/slippage.
    val permissionId: String,
    val feeTier: Int,
    val amountOutMin: BigInteger,
)

/**
 * The scheduler's view of the schedule store — a narrow port so [DcaScheduler] is unit-testable with an
 * in-memory fake (the concrete [DcaScheduleRepository] is Postgres-specific SQL).
 */
interface DcaSchedules {
    fun dueSchedules(nowEpoch: Long): List<DcaSchedule>
    fun markRun(id: String, nowEpoch: Long)
}

/**
 * DCA schedule store (PRD-05). The scheduler reads [dueSchedules] and builds a DCA buy per due row; the app
 * signs the userOpHash on-device (Q1). No key material — recurring-buy config only.
 */
class DcaScheduleRepository(private val dataSource: DataSource) : DcaSchedules {

    fun create(
        userId: String, chainId: Long, account: String, tokenIn: String, tokenOut: String,
        amountIn: BigInteger, router: String, intervalSeconds: Long, firstRunEpoch: Long,
        permissionId: String, feeTier: Int, amountOutMin: BigInteger,
    ): String {
        val sql = """
            INSERT INTO dca_schedule
              (user_id, chain_id, account, token_in, token_out, amount_in, router, interval_seconds, next_run_at,
               permission_id, fee_tier, amount_out_min)
            VALUES (?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        """.trimIndent()
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.setString(1, userId)
                ps.setLong(2, chainId)
                ps.setString(3, account.lowercase())
                ps.setString(4, tokenIn.lowercase())
                ps.setString(5, tokenOut.lowercase())
                ps.setBigDecimal(6, amountIn.toBigDecimal())
                ps.setString(7, router.lowercase())
                ps.setLong(8, intervalSeconds)
                ps.setTimestamp(9, Timestamp(firstRunEpoch * 1000))
                ps.setString(10, permissionId)
                ps.setInt(11, feeTier)
                ps.setBigDecimal(12, amountOutMin.toBigDecimal())
                ps.executeQuery().use { rs -> check(rs.next()); return rs.getString(1) }
            }
        }
    }

    /** Enabled schedules whose next_run_at is due (<= now), with a permission_id set. The scheduler's hot path. */
    override fun dueSchedules(nowEpoch: Long): List<DcaSchedule> {
        val sql = """
            SELECT id, user_id, chain_id, account, token_in, token_out, amount_in, router, interval_seconds,
                   permission_id, fee_tier, amount_out_min
            FROM dca_schedule
            WHERE enabled AND permission_id IS NOT NULL AND next_run_at <= ?
            ORDER BY next_run_at
        """.trimIndent()
        val out = ArrayList<DcaSchedule>()
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.setTimestamp(1, Timestamp(nowEpoch * 1000))
                ps.executeQuery().use { rs ->
                    while (rs.next()) {
                        out.add(
                            DcaSchedule(
                                id = rs.getString(1), userId = rs.getString(2), chainId = rs.getLong(3),
                                account = rs.getString(4), tokenIn = rs.getString(5), tokenOut = rs.getString(6),
                                amountIn = rs.getBigDecimal(7).toBigInteger(), router = rs.getString(8),
                                intervalSeconds = rs.getLong(9), permissionId = rs.getString(10),
                                feeTier = rs.getInt(11), amountOutMin = rs.getBigDecimal(12).toBigInteger(),
                            )
                        )
                    }
                }
            }
        }
        return out
    }

    /** After a run is built: advance next_run_at = now + interval (skip missed slots). */
    override fun markRun(id: String, nowEpoch: Long) {
        val sql = "UPDATE dca_schedule SET last_run_at = ?, next_run_at = ? + (interval_seconds * interval '1 second') WHERE id = ?::uuid"
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                val now = Timestamp(nowEpoch * 1000)
                ps.setTimestamp(1, now)
                ps.setTimestamp(2, now)
                ps.setString(3, id)
                ps.executeUpdate()
            }
        }
    }
}
