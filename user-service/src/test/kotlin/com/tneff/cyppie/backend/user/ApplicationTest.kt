package com.tneff.cyppie.backend.user

import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
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

    @Test
    fun registerSessionFailsClosedWithoutAuth() = testApplication {
        application { userServiceModule() }
        // KAN-159: without CYPPIE_OIDC_ISSUER the register endpoint must fail closed (not 200/500).
        val res = client.post("/v1/me/sessions") {
            contentType(ContentType.Application.Json)
            setBody("""{"config":{"chainId":8453,"account":"0x0000000000000000000000000000000000000001","actions":[]}}""")
        }
        assertEquals(HttpStatusCode.NotImplemented, res.status)
    }

    @Test
    fun deriveSessionFieldsFromConfig() {
        // The §2-config derivation: signer defaults to on-device (omitted on the wire), valid_until = max action expiry.
        val json = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"chainId":8453,"account":"0xABCdef0000000000000000000000000000000001",
                "actions":[{"validUntil":100},{"validUntil":1752958208}]}"""
        ) as kotlinx.serialization.json.JsonObject
        val d = deriveSessionFields(json)
        assertEquals(8453L, d.chainId)
        assertEquals("on-device", d.signer)           // omitted → default
        assertEquals(1752958208L, d.validUntil)        // max of the action expiries
    }
}
