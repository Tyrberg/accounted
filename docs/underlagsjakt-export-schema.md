# Underlagsjakt Export Schema

**Contract version:** 1.4 (minimum 1.1)

Canonical root form: **wrapper** (one file contains zero or more bolag×period combinations).

## Root Wrapper

The export from `python -m underlagsjakt --json` is a wrapper that allows multiple bolag×period combinations in a single file. This is the canonical root form.

```json
{
  "export_version": "1.4",
  "generated_at": "2026-09-17T12:12:00+00:00",
  "sammanstallningar": [ /* zero or more Sammanstallning */ ]
}
```

### Fields

- **`export_version`** (string, required): Contract version (e.g., "1.1", "1.2", "1.3", "1.4").
- **`generated_at`** (ISO8601 string, required): Export timestamp.
- **`sammanstallningar`** (array, required): Array of Sammanstallning objects, one per bolag×period combination.

## Sammanstallning

One Sammanstallning is the analysis for a single bolag and period.

```json
{
  "export_version": "1.4",
  "bolag": "Tyrberg Group",
  "period": "2026-08",
  "generated_at": "2026-09-17T12:12:00+00:00",
  "sammanfattning": { /* summary object */ },
  "posts": [ /* array of Post objects */ ]
}
```

### Fields

- **`export_version`** (string, required): Same as wrapper version.
- **`bolag`** (string, required): Company/legal entity name.
- **`period`** (string, required): Month in YYYY-MM format.
- **`generated_at`** (ISO8601 string, required): Export timestamp.
- **`sammanfattning`** (object, required): Summary counts (see Sammanfattning).
- **`posts`** (array, required): Payment/transaction posts.

## Sammanfattning

Summary statistics for the period.

```json
{
  "totalt": 67,
  "med_underlag": 40,
  "hittad_i_mejl": 6,
  "sjalvforklarande": 12,
  "inlard_regel": 4,
  "behover_mattias": 1,
  "tvetydig": 1,
  "fel_bolag": 1,
  "uppskjuten": 1,
  "lost_svar": 1
}
```

- **`totalt`**: Total posts processed.
- **`med_underlag`**: Posts with supporting documents.
- **`hittad_i_mejl`**: Posts found in email.
- **`sjalvforklarande`**: Self-explanatory posts.
- **`inlard_regel`**: Posts matched by a learned rule.
- **`behover_mattias`**: Posts requiring manual decision.
- **`tvetydig`**: Posts with ambiguous candidates.
- **`fel_bolag`**: Posts with wrong company (wrong-company case).
- **`uppskjuten`**: Deferred posts.
- **`lost_svar`**: Posts for which answer was lost.

## Post

One post is a single payment/transaction.

```json
{
  "bolag": "Tyrberg Group",
  "period": "2026-08",
  "transaction_id": "tx-google-20260803",
  "datum": "2026-08-03",
  "belopp": -1249.0,
  "valuta": "SEK",
  "motpart": "GOOGLE*WORKSPACE",
  "konto_identitet": "SEB Företagskonto 5609 11 241 10",
  "typ": "Kortköp",
  "saldo": 95021.0,
  "kategori": "tvetydig",
  "forslag": { /* suggestion object or null */ },
  "kandidater": [ /* array of Kandidat */ ],
  "tvetydiga_alternativ": [ /* array of Kandidat */ ],
  "mottagare": "Company AB",
  "reglering": "vidarefakturera",
  "leverantor_sokord": "cloud-workspace"
}
```

### Fields

- **`bolag`** (string, required): Company name (must match parent).
- **`period`** (string, required): Month in YYYY-MM format (must match parent).
- **`transaction_id`** (string, required): Unique identifier per transaction.
- **`datum`** (ISO8601 date string, required): Transaction date.
- **`belopp`** (number, required): Amount in base currency (negative for outgoing).
- **`valuta`** (string, required): Currency code (e.g., "SEK").
- **`motpart`** (string, required): Counterparty name or account number.
- **`konto_identitet`** (string, required): Bank account identifier.
- **`typ`** (string, required): Transaction type (e.g., "Överföring", "Kortköp", "Autogiro").
- **`saldo`** (number or null, required): Account balance after transaction, or null if unknown.
- **`kategori`** (enum, required): Post category. One of:
  - `behover_mattias`: Requires manual decision.
  - `tvetydig`: Ambiguous candidates.
  - `fel_bolag`: Wrong company.
- **`forslag`** (object or null, required): Suggested classification (Forslag), or null if no suggestion.
- **`kandidater`** (array, required): Candidate documents (Kandidat) for non-ambiguous posts. Empty for ambiguous posts.
- **`tvetydiga_alternativ`** (array, required): Candidate documents for ambiguous posts. Empty for non-ambiguous posts.
- **`mottagare`** (string or null, required): Recipient/payee name for wrong-company posts, null otherwise.
- **`reglering`** (string or null, optional): Settlement type for wrong-company posts (`fel_bolag`). One of:
  - `vidarefakturera`: Re-invoice to correct company.
  - `mellanhavande`: Clear as accounts receivable/payable.
- **`leverantor_sokord`** (string, optional): Supplier search hint for classification.

## Forslag

Optional suggestion for how to classify a post.

```json
{
  "kategori": "leverantor",
  "varfor": "Fakturan är ställd till ett annat bolag än betalaren",
  "bas_konto": "5420",
  "momstyp": "eu_reverse_charge"
}
```

- **`kategori`** (string, required): Suggested category.
- **`varfor`** (string, required): Reason for suggestion.
- **`bas_konto`** (string or null, required): Suggested BAS account (4 digits) or null.
- **`momstyp`** (string or null, required): Suggested VAT type or null. One of:
  - `svensk_25`
  - `eu_reverse_charge`
  - `utland`
  - `representation`

## Kandidat

A supporting document (email, invoice, receipt).

```json
{
  "filnamn": "google_workspace_augusti.pdf",
  "kalla": "gmail:bohed",
  "datum": "2026-08-02",
  "bevisgrund": "belopp exakt på beloppsraden + motpart google + mejl 2026-08-02",
  "sha256": "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
}
```

- **`filnamn`** (string, required): Document file name.
- **`kalla`** (string, required): Source identifier (e.g., "gmail:bohed", "outlook:work").
- **`datum`** (ISO8601 date string or null, required): Document date.
- **`bevisgrund`** (string, required): Evidence description (why this document matches the post).
- **`sha256`** (string, required): SHA256 hash of document content (lowercase hex, 64 characters).

## Version History

### 1.4
- Added `leverantor_sokord` field on posts for supplier search hints.
- Answer file now includes `reglering` in `fel_bolag` and `val_kandidat` beslut.
- Existing clients ignore unknown fields per JSON schema forward compatibility.

### 1.3
- Sharpened validation and retracted a requirement.

### 1.2
- Added `reglering` field on posts with `kategori: "fel_bolag"` to indicate settlement type.

### 1.1
- Initial contract. Root schema as described above, but exported as single Sammanstallning.
- CLI wrapper (multiple Sammanstallningar) was implicit; now explicit and canonical.

## Forward Compatibility

Unknown fields in any object are silently ignored by Accounted. A new version may add optional fields without breaking older clients. Clients should not validate field presence beyond what is documented above; treat all fields as potentially appearing or absent in future versions.
