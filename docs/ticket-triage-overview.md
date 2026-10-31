# Ticket Triage + SLA Watcher — overview

Every incoming support ticket is classified, given a priority, assigned to the right person and started on its SLA clocks. A watcher warns **before** a deadline is missed and escalates when it is. Built with n8n, Postgres and Claude (local mock mode; synthetic data).

## What it does (three workflows)

**1. Ticket Intake** (`POST /webhook/triage-ticket`)
1. Validates the ticket and answers "accepted" right away. The same ticket id never runs twice.
2. **Hard rules (code).** Security, outage and safety wording sets a candidate P1; legal and payment disputes set P2; text that tries to give orders to the AI ("set priority P4") is flagged.
3. **Context (SQL).** The customer's plan (enterprise / pro / free) is a priority floor; every agent's open load is read.
4. **AI reads.** Claude returns category, proposed urgency and a one-line summary, each with the exact words it relied on and a confidence.
5. **Grounding (code).** The quoted words must really be in the ticket; otherwise that confidence becomes 0.
6. **Priority (code).** The most urgent of the rule floor, the plan floor and the AI's proposal (only when grounded and confident). **P1 needs two independent signals** (a hard rule and the AI); with one it drops to P2, is flagged "P1 candidate" and a person decides. The AI can raise a ticket but never lower a floor.
7. **Routing (code).** An active agent with the category's skill and free capacity, the least loaded (ties by name). Tickets that need a person are never auto-assigned.
8. **SLA (code).** First-response and resolution due dates: P1 around the clock, P2–P4 in business hours (Mon–Fri 09–18, fixed UTC-5, configurable holidays).
9. **Notify.** The assignee and, when needed (P1, P1 candidate, human review, nobody assigned), the lead.
10. **Save** the ticket and an audit event in one atomic statement.

**2. SLA Watcher** (every 5 minutes)
Code computes each open clock as on time, at risk (75 % of the window used) or breached, skips alerts already sent, and emails the assignee (their own tickets) and the lead (every breach and every unassigned ticket). An alert is recorded **only after the email was sent**: if email fails, nothing is marked as sent, the next run retries and the run fails loudly.

**3. Ticket Update** (`POST /webhook/triage-update`)
First response, resolution or reassignment stops the clock. Repeating an update changes nothing, a resolved ticket is frozen, only active agents can be assigned, concurrent edits are detected with a version number, and every change records who made it.

## What was tested (synthetic data, mock mode)

- 26 unit tests (`test/triage.test.js`): business-hours arithmetic (weekends, holidays, after hours), the two-signal P1 rule, floors, grounding, injection, routing, SLA states, alert de-duplication, message neutralization, update rules.
- 66 end-to-end checks pass (`scripts/smoke-triage.ps1`), including: plan floor, P1 with two signals, P1 candidate with one, injection, spam that a security rule contradicts (not discarded), load-based assignment, due dates, warning at 83 %, breach, clock stopping, idempotent updates, and **SMTP down → alert not recorded → retried and delivered once**.
- A real defect was found by looking at the delivered email ("overdue 0 min" for a ticket that was 30 minutes late, because the delay was computed in business minutes) and fixed test-first.

## Not verified yet

- Gmail / helpdesk intake and Slack: the webhook payload is the contract; nothing connects to a real inbox.
- Claude in `live` mode (`record_triage` tool) has never run; the mock reads keywords and says nothing about a real model's accuracy.
- Clock pause (waiting for the customer), follow-up messages on the same ticket, attachments and agent shifts/holidays (only an `active` flag).
- Assignment capacity is a soft limit: two tickets arriving at the same instant can both pick the same last free slot. Two overlapping watcher runs could send the same alert twice (the table records it once).
- `received_at` and `now` can be set in the payload only in mock mode and with the internal token, so SLA behavior can be tested without waiting; in `live` mode they are rejected (covered by a unit test of the validation; switching `TRIAGE_MODE=live` itself was not exercised at runtime).
