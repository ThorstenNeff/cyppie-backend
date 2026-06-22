package com.tneff.cyppie.backend.user

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigInteger

/**
 * Loopback HTTP client to the `aa-trigger` Node service (KAN-163). It speaks the proven `/v1/dca/build` +
 * `/v1/dca/submit` contract (docs/dca-integration-plan / server.ts). `userOp` is treated as an OPAQUE JSON
 * object — built by aa-trigger, parked verbatim, and resubmitted verbatim with the app signature (so the
 * userOpHash never changes). The DCA build is USE-mode, so `digestToSign == userOpHash` (RAW, the C3 USE-lock).
 *
 * The scheduler tick is synchronous, so the suspend client calls are bridged with [runBlocking] — the scheduler
 * runs on its own coroutine/dispatcher, never the request path. [baseUrl] is the loopback aa-trigger URL.
 */
class KtorAaTriggerClient(
    private val baseUrl: String,
    private val http: HttpClient = HttpClient(CIO) { install(ContentNegotiation) { json() } },
) : AaTriggerClient {

    private val json = Json { ignoreUnknownKeys = true }

    override fun buildDcaBuy(
        chainId: Long, account: String, permissionId: String, tokenIn: String, tokenOut: String,
        amountIn: BigInteger, amountOutMin: BigInteger, feeTier: Int, router: String,
    ): BuiltBuy {
        val req = buildJsonObject {
            put("chainId", JsonPrimitive(chainId))
            put("account", JsonPrimitive(account))
            put("permissionId", JsonPrimitive(permissionId))
            put("tokenIn", JsonPrimitive(tokenIn))
            put("tokenOut", JsonPrimitive(tokenOut))
            put("amountIn", JsonPrimitive(amountIn.toString()))       // base-units decimal string (aa-trigger BigInt())
            put("amountOutMin", JsonPrimitive(amountOutMin.toString()))
            put("feeTier", JsonPrimitive(feeTier))
            put("router", JsonPrimitive(router))
        }
        val body = postJson("/v1/dca/build", req)
        val userOpHash = body["userOpHash"]?.jsonPrimitive?.content ?: error("aa-trigger: no userOpHash")
        val digest = body["digestToSign"]?.jsonPrimitive?.content ?: error("aa-trigger: no digestToSign")
        val userOp = body["userOp"]?.jsonObject ?: error("aa-trigger: no userOp")
        return BuiltBuy(userOpHash = userOpHash, digestToSign = digest, userOp = userOp.toString())
    }

    override fun submitDcaBuy(chainId: Long, permissionId: String, userOp: String, signature: String): String {
        val req = buildJsonObject {
            put("chainId", JsonPrimitive(chainId))
            put("permissionId", JsonPrimitive(permissionId))
            put("userOp", json.parseToJsonElement(userOp))           // re-embed the opaque userOp verbatim
            put("signature", JsonPrimitive(signature))
        }
        val body = postJson("/v1/dca/submit", req)
        return body["userOpHash"]?.jsonPrimitive?.content ?: error("aa-trigger: no userOpHash on submit")
    }

    private fun postJson(path: String, req: JsonObject): JsonObject = runBlocking {
        val res = http.post("$baseUrl$path") {
            contentType(ContentType.Application.Json)
            setBody(req.toString())
        }
        json.parseToJsonElement(res.bodyAsText()).jsonObject
    }
}
