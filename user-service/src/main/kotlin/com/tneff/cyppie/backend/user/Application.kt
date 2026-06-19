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
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable
import java.net.URI
import java.util.concurrent.TimeUnit

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
data class MeResponse(val walletAddress: String, val subject: String)

private const val JWT_PROVIDER = "cyppie-jwt"

fun Application.userServiceModule() {
    install(ContentNegotiation) { json() }
    install(CallLogging)
    install(StatusPages) {
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

    routing {
        get("/health") { call.respond(HealthStatus("ok")) }   // liveness
        get("/ready") { call.respond(HealthStatus("ready")) }  // readiness (adds DB check once wired)

        if (issuer != null) {
            authenticate(JWT_PROVIDER) {
                get("/v1/me") {
                    val principal = call.principal<JWTPrincipal>()!!
                    val address = principal.payload.getClaim("preferred_username").asString()
                        ?: principal.payload.subject
                    call.respond(MeResponse(walletAddress = address, subject = principal.payload.subject))
                }
            }
        } else {
            get("/v1/me") {
                call.respond(HttpStatusCode.NotImplemented, ApiError("auth not configured — set CYPPIE_OIDC_ISSUER"))
            }
        }
    }
}
