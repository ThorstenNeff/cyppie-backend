-- AA session registry + cross-session exposure + global kill-switch (PRD-05 / ADR-0024 Q1/Q7).
-- 🔑 No key material here: the Copy/Vaults backend session key lives in HSM/KMS (Ph2), never in this DB.
-- This is metadata + accounting only — what sessions exist, their scopes, and cumulative spend.

-- A scoped Smart-Session on a user's 7702 SCA (= the SIWE-identity address).
CREATE TABLE aa_session (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    chain_id     BIGINT NOT NULL,                                   -- 1 (ETH) | 8453 (Base)
    account      VARCHAR(42) NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),  -- the SCA (= SIWE address)
    signer       VARCHAR(16) NOT NULL CHECK (signer IN ('on-device','backend')),  -- Q1 per-feature
    status       VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
    config       JSONB NOT NULL,                                    -- Ph0 session-config schema (scopes+limits)
    valid_until  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_aa_session_user ON aa_session(user_id);
CREATE INDEX idx_aa_session_account ON aa_session(chain_id, account);

-- Q7 total-exposure: cumulative spend per (user, chain, token) across ALL of a user's sessions. The
-- backend gate before submitting any UserOp (the on-chain per-session cap is the hard gate; this is the
-- cross-session aggregate). NUMERIC(78,0) covers the uint256 range.
CREATE TABLE aa_exposure (
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    chain_id    BIGINT NOT NULL,
    token       VARCHAR(42) NOT NULL,
    spent       NUMERIC(78,0) NOT NULL DEFAULT 0,
    cap         NUMERIC(78,0),                                      -- null = no aggregate cap
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, chain_id, token)
);

-- Global kill-switch (single row): an incident-response pause that stops new UserOps immediately.
CREATE TABLE aa_killswitch (
    id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    paused      BOOLEAN NOT NULL DEFAULT false,
    reason      TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO aa_killswitch (id, paused) VALUES (1, false);
