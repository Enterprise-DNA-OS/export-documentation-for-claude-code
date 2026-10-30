# Export Documentation for Claude Code: operating instructions

This file is the brain. Claude Code reads it at the start of every session. It says who this is for, how work gets done, and the one right way to do each recurring job.

## Who this is for

- **Business:** [YOUR BUSINESS] (the demo is Tasman Bay Provisions, a fictional Nelson food exporter)
- **Operator:** [YOUR NAME], [your role]
- **What matters most:** [the one or two outcomes you care about]

Fill this in once. A worker with context knows. A worker without it guesses.

## How to work

1. **Take a brief, not a script.** The operator describes the outcome. You run the right command and present the answer.
2. **Read before you write.** Before drafting anything about a record, read its full history first.
3. **Plain language.** Short sentences. No filler. Numbers in tables.
4. **Silent success, loud problems.** No play-by-play. Say what broke and what you did about it.
5. **Stop at the line.** Anything that sends, deletes, or faces a customer waits for a yes in this session.

## Routing table: one right way for each recurring job

| When the operator asks for... | Use this |
|---|---|
| what needs doing, what is on fire | `/attention` |
| the morning desk check, what sails this week | `/morning-check` |
| live shipments | `/shipments` |
| look up a shipment | `/shipment` |
| cut-offs, what sails when | `/cutoffs` |
| documents outstanding, what are we waiting on | `/docs-due` |
| export entries to lodge | `/entries` |
| the entry number came back | `/enter` |
| agreement claims, rules of origin | `/origin-check` |
| record origin evidence | `/origin` |
| tariff codes, HS codes | `/hs-codes` |
| set a tariff code | `/hs` |
| letters of credit | `/lcs` |
| look up a credit | `/lc` |
| documents went to the bank | `/present` |
| who owes us | `/receivables` |
| who pays late | `/payers` |
| invoice a shipment | `/invoice` |
| a payment came in | `/pay` |
| where the goods go, by market | `/lanes` |
| what lands soon, documents not sent | `/arrivals` |
| market requirements | `/markets` |
| one market | `/market` |
| customer list | `/customers` |
| look up a customer | `/customer` |
| product list | `/products` |
| look up a product | `/product` |
| open orders | `/orders` |
| look up an order | `/order` |
| enter an order | `/new-order` |
| book a sailing or flight | `/book` |
| a document was issued | `/issue` |
| documents sent to the customer | `/send` |
| the goods are on board | `/ship` |
| goods arrived | `/arrive` |
| cancel a booking | `/cancel` |
| add a note | `/log` |
| add markets, customers, products, credits | `/add` |
| bring data from Prodoc | `/import` |
| export everything | `/export` |
| invoices, packing lists, origin certificates, shipping advice | `/documents` |
| tell the customer it has sailed | `/draft-shipping-advice` |
| ask MPI, the chamber or the insurer for a document | `/draft-docs-request` |
| write an overdue reminder | `/draft-overdue` |
| save the review as a draft | `/draft-weekly` |
| the Monday review | `/weekly-review` |
| all rule checks | `/compliance` |
| add a field, change a rule | `/customise` |
| a new dashboard page | `/new-view` |

If an ask fits nothing here, run the CLI directly (`npm run trade -- help`) and then propose a new command for it.

## How an export desk runs (read before you change anything)

- Money is stored in cents of the order's currency. `fx_rate` converts it to the base currency (`trade.settings.base_currency`); columns ending `_base_cents` are already converted.
- Line prices are the goods price. Freight goes on the invoice under C and D incoterms, insurance under CIF and CIP. The FOB value is the goods value in the base currency, and it decides whether a full export entry is needed (`entry_threshold_cents`).
- A shipment's documents are worked out, not typed: every shipment needs a commercial invoice and packing list, then whatever the market, the customer, the letter of credit, the agreement claimed, the incoterm and the products add (`trade.shipment_required_docs`). Each required document is missing until one is recorded with `/issue`.
- The cargo cut-off stands in for loading time. The export entry is due 48 hours before it by sea and 9 hours by air (settings).
- An agreement claim needs every line to have a six-digit tariff code and origin evidence current on the day it ships (`trade.origin_check`). Never record a tariff code or an origin determination the operator has not confirmed.
- `/ship` refuses when the export entry, a health certificate or a permit is missing, and `/book` refuses a sailing after a credit's latest shipment date, unless the operator names who accepts it (`--override-by`), and that is noted on the record.
- `/send` records that documents went; it never emails them.

## Hard rules

- Never send email or messages from here. Draft to `drafts/`, a person sends.
- Never delete records without an explicit yes in this session. Prefer marking closed or archived.
- Never invent a record. If a name is ambiguous, list the candidates and ask.
- The database is the source of truth. If the answer is not in it, say so.

## Where things live

- `scripts/` the CLI. `scripts/lib/db.mjs` picks `DATABASE_URL` (Postgres, Supabase) or the embedded database in `.data/`.
- `supabase/migrations/` the schema, plain SQL. `npm run migrate` applies it.
- `.claude/commands/` the slash commands. Add one every time the same ask comes twice.
- `docs/` the thesis and the guide for moving off TradeWindow Prodoc.

Built by Enterprise DNA. Installed and run for you as part of Omni: https://enterprisedna.co/omni/instead-of/tradewindow-prodoc
