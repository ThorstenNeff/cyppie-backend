package com.tneff.cyppie.backend.keycloak.siwe;

import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

import java.util.List;

/** Registers {@link SiweAuthenticator} as a configurable Keycloak authenticator (ADR-0026 / KAN-137). */
public class SiweAuthenticatorFactory implements AuthenticatorFactory {

    public static final String PROVIDER_ID = "siwe-authenticator";
    private static final SiweAuthenticator SINGLETON = new SiweAuthenticator();

    private static final AuthenticationExecutionModel.Requirement[] REQUIREMENT_CHOICES = {
            AuthenticationExecutionModel.Requirement.REQUIRED,
            AuthenticationExecutionModel.Requirement.DISABLED,
    };

    @Override
    public String getId() {
        return PROVIDER_ID;
    }

    @Override
    public Authenticator create(KeycloakSession session) {
        return SINGLETON;
    }

    @Override
    public String getDisplayType() {
        return "SIWE (Sign-In-With-Ethereum)";
    }

    @Override
    public String getReferenceCategory() {
        return "siwe";
    }

    @Override
    public boolean isConfigurable() {
        return true;
    }

    @Override
    public AuthenticationExecutionModel.Requirement[] getRequirementChoices() {
        return REQUIREMENT_CHOICES;
    }

    @Override
    public boolean isUserSetupAllowed() {
        return false;
    }

    @Override
    public String getHelpText() {
        return "Authenticates a user by verifying a Sign-In-With-Ethereum (EIP-4361) message + signature. "
                + "The lowercase wallet address becomes the username. Auth != Custody: no keys are handled.";
    }

    @Override
    public List<ProviderConfigProperty> getConfigProperties() {
        ProviderConfigProperty domain = new ProviderConfigProperty();
        domain.setName(SiweAuthenticator.CFG_DOMAIN);
        domain.setLabel("Expected domain");
        domain.setType(ProviderConfigProperty.STRING_TYPE);
        domain.setHelpText("The RFC 4501 dnsauthority that must appear in the SIWE message "
                + "(domain-binding / anti-phishing), e.g. auth.cyppie.example.");

        ProviderConfigProperty chains = new ProviderConfigProperty();
        chains.setName(SiweAuthenticator.CFG_CHAIN_IDS);
        chains.setLabel("Allowed chain IDs");
        chains.setType(ProviderConfigProperty.STRING_TYPE);
        chains.setHelpText("Comma-separated EVM chain IDs allowed to authenticate (empty = any). E.g. 1,8453.");

        return List.of(domain, chains);
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
