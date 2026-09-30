# Fakturainkorg via mejl (leverantörsfakturor)

Varje bolag i Accounted har en egen inkorgsadress. Leverantörsfakturor som mejlas dit hamnar i Dokumentinkorgen (extension `invoice-inbox`) i stället för i Fortnox.

## Vad som redan finns i koden

- **Adress per bolag:** tabellen `company_inboxes` (migration `20260420000000_arcim_inbox.sql`). En rad skapas automatiskt när ett bolag skapas: `{bolagsnamn-slug}-{4 tecken}@{RESEND_INBOUND_DOMAIN}`. Adressen visas i Dokumentinkorgen och via `GET /api/extensions/ext/invoice-inbox/inbox/address`. Den kan roteras (`rotate_company_inbox`).
- **Mottagning:** Resend skickar ett `email.received`-webhook till `POST /api/extensions/ext/invoice-inbox/inbound`. Signaturen verifieras med `RESEND_INBOUND_WEBHOOK_SECRET`, mottagaradressen slås upp mot `company_inboxes`, och mejlet hämtas från Resend.
- **Bilagan:** varje PDF/bild blir ett `document_attachments`-underlag (lagras 7 år, kopplas till verifikatet vid bokning) och en rad i `invoice_inbox_items`. Mejlkroppen sparas som underlag om det saknas bilaga.
- **Avläsning:** AI-extraktionen läser ut leverantör, org.nr, fakturanummer, OCR, bankgiro, belopp, fakturadatum och förfallodatum.
- **Leverantörsfaktura:** `POST .../items/:id/convert` skapar en `supplier_invoices`-rad med `document_id` (bilagan), `due_date`, `supplier_invoice_number`, ankomstnummer och rader, samt registreringsverifikatet (2440) om bolaget bokför vid registrering. Testat i `extensions/general/invoice-inbox/__tests__/convert-route.test.ts`.

Tabellerna är tomma i prod idag eftersom ingen har skickat något dit ännu; det är inte ett kodfel.

## Vad som behövs från Mattias (DNS och Resend)

1. **Domän för inkommande mejl** (förslag: `inbox.bohed.com`, en subdomän som inte används för vanlig mejl). Lägg den i Resend under Domains.
2. **MX-post** för subdomänen enligt värdet Resend visar (Resend Inbound). Lägg även SPF/DKIM som Resend anger om domänen ska kunna skicka.
3. **Webhook i Resend:** händelse `email.received`, URL `https://bokforing.bohed.com/api/extensions/ext/invoice-inbox/inbound`. Kopiera signeringshemligheten (`whsec_...`).
4. **Miljövariabler i prod** (prod körs på boxen, bokforing.bohed.com: lägg dem i `/opt/gnubok/app.env` och starta om med `docker compose -f docker-compose.app.yml -p gnubok-app up -d`; inte Vercel): `RESEND_API_KEY` (med läsrätt för mottagna mejl), `RESEND_INBOUND_DOMAIN` (t.ex. `inbox.bohed.com`), `RESEND_INBOUND_WEBHOOK_SECRET`.
5. **Aktivera extensionen** `invoice-inbox` i `extensions.config.json` om den inte redan är på.
6. **Driftsättning kräver Mattias OK.** Ingen automatisk deploy görs; ändringar här är enbart dokumentation och test.

## Sätta upp adressen för ett bolag

1. Öppna bolaget i Accounted och gå till Dokumentinkorg. Adressen finns redan; visas den inte, välj "Aktivera inkorgsadress".
2. Kopiera adressen och lägg den som mottagare för fakturamejl hos leverantörerna (eller som vidarebefordran från befintlig fakturaadress).
3. Skicka en testfaktura och kontrollera att den syns i inkorgen med bilaga och förfallodatum.
4. Öppna posten, kontrollera leverantör, konto och förfallodag och välj Registrera. Betalning signeras alltid av Mattias själv i separat steg.

## Kontroll efter driftsättning

- `select count(*) from company_inboxes where status = 'active'` ska motsvara antalet bolag.
- Efter en testfaktura: en rad i `invoice_inbox_items` med `document_id`, och efter registrering `created_supplier_invoice_id` satt.
