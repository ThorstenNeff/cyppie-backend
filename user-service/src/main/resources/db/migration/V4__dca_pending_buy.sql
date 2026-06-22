-- KAN-163 DCA scheduler plumbing: the mapping the scheduler needs to BUILD a buy, plus the on-device-sign
-- handshake store. The on-chain enable already happened (approach B); the schedule references its session by
-- permission_id so the scheduler can call aa-trigger /v1/dca/build. The buy is then BUILT (USE-mode, sponsored)
-- and parked here for the app to fetch, sign the RAW userOpHash on-device (Q1), and submit. No key material.

-- (1) Mapping: a schedule carries the buy parameters the build needs beyond the recurring config (the permission
--     of the enabled session it runs under + the swap slippage/fee). Resolved at schedule creation from the
--     registered session (the cleanest of the plan's two options: register returns permissionId, schedule stores it).
ALTER TABLE dca_schedule
    ADD COLUMN permission_id  VARCHAR(66),                          -- the enabled DCA Smart-Session (USE-mode)
    ADD COLUMN fee_tier       INTEGER NOT NULL DEFAULT 500,         -- Uniswap V3 pool fee for the buy
    ADD COLUMN amount_out_min NUMERIC(78,0) NOT NULL DEFAULT 0;     -- slippage floor (base units; 0 = testnet)

-- (2) Pending-buy handshake: one row per BUILT-but-unsigned recurring buy. status flows
--     pending → submitted (app signed + we relayed to the bundler) | failed. user_op is the opaque serialized
--     v0.7 UserOperation from aa-trigger (resubmitted verbatim with the app signature). digest == RAW userOpHash
--     (the C3 USE-lock — the app raw-signs THIS; NOT the EIP-191 enable form).
CREATE TABLE dca_pending_buy (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id   UUID NOT NULL REFERENCES dca_schedule(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    chain_id      BIGINT NOT NULL,
    account       VARCHAR(42) NOT NULL,
    token_in      VARCHAR(42) NOT NULL,
    amount_in     NUMERIC(78,0) NOT NULL,
    permission_id VARCHAR(66) NOT NULL,
    user_op       JSONB NOT NULL,                                   -- opaque serialized UserOp (submit verbatim)
    user_op_hash  VARCHAR(66) NOT NULL,
    digest        VARCHAR(66) NOT NULL,                             -- == user_op_hash (RAW, USE-lock)
    status        VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at  TIMESTAMPTZ,
    CONSTRAINT dca_pending_status_ck CHECK (status IN ('pending', 'submitted', 'failed'))
);

-- The app's "my pending buys" fetch + the idempotency guard (one open build per schedule at a time).
CREATE INDEX idx_dca_pending_user ON dca_pending_buy(user_id) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_dca_pending_open ON dca_pending_buy(schedule_id) WHERE status = 'pending';
