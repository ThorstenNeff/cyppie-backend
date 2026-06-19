package com.tneff.cyppie.backend.keycloak.siwe;

import com.moonstoneid.siwe.SiweMessage;
import com.moonstoneid.siwe.error.SiweException;

import java.util.Locale;
import java.util.Set;

/**
 * Pure (Keycloak-independent) Sign-In-With-Ethereum verification (ADR-0026 / KAN-137). Extracted from
 * {@link SiweAuthenticator} so the security-critical crypto path is unit-testable without a running
 * Keycloak: parse → domain-binding + signature recovery (siwe-java) → nonce match → chain-id binding.
 *
 * <p><b>Replay (single-use) is NOT here:</b> consuming the nonce exactly once is the caller's job (the
 * Keycloak {@code SingleUseObjectProvider}); this class only enforces that the message <em>binds</em> to
 * the expected nonce. The end-to-end single-use behaviour is verified against a live Keycloak (Mac Mini).
 */
public final class SiweVerifier {

    private SiweVerifier() {
    }

    /** Successful verification result — the lowercase EVM address (platform identity) + the chain id. */
    public record Result(String address, long chainId) {
    }

    /** Thrown when a SIWE message+signature fails any verification check. */
    public static final class SiweVerificationException extends Exception {
        public SiweVerificationException(String message) {
            super(message);
        }
    }

    /**
     * @param message        the raw EIP-4361 message the wallet signed
     * @param signature      the hex (0x…65-byte) personal_sign signature
     * @param expectedDomain the RFC 4501 dnsauthority that MUST appear in the message (domain-binding)
     * @param expectedNonce  the nonce the server issued (and, at the call site, just consumed single-use)
     * @param allowedChains  permitted EVM chain ids; empty = any
     * @return the recovered lowercase address + chain id
     */
    public static Result verify(String message, String signature, String expectedDomain,
                                String expectedNonce, Set<Long> allowedChains) throws SiweVerificationException {
        final SiweMessage siwe;
        try {
            siwe = new SiweMessage.Parser().parse(message);
        } catch (Exception e) {
            throw new SiweVerificationException("unparseable SIWE message");
        }

        // Domain-binding (anti-phishing) + nonce match + signature recovery + issuedAt/expiration window.
        try {
            siwe.verify(expectedDomain, expectedNonce, signature);
        } catch (SiweException e) {
            throw new SiweVerificationException("SIWE verification failed");
        }

        // NB: siwe-java getChainId() returns int — capture as long BEFORE the Set<Long> check, otherwise
        // it autoboxes to Integer and never matches a Long element (would silently reject every chain).
        long chainId = siwe.getChainId();
        if (!allowedChains.isEmpty() && !allowedChains.contains(chainId)) {
            throw new SiweVerificationException("chainId " + chainId + " not allowed");
        }

        return new Result(siwe.getAddress().toLowerCase(Locale.ROOT), chainId);
    }
}
