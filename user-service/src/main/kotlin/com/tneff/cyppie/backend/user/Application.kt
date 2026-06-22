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
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
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
