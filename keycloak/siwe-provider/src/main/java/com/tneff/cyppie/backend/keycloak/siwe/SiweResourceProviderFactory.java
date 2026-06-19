package com.tneff.cyppie.backend.keycloak.siwe;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;

/** Mounts {@link SiweResourceProvider} at the realm path segment {@code siwe} (ADR-0026 / KAN-137). */
public class SiweResourceProviderFactory implements RealmResourceProviderFactory {

    public static final String ID = "siwe";

    @Override
    public String getId() {
        return ID;
    }

    @Override
    public RealmResourceProvider create(KeycloakSession session) {
        return new SiweResourceProvider(session);
    }

    @Override
    public void init(Config.Scope config) {
    }

    @Override
    public void postInit(KeycloakSessionFactory factory) {
    }

    @Override
    public void close() {
    }
}
