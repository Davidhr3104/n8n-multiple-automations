# Appointment Reminders + No-show Reducer — overview

Fewer missed appointments. Reminders go out 48 hours and 2 hours before each appointment; the customer answers 1, 2 or 3 and **code** handles it with no AI. A cancelled or moved appointment frees its slot and offers it to the waitlist; whoever does not show up gets one follow-up, and repeat no-shows are flagged to a person. Built with n8n, Postgres and Claude (local mock mode; synthetic data).

## What it does (four workflows)

**1. Reminders · Send** (every 10 minutes)
Code decides what is due: the 48 h reminder between 48 and 24 hours before, the 2 h reminder between 2 hours and 30 minutes before, only for active appointments, once each. It respects the opt-out list and each contact's sending hours (their own time zone). Outside those hours the reminder is deferred; if there will be no later chance it is recorded as **skipped with the reason**, never lost silently. A reminder is recorded only **after** it was sent: a failed send retries next run and fails loudly.

**2. Reminders · Customer Reply** (`POST /webhook/reminder-reply`)
- Opt-out words (STOP, baja) first; each message id runs once.
- "1 / 2 / 3", yes, cancel and reschedule are read by code. Only free text reaches the AI, which classifies the intent with its evidence and confidence; the evidence must be in the customer's text.
- Code decides from what the conversation was waiting for (a reminder reply, a slot choice, a waitlist offer). Prompt injection, a failed AI, low confidence or a question goes to a person; two reminders for invalid answers, then a person.
- Each effect is one atomic statement: confirm; cancel (frees the slot); rebook (claims the new slot **only if it is still free**, creates a linked appointment, releases the old one); waitlist claim or decline; opt-out to the shared suppression list.
- A freed slot is offered to the first person on the waitlist; "1" takes it (first to answer wins).

**3. Reminders · No-show Sweep** (every 15 minutes)
After a 15-minute grace period with no check-in, the appointment is marked no-show (only if it is still active and without check-in at that instant) and the customer gets **one** follow-up offering a new time. Two or more no-shows in 90 days alert a person once. Nothing is blocked or charged automatically.

**4. Reminders · Staff Update** (`POST /webhook/appt-update`)
Check-in, attended, cancel or manual no-show, with who and when. A check-in stops the sweep, a wrong no-show can be corrected, a closed appointment is not touched, cancelling frees the slot, and concurrent edits are detected with a version number.

## What was tested (synthetic data, mock mode)

- 16 unit tests (`test/reminders.test.js`): reminder windows, send-window deferral and last-chance skip, opt-outs, the reply state machine (numbers, free text, invalid options, closed appointments), slot eligibility, waitlist order, no-show grace and repeat alert, staff transitions, message sanitizing.
- 61 end-to-end checks pass (`scripts/smoke-reminders.ps1`), including: a 03:00 reminder deferred instead of sent, a last-chance skip recorded with its reason, an opted-out contact never messaged, each customer seeing their own local time, confirm / cancel / reschedule by number, **two customers picking the same slot with no double booking**, the waitlist offer and decline, free text classified by the (mock) AI, an injection and an AI failure handed to a person, no-show grace to the minute, a staff check-in beating the sweep, a wrong no-show corrected, one follow-up only, and **SMTP down → reminder not recorded → sent once after recovery**.

## Not verified yet

- Real SMS / WhatsApp and the calendar (GoHighLevel / Google Calendar): locally the SMS is an email to a test inbox and the calendar is a table. Those contracts are unverified.
- Claude in `live` mode (`record_reply_intent` tool): the mock reads keywords and says nothing about a real model.
- Waitlist offers do not expire on their own: if the first person never answers, the slot stays free for anyone who chooses it.
- Two overlapping reminder runs could send the same reminder twice (the table records it once).
- `now` and `received_at` can be set in the payload only in mock mode and with the internal token; in `live` mode they are rejected (unit-tested; the live switch itself was not exercised at runtime).
