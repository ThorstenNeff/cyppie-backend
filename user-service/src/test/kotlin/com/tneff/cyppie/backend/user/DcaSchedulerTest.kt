package com.tneff.cyppie.backend.user

import java.math.BigInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * KAN-163 DCA scheduler tick — the gate→build→park→advance decision logic over in-memory fakes (the on-chain
 * buy money-path is proven separately by aa-trigger c9, receipt 0x2e6b976c…). Verifies: build+park on an active
 * gated session, skip (advance) on no-session and kill-switch/Q7, per-tick failure isolation, idempotent park.
 */
class DcaSchedulerTest {

    private fun schedule(id: String, userId: String = "u1") = DcaSchedule(
        id = id, userId = userId, chainId = 84532, account = "0xabc", tokenIn = "0xin", tokenOut = "0xout",
        amountIn = BigInteger.valueOf(1_000_000), router = "0xrouter", intervalSeconds = 3600,
        permissionId = "0x" + "11".repeat(32), feeTier = 500, amountOutMin = BigInteger.ZERO,
    )

    private class FakeSchedules(val due: MutableList<DcaSchedule>) : DcaSchedules {
        val ran = mutableListOf<String>()
        override fun dueSchedules(nowEpoch: Long) = due.toList()
        override fun markRun(id: String, nowEpoch: Long) { ran.add(id) }
    }

    private class FakeSessions(val active: Boolean) : DcaSessions {
        override fun listByUser(userId: String) = if (active)
            listOf(AaSession("s1", userId, 84532, "0xabc", "on-device", "active", "{}", null)) else emptyList()
    }

    private class FakeGate(val paused: Boolean = false, val underCap: Boolean = true) : ExposureGate {
        override fun isPaused() = paused
        override fun withinExposureCap(userId: String, chainId: Long, token: String, amount: BigInteger) = underCap
    }

    private class FakeAa(val fail: Boolean = false) : AaTriggerClient {
        var builds = 0
        override fun buildDcaBuy(chainId: Long, account: String, permissionId: String, tokenIn: String, tokenOut: String, amountIn: BigInteger, amountOutMin: BigInteger, feeTier: Int, router: String): BuiltBuy {
            builds++
            if (fail) throw RuntimeException("aa-trigger down")
            return BuiltBuy(userOpHash = "0xhash$builds", digestToSign = "0xhash$builds", userOp = """{"sender":"$account"}""")
        }
        override fun submitDcaBuy(chainId: Long, permissionId: String, userOp: String, signature: String) = "0xsubmitted"
    }

    private class FakePending(val rejectSecond: Boolean = false) : PendingBuys {
        val parked = mutableListOf<PendingBuy>()
        override fun add(b: PendingBuy): Boolean {
            if (rejectSecond && parked.isNotEmpty()) return false // simulate the open-build unique index
            parked.add(b); return true
        }
    }

    @Test
    fun buildsAndParksForActiveGatedSession() {
        val sch = FakeSchedules(mutableListOf(schedule("a")))
        val pending = FakePending()
        val aa = FakeAa()
        val n = DcaScheduler(sch, FakeSessions(active = true), SubmitGate(FakeGate()), aa, pending).tick(1000)
        assertEquals(1, n)
        assertEquals(1, aa.builds)
        assertEquals(1, pending.parked.size)
        // The parked buy carries the build's RAW-userOpHash digest (digest == userOpHash, USE-lock).
        assertEquals(pending.parked[0].userOpHash, pending.parked[0].digest)
        assertEquals("a", pending.parked[0].scheduleId)
        assertTrue(sch.ran.contains("a")) // advanced
    }

    @Test
    fun skipsAndAdvancesWhenNoActiveSession() {
        val sch = FakeSchedules(mutableListOf(schedule("a")))
        val pending = FakePending()
        val aa = FakeAa()
        val n = DcaScheduler(sch, FakeSessions(active = false), SubmitGate(FakeGate()), aa, pending).tick(1000)
        assertEquals(0, n)
        assertEquals(0, aa.builds)       // never even built
        assertTrue(sch.ran.contains("a")) // but advanced (no hot-loop)
    }

    @Test
    fun killSwitchBlocksBuild() {
        val sch = FakeSchedules(mutableListOf(schedule("a")))
        val aa = FakeAa()
        val n = DcaScheduler(sch, FakeSessions(active = true), SubmitGate(FakeGate(paused = true)), aa, FakePending()).tick(1000)
        assertEquals(0, n)
        assertEquals(0, aa.builds)
        assertTrue(sch.ran.contains("a"))
    }

    @Test
    fun q7CapBlocksBuild() {
        val sch = FakeSchedules(mutableListOf(schedule("a")))
        val aa = FakeAa()
        val n = DcaScheduler(sch, FakeSessions(active = true), SubmitGate(FakeGate(underCap = false)), aa, FakePending()).tick(1000)
        assertEquals(0, n)
        assertEquals(0, aa.builds)
    }

    @Test
    fun oneFailingBuildDoesNotSinkTheTick() {
        // Two due schedules, the aa-trigger throws → the tick swallows it per-schedule and keeps going.
        val sch = FakeSchedules(mutableListOf(schedule("a"), schedule("b")))
        val aa = FakeAa(fail = true)
        val n = DcaScheduler(sch, FakeSessions(active = true), SubmitGate(FakeGate()), aa, FakePending()).tick(1000)
        assertEquals(0, n)             // nothing parked
        assertEquals(2, aa.builds)     // both attempted (didn't stop after the first throw)
    }

    @Test
    fun idempotentParkIsNotDoubleCounted() {
        val sch = FakeSchedules(mutableListOf(schedule("a"), schedule("b")))
        val pending = FakePending(rejectSecond = true) // second open build rejected (unique index)
        val n = DcaScheduler(sch, FakeSessions(active = true), SubmitGate(FakeGate()), FakeAa(), pending).tick(1000)
        assertEquals(1, n)             // only the first park counted
        assertEquals(1, pending.parked.size)
    }
}
