package com.tneff.cyppie.backend.user

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.math.BigInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * KAN-163 DCA orchestration e2e — proves the full backend orchestration money-path on Base Sepolia:
 *   on-chain ENABLE → DB schedule → [DcaScheduler.tick] → [KtorAaTriggerClient] /v1/dca/build → park PendingBuy
 *   → app raw-signs the RAW userOpHash on-device → submit relay → bundler RECEIPT.
 *
 * Gated by RUN_DCA_E2E=1 (like aa-trigger's RUN_SEND=1) — a no-op in the normal suite (it needs a live Postgres
 * + aa-trigger + testnet RPC + a funded-by-paymaster session). The crypto primitives (enable, raw-sign,
 * receipt-poll) are delegated to the proven aa-trigger node helpers (the SAME path as c9, 0x2e6b976c…); this
 * test proves the KOTLIN orchestration that drives them. It bypasses the Keycloak HTTP edge (PRD-08 auth track,
 * deferred + separately fail-closed-tested) and exercises the service layer directly.
 *
 * Env: CYPPIE_DB_URL/USER/PASSWORD, AA_TRIGGER_URL, TEST_PRIVATE_KEY (the fixed owner key, shared enable↔sign),
 * AA_TRIGGER_DIR (default ../aa-trigger), AA_ENV_FILE (default $AA_TRIGGER_DIR/../.env), PIMLICO_API_KEY (via env-file).
 */
class DcaOrchestrationE2eTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun fullOrchestrationToReceipt() {
        if (System.getenv("RUN_DCA_E2E") != "1") return // no-op unless the live stack is set up
        val aaTriggerUrl = System.getenv("AA_TRIGGER_URL") ?: error("AA_TRIGGER_URL required")
        val aaDir = File(System.getenv("AA_TRIGGER_DIR") ?: "../aa-trigger").absoluteFile
        val envFile = System.getenv("AA_ENV_FILE") ?: File(aaDir, "../.env").path

        // 1) ENABLE a scoped DCA session on-chain (node helper) → {account, permissionId, buy params}.
        val enable = node(aaDir, envFile, "scripts/e2e-enable.mjs").let { json.parseToJsonElement(it).jsonObject }
        val chainId = enable["chainId"]!!.jsonPrimitive.content.toLong()
        val account = enable["account"]!!.jsonPrimitive.content.lowercase() // app_user CHECK requires lowercase; case-insensitive on-chain
        val permissionId = enable["permissionId"]!!.jsonPrimitive.content
        val tokenIn = enable["tokenIn"]!!.jsonPrimitive.content
        val tokenOut = enable["tokenOut"]!!.jsonPrimitive.content
        val router = enable["router"]!!.jsonPrimitive.content
        val amountIn = BigInteger(enable["amountIn"]!!.jsonPrimitive.content)
        val feeTier = enable["feeTier"]!!.jsonPrimitive.content.toInt()
        val amountOutMin = BigInteger(enable["amountOutMin"]!!.jsonPrimitive.content)
        println("[e2e] enabled session $permissionId on $account")

        // 2) Real DB: migrate + seed profile + active session + a due schedule (referencing the enabled session).
        val db = Db.fromEnv() ?: error("CYPPIE_DB_URL required")
        db.migrate()
        val profiles = ProfileRepository(db.dataSource)
        val sessions = AaSessionRepository(db.dataSource)
        val schedules = DcaScheduleRepository(db.dataSource)
        val pending = PendingBuyRepository(db.dataSource)

        val userId = profiles.upsertAndGet(account, "e2e-${account.takeLast(8)}").id
        sessions.createSession(userId, chainId, account, "on-device", """{"chainId":$chainId,"account":"$account"}""", null)
        val now = System.currentTimeMillis() / 1000
        val scheduleId = schedules.create(
            userId, chainId, account, tokenIn, tokenOut, amountIn, router, 3600, now - 1, // due
            permissionId, feeTier, amountOutMin,
        )
        println("[e2e] seeded user=$userId schedule=$scheduleId (due)")

        // 3) Real DcaScheduler.tick → real KtorAaTriggerClient → aa-trigger /v1/dca/build → park PendingBuy.
        val client = KtorAaTriggerClient(aaTriggerUrl)
        val built = DcaScheduler(schedules, sessions, SubmitGate(sessions), client, pending).tick(now)
        assertEquals(1, built, "scheduler should build+park exactly one buy")

        val pb = pending.listPending(userId).single()
        assertEquals(pb.userOpHash, pb.digest, "DCA buy digest == RAW userOpHash (USE-lock)")
        assertEquals(scheduleId, pb.scheduleId)
        println("[e2e] parked buy ${pb.id} userOpHash=${pb.userOpHash}")

        // 4) App-sign half: owner raw-signs the digest on-device (node helper, the fixed TEST key).
        val signature = node(aaDir, envFile, "scripts/e2e-sign.mjs", pb.digest).trim()
        assertTrue(signature.matches(Regex("^0x[0-9a-fA-F]{130}$")), "65-byte signature")

        // 5) Submit relay (the /v1/me/dca/{id}/submit core, minus the Keycloak edge): re-gate → relay → record → mark.
        assertEquals(GateResult.Allowed, SubmitGate(sessions).check(userId, pb.chainId, pb.tokenIn, pb.amountIn))
        val bundlerHash = client.submitDcaBuy(pb.chainId, pb.permissionId, pb.userOp, signature)
        sessions.recordSpend(userId, pb.chainId, pb.tokenIn, pb.amountIn)
        pending.markSubmitted(pb.id)
        println("[e2e] submitted → bundler userOpHash=$bundlerHash")

        // 6) Bundler RECEIPT (node helper).
        val receipt = node(aaDir, envFile, "scripts/e2e-receipt.mjs", pb.chainId.toString(), bundlerHash)
            .let { json.parseToJsonElement(it).jsonObject }
        val success = receipt["success"]!!.jsonPrimitive.content.toBoolean()
        val txHash = receipt["transactionHash"]!!.jsonPrimitive.content
        assertTrue(success, "DCA buy receipt must be success")

        println("\n================ KAN-163 DCA orchestration e2e ================")
        println("session       : $permissionId  (account $account)")
        println("schedule      : $scheduleId")
        println("buy userOpHash: ${pb.userOpHash}")
        println("DCA BUY TX    : $txHash  (success=$success)")
        println("===============================================================")
    }

    /** Run a node helper in [aaDir] with the aa-trigger env-file; return stdout (stderr inherited for logs). */
    private fun node(aaDir: File, envFile: String, script: String, vararg args: String): String {
        val cmd = mutableListOf("node", "--env-file=$envFile", script); cmd.addAll(args)
        val proc = ProcessBuilder(cmd).directory(aaDir).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        val out = proc.inputStream.bufferedReader().readText()
        val code = proc.waitFor()
        check(code == 0) { "node $script exited $code" }
        return out.trim()
    }
}
