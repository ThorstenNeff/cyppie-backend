-- User-Service schema v1 (PRD-08 §3 — profiles/settings on Postgres). Applied by Flyway on startup
-- once DB wiring lands (next increment). The identity key is the EVM address (F1 = SIWE: the wallet
-- address IS the platform identity); email is OPTIONAL recovery/notification only — never wallet access.
--
-- 🔑 Auth ≠ Custody: no seeds, no private keys, no signing material is ever stored here. The address is
--    a public identifier; PII (email/display name) is the only sensitive data — encrypt at rest (F3).

CREATE TABLE app_user (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Lower-cased EVM address (EIP-55 checksum normalised to lowercase for the unique key). 0x + 40 hex.
    wallet_address  VARCHAR(42) NOT NULL UNIQUE
        CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    -- Keycloak subject (sub) once the SIWE federation issues it; nullable until auth is wired.
    keycloak_sub    VARCHAR(64) UNIQUE,
    email           VARCHAR(320),          -- OPTIONAL recovery/notification channel (PII — encrypt at rest)
    display_name    VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Free-form per-user preferences (currency, locale, notification opt-ins, …). One row per user.
CREATE TABLE user_settings (
    user_id     UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_user_keycloak_sub ON app_user(keycloak_sub);
