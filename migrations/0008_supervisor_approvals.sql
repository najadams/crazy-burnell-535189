-- 0008_supervisor_approvals.sql
-- Reusable supervisor-PIN gate primitive. Spec Section 11.
--
-- The pattern: a cashier triggers an action requiring elevation (an
-- over-credit-limit partial payment, an over-threshold discount, a
-- breakage write-off, a sale void). The supervisor enters their PIN
-- in the dialog. The PIN is bcrypt-verified against any active
-- SUPERVISOR/OWNER/FOUNDER worker's pin_hash. On success, a row is
-- inserted here recording who approved what and for what context. The
-- service that triggered the gate then consumes the approval row
-- (marks used_at) as part of its transaction.
--
-- Why a row, not just a boolean: the audit trail needs a forensic
-- record of "who approved over-limit on sale X" months after the fact.
-- A bcrypt-pass-no-record approach leaves no breadcrumb. The row also
-- enforces single-use (you can't approve once and consume the same
-- approval twice) and time-bounded validity (an approval doesn't sit
-- in memory forever waiting for an unrelated future action).
--
-- This migration is independent of sale_payments — written as a
-- general primitive so the other elevated-action flows (discounts,
-- breakage, voids) can use it without further schema work.

CREATE TABLE supervisor_approvals (
  id TEXT PRIMARY KEY,                            -- sa-{uuid}
  -- The supervisor whose PIN was verified. May equal created_by when
  -- a SUPERVISOR-role worker is themselves the cashier (rare, allowed).
  supervisor_worker_id TEXT NOT NULL REFERENCES workers(id),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'OVER_LIMIT_PARTIAL',
    'OVER_THRESHOLD_DISCOUNT',
    'BREAKAGE',
    'VOID_SALE',
    'CUSTOMER_RETURN'
  )),
  -- JSON snapshot of what the supervisor was approving at the moment
  -- of approval — customer id, over-limit delta, discount %, etc.
  -- Lets a forensic reader reconstruct the decision without joining
  -- back through the audit log. Empty object is the no-context default.
  context_json TEXT NOT NULL DEFAULT '{}',
  -- An approval is short-lived. The default expiry (set in service
  -- code) is 5 minutes — long enough for the supervisor to walk back
  -- and the cashier to complete the action, short enough that an
  -- unconsumed approval can't be used hours later.
  expires_at TEXT NOT NULL,
  -- Consumption columns: NULL means unused, non-NULL means consumed.
  -- The trio (used_at, used_by_action, used_by_entity_id) records
  -- when, what action consumed it, and which entity carries the
  -- approval downstream (e.g. the sale-{uuid} that gated through).
  used_at TEXT,
  used_by_action TEXT,
  used_by_entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The cashier who requested the elevation. Audit-attribution path.
  created_by TEXT NOT NULL REFERENCES workers(id),
  device_id TEXT NOT NULL DEFAULT 'd-counter-1'
);

-- Lookup pattern when consuming: "is this approval still valid?" is
-- (id = ? AND used_at IS NULL AND expires_at > now). The id PK handles
-- the equality lookup; the partial index narrows the available-row
-- scan for any forensic "show me unused approvals" query.
CREATE INDEX idx_supervisor_approvals_open
  ON supervisor_approvals(expires_at)
  WHERE used_at IS NULL;

CREATE INDEX idx_supervisor_approvals_supervisor_created
  ON supervisor_approvals(supervisor_worker_id, created_at);

CREATE INDEX idx_supervisor_approvals_used_entity
  ON supervisor_approvals(used_by_entity_id)
  WHERE used_at IS NOT NULL;
