package com.tneff.cyppie.backend.user

import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable

/**
 * Cyppie User-Service (PRD-08 / ADR-0023) — platform profiles & settings behind the Caddy gateway.
 *
 * 🔑 Auth ≠ Custody: this service handles platform identity only. It never receives, stores, or signs
 *    wallet seeds or private keys — those stay on-device (PRD-01). Identity = the EVM address (F1 SIWE).
 *
 * v1 SKELETON: boots standalone and serves liveness/readiness. The DB layer (Postgres + Flyway, schema
 * in resources/db/migration/V1__init.sql) and the JWT-protected `/v1` profile API land in the next
 * increments — the latter gated by the SIWE-Keycloak mini-ADR before any auth code is written.
 */
fun main() {
    val port = System.getenv("USER_SERVICE_PORT")?.toIntOrNull() ?: 8081
    embeddedServer(Netty, port = port, host = "0.0.0.0", module = Application::userServiceModule).start(wait = true)
}

@Serializable
data class HealthStatus(val status: String, val service: String = "user-service", val version: String = "0.1.0")

@Serializable
data class ApiError(val error: String)

fun Application.userServiceModule() {
    install(ContentNegotiation) { json() }
    install(CallLogging)
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            call.respond(HttpStatusCode.InternalServerError, ApiError(cause.message ?: "internal error"))
        }
    }

    routing {
        // Liveness — process is up. Used by the container/orchestrator healthcheck.
        get("/health") { call.respond(HealthStatus("ok")) }

        // Readiness — will additionally verify the DB connection once Postgres/Flyway is wired.
        get("/ready") { call.respond(HealthStatus("ready")) }

        // Profile API — JWT-protected (Keycloak/SIWE). Closed until auth lands (own mini-ADR).
        get("/v1/me") {
            call.respond(HttpStatusCode.NotImplemented, ApiError("auth not yet wired — PRD-08 SIWE pending"))
        }
    }
}
