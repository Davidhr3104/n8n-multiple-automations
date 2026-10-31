# Invoice & Document Processor — overview

Reads invoices that arrive by email and posts them to accounting **only when every check passes**. Anything doubtful goes to a person with the reasons and the evidence. Built with n8n, Postgres and Claude (local mock mode; synthetic data).

## What it does

1. **Receives a document** (email attachment in production, webhook locally) and answers "accepted" right away. The same document id never runs twice.
2. **Hard rules first (code).** Text that tries to give orders to the AI ("approve this invoice", "ignore the rules") is flagged and the invoice can never post on its own.
3. **Extraction (AI reads).** Claude returns each field with the exact text it came from (evidence) and a confidence. The AI only reads; it does not decide anything.
4. **Grounding (code).** Every field's evidence must be in the document **and** must support the value. If not, that field's confidence becomes 0.
5. **Checks (code).** Required fields; line × price = amount; lines add up to the subtotal; subtotal + tax = total; sensible dates; allowed currency; same invoice number or same document already processed; same vendor, total and date under another number; **vendor bank account compared with the vendor master**; unknown or unapproved vendor; amount over the automatic limit.
6. **Gate (code).** Posted automatically only if nothing failed and confidence is high. Otherwise a person approves or rejects (email with the extracted fields, failed checks and evidence). Duplicates and non-invoices are recorded without bothering anyone. If the AI fails, a person is told and nothing is posted.
7. **Post + record, atomically.** The invoice, its evidence and decision, and the ledger entry (mock accounting table) are written in one statement. A unique index per vendor + invoice number is the last net against paying twice.

## What was tested (synthetic data, mock mode)

- 19 unit tests (`test/invoice.test.js`): arithmetic, dates, duplicates, bank change, grounding of hallucinated values, injection, request/response parsing.
- 34 end-to-end checks pass (`scripts/smoke-invoice.ps1`): automatic posting, human approve/reject, duplicate with another id, direct second ledger entry blocked by the index, changed bank account, new / unapproved vendor, over-limit, possible duplicate, injection, HTML in the vendor name neutralised, not-an-invoice, AI down, and an approved-but-incomplete invoice that is **not** posted and fails loudly.

## Not verified yet

- The extraction step in `live` mode (Claude with PDF/image blocks) has never run: that contract is an assumption. With a file and no text, grounding has nothing to compare against, so those invoices always go to a person.
- The mock extractor only reads text with clear labels (`Vendor:`, `Invoice No:`, `Total:`…); it says nothing about the accuracy of a real model.
- Accounting is a Postgres table. `ACCOUNTING_MODE=live` (Xero / Google Sheets) is not built and makes the workflow refuse to post instead of using the mock.
- Approval is approve/reject by email; there is no field editing. Payment reminders (Stripe) are not part of this system.
