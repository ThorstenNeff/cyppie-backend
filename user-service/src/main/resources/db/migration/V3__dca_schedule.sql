-- DCA schedules (PRD-05). The scheduler picks due rows and signals a DCA build; the app signs the
-- userOpHash on-device (Q1 = DCA on-device). No key material — just the recurring-buy config.

CREATE TABLE dca_schedule (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    chain_id         BIGINT NOT NULL,
    account          VARCHAR(42) NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),  -- 7702 SCA = SIWE addr
    token_in         VARCHAR(42) NOT NULL,
    token_out        VARCHAR(42) NOT NULL,
    amount_in        NUMERIC(78,0) NOT NULL,                         -- base units (uint256)
    router           VARCHAR(42) NOT NULL,
    interval_seconds BIGINT NOT NULL CHECK (interval_seconds >= 3600),  -- min 1h cadence
    enabled          BOOLEAN NOT NULL DEFAULT true,
    next_run_at      TIMESTAMPTZ NOT NULL,
    last_run_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index for the scheduler's hot path: enabled + due.
CREATE INDEX idx_dca_due ON dca_schedule(next_run_at) WHERE enabled;
