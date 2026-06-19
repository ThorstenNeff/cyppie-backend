package com.tneff.cyppie.backend.keycloak.siwe;

import com.moonstoneid.siwe.SiweMessage;
import jakarta.ws.rs.core.MultivaluedMap;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.models.AuthenticatorConfigModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Keycloak Authenticator that authenticates a user from a Sign-In-With-Ethereum (EIP-4361) message +
 * signature (ADR-0026 / KAN-137). Designed for the Direct-Grant flow so native/KMP clients authenticate
 * without a browser: the client first fetches a nonce ({@link SiweResourceProvider}), builds + signs the
 * SIWE message on-device, then posts {@code siwe_message} + {@code siwe_signature} to the token endpoint.
 *
 * <p>🔑 Auth ≠ Custody: only a public address + a signature are ever seen here — never a key.
 *
 * <p>Security properties (ADR-0026 review focus):
 * <ul>
 *   <li><b>Replay</b>: the nonce must be one we issued; {@code singleUseObjects().remove} is atomic
 *       single-use, so a message can authenticate at most once.</li>
 *   <li><b>Nonce single-use + expiry</b>: issued with a short TTL via the SingleUseObjectProvider.</li>
 *   <li><b>Domain-binding</b> (anti-phishing): {@code verify} requires the message domain == our domain,
 *       so a signature gathered by another dApp can't be replayed here.</li>
 *   <li><b>Signature recovery</b>: delegated to siwe-java (ecrecover) — not hand-rolled.</li>
 *   <li><b>Chain-ID binding</b>: only configured chain IDs may authenticate.</li>
 * </ul>
 */
public class SiweAuthenticator implements Authenticator {

    private static final System.Logger LOG = System.getLogger(SiweAuthenticator.class.getName());

    public static final String MSG_PARAM = "siwe_message";
    public static final String SIG_PARAM = "siwe_signature";

    /** Short nonce lifetime — a sign-in must complete promptly after fetching the challenge. */
    public static final long NONCE_TTL_SECONDS = 300L;

    public static final String CFG_DOMAIN = "domain";
    public static final String CFG_CHAIN_IDS = "chainIds";

    public static final String ATTR_WALLET_ADDRESS = "wallet_address";

    static String nonceKey(String nonce) {
        return "siwe-nonce:" + nonce;
    }

    @Override
    public void authenticate(AuthenticationFlowContext context) {
        MultivaluedMap<String, String> form = context.getHttpRequest().getDecodedFormParameters();
        String message = form.getFirst(MSG_PARAM);
        String signature = form.getFirst(SIG_PARAM);
        if (message == null || signature == null) {
            fail(context, "missing " + MSG_PARAM + " / " + SIG_PARAM);
            return;
        }

        SiweMessage siwe;
        try {
            siwe = new SiweMessage.Parser().parse(message);
        } catch (Exception e) {
            fail(context, "unparseable SIWE message");
            return;
        }

        AuthenticatorConfigModel cfg = context.getAuthenticatorConfig();
        String expectedDomain = configValue(cfg, CFG_DOMAIN);
        Set<Long> allowedChains = parseChainIds(configValue(cfg, CFG_CHAIN_IDS));
        String nonce = siwe.getNonce();

        // 1) Replay protection (Keycloak single-use) — the nonce must be one WE issued, unused and
        //    unexpired. remove() is the atomic single-use op: returns the entry iff present, then deletes
        //    it (no reuse). This is the part that needs a live Keycloak; the crypto below is unit-tested.
        Map<String, String> issued = context.getSession().singleUseObjects().remove(nonceKey(nonce));
        if (issued == null) {
            fail(context, "nonce unknown, expired, or already used");
            return;
        }

        // 2) Crypto verification — domain-binding + ecrecover + nonce match + window + chain-id binding.
        //    Delegated to the pure, unit-tested SiweVerifier (siwe-java under the hood).
        final SiweVerifier.Result result;
        try {
            result = SiweVerifier.verify(message, signature, expectedDomain, nonce, allowedChains);
        } catch (SiweVerifier.SiweVerificationException e) {
            fail(context, e.getMessage());
            return;
        }

        // 3) Federate: the lowercase EVM address IS the platform identity (F1). No key material involved.
        UserModel user = findOrCreateUser(context, result.address());
        context.setUser(user);
        context.success();
    }

    private UserModel findOrCreateUser(AuthenticationFlowContext context, String address) {
        KeycloakSession session = context.getSession();
        RealmModel realm = context.getRealm();
        UserModel user = session.users().getUserByUsername(realm, address);
        if (user == null) {
            user = session.users().addUser(realm, address);
            user.setSingleAttribute(ATTR_WALLET_ADDRESS, address);
        }
        // A SIWE identity is passwordless and email-less. Idempotently keep it "fully set up" so Keycloak
        // issues tokens after a valid sign-in: enabled, email marked verified, and no pending required
        // actions (otherwise the direct-grant fails with "Account is not fully set up").
        user.setEnabled(true);
        user.setEmailVerified(true);
        user.getRequiredActionsStream().toList().forEach(user::removeRequiredAction);
        return user;
    }

    private static String configValue(AuthenticatorConfigModel cfg, String key) {
        if (cfg == null || cfg.getConfig() == null) {
            return null;
        }
        return cfg.getConfig().get(key);
    }

    private static Set<Long> parseChainIds(String csv) {
        Set<Long> out = new HashSet<>();
        if (csv == null || csv.isBlank()) {
            return out;
        }
        for (String part : csv.split(",")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) {
                out.add(Long.parseLong(trimmed));
            }
        }
        return out;
    }

    private void fail(AuthenticationFlowContext context, String reason) {
        LOG.log(System.Logger.Level.WARNING, "SIWE authentication rejected: " + reason);
        context.failure(AuthenticationFlowError.INVALID_CREDENTIALS);
    }

    @Override
    public boolean requiresUser() {
        return false;
    }

    @Override
    public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) {
        return true;
    }

    @Override
    public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) {
    }

    @Override
    public void action(AuthenticationFlowContext context) {
    }

    @Override
    public void close() {
    }
}
