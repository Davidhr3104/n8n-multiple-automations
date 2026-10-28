# Support Reply Agent (RAG) — overview

Answers customer support emails **from a knowledge base, with the source cited**. Anything the knowledge base does not cover, anything sensitive and anything that asks for an action on an account goes to a person. Built with n8n, Postgres + pgvector and Claude (local mock mode; synthetic data).

## What it does

1. **Receives a ticket** (email in production, webhook locally) and replies "accepted" right away. The same ticket id never runs twice.
2. **Hard rules first (code).** Legal threats, chargebacks, fraud, health and privacy topics always go to a person. Prompt-injection attempts are flagged.
3. **Triage (AI judges).** Is it support at all? What is it about? Is the customer angry? Do they want us to *do* something (cancel, refund, look up an order)? Actions and angry customers go to a person with no draft.
4. **Retrieve.** The question is embedded and the 4 closest knowledge-base passages are found with pgvector (cosine similarity).
5. **Draft (AI writes).** Claude writes the reply using only those passages and cites them.
6. **Check (code).** Every number, link and email address in the reply must appear in the cited text. A reply that adds anything of its own is rejected.
7. **Gate (code).** The reply is sent on its own only if the similarity and the confidence are high enough and nothing is flagged. Otherwise a person gets the draft with its sources and approves or rejects it. No answer found means the ticket is escalated with no draft.
8. **Send in the same thread, record everything.** Ticket, decision, reasons, the passages used (with similarity) and the reply are stored. Every step is logged and every failure raises an alert.

A second workflow, **KB Ingest**, loads a document: it splits it into passages, embeds them and saves them idempotently (an unchanged document changes nothing, a removed paragraph is deleted).

## Workflows

| Workflow | Job |
|---|---|
| Support · Ticket Reply Agent | Hard rules, triage, retrieval, drafting, grounding check, gate, approval, reply, audit |
| Support · KB Ingest | Chunk, embed and upsert a knowledge-base document |

## What was tested (synthetic data, mock mode)

- 31 end-to-end checks pass (`scripts/smoke-support.ps1`): automatic reply with the right fact and signature, duplicate ticket, human approval sends and human rejection does not, escalation without a draft, spam ignored, AI outage escalated, customer markup neutralised, idempotent KB ingest, paragraph removal.
- 30-ticket evaluation against the real workflow (`scripts/eval-support.js`, report in `docs/evals/support-eval.md`): **0 wrong automatic replies**, all 11 non-answerable tickets handled safely, 13 of 19 answerable tickets answered automatically and correctly, and the other 6 went to a person.
- Those numbers describe the pipeline and its safety gates. Local embeddings match words, not meaning, so they do not measure a real model.

## Not verified yet

- Live Claude calls, a real embeddings provider (it must return 256 dimensions) and the Gmail API (thread reply) have never run: those contracts are assumptions.
- The agent only has the knowledge base. Looking up a specific order needs an integration with the order system.
