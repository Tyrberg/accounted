# Underlagsjakt Export Schema

**Contract version:** export 1.4 (minimum 1.1); answer 1.4, 1.5 for a file holding an `uppladdat_underlag`, or 1.6 for a file where a `val_kandidat` beslut chose more than one document

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
- **`belopp`** (number or null, optional): The amount this specific document covers, when known (e.g. one person's löneunderlag out of a payment covering several). Same sign convention as the post's own `belopp` (negative for outgoing): the sum of every chosen candidate's `belopp` is compared to the post's `belopp` directly, not by absolute value, so a payment of -35000 covered exactly by candidates of -15000 and -20000 nets to a difference of zero. Absent on every export version to date; used only to sharpen the chosen-vs-payment sum Accounted shows once more than one candidate is chosen. A missing or null value never blocks a selection.

## Answers (`beslut`)

The answer file is `{ "version": "1.4", "beslut": [...] }`, `"1.5"` when it holds at least one `uppladdat_underlag` entry, or `"1.6"` when a `val_kandidat` entry chose more than one document: a file without either is byte-for-byte what a 1.4 reader already ingests. Every entry carries
`answer_id`, `transaction_id` and a `svarstyp`, one of:

| `svarstyp` | Meaning |
|---|---|
| `val_kandidat` | The document(s) among the post's candidates (`vald_kandidat`/`sha256`/`kalla` for the first, `vald_kandidater` for all of them), or none (`vald_kandidat: null`, `vald_kandidater: []`, "no document needed"), with `motpart`, `kategori`, `bas_konto`, `momstyp`, `bolag`, `bankkonto`, `belopp` for the learned rule. |
| `fel_bolag` | The payment belongs to another company (`fel_bolag_mottagare`, `till_bolag`, `reglering`). |
| `osaker` | Postponed; bertil asks again later. |
| `uppladdat_underlag` | **New in 1.5.** bertil found no document (or none that fits), and the user uploaded the real one in Accounted. The entry carries a reference to that file instead of a choice among candidates. |

### `val_kandidat` with more than one document

A payment can be backed by several documents at once (e.g. one bank payment covering two people's löneunderlag, one BAS account, no split to compute). `vald_kandidat`/`sha256`/`kalla` keep naming only the first chosen document, exactly as before, so nothing here changes for a reader that has not been updated. `vald_kandidater` carries every chosen document:

```json
{
  "answer_id": "2026-09-22T09:00:00.000Z:tx-lon-20260925",
  "transaction_id": "tx-lon-20260925",
  "svarstyp": "val_kandidat",
  "vald_kandidat": "lon_mattias_september.pdf",
  "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "kalla": "gmail:löner",
  "vald_kandidater": [
    { "filnamn": "lon_mattias_september.pdf", "sha256": "1111111111111111111111111111111111111111111111111111111111111111", "kalla": "gmail:löner" },
    { "filnamn": "lon_jennie_september.pdf", "sha256": "2222222222222222222222222222222222222222222222222222222222222222", "kalla": "gmail:löner" }
  ],
  "motpart": "LÖN SEPTEMBER",
  "kategori": "lon",
  "bas_konto": "2893",
  "momstyp": null,
  "bolag": null,
  "bankkonto": null,
  "belopp": null
}
```

`vald_kandidater` is only present with more than one entry when the answer file itself is version 1.6 (see "Version History"); a reader that does not know 1.6 never sees it and keeps working from `vald_kandidat` alone, which is the correct single-document answer for it. This is the opposite situation from Accounted's document-reuse guard (task 1435: one document never backs two payments): here one payment backs several documents, and each of them is still bound in Accounted exactly as a single choice would be, just several at a time.

### `uppladdat_underlag`

```json
{
  "answer_id": "2026-09-21T10:15:00.000Z:tx-ocr-20260812",
  "transaction_id": "tx-ocr-20260812",
  "svarstyp": "uppladdat_underlag",
  "dokument_id": "6f1c0f0e-3f4b-4c58-9a51-0d2f4a0f7b11",
  "filnamn": "kvitto.pdf",
  "sha256": "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "mime_type": "application/pdf",
  "storage_path": "documents/<company_id>/<user_id>/1789985700000_kvitto.pdf",
  "kalla": "gnubok_uppladdning",
  "motpart": "OCR-betalning",
  "kategori": "leverantor",
  "bas_konto": null,
  "momstyp": null,
  "bolag": null,
  "bankkonto": null,
  "belopp": null
}
```

- **`dokument_id`** (string): The document's id in Accounted (`document_attachments.id`).
- **`filnamn`** (string): The uploaded file's name.
- **`sha256`** (string): SHA-256 of the stored bytes, lowercase hex. Computed by Accounted from the stored file, never taken from the browser; it is the same identity bertil uses for `Kandidat.sha256`.
- **`mime_type`** (string or null): `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/heic` or `image/heif`.
- **`storage_path`** (string): Key in Accounted's `documents` storage bucket.
- **`kalla`** (string): Always `gnubok_uppladdning`.
- **`motpart`, `kategori`, `bas_konto`, `momstyp`, `bolag`, `bankkonto`, `belopp`**: Exactly as in `val_kandidat`; they are what the rule is learned from.

bertil must treat the payment as **having underlag** (`med_underlag`) from the
next run, exactly as if the document had been a candidate chosen by the user,
and must not keep asking about it. A reader that does not know `uppladdat_underlag`
must refuse the whole file (an unknown `svarstyp` is never to be skipped
silently): acknowledging an answer it did not understand would lose the document.
`vald_kandidat` is absent from this entry.

The file is stored in Accounted's archive (WORM, retained seven years) and, when
`transaction_id` identifies exactly one Accounted bank transaction (its id or its
`external_id`), pinned to that transaction so it follows the verifikat. When it
does not, the document is archived and the answer is still delivered; Accounted
never guesses a transaction from date and amount.

## Transport: the automatic delivery

The export does not have to be uploaded by hand. bertil can deliver it, and
collect the answers, over three HTTP endpoints. They are the only routes in
Accounted reachable without a logged-in user, and they are authenticated by a
shared token, not by a session.

| Call | Endpoint | Body |
|---|---|---|
| Deliver an export | `POST {GNUBOK_API_URL}/api/extensions/ext/underlagsjakt/export` | The root wrapper above |
| Collect the answers | `GET {GNUBOK_API_URL}/api/extensions/ext/underlagsjakt/svar` | Answers as `--mottak-svar` reads them: `{ "version": "1.4" or "1.5", "beslut": [...] }` |
| Acknowledge ingestion | `POST {GNUBOK_API_URL}/api/extensions/ext/underlagsjakt/svar/kvittens` | Acknowledgement request with both `transaction_id` and `answer_id` (see below) |

All three calls send the token as `Authorization: Bearer <token>` (the `apikey`
header is accepted as well, since bertil's client sets both).

`GET /svar` offers every unacknowledged answer on every fetch. It never sets
`levererad_at`. After successfully persisting each answer through
`mottak_svar_fran_ui`, bertil must POST both the transaction ID and the answer ID to
`/svar/kvittens`. An already-ingested no-op is also safe to acknowledge.
Never acknowledge failed ingestion. Retry after network or server errors,
including a lost acknowledgement response.

Acknowledgement request body must include both fields:
- **`transaction_id`** (string, required): The transaction ID from the answer.
- **`answer_id`** (string, required): The answer ID from the answer. This ensures the acknowledgement matches the exact version that was ingested.

Acknowledgement returns HTTP 200 with `{ "data": { "transaction_id": "<id>" } }`.
Repeated acknowledgements preserve the original delivery timestamp. Unknown
IDs (including withdrawn or reconciled answers) succeed without a write.
Malformed JSON or a missing, blank, or non-string ID returns 400; authentication
and configuration failures use the same 401/503 responses as the other calls.
The answer file is version 1.4, or 1.5 when it holds an uploaded underlag (see "Answers" below).

An unacknowledged answer stays on offer until it is acknowledged; a re-export
does not reopen its question. Once an answer has been offered to bertil it can
no longer be withdrawn or replaced in the UI (it shows as "Offered to bertil"
until acknowledged). The standing check alarms after two days without an
acknowledgement even when polling continues. Poll counts are not proof of ingestion.

To check the configuration without writing anything, post a body the contract
rejects, e.g. `{}`. Authentication and the company lookup run first and the
export is stored last, so any `400` means the token was accepted and the org
number resolved to a single active company, while `401` and `503` mean what
the error table below says. The full switch-on order is in `fork/README.md`
section 11.

### What the server needs

Two environment variables on the Accounted box, both unset by default (with
either missing, the three endpoints answer `503 LEVERANS_NOT_CONFIGURED` and no
token exists):

| Variable | Meaning |
|---|---|
| `UNDERLAGSJAKT_LEVERANS_TOKEN` | The shared secret. At least 32 characters: generate with `openssl rand -base64 24`. |
| `UNDERLAGSJAKT_LEVERANS_ORGNR` | Organisationsnummer of the one company the delivery writes to. 10 or 12 digits, hyphen optional. |

The org number is the whole of the company binding: the caller cannot name a
company, so a delivery can never land in another company's data. An org number
that matches no active company, or more than one, stops the delivery rather
than guessing.

### What bertil needs

`GNUBOK_API_URL` (e.g. `https://bokforing.bohed.com`) and `GNUBOK_API_KEY` set
to the same token. The secret belongs in the box's environment, never in either
repository.

### Scheduling it

The delivery is a push from bertil, so the schedule lives on bertil's box, not
in Accounted. System crontab format (field 6 is the user), running the export
client every morning:

```cron
# /etc/cron.d/underlagsjakt-leverans
PATH=/usr/local/bin:/usr/bin:/bin
17 6 * * * deploy cd /opt/projects/bertil && python underlagsjakt_export_client.py >> var/leverans.log 2>&1
```

(Adjust the invocation to however bertil's repository exposes
`underlagsjakt_export_client.py`.)

`GNUBOK_API_URL` and `GNUBOK_API_KEY` must be readable by that user (bertil's
`.env`), and the file has to end with a newline or cron ignores the last line.

### Checking that it runs

On the Accounted box, in the clone:

```bash
npx tsx extensions/general/underlagsjakt/leverans-status.ts
```

It reports what the machine path has actually carried in each direction and
exits `0` only once both have carried real data recently, `2` while a direction
has never run or has gone quiet for more than two days, and `4` when the box is
not configured at all. It writes nothing and never calls `GET /svar`.

### Errors

| Status | Code | Meaning |
|---|---|---|
| 401 | `LEVERANS_TOKEN_MISSING` / `LEVERANS_TOKEN_INVALID` | No token, or not the configured one. |
| 503 | `LEVERANS_NOT_CONFIGURED` | The server has no usable delivery configuration. The message names each variable that is unset, too short or malformed, so a token that was typed by hand is not reported as a token that was never set, and an org number with one mistyped digit is reported as a wrong check digit rather than as the wrong number of digits. |
| 503 | `LEVERANS_COMPANY_NOT_FOUND` / `LEVERANS_COMPANY_AMBIGUOUS` | `UNDERLAGSJAKT_LEVERANS_ORGNR` matches no active company, or several. |
| 400 | `UNSUPPORTED_VERSION` / `INVALID_EXPORT` / `INVALID_JSON` | The export was rejected by the contract rules above; nothing was stored. |

## Version History

### Answer 1.6
- Written only when a `val_kandidat` beslut chooses more than one document; every other answer file stays at whatever 1.4/1.5 rule already applied. Choosing more than one document in Accounted is off until `UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED=true` is set on the box, which is done once bertil reads 1.6.
- New `vald_kandidater` field on `val_kandidat` beslut: every chosen document, not only the first (see "val_kandidat with more than one document"). `vald_kandidat`/`sha256`/`kalla` are unchanged and still name the first choice.

### Answer 1.5
- Written only to a file that holds an `uppladdat_underlag`; every other answer file stays 1.4. The upload option in Accounted is off until `UNDERLAGSJAKT_UPLOAD_ENABLED=true` is set on the box, which is done once bertil reads 1.5.
- New `svarstyp` `uppladdat_underlag`: the user uploaded the document in Accounted (see "Answers"). The export version is unchanged (1.4).

### 1.4
- Added `leverantor_sokord` field on posts for supplier search hints (ignored by Accounted; reserved for future use).
- Answer file now includes `reglering` in `fel_bolag` beslut (settlement is sent to bertil when a company is selected and settled).
- `reglering` is not included in `val_kandidat` beslut (candidate selection answers).
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
