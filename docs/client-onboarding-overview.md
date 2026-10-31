# Client Onboarding — overview

From a closed deal to a project kicked off without copying data by hand. **A template writes the contract, never the AI.** The AI only turns the client's form notes into requirements, each quoted from the text, and code drops anything that is not really in the notes. Built with n8n, Postgres and Claude (local mock mode; synthetic data).

## What it does (three workflows)

**1. Onboarding · Start** (`POST /webhook/onboarding-start`)
- Validates the package, amount, email and dates; one client id never runs twice.
- Hard rules flag special terms in the notes (discount, refund, exclusivity, NDA, penalties, guarantees), prompt injection, and another client with the same email or company.
- The AI lists what the client asked for; every requirement must be quoted from the notes. Quotes that are not in the text are dropped and recorded, so invented work never becomes a task.
- A fixed template per package writes the contract. A gate decides: it goes out alone only if the package is standard, the amount is under the limit, there are no special terms, no duplicate, no injection and the notes were read. Otherwise the account manager approves by email (fail closed; no answer in 48 h means nothing is sent).
- The client, the contract and a one-time signature token (generated in Postgres, with an expiry) are saved in one atomic statement. The contract counts as sent only when the email went out.

**2. Onboarding · Signature & Setup** (`GET/POST /webhook/onboarding-sign*`)
- The link in the email opens a page that only **shows** the contract; a GET (an email scanner, a preview) never signs. Signing is a POST with the one-time token.
- Code verifies the token (an empty one never matches), the expiry and the client status. One atomic statement signs. A repeated signature is idempotent; an interrupted setup is resumed.
- Setup runs step by step, each idempotent and recorded in `onb_steps`: folder, project and tasks (the package template plus the verified requirements, due dates in business days with holidays), CRM stage, welcome sequence, team notice. The client becomes **active only when all five steps are ok**; otherwise it fails loudly and signing again resumes what is missing.

**3. Onboarding · Sequence & Follow-ups** (every 15 minutes)
Sends the welcome sequence on schedule (welcome, a check-in 2 business days later, a kickoff reminder the business day before), respecting opt-outs, cancelled clients and sending hours. Nudges an unsigned contract once at 3 days, alerts the account manager once at 7 and expires it at 14. Retries a contract that never went out. Everything is recorded only after it was sent.

## What was tested (synthetic data, mock mode)

- 14 unit tests (`test/onboarding.test.js`, `test/onbpages.test.js`): validation, business days, hard rules, the contract gate, the contract template, grounding of requirements, provisioning plan and dates, sequence timing, due messages, contract follow-ups, signature verification, page escaping, messages. Writing them found a real defect (an impossible date such as 2027-13-40 raised an exception instead of a validation error), fixed test-first.
- 63 end-to-end checks pass (`scripts/smoke-onboarding.ps1`), including: the standard path with no approval, six reasons that force a human (over the limit, special terms, duplicate client, injection, AI down, enterprise package) approved and rejected for real by email, a GET that does not sign, wrong / empty / expired tokens, the full setup with the right business-day due dates, an idempotent second signature, **two simultaneous signatures with exactly one winner**, **SMTP down during setup → the step fails visibly and the client stays in provisioning → signing again resumes it without duplicates**, the sequence respecting a Saturday and an opt-out, and the unsigned-contract nudge, alert and expiry.
- The smoke test also exposed a design flaw that was fixed: send dates came from the database clock instead of the run's clock, which made simulated-time tests look a year old.

## Not verified yet

- Drive, Notion / Asana, Slack, the e-signature provider and the CRM: locally they are tables and emails to a test inbox. Those contracts are unverified.
- Claude in `live` mode (`record_intake_summary` tool): the mock reads sentences with need / want / require / must / please and says nothing about a real model.
- A client stuck in provisioning waits for the signature link to be used again; there is no automatic retry or alert for it yet beyond the failed execution reaching the Global Error Handler.
- `now` can be set in the payload only in mock mode and with the internal token; in `live` mode it is rejected (unit-tested; the live switch itself was not exercised at runtime).
