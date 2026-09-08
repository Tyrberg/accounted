-- Migration: propmate lease -> recurring invoice schedule chain (hyresaviseringskedjan)
--
-- Why this exists: hyresavisering (Bohed, Molleborgen-kontorshotellet) is
-- currently a manual Excel process. propmate's `leases` table is the avtalskälla
-- (monthly_rent, tillägg, kampanjpris, KPI-index reference data); gnubok's
-- existing recurring_invoice_schedules/_items (20260518150000) is the
-- fakturamotor. lib/invoices/create-recurring-schedule.ts and
-- apply-recurring-schedule-update.ts are the ONLY two write paths that can
-- create or edit a schedule's items (extensions/general/propmate's sync
-- service calls those same functions rather than writing schedule rows
-- itself), so there is exactly one place that validates a revenue_account
-- override: lib/invoices/validate-schedule-revenue-accounts.ts.
--
-- Deposits (depositioner) and automatic KPI index uppräkning are explicitly
-- OUT of scope for this migration/chain: leases.kpi_base_index/kpi_base_year/
-- kpi_next_review_date are avtalskälla reference fields only, read by nothing
-- yet. Filed as follow-up work (see PR description), not built here.

-- ============================================================
-- recurring_invoice_schedule_items.revenue_account
-- ============================================================
-- Same shape/purpose as invoice_items.revenue_account (20260621120000,
-- artikelregister): an optional per-line posting-account override, class 1-3.
-- Unlike invoice_items, this column gets a DB-level CHECK on the shape
-- (matching INVOICE_POSTING_ACCOUNT_REGEX in lib/invoices/posting-account.ts)
-- as defense in depth: this table is written from more than one application
-- code path (the manual recurring-invoice UI route, and propmate's lease
-- sync), and a DB constraint cannot be bypassed by a future write path that
-- forgets to call validate-schedule-revenue-accounts.ts. It only enforces the
-- *shape*; the chart-of-accounts membership + active + zero-VAT-for-class-1-2
-- checks stay application-side (they need a join against a per-company table
-- state a CHECK constraint cannot express).
ALTER TABLE public.recurring_invoice_schedule_items
  ADD COLUMN revenue_account TEXT;

ALTER TABLE public.recurring_invoice_schedule_items
  ADD CONSTRAINT recurring_invoice_schedule_items_revenue_account_shape
  CHECK (revenue_account IS NULL OR revenue_account ~ '^[123][0-9]{3}$');

-- ============================================================
-- leases, propmate's avtalskälla
-- ============================================================

CREATE TABLE public.leases (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The user who created the lease. Stamped onto the schedule's own user_id
  -- at first sync (createRecurringSchedule); a later resync (daily cron, no
  -- interactive user) never touches that column, so this is only read once.
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Tenant (hyresgäst). RESTRICT so deleting a customer with a lease raises a
  -- clear FK error instead of silently orphaning the billing chain, same
  -- rationale as recurring_invoice_schedules.customer_id.
  customer_id           UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  property_name         TEXT NOT NULL CHECK (length(property_name) > 0),
  unit_description       TEXT,

  -- Base rent (grundhyra). tillägg (additions) are itemized on top of it:
  -- [{ "description": "...", "amount": 1234.00 }, ...]. Both roll into the
  -- linked schedule as separate line items so each is individually visible on
  -- the invoice and in the ledger, not folded into one lump sum.
  monthly_rent          NUMERIC(14, 2) NOT NULL CHECK (monthly_rent >= 0),
  additions             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Defense in depth for a hand-edited additions row bypassing
  -- LeaseAdditionSchema's z.number().nonnegative() (extensions/general/
  -- propmate/lib/schemas.ts): a negative tillägg amount becomes a negative
  -- invoice line on a real avisering, same rationale as monthly_rent's own
  -- CHECK above. jsonb_path_exists with a static jsonpath literal and no
  -- vars argument is safe in a CHECK (no row/table reference, so it is not a
  -- disallowed subquery); lax mode (the default) treats a missing/non-numeric
  -- `amount` key as no match rather than an error, matching the schema's own
  -- shape guarantee that amount is always a number when present.
  CONSTRAINT leases_additions_amounts_nonnegative CHECK (
    NOT jsonb_path_exists(additions, '$[*].amount ? (@ < 0)')
  ),

  -- Kampanjpris: a temporary rent override for [campaign_start_date,
  -- campaign_end_date]. All-or-nothing triple: a campaign either has all
  -- three fields or none of them (the sync can't interpret a partial one).
  campaign_price_amount NUMERIC(14, 2) CHECK (campaign_price_amount IS NULL OR campaign_price_amount >= 0),
  campaign_start_date   DATE,
  campaign_end_date     DATE,
  CONSTRAINT leases_campaign_triple CHECK (
    (campaign_price_amount IS NULL AND campaign_start_date IS NULL AND campaign_end_date IS NULL)
    OR (campaign_price_amount IS NOT NULL AND campaign_start_date IS NOT NULL AND campaign_end_date IS NOT NULL)
  ),
  CONSTRAINT leases_campaign_dates_order CHECK (
    campaign_end_date IS NULL OR campaign_start_date IS NULL OR campaign_end_date >= campaign_start_date
  ),

  -- KPI-index avtalsklausul: reference data only (base index value/year and
  -- the date the clause is next due for review). No automatic uppräkning is
  -- computed from these; a human still applies the index and edits
  -- monthly_rent when it's time. Deliberately out of scope for this chain.
  kpi_base_index        NUMERIC(10, 2),
  kpi_base_year         SMALLINT,
  kpi_next_review_date  DATE,

  -- Lokalhyra VAT: uthyrning av lokal is momsfri by default (0). A landlord
  -- who has frivillig skattskyldighet för uthyrning (ML 3 kap./ Skatteverket
  -- registration) charges 25% instead; there is no third rate for rent.
  vat_rate              SMALLINT NOT NULL DEFAULT 0 CHECK (vat_rate IN (0, 25)),
  -- Optional posting-account override. Restricted to BAS class 3 at the DB
  -- level (narrower than the general class 1-3 shape check on
  -- recurring_invoice_schedule_items above): a lease rent/addition line is
  -- always a revenue line, never a deposit/advance/outlay, so a class 1-2
  -- override has no legitimate use here and is never accepted, from either
  -- the API schema (extensions/general/propmate/lib/schemas.ts) or the DB.
  revenue_account       TEXT CHECK (revenue_account IS NULL OR revenue_account ~ '^3[0-9]{3}$'),

  day_of_month          SMALLINT NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  auto_send             BOOLEAN NOT NULL DEFAULT false,

  start_date            DATE NOT NULL,
  -- NULL = tillsvidare (ongoing, no fixed end).
  end_date              DATE,
  CONSTRAINT leases_end_after_start CHECK (end_date IS NULL OR end_date >= start_date),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),

  -- Set once the lease's first sync provisions a schedule. NULL until then;
  -- extensions/general/propmate/lib/lease-schedule-sync.ts branches on this
  -- to decide createRecurringSchedule vs applyRecurringScheduleUpdate, both
  -- of which validate revenue_account identically (see file header note).
  recurring_schedule_id UUID REFERENCES public.recurring_invoice_schedules(id) ON DELETE SET NULL,
  last_synced_at        TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leases_company ON public.leases (company_id);
CREATE INDEX idx_leases_customer ON public.leases (customer_id);
CREATE INDEX idx_leases_schedule ON public.leases (recurring_schedule_id);
-- Daily resync cron pages active leases ordered by last_synced_at with id as
-- the tiebreaker (stable pagination across rows sharing a timestamp,
-- including all-NULL on a fresh company). The cron queries
-- .order('last_synced_at', { ascending: true, nullsFirst: true }), i.e.
-- ORDER BY last_synced_at ASC NULLS FIRST; a plain ASC index defaults to
-- NULLS LAST and cannot serve that ordering, forcing a sort on every run.
CREATE INDEX idx_leases_resync_paging ON public.leases (last_synced_at ASC NULLS FIRST, id ASC)
  WHERE status = 'active';

ALTER TABLE public.leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leases_select" ON public.leases
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "leases_insert" ON public.leases
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "leases_update" ON public.leases
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "leases_delete" ON public.leases
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER leases_updated_at
  BEFORE UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Viewer-write gate (20260902093000): membership alone (the policies above)
-- lets a read-only viewer through RLS; this trigger is what actually refuses
-- the write, and it also fires inside SECURITY DEFINER bodies where RLS does
-- not apply. Every company-scoped table added after that migration needs its
-- own copy, same as employee_recurring_lines (20260902140000) and
-- sales_orders (20260902180000).
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

NOTIFY pgrst, 'reload schema';
