#!/usr/bin/env bash
# Post-import realm config that Keycloak's realm import can't express (ADR-0026 / KAN-137).
#
# Disables the VERIFY_PROFILE required action for the cyppie realm so passwordless wallet (SIWE)
# identities — which have no email/name — count as "fully set up" and the SIWE direct-grant flow can
# issue tokens. (Keycloak ignores `enabled:false` for built-in required actions on realm import, so this
# must run once after the realm is imported. Verified: the SIWE e2e returns a JWT only after this.)
#
# Idempotent. Run after Keycloak is up and the cyppie realm exists.
set -euo pipefail

KC_HOME="${KC_HOME:-/opt/keycloak}"
KC_URL="${KC_URL:-http://localhost:8080}"
: "${KC_ADMIN:?set KC_ADMIN}"
: "${KC_ADMIN_PASSWORD:?set KC_ADMIN_PASSWORD}"

KCADM="$KC_HOME/bin/kcadm.sh"
"$KCADM" config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN" --password "$KC_ADMIN_PASSWORD"
"$KCADM" update authentication/required-actions/VERIFY_PROFILE -r cyppie -s enabled=false -s defaultAction=false
echo "VERIFY_PROFILE disabled for realm cyppie (SIWE wallet identities are passwordless/profileless)."

# Security (Ph1 review INFO-5b): the ONLY allowed grant_type=password path must be cyppie-app -> the SIWE
# authenticator flow. The default admin-cli client otherwise exposes a generic ROPC (username/password)
# surface on the realm's default direct-grant flow. cyppie-realm admin ops go via the MASTER realm, so
# disable direct-access-grants on the cyppie admin-cli — closing the generic password-grant entirely.
ADMIN_CLI_ID="$("$KCADM" get clients -r cyppie -q clientId=admin-cli --fields id --format csv --noquotes | tr -d '\r' | tail -1)"
if [ -n "$ADMIN_CLI_ID" ]; then
  "$KCADM" update "clients/$ADMIN_CLI_ID" -r cyppie -s directAccessGrantsEnabled=false
  echo "Generic ROPC closed: admin-cli direct-access-grants disabled (cyppie realm; only cyppie-app -> SIWE remains)."
fi
