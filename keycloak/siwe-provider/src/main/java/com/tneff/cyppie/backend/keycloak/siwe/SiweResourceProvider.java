package com.tneff.cyppie.backend.keycloak.siwe;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import org.keycloak.common.util.SecretGenerator;
import org.keycloak.models.KeycloakSession;
import org.keycloak.services.resource.RealmResourceProvider;

import java.util.Map;

/**
 * Realm REST resource exposing the SIWE nonce endpoint at {@code GET /realms/{realm}/siwe/nonce}
 * (ADR-0026 / KAN-137). Issues a single-use, short-lived nonce that the client embeds in the EIP-4361
 * message it signs on-device; {@link SiweAuthenticator} later consumes it exactly once (replay protection).
 */
public class SiweResourceProvider implements RealmResourceProvider {

    private final KeycloakSession session;

    public SiweResourceProvider(KeycloakSession session) {
        this.session = session;
    }

    @Override
    public Object getResource() {
        return this;
    }

    /** Issue a single-use SIWE nonce (EIP-4361 nonce = >=8 alphanumeric chars) with a short TTL. */
    @GET
    @Path("nonce")
    @Produces(MediaType.APPLICATION_JSON)
    public Response nonce() {
        String nonce = SecretGenerator.getInstance().randomString(24);
        session.singleUseObjects().put(
                SiweAuthenticator.nonceKey(nonce),
                SiweAuthenticator.NONCE_TTL_SECONDS,
                Map.of());
        return Response.ok(Map.of(
                "nonce", nonce,
                "expiresInSeconds", SiweAuthenticator.NONCE_TTL_SECONDS)).build();
    }

    @Override
    public void close() {
    }
}
