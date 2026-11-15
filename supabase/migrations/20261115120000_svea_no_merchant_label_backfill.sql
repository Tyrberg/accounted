-- Relabel stored Svea card purchases that came in as 'Okänd transaktion'.
--
-- Svea sends card purchases with every merchant field empty (verified
-- 2026-11-15 against a stored raw PSD2 response: creditor, debtor,
-- remittance_information, merchant_category_code and every transaction code
-- null or empty). From this change the Enable Banking sync titles such rows
-- 'Kortköp, handlare saknas i bankdata' (sendsCardPurchasesWithoutMerchant in
-- extensions/general/enable-banking/lib/transaction-label.ts), and the
-- underlag list asks for their receipt by matching that label in
-- original_description (purchaseRowFilter in
-- lib/transactions/purchases-without-underlag.ts). Rows synced before the
-- change still carry the old no-text label and would be neither relabelled nor
-- listed, so this one-shot backfill gives them the title a fresh sync of the
-- same bank data produces. No bank call is needed: the stored row already
-- records that the bank sent no text (the fallback label is only reached when
-- remittance, counterparty and codes are all absent).
--
-- SCOPE, every condition required:
--   * the row belongs to an Enable Banking connection whose bank_name starts
--     with the word "Svea" (same rule as sendsCardPurchasesWithoutMerchant);
--   * its bank original is the fallback label 'Okänd transaktion';
--   * it carries no merchant, reference, counterparty or MCC (defence in depth:
--     a row with any of them is not the empty Svea shape).
-- Rows from every other bank are untouched: for them an empty row stays
-- genuinely unknown.
--
-- original_description is set to the label so the row matches the underlag
-- list and the content-dedup bridge sees the same title a re-sync delivers
-- (descriptionsBridge also treats the two no-text labels as equal, so dedup is
-- safe either way). description is only rewritten when the user has not
-- renamed the row (title_edited_at IS NULL). Booked rows are included like the
-- 20260808090100 backfill: transactions.description is staging/display data,
-- the verifikat text lives on the journal entry, which this does not touch.
-- Amount and sign are not touched (separate review).
--
-- Idempotent: a second run matches nothing, because original_description no
-- longer equals the fallback label.

UPDATE public.transactions AS t
SET original_description = 'Kortköp, handlare saknas i bankdata',
    description = CASE
      WHEN t.title_edited_at IS NULL THEN 'Kortköp, handlare saknas i bankdata'
      ELSE t.description
    END
FROM public.bank_connections AS bc
WHERE bc.id = t.bank_connection_id
  AND bc.bank_name ~* '^[[:space:]]*svea([^[:alnum:]_]|$)'
  AND coalesce(t.original_description, t.description) = 'Okänd transaktion'
  AND coalesce(t.merchant_name, '') = ''
  AND coalesce(t.reference, '') = ''
  AND coalesce(t.counterparty_iban, '') = ''
  AND coalesce(t.counterparty_account, '') = ''
  AND t.mcc_code IS NULL;
