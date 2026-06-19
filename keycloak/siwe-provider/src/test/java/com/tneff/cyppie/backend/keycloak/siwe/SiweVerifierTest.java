package com.tneff.cyppie.backend.keycloak.siwe;

import com.moonstoneid.siwe.SiweMessage;
import org.junit.jupiter.api.Test;
import org.web3j.crypto.ECKeyPair;
import org.web3j.crypto.Sign;
import org.web3j.utils.Numeric;

import java.nio.charset.StandardCharsets;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Proves the SIWE crypto path (ADR-0026 review focus) WITHOUT a running Keycloak: a deterministic
 * EIP-4361 message is built via siwe-java (so the serialization matches what verify recomputes), signed
 * with a well-known test key via web3j, then run through {@link SiweVerifier}. Covers signature recovery,
 * domain-binding, chain-id binding, and nonce match. (Single-use replay is the Keycloak store's job and
 * is verified end-to-end on the Mac Mini.)
 */
class SiweVerifierTest {

    // Hardhat / Anvil well-known test account #0 — deterministic, holds no real funds.
    private static final String PRIV_KEY =
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    private static final String ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // EIP-55 checksum
    private static final String DOMAIN = "auth.cyppie.example";
    private static final String URI = "https://auth.cyppie.example";
    private static final String NONCE = "abcdef1234567890";
    private static final int CHAIN_ID = 1; // siwe-java Builder + getChainId() use int
    private static final String ISSUED_AT = "2026-06-19T12:00:00Z";

    private final ECKeyPair keyPair = ECKeyPair.create(Numeric.toBigInt(PRIV_KEY));

    private String buildMessage() {
        try {
            SiweMessage m = new SiweMessage.Builder(DOMAIN, ADDRESS, URI, "1", CHAIN_ID, NONCE, ISSUED_AT)
                    .statement("Sign in to Cyppie")
                    .build();
            return m.toMessage();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private String sign(String message) {
        Sign.SignatureData sd = Sign.signPrefixedMessage(message.getBytes(StandardCharsets.UTF_8), keyPair);
        byte[] sig = new byte[65];
        System.arraycopy(sd.getR(), 0, sig, 0, 32);
        System.arraycopy(sd.getS(), 0, sig, 32, 32);
        sig[64] = sd.getV()[0];
        return Numeric.toHexString(sig);
    }

    @Test
    void validSignatureRecoversAddress() throws Exception {
        String msg = buildMessage();
        String sig = sign(msg);
        SiweVerifier.Result r = SiweVerifier.verify(msg, sig, DOMAIN, NONCE, Set.of(1L));
        assertEquals(ADDRESS.toLowerCase(), r.address());
        assertEquals(1L, r.chainId());
    }

    @Test
    void anyChainAllowedWhenConfigEmpty() throws Exception {
        String msg = buildMessage();
        String sig = sign(msg);
        // empty allow-set = any chain
        assertEquals(ADDRESS.toLowerCase(), SiweVerifier.verify(msg, sig, DOMAIN, NONCE, Set.of()).address());
    }

    @Test
    void wrongDomainRejected() {
        String msg = buildMessage();
        String sig = sign(msg);
        assertThrows(SiweVerifier.SiweVerificationException.class,
                () -> SiweVerifier.verify(msg, sig, "evil.example", NONCE, Set.of()));
    }

    @Test
    void tamperedSignatureRejected() {
        String msg = buildMessage();
        String sig = sign(msg);
        char[] c = sig.toCharArray();
        c[10] = (c[10] == 'a') ? 'b' : 'a'; // flip a byte in r
        assertThrows(SiweVerifier.SiweVerificationException.class,
                () -> SiweVerifier.verify(msg, new String(c), DOMAIN, NONCE, Set.of()));
    }

    @Test
    void disallowedChainRejected() {
        String msg = buildMessage();
        String sig = sign(msg);
        assertThrows(SiweVerifier.SiweVerificationException.class,
                () -> SiweVerifier.verify(msg, sig, DOMAIN, NONCE, Set.of(8453L)));
    }

    @Test
    void wrongNonceRejected() {
        String msg = buildMessage();
        String sig = sign(msg);
        assertThrows(SiweVerifier.SiweVerificationException.class,
                () -> SiweVerifier.verify(msg, sig, DOMAIN, "differentnonce99", Set.of()));
    }
}
