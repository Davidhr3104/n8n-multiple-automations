// Genera docs/workflows-catalog.html: una ficha por workflow (qué hace, cómo, salvaguardas, cifras reales leídas de workflows/*.json)
// con sus capturas del canvas de n8n incrustadas. Uso: node scripts/build-catalog.js
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots', 'n8n');

// slug de capturas, archivo del workflow, sistema, resumen, pasos, salvaguardas
const CATALOG = [
  ['01-lead-intake', 'lead-intake.json', 'Lead Intake & Qualification', 'A form lead arrives, is validated, de-duplicated, enriched and scored; a sales rep approves the first message before anything reaches the lead.',
    ['Validates and normalizes the payload; one lead id never runs twice (idempotency key claimed atomically).', 'Deterministic rules score the lead against the ICP in config; AI (mock) only judges what rules cannot.', 'Round-robin assignment of a sales rep (atomic Postgres sequence).', 'The rep approves the first message by email (Send-and-Wait). Nothing is sent without an explicit yes.', 'Creates or updates the contact in the CRM with the right stage; writes one JSON evidence file per lead.'],
    ['Opt-out and hard rules run before AI', 'Failures raise an alert, never silent', 'Every step is logged to Postgres']],
  ['02-weekly-report', 'weekly-report.json', 'Weekly Lead Report', 'Monday report built from the lead outcomes stored in Postgres.',
    ['Runs on a Monday schedule or on demand.', 'Figures come from SQL over the lead outcomes table.', 'Sends the report by email.'],
    ['Numbers are computed, not written by AI']],
  ['03-revival-daily-run', 'revival-run.json', 'Lead Revival · Daily Run', 'Every weekday it picks dormant leads, prepares draft messages and emails the owner a review link.',
    ['Weekdays at 09:00 (or manual webhook); idempotent per day.', 'Selects contacts that went quiet and are not on the opt-out list.', 'Calls Prepare Draft to write one message per contact.', 'Emails the owner a link to review the real drafts.'],
    ['Nothing is sent before the owner reviews', 'Opt-outs checked before AI']],
  ['07-revival-prepare-draft', 'revival-prepare.json', 'Lead Revival · Prepare Draft', 'Writes the personalized draft for each contact in a batch and stores the batch as pending review.',
    ['Builds the context per contact.', 'AI (mock locally) writes the message; code validates it (no links or price promises).', 'Contacts that cannot be messaged are marked blocked with the reason.'],
    ['AI writes text only; code decides what is allowed']],
  ['08-revival-review-page', 'revival-review.json', 'Lead Revival · Review Page', 'A web page showing the real drafts: the owner sends, edits or skips each one.',
    ['GET shows the batch behind a token; expired or reused links change nothing.', 'POST receives the decisions; edited text that adds links or promises is rejected.', 'Persists the review in one atomic statement and dispatches only the approved drafts.'],
    ['Fail closed: no clear choice means not sent', 'Customer data is HTML-escaped on the page']],
  ['04-revival-send-touch', 'revival-touch.json', 'Lead Revival · Send Touch', 'Sends ONE approved draft after re-checking everything at send time.',
    ['Re-checks batch approved, opt-out list, touch order and the contact\'s local sending hours.', 'Outside hours the message waits for the window to open.', 'Sends (email in mock, GoHighLevel in live) and records the result.'],
    ['Guards are evaluated here, not trusted from the caller', 'Idempotent per draft']],
  ['09-revival-send-queue', 'revival-queue.json', 'Lead Revival · Send Queue', 'Every 15 minutes releases messages that were held until the sending window opened.',
    ['Finds approved drafts whose time has come.', 'Calls Send Touch for each, one at a time.'], ['Retries failed dispatches next cycle']],
  ['05-revival-handle-reply', 'revival-reply.json', 'Lead Revival · Handle Reply', 'Processes a reply from a lead and stops or continues the sequence.',
    ['Detects opt-out requests with code before any AI.', 'Classifies the reply (AI in mock) and updates the contact state.', 'Notifies a person when the lead shows interest.'],
    ['An opt-out is honored immediately and permanently']],
  ['10-revival-dashboard', 'revival-dashboard.json', 'Lead Revival · Dashboard', 'A page with the revival funnel and the state of every batch.',
    ['Reads counts straight from Postgres.', 'Renders an escaped HTML page.'], ['Read-only']],
  ['11-qualifier-inbound', 'qualifier-inbound.json', 'Qualifier · Inbound Message', 'Handles each incoming SMS: opt-out, per-contact lock, AI decision, validated reply.',
    ['Normalizes the message; opt-out is checked before AI.', 'Takes a per-contact lock so two messages from the same lead do not collide.', 'AI (mock) decides the next step; code validates the outbound text and decides the action.', 'Queues the reply; hands off to a person by email when qualified.'],
    ['Deterministic code has the last word', 'Messages saved before processing so none is lost']],
  ['12-qualifier-booking', 'qualifier-booking.json', 'Qualifier · Booking', 'Offers free slots, understands the lead\'s choice and books the appointment.',
    ['Reads free slots (mock calendar), offers up to three.', 'AI picks which slot the lead chose; code validates it.', 'Books atomically: a unique index decides races for the same slot.', 'Sends the confirmation.'],
    ['No double booking even under a race']],
  ['13-qualifier-send', 'qualifier-send.json', 'Qualifier · Send Message', 'Sends one message from the outbox, re-checking everything at send time.',
    ['Re-reads the opt-out list and the conversation state.', 'Only sends within working hours in the lead\'s local time.', 'Persists outbox, conversation log and state in one statement.'],
    ['Send-time guard', 'Failures leave state intact and alert']],
  ['14-qualifier-stale-queue', 'qualifier-stale.json', 'Qualifier · Stale & Queue', 'Every 15 minutes releases held messages and follows up on conversations that went quiet.',
    ['Releases messages whose sending window opened.', 'Creates one follow-up for stale conversations, then stops.'], ['One follow-up only, never a spam loop']],
  ['15-support-kb-ingest', 'support-kb-ingest.json', 'Support · KB Ingest', 'Loads a knowledge-base document: splits, embeds and stores it.',
    ['Splits the text into passages.', 'Embeds each passage (mock embeddings locally).', 'Upserts idempotently: unchanged documents change nothing; removed paragraphs are deleted.'],
    ['Idempotent ingest']],
  ['16-support-ticket-agent', 'support-ticket.json', 'Support · Ticket Reply Agent', 'Answers support emails from the knowledge base with the source cited; anything else goes to a person.',
    ['Hard rules first: legal, chargeback, fraud, health and privacy topics always go to a person.', 'AI triages: is it support, intent, sentiment, does it ask for an action.', 'Retrieves the 4 closest passages with pgvector.', 'AI drafts using only those passages; code checks every number, link and email is in the cited text.', 'Gate: reply on its own, a person approves, or escalate with no draft.'],
    ['Evaluated on 30 synthetic tickets: 0 wrong automatic replies']],
  ['17-sync-run', 'sync-run.json', 'CRM ↔ Sheets Sync · Run', 'Keeps a CRM and a spreadsheet consistent with no AI: plan in pure code, apply atomically.',
    ['Every 15 minutes (or on demand); a lock allows one run at a time.', 'Reads both sides through a mock adapter.', 'Plans: normalize, find duplicates, link records, three-way merge against the last synced value.', 'Applies the plan in one atomic statement and logs every change before and after.', 'Notifies a person only about what is new.'],
    ['Never deletes, never overwrites a field both sides changed', 'The whole statement aborts if a record changed meanwhile', 'SYNC_MODE=live refuses to run']],
  ['18-sync-conflict-review', 'sync-review.json', 'CRM ↔ Sheets Sync · Conflict Review', 'A page where a person chooses the CRM value, the Sheet value, or decides later for each conflict.',
    ['Token and expiry protect the page.', 'The chosen value is copied to the other system and the last-synced value is updated, atomically.', 'A choice is skipped if either record changed since the conflict was detected.'],
    ['Unclear choice stays open', 'Data is HTML-escaped']],
  ['19-sync-weekly-summary', 'sync-weekly.json', 'CRM ↔ Sheets Sync · Weekly Summary', 'Monday summary of what the sync created, updated and what still waits for a person.',
    ['Numbers come straight from SQL.', 'Sends the summary by email; fails loudly if the email fails.'], ['No AI in the numbers']],
  ['20-invoice-processor', 'invoice-intake.json', 'Invoice & Document Processor', 'Reads invoices and posts them to accounting only when every check passes; anything doubtful goes to a person.',
    ['Hard rules flag text that tries to give orders to the AI.', 'AI reads the document and returns each field with its evidence and confidence.', 'Code checks each field is really in the document, the arithmetic, dates, duplicates, the vendor bank account and the limit.', 'Gate: post automatically, a person approves, discard (duplicate / not an invoice) or escalate if the AI failed.', 'Posts the invoice and the ledger entry atomically; a unique index blocks double payment.'],
    ['Changed bank account is never automatic', 'Approved but incomplete invoices are NOT posted and fail loudly']],
  ['21-triage-ticket-intake', 'triage-intake.json', 'Ticket Triage · Intake', 'Classifies each incoming ticket, sets its priority, assigns it to the right person and starts the SLA clocks; anything doubtful goes to the triage lead.',
    ['Hard rules flag security / outage / safety wording and text that tries to give orders to the AI.', 'Looks up the customer plan and every agent\'s open load.', 'AI reads the ticket: category, proposed urgency and summary, each with the exact words it relied on.', 'Code checks that evidence is really in the ticket, then decides the priority: rule and plan floors the AI cannot lower, and P1 only with two independent signals.', 'Code assigns by skill and load, computes first-response and resolution due dates (P1 around the clock, the rest in business hours) and emails the assignee and, when needed, the lead.', 'Ticket and audit event are saved in one atomic statement.'],
    ['AI alone can never create a P1', 'Spam verdicts never discard a ticket that a hard rule or a known customer contradicts', 'A failed notification email is recorded and fails loudly']],
  ['22-triage-sla-watcher', 'triage-sla-watch.json', 'Ticket Triage · SLA Watcher', 'Every 5 minutes it checks every open ticket and warns before an SLA is missed, then escalates when it is.',
    ['Reads open tickets and the alerts already sent.', 'Code computes each clock: on time, at risk (75 % of the window used) or breached, in business or calendar time.', 'Groups alerts per recipient: the assignee sees their own, the lead sees every breach and every unassigned ticket.', 'Sends the emails, then records only the alerts that were actually delivered.'],
    ['Each alert is sent once', 'If email fails nothing is marked as sent: it retries next run and the failure is visible', 'The clock only runs on the real time unless a test token overrides it in mock mode']],
  ['23-triage-ticket-update', 'triage-update.json', 'Ticket Triage · Ticket Update', 'Records a first response, a resolution or a reassignment so the SLA clock stops and the change is audited.',
    ['Validates the action and who did it.', 'Code decides the outcome: repeating a first response or a resolution changes nothing; a resolved ticket is frozen; only active agents can be assigned.', 'Writes the change and an audit event with who and when in one statement, guarded by a version number.'],
    ['Concurrent edits are detected, never overwritten', 'Every change is attributed to a person']],
  ['06-error-handler', 'error-handler.json', 'Global Error Handler', 'Any workflow that fails reports here: the failure is logged and a person is emailed.',
    ['Error trigger receives the failed execution.', 'Writes a workflow_error row in Postgres.', 'Emails the details.'], ['Nothing fails silently']],
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b64 = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');

function facts(file) {
  const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', file), 'utf8'));
  const n = w.nodes;
  const cnt = re => n.filter(x => re.test(x.type)).length;
  const triggers = n.filter(x => /scheduleTrigger|webhook$|errorTrigger/.test(x.type)).map(x => x.type.endsWith('webhook') ? `${x.parameters.httpMethod} /webhook/${x.parameters.path}` : x.type.endsWith('scheduleTrigger') ? `cron ${x.parameters.rule.interval[0].expression}` : 'error trigger');
  return { id: w.id, nodes: n.length, code: cnt(/\.code$/), pg: cnt(/postgres$/), branches: cnt(/\.if$/), http: cnt(/httpRequest$/), email: cnt(/emailSend$/), triggers };
}

let cards = '';
let totalShots = 0;
for (const [slug, file, title, summary, steps, guards] of CATALOG) {
  const f = facts(file);
  const dir = path.join(SHOTS, slug);
  const canvas = fs.readdirSync(dir).filter(x => x.startsWith('canvas')).sort();
  const exec = fs.readdirSync(dir).filter(x => x.startsWith('execution')).sort();
  totalShots += canvas.length + exec.length;
  cards += `<section class="card" id="${slug}"><h2>${esc(title)}</h2><p class="lead">${esc(summary)}</p>
<div class="facts"><span><b>${f.nodes}</b> nodes</span><span><b>${f.pg}</b> Postgres</span><span><b>${f.code}</b> code</span><span><b>${f.branches}</b> decisions</span><span><b>${f.email}</b> email</span><span><b>${f.http}</b> HTTP</span></div>
<p class="meta"><b>Starts from:</b> ${f.triggers.map(esc).join(' · ')} &nbsp;|&nbsp; <b>id:</b> <code>${f.id}</code></p>
<div class="cols"><div><h3>How it works</h3><ol>${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div><div><h3>Safeguards</h3><ul>${guards.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div></div>
<h3>Canvas in n8n</h3>${canvas.map(c => `<figure><img loading="lazy" alt="${esc(title)} canvas ${c}" src="${b64(path.join(dir, c))}"><figcaption>${esc(c)}</figcaption></figure>`).join('')}
<h3>A real execution</h3>${exec.slice(0, 1).map(c => `<figure><img loading="lazy" alt="${esc(title)} execution" src="${b64(path.join(dir, c))}"><figcaption>${esc(c)} (${exec.length} execution captures in the folder)</figcaption></figure>`).join('')}
</section>`;
}

const toc = CATALOG.map(([slug, , title]) => `<a href="#${slug}">${esc(title)}</a>`).join('');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>n8n workflows catalog</title><style>
:root{--bg:#f8fafc;--fg:#0f172a;--muted:#475569;--card:#fff;--border:#cbd5e1;--primary:#1e40af;--chip:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2e;--border:#2a3a5c;--primary:#93c5fd;--chip:#1e2a45}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:16px}h1{margin:.2em 0}.sub{color:var(--muted)}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}nav a{background:var(--chip);padding:4px 12px;border-radius:999px;color:var(--fg);text-decoration:none;font-size:.9rem}nav a:hover{outline:2px solid var(--primary)}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin:20px 0}.lead{font-size:1.05rem}
.facts{display:flex;flex-wrap:wrap;gap:8px}.facts span{background:var(--chip);border-radius:999px;padding:2px 12px;font-size:.9rem}.meta{color:var(--muted);font-size:.9rem}
.cols{display:grid;grid-template-columns:2fr 1fr;gap:20px}@media(max-width:760px){.cols{grid-template-columns:1fr}}
figure{margin:12px 0}img{max-width:100%;height:auto;border:1px solid var(--border);border-radius:8px}figcaption{color:var(--muted);font-size:.8rem}
code{background:var(--chip);padding:1px 6px;border-radius:4px}h3{margin:.8em 0 .3em;font-size:1rem}
</style></head><body><div class="wrap"><h1>n8n workflows catalog</h1>
<p class="sub">${CATALOG.length} workflows, ${totalShots} editor screenshots. Built and tested with synthetic data in mock mode: live Claude, GoHighLevel, Gmail, Google Sheets, Xero and embeddings contracts are not verified. Node counts are read from the workflow files.</p>
<nav>${toc}</nav>${cards}</div></body></html>`;
fs.writeFileSync(path.join(ROOT, 'docs', 'workflows-catalog.html'), html);
console.log(`catalog: ${CATALOG.length} workflows, ${totalShots} screenshots, ${(html.length / 1e6).toFixed(1)} MB`);
