package com.tneff.cyppie.backend.user

import com.auth0.jwk.JwkProviderBuilder
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.auth.jwt.jwt
import io.ktor.server.auth.principal
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.math.BigInteger
import java.net.URI
import java.util.concurrent.TimeUnit

/** A client/input error → HTTP 400. */
class BadRequestException(message: String) : RuntimeException(message)
/** The caller may only act on their own account → HTTP 403. */
class ForbiddenException(message: String) : RuntimeException(message)

/**
 * Cyppie User-Service (PRD-08 / ADR-0023, ADR-0026) — platform profiles & settings behind the Caddy
 * gateway.
 *
 * 🔑 Auth ≠ Custody: platform identity only — never seeds/keys. Identity = the EVM address (F1 SIWE),
 * carried as the Keycloak JWT's `preferred_username` (the username the SIWE authenticator federated).
 *
 * `/v1` is gated by a Keycloak-issued RS256 JWT, validated against the realm JWKS (defense-in-depth with
 * the Caddy edge). DB-backed profile persistence (Postgres/Flyway, V1__init.sql) is the next sub-step;
 * `/v1/me` currently echoes the verified identity from the token.
 */
fun main() {
    val port = System.getenv("USER_SERVICE_PORT")?.toIntOrNull() ?: 8081
    embeddedServer(Netty, port = port, host = "0.0.0.0", module = Application::userServiceModule).start(wait = true)
}

@Serializable
data class HealthStatus(val status: String, val service: String = "user-service", val version: String = "0.1.0")

@Serializable
data class ApiError(val error: String)

@Serializable
data class MeResponse(
    val walletAddress: String,
    val subject: String,
    val email: String? = null,
    val displayName: String? = null,
    val persisted: Boolean = false,
)

/**
 * KAN-159 DCA-session register (`POST /v1/me/sessions`). Nested `{config}` = single source of truth: the backend
 * DERIVES the indexed columns from the §2 `SessionConfig` JSONB (no duplicated fields that can drift). No
 * `enableSignature` — the on-chain enable already happened (approach B, via the app's EnableBroadcaster).
 */
@Serializable
data class CreateSessionRequest(val config: JsonObject)

@Serializable
data class CreateSessionResponse(val sessionId: String)

@Serializable
data class SessionSummary(val sessionId: String, val chainId: Long, val account: String, val signer: String, val status: String, val validUntil: Long? = null)

@Serializable
data class SessionsResponse(val sessions: List<SessionSummary>)

/**
 * KAN-163 create a DCA schedule. The mapping decision (plan §4): the schedule stores the enabled session's
 * `permissionId` + the swap `feeTier`/`amountOutMin`, so the scheduler has everything to build the buy. The app
 * supplies them, having registered the session (`POST /v1/me/sessions`) and knowing its permissionId. uint256
 * amounts ride as decimal strings. `account` MUST be the caller's own SCA.
 */
@Serializable
data class CreateDcaScheduleRequest(
    val chainId: Long, val account: String, val tokenIn: String, val tokenOut: String, val amountIn: String,
    val router: String, val intervalSeconds: Long, val permissionId: String, val feeTier: Int,
    val amountOutMin: String = "0",
)

@Serializable
data class CreateDcaScheduleResponse(val scheduleId: String)

/**
 * A built, owner-unsigned buy the app fetches, raw-signs the `digestToSign` on-device, and submits.
 *
 * 🔒 no-blind (PO decision (b)): the full `userOp` ships so the app can RECOMPUTE the userOpHash from it,
 * bind its signature to that, and scope-check the calls (Dev-1's `verifyBuyUserOp`) BEFORE signing — the
 * on-chain policy only binds cap+router+selector, NOT tokenOut/amount/timing, so blind-signing the digest
 * alone would let a hostile backend front-load the cap into a worthless token. The app must not trust `digestToSign`.
 */
@Serializable
data class PendingBuyDto(
    val id: String, val chainId: Long, val account: String, val tokenIn: String, val amountIn: String,
    val userOpHash: String, val digestToSign: String, val userOp: JsonObject,
)

@Serializable
data class PendingBuysResponse(val pending: List<PendingBuyDto>)

@Serializable
data class SubmitBuyRequest(val signature: String)

@Serializable
data class SubmitBuyResponse(val userOpHash: String)

internal data class DerivedSession(val chainId: Long, val account: String, val signer: String, val validUntil: Long?)

/** Derive the indexed columns from the §2 SessionConfig (docs/aa-ph0-api-contract.md). Fail-closed on bad input. */
internal fun deriveSessionFields(config: JsonObject): DerivedSession {
    val chainId = config["chainId"]?.jsonPrimitive?.longOrNull
        ?: throw BadRequestException("config.chainId is required")
    val account = config["account"]?.jsonPrimitive?.contentOrNull
        ?: throw BadRequestException("config.account is required")
    if (!account.matches(Regex("^0x[0-9a-fA-F]{40}$"))) throw BadRequestException("config.account must be a 0x address")
    // signer is OPTIONAL on the wire (Dev-1's client omits the "on-device" default, encodeDefaults=false) → default it.
    val signer = config["signer"]?.jsonPrimitive?.contentOrNull ?: "on-device"
    if (signer != "on-device" && signer != "backend") throw BadRequestException("config.signer must be 'on-device' or 'backend'")
    // valid_until = the latest action expiry (DCA = 1 action → its validUntil); null if no actions carry one.
    val validUntil = (config["actions"] as? JsonArray)
        ?.mapNotNull { (it as? JsonObject)?.get("validUntil")?.jsonPrimitive?.longOrNull }
        ?.maxOrNull()
    return DerivedSession(chainId, account, signer, validUntil)
}

/** Parse a uint256 decimal string (base units); fail-closed (400) on garbage or negatives. */
internal fun parseUint(s: String, field: String): BigInteger {
    val v = try { BigInteger(s.trim()) } catch (_: NumberFormatException) { throw BadRequestException("$field must be a base-units integer") }
    if (v.signum() < 0) throw BadRequestException("$field must be >= 0")
    return v
}

internal fun parsePositiveUint(s: String, field: String): BigInteger {
    val v = parseUint(s, field)
    if (v.signum() <= 0) throw BadRequestException("$field must be > 0")
    return v
}

private const val JWT_PROVIDER = "cyppie-jwt"

fun Application.userServiceModule() {
    install(ContentNegotiation) { json() }
    install(CallLogging)
    install(StatusPages) {
        exception<BadRequestException> { call, cause -> call.respond(HttpStatusCode.BadRequest, ApiError(cause.message ?: "bad request")) }
        exception<ForbiddenException> { call, cause -> call.respond(HttpStatusCode.Forbidden, ApiError(cause.message ?: "forbidden")) }
        exception<Throwable> { call, cause ->
            call.respond(HttpStatusCode.InternalServerError, ApiError(cause.message ?: "internal error"))
        }
    }

    // OIDC issuer (Keycloak realm). When set, /v1 is JWT-gated against the realm JWKS; when unset, /v1
    // stays fail-closed (the service boots + serves health regardless).
    val issuer = System.getenv("CYPPIE_OIDC_ISSUER")?.takeIf { it.isNotBlank() }
    if (issuer != null) {
        val jwksUrl = URI("$issuer/protocol/openid-connect/certs").toURL()
        val jwkProvider = JwkProviderBuilder(jwksUrl)
            .cached(10, 24, TimeUnit.HOURS)
            .rateLimited(10, 1, TimeUnit.MINUTES)
            .build()
        install(Authentication) {
            jwt(JWT_PROVIDER) {
                realm = "cyppie"
                verifier(jwkProvider, issuer) {
                    acceptLeeway(5)
                }
                validate { cred ->
                    // A valid Keycloak token carries a subject; the wallet address is the username.
                    if (cred.payload.subject != null) JWTPrincipal(cred.payload) else null
                }
            }
        }
    }

    // Optional Postgres profile store (PRD-08 §3). Absent → /v1/me echoes the verified token identity.
    val db = Db.fromEnv()
    db?.migrate()
    val profiles = db?.let { ProfileRepository(it.dataSource) }
    val sessions = db?.let { AaSessionRepository(it.dataSource) }
    val schedules = db?.let { DcaScheduleRepository(it.dataSource) }
    val pendingBuys = db?.let { PendingBuyRepository(it.dataSource) }

    // KAN-163 DCA scheduler loop: when DB + the loopback aa-trigger are configured, tick every DCA_TICK_SECONDS —
    // build a USE-mode buy per due schedule (gated by kill-switch/Q7) and park it for on-device signing. The loop
    // never holds keys (Auth ≠ Custody). Absent config → no loop (the service still serves profiles/sessions).
    val aaTriggerUrl = System.getenv("AA_TRIGGER_URL")?.takeIf { it.isNotBlank() }
    val aaClient = aaTriggerUrl?.let { KtorAaTriggerClient(it) }
    if (sessions != null && schedules != null && pendingBuys != null && aaClient != null) {
        val scheduler = DcaScheduler(schedules, sessions, SubmitGate(sessions), aaClient, pendingBuys)
        val tickSeconds = System.getenv("DCA_TICK_SECONDS")?.toLongOrNull() ?: 60L
        launch(Dispatchers.IO) { // the tick does blocking JDBC + a blocking loopback call → IO pool, not Default
            while (isActive) {
                try { scheduler.tick(System.currentTimeMillis() / 1000) } catch (_: Exception) { /* never sink the loop */ }
                delay(tickSeconds * 1000)
            }
        }
    }

    routing {
        get("/health") { call.respond(HealthStatus("ok")) }   // liveness
        get("/ready") {                                        // readiness (DB-aware)
            val ok = db?.healthy() ?: true
            if (ok) call.respond(HealthStatus("ready"))
            else call.respond(HttpStatusCode.ServiceUnavailable, HealthStatus("db-unavailable"))
        }

        if (issuer != null) {
            authenticate(JWT_PROVIDER) {
                get("/v1/me") {
                    val principal = call.principal<JWTPrincipal>()!!
                    val subject = principal.payload.subject
                    val address = principal.payload.getClaim("preferred_username").asString() ?: subject
                    if (profiles != null) {
                        // First sign-in creates the profile; subsequent ones link the current KC subject.
                        val p = profiles.upsertAndGet(address, subject)
                        call.respond(MeResponse(p.walletAddress, subject, p.email, p.displayName, persisted = true))
                    } else {
                        call.respond(MeResponse(address, subject))
                    }
                }

                // KAN-159: register a §2 AA session (DCA). Nested {config} → derive columns server-side. No
                // enableSignature (enable already on-chain). The session account MUST be the caller's own SCA.
                post("/v1/me/sessions") {
                    if (profiles == null || sessions == null) {
                        call.respond(HttpStatusCode.ServiceUnavailable, ApiError("session store not configured")); return@post
                    }
                    val principal = call.principal<JWTPrincipal>()!!
                    val subject = principal.payload.subject
                    val address = principal.payload.getClaim("preferred_username").asString() ?: subject
                    val config = call.receive<CreateSessionRequest>().config
                    val f = deriveSessionFields(config)
                    if (!f.account.equals(address, ignoreCase = true)) {
                        throw ForbiddenException("config.account must be the caller's own wallet (7702 same-address)")
                    }
                    val userId = profiles.upsertAndGet(address, subject).id
                    val id = sessions.createSession(userId, f.chainId, f.account, f.signer, config.toString(), f.validUntil)
                    call.respond(HttpStatusCode.Created, CreateSessionResponse(id))
                }

                // The caller's registered AA sessions (app list + DCA-scheduler lookup).
                get("/v1/me/sessions") {
                    if (profiles == null || sessions == null) {
                        call.respond(HttpStatusCode.ServiceUnavailable, ApiError("session store not configured")); return@get
                    }
                    val principal = call.principal<JWTPrincipal>()!!
                    val subject = principal.payload.subject
                    val address = principal.payload.getClaim("preferred_username").asString() ?: subject
                    val userId = profiles.upsertAndGet(address, subject).id
                    val list = sessions.listByUser(userId).map { SessionSummary(it.id, it.chainId, it.account, it.signer, it.status, it.validUntilEpoch) }
                    call.respond(SessionsResponse(list))
                }

                // KAN-163: create a recurring DCA schedule referencing an enabled session (by permissionId). The
                // scheduler then builds buys for it. account MUST be the caller's own SCA.
                post("/v1/me/dca/schedules") {
                    if (profiles == null || schedules == null) {
                        call.respond(HttpStatusCode.ServiceUnavailable, ApiError("dca store not configured")); return@post
                    }
                    val principal = call.principal<JWTPrincipal>()!!
                    val subject = principal.payload.subject
                    val address = principal.payload.getClaim("preferred_username").asString() ?: subject
                    val r = call.receive<CreateDcaScheduleRequest>()
                    if (!r.account.equals(address, ignoreCase = true)) throw ForbiddenException("account must be the caller's own wallet")
                    if (!r.permissionId.matches(Regex("^0x[0-9a-fA-F]{64}$"))) throw BadRequestException("permissionId must be 0x+32 bytes")
                    if (r.feeTier <= 0) throw BadRequestException("feeTier must be > 0")
                    val amountIn = parsePositiveUint(r.amountIn, "amountIn")
                    val amountOutMin = parseUint(r.amountOutMin, "amountOutMin")
                    val userId = profiles.upsertAndGet(address, subject).id
                    val now = System.currentTimeMillis() / 1000
                    val id = schedules.create(
                        userId, r.chainId, r.account, r.tokenIn, r.tokenOut, amountIn, r.router,
                        r.intervalSeconds, now, r.permissionId, r.feeTier, amountOutMin,
                    )
                    call.respond(HttpStatusCode.Created, CreateDcaScheduleResponse(id))
                }

                // KAN-163: the caller's pending (built, unsigned) buys. The app raw-signs `digestToSign` on-device.
                // The opaque userOp stays backend-side (parked) — the app never sees or rebuilds it.
                get("/v1/me/dca/pending") {
                    if (profiles == null || pendingBuys == null) {
                        call.respond(HttpStatusCode.ServiceUnavailable, ApiError("dca store not configured")); return@get
                    }
                    val principal = call.principal<JWTPrincipal>()!!
                    val subject = principal.payload.subject
                    val address = principal.payload.getClaim("preferred_username").asString() ?: subject
                    val userId = profiles.upsertAndGet(address, subject).id
                    val list = pendingBuys.listPending(userId).map {
                        PendingBuyDto(
                            it.id, it.chainId, it.account, it.tokenIn, it.amountIn.toString(), it.userOpHash, it.digest,
                            userOp = Json.parseToJsonElement(it.userOp).jsonObject, // no-blind (b): app recomputes + scope-checks
                        )
                    }
                    call.respond(PendingBuysResponse(list))
                }

                // KAN-163: submit an app-signed buy. Re-gate (kill-switch may have engaged since build), relay the
                // parked userOp + signature to aa-trigger, record the spend (Q7), mark submitted. Fail-closed.
                post("/v1/me/dca/{id}/submit") {
                    if (profiles == null || pendingBuys == null || sessions == null || aaClient == null) {
                        call.respond(HttpStatusCode.ServiceUnavailable, ApiError("dca submit not configured")); return@post
                    }
                    val principal = call.principal<JWTPrincipal>()!!
                    val subject = principal.payload.subject
                    val address = principal.payload.getClaim("preferred_username").asString() ?: subject
                    val id = call.parameters["id"] ?: throw BadRequestException("missing id")
                    val sig = call.receive<SubmitBuyRequest>().signature
                    if (!sig.matches(Regex("^0x[0-9a-fA-F]{130}$"))) throw BadRequestException("signature must be a 65-byte 0x hex")
                    val userId = profiles.upsertAndGet(address, subject).id
                    val pb = pendingBuys.getPendingForUser(id, userId) ?: throw BadRequestException("no such pending buy")
                    when (val g = SubmitGate(sessions).check(userId, pb.chainId, pb.tokenIn, pb.amountIn)) {
                        is GateResult.Blocked -> { pendingBuys.markFailed(pb.id); throw ForbiddenException(g.reason) }
                        GateResult.Allowed -> {
                            val hash = try {
                                withContext(Dispatchers.IO) { aaClient.submitDcaBuy(pb.chainId, pb.permissionId, pb.userOp, sig) }
                            } catch (e: Exception) {
                                pendingBuys.markFailed(pb.id)
                                call.respond(HttpStatusCode.BadGateway, ApiError("aa-trigger submit failed: ${e.message}")); return@post
                            }
                            sessions.recordSpend(userId, pb.chainId, pb.tokenIn, pb.amountIn) // Q7 cumulative
                            pendingBuys.markSubmitted(pb.id)
                            call.respond(SubmitBuyResponse(hash))
                        }
                    }
                }
            }
        } else {
            get("/v1/me") {
                call.respond(HttpStatusCode.NotImplemented, ApiError("auth not configured — set CYPPIE_OIDC_ISSUER"))
            }
            post("/v1/me/sessions") {
                call.respond(HttpStatusCode.NotImplemented, ApiError("auth not configured — set CYPPIE_OIDC_ISSUER"))
            }
        }
    }
}
