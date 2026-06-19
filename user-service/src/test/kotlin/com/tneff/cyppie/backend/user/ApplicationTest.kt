package com.tneff.cyppie.backend.user

import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ApplicationTest {

    @Test
    fun healthReturnsOk() = testApplication {
        application { userServiceModule() }
        val res = client.get("/health")
        assertEquals(HttpStatusCode.OK, res.status)
        assertTrue(res.bodyAsText().contains("\"status\":\"ok\""))
    }

    @Test
    fun readyReturnsReady() = testApplication {
        application { userServiceModule() }
        assertEquals(HttpStatusCode.OK, client.get("/ready").status)
    }

    @Test
    fun meIsNotYetImplemented() = testApplication {
        application { userServiceModule() }
        // Auth (SIWE/Keycloak) not wired yet — the profile endpoint must fail closed, not 200.
        assertEquals(HttpStatusCode.NotImplemented, client.get("/v1/me").status)
    }
}
