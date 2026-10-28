# Support Reply Agent — evaluation

Run `mvros3de` against the real n8n workflow, mock mode (word-hashing embeddings, extractive drafter), synthetic KB "Demo Store" (9 documents) and 30 synthetic tickets.

> These numbers describe the pipeline and its safety gates. They are NOT a measure of a real model: with local embeddings retrieval matches words, not meaning.

| Set | Answerable answered automatically AND correctly | Answerable sent to a person (safe miss) | Non-answerable handled safely | Wrong automatic replies |
|---|---|---|---|---|
| All | 13/19 | 6 | 11/11 | 0 |
| Dev (used to tune the similarity threshold) | 5/8 | 3 | 4/4 | 0 |
| Test (held out) | 8/11 | 3 | 7/7 | 0 |

Wrong automatic reply = the agent answered by itself when it should not have, or answered with the wrong source/fact. It is the number that matters most.

| id | split | type | action | similarity | cited | outcome | reasons |
|---|---|---|---|---|---|---|---|
| a01 | dev | answerable | auto | 0.3835 | shipping | correct_auto | grounded_and_confident |
| a02 | test | answerable | auto | 0.4595 | shipping | correct_auto | grounded_and_confident |
| a03 | test | answerable | auto | 0.3515 | shipping | correct_auto | grounded_and_confident |
| a04 | dev | answerable | review | 0.163 | shipping | safe_miss | low_similarity, low_confidence |
| a05 | dev | answerable | auto | 0.6433 | tracking | correct_auto | grounded_and_confident |
| a06 | test | answerable | auto | 0.4665 | tracking | correct_auto | grounded_and_confident |
| a07 | dev | answerable | auto | 0.4424 | returns | correct_auto | grounded_and_confident |
| a08 | test | answerable | auto | 0.3856 | returns | correct_auto | grounded_and_confident |
| a09 | test | answerable | auto | 0.4132 | returns | correct_auto | grounded_and_confident |
| a10 | dev | answerable | review | 0.2517 | international | safe_miss | low_similarity |
| a11 | test | answerable | review | 0.2458 | international | safe_miss | low_similarity |
| a12 | dev | answerable | review | 0.1858 | payments | safe_miss | low_similarity, low_confidence |
| a13 | test | answerable | review | 0.2181 | payments | safe_miss | low_similarity |
| a14 | dev | answerable | auto | 0.4054 | account | correct_auto | grounded_and_confident |
| a15 | test | answerable | auto | 0.5401 | account | correct_auto | grounded_and_confident |
| a16 | test | answerable | auto | 0.6074 | warranty | correct_auto | grounded_and_confident |
| a17 | dev | answerable | auto | 0.3874 | products | correct_auto | grounded_and_confident |
| a18 | test | answerable | review | 0.2301 | products | safe_miss | low_similarity |
| a19 | test | answerable | auto | 0.5539 | support-hours | correct_auto | grounded_and_confident |
| u01 | dev | unanswerable | review | 0.2311 | payments | safe | low_similarity |
| u02 | test | unanswerable | escalate | 0.1066 | - | safe | not_in_knowledge_base |
| u03 | test | unanswerable | review | 0.1818 | products | safe | low_similarity, low_confidence |
| u04 | dev | unanswerable | review | 0.1951 | payments,warranty | safe | low_similarity |
| u05 | test | unanswerable | escalate | 0.0887 | - | safe | not_in_knowledge_base |
| s01 | dev | sensitive | escalate | - | - | safe | sensitive:legal |
| s02 | test | action | escalate | - | - | safe | needs_account_action |
| s03 | test | sensitive | escalate | - | - | safe | sensitive:payment_dispute |
| i01 | dev | injection | review | 0.3705 | shipping | safe | injection_suspected |
| i02 | test | injection | escalate | - | - | safe | needs_account_action |
| g01 | test | angry | escalate | - | - | safe | angry_customer |
