<h1 align="center">Export Documentation for Claude Code</h1>

<p align="center">
  <strong>The open-source export documentation system that is just a database and Claude Code.</strong>
</p>

<p align="center">
  Created by <a href="https://www.enterprisedna.co"><strong>Enterprise DNA</strong></a>. Free and open source. Works with Claude Code, Codex, OpenCode or Cursor.
</p>

<!-- three-doors -->
<table align="center">
  <tr>
    <td align="center"><strong>Do it yourself</strong><br/>Clone it, run it, own it. Free, MIT.<br/><a href="#quick-start">Quick start</a></td>
    <td align="center"><strong>We customise it</strong><br/>Your fields, your rules, your TradeWindow Prodoc data brought across.<br/><a href="https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=tradewindow-prodoc">Book a call</a></td>
    <td align="center"><strong>We run it for you</strong><br/>Installed, connected and operated inside Omni. Setup fee, then a retainer.<br/><a href="https://enterprisedna.co/omni/instead-of/tradewindow-prodoc?utm_source=github&utm_medium=readme&utm_campaign=tradewindow-prodoc">How it works</a></td>
  </tr>
</table>

<p align="center">
  <a href="#what-is-this">What is this</a> &bull;
  <a href="#why-no-front-end">Why no front end</a> &bull;
  <a href="#quick-start">Quick start</a> &bull;
  <a href="#the-commands">Commands</a> &bull;
  <a href="#instead-of-tradewindow-prodoc">Instead of TradeWindow Prodoc</a> &bull;
  <a href="#want-it-installed-and-run-for-you">Installed for you</a> &bull;
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square" alt="Node 20+" />
  <img src="https://img.shields.io/badge/PostgreSQL-any-336791?style=flat-square" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/PGlite-embedded-3ecf8e?style=flat-square" alt="PGlite" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" />
</p>

---

## What is this

Export Documentation for Claude Code does the job you pay TradeWindow Prodoc for, as a Postgres database and a set of agent commands. There is no web front end. You open the folder in [Claude Code](https://claude.com/claude-code) (or Codex, OpenCode, Cursor: see `AGENTS.md`) and ask for what you want in plain language. It runs the right query, and it can answer questions the TradeWindow Prodoc dashboard cannot.

TradeWindow does not publish a Prodoc price. It is quoted by users and modules, with extras such as Hybrid Data Connect and custom forms charged on top ([FitGap](https://us.fitgap.com/products/058082/tradewindow), checked 30 October 2026). TradeWindow's own Q1 FY27 investor update reports an average of NZ$36,447 a year per exporter and importer customer across Prodoc, Cube and Origin ([NZX, 23 July 2026](https://announcements.nzx.com/announcement/476545)). The free code still has hosting, agent and support costs.

Want the same thing with a web front end, or built on a different stack? That is a customisation, and it is exactly what Enterprise DNA does: [book a call](https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=tradewindow-prodoc).

It is for New Zealand and Australian exporters that ship their own goods by sea and air: food and beverage, seafood, honey, horticulture and manufacturers, with one person or a small team on the export desk. It keeps destination markets and the documents each asks for, overseas customers with their own document instructions, products with tariff codes, weights and health certificate or permit flags, origin evidence for each trade agreement, export orders with incoterms and exchange rates, shipments with cut-offs, export entries and bills of lading, every document on every shipment, letters of credit and invoices. It checks every shipment against the export entry rules, the CPTPP certification of origin rules, letter of credit presentation under UCP 600, and record keeping, with each rule cited in [docs/compliance.md](docs/compliance.md).

The demo is a fictional Nelson exporter, Tasman Bay Provisions. It has a sea shipment to Yokohama one day from cut-off with no export entry and no health certificate, a CPTPP claim on mussel powder with no tariff code and on honey with no origin evidence, last year's blanket certification of origin reused on a Singapore air shipment, kiwifruit purée whose supplier declarations ran out last month, an entry lodged after the lodgement time, a chamber certificate still in draft the day before cut-off, a Dubai letter of credit whose latest shipment date falls before the sailing and whose amount the order exceeds, documents due at the bank in three days, a Los Angeles customer whose goods land in four days without their documents, a shipment with no packing list on file, a US$91,020 invoice a month overdue, and no phone number for the person who signs origin statements.

## Why no front end

- The front end was only ever there because the database was hard to talk to. That is no longer true.
- Your data sits in plain Postgres tables you own. Any tool can read them. No export, no lock-in.
- No seats, no tiers, no add-ons. Read [docs/why-no-front-end.md](docs/why-no-front-end.md) for the honest trade-offs too.

## Quick start

Sixty seconds, no database install (an embedded Postgres runs inside Node):

```bash
git clone https://github.com/Enterprise-DNA-OS/export-documentation-for-claude-code.git
cd export-documentation-for-claude-code
npm install
npm run demo
```

Then open the folder in Claude Code and type `/attention`. Follow it with `/morning-check`, `/origin-check` and `/lcs`.

Or from the terminal:

```bash
npm test
npm run trade -- attention
npm run view
npm run docs
```

### Use it with your own Postgres or Supabase

Copy `.env.example` to `.env`, set `DATABASE_URL`, then `npm run migrate`. Same commands, shared data, no per-seat fee.

## The commands

| Command | What it does |
|---|---|
| `/add` | Add markets, agreements, document types, customers, products or letters of credit from a JSON file. |
| `/arrivals` | Goods arriving in the next 14 days, and the documents the customer does not have yet. |
| `/arrive` | Mark a shipment as arrived. |
| `/attention` | Everything the export desk needs to act on today: rule breaches, cut-offs in the next three days, documents outstanding, credits due at the bank, documents not yet with customers, and invoices overdue. |
| `/book` | Book an order onto a sailing or flight, with its cut-off, and see the documents it needs and the export entry time. |
| `/cancel` | Cancel a booking that has not sailed, with the reason. The order can be booked again. |
| `/compliance` | Check the records against the rules this industry lives under (the ones listed in docs/compliance.md) and report what is missing, late, or about to breach, with the rule cited. |
| `/customer` | One customer: details, the documents they ask for and their instructions, payment record, shipments, invoices and credits. |
| `/customers` | Overseas customers: currency, incoterm, payment terms, extra documents and how late they pay. |
| `/customise` | Make this system yours in plain language. Add a field, rename stages, change a rule, add a column to a document. Writes the migration, applies it, updates the commands that touch it. |
| `/cutoffs` | Cargo cut-offs in the next 14 days, with the time each export entry must be lodged and the documents still outstanding. |
| `/docs-due` | Every document still outstanding on live shipments: what it is, who issues it, why it is needed, and days to cut-off. |
| `/documents` | Render the paperwork: commercial invoices, packing lists, certifications of origin and shipping advice, in your brand. |
| `/draft-docs-request` | Draft the request to whoever issues the documents still outstanding on a shipment (the chamber, MPI, the insurer), with the goods listed. |
| `/draft-overdue` | Draft an overdue reminder for one customer, listing each overdue invoice. |
| `/draft-shipping-advice` | Draft the shipping advice to the customer once goods are on board: vessel, bill of lading, container, arrival, the documents and the invoice. |
| `/draft-weekly` | Save the weekly review as a draft in drafts/. |
| `/enter` | Record the export entry number for a shipment once it is lodged. |
| `/entries` | Export entries for booked shipments over the threshold: the time each must be lodged, the entry number, and whether it went in late. |
| `/export` | Write every record to one JSON file. |
| `/hs-codes` | Products and their tariff codes: missing first, then codes not checked in the last year. |
| `/hs` | Record or correct a product's tariff code (six to ten digits). |
| `/import` | Bring customers or products across from a TradeWindow Prodoc export (a list saved as CSV). |
| `/invoice` | Raise the invoice for a shipment at the order value, due on the customer's terms. |
| `/issue` | Record a document as issued (or in draft) for a shipment: our invoice and packing list, a health certificate, a chamber certificate, insurance. |
| `/lanes` | Trade lanes over the last year: shipments, customers, FOB value and weight by market, and how many claimed an agreement. |
| `/lc` | One letter of credit: its terms, the documents it asks for, each shipment under it with the date documents must be presented, and its findings. |
| `/lcs` | Letters of credit: amount and ceiling, what is drawn, latest shipment date, expiry, and the next date documents must reach the bank. |
| `/log` | Add a note to a customer, product, order, shipment, credit or market. |
| `/market` | One market: its documents, agreements, and customers. |
| `/markets` | Destination markets: the agreements in force and the documents every shipment there needs. |
| `/morning-check` | The morning desk check: cut-offs in the next 14 days, export entries to lodge, documents outstanding, and goods arriving with documents not yet sent. |
| `/new-order` | Enter an export order for a customer from product codes, quantities and prices. |
| `/new-view` | Add a read-only HTML view (a dashboard page) from a plain-language description, rendered in the operator's brand by `npm run view`. |
| `/order` | One order: totals, FOB value, weights, lines and its booking. |
| `/orders` | Open export orders, their value, claim, credit and booking. |
| `/origin-check` | Every line on a shipment claiming a trade agreement, against its tariff code and the origin evidence on file on the day it ships. |
| `/origin` | Record the origin evidence for a product under an agreement: the criterion, the basis, who decided, and how long it holds. |
| `/pay` | Record a payment against an invoice. |
| `/payers` | How each customer pays: paid invoices in the last year, average days late, what they owe now. |
| `/present` | Record that the documents for a letter of credit shipment went to the bank. |
| `/product` | One product: tariff code, weights, origin evidence by agreement, and where it shipped in the last year. |
| `/products` | Products: tariff code, weights, health certificate or permit, and the origin evidence on file. |
| `/receivables` | Invoices owing, in the order currency and the base currency, oldest overdue first. |
| `/send` | Mark a shipment's issued documents as sent to the customer, their broker or the bank. |
| `/ship` | Record that the goods are on board, with the bill of lading or air waybill. |
| `/shipment` | One shipment in full: booking, goods with tariff codes and weights, every document it needs and why, origin, rule findings and notes. |
| `/shipments` | Every live shipment: customer, vessel or flight, cut-off, sailing, documents ready against needed, what is outstanding, and the export entry. |
| `/weekly-review` | The Monday review, written from attention, cut-offs, documents outstanding, credits and money owed. |

Views (`npm run view`): `week` (cut-offs, documents outstanding, on the water, rule findings), `origin` (claims with a problem, origin evidence, tariff codes), `money` (letters of credit, invoices owing, how each customer pays, trade lanes). Documents (`npm run docs`): commercial invoices with the origin statement, packing lists, CPTPP certifications of origin and shipping advice, in your `brand.json`.

## Ten questions Prodoc's screens do not answer

Each one is a single question to Claude Code, answered from your own records today:

1. Which shipments sailing this week still have no export entry, and when must each be lodged?
2. Which products on agreement claims have no tariff code, no origin evidence, or evidence that has lapsed?
3. Which shipments are about to reuse a certification of origin that is past its twelve months?
4. Which documents are we waiting on from MPI, the chamber or the insurer, by issuer, with days to cut-off?
5. Which letters of credit have a bank date in the next five days, and which bookings sail after a credit's latest shipment date?
6. Which orders under a credit come to more than the credit allows?
7. Which customers' goods land within a week without their documents?
8. Which customers pay late, and by how many days on average?
9. What did each market take from us in the last year, by FOB value, and how many shipments claimed an agreement?
10. Which shipments have gone out with a document never recorded, inside the years the records must be kept?

## Instead of TradeWindow Prodoc

Save your consignee and product lists from Prodoc (or the ERP that feeds it) to CSV and run `/import`. [docs/replace-tradewindow-prodoc.md](docs/replace-tradewindow-prodoc.md) lists the column names the import reads, what carries over and what does not, and how to run both side by side for a month.

## Your first hour: ten things to ask for

1. "Set up our markets and the documents each one asks for." (`/add`)
2. "Import our consignees and products from these Prodoc lists." (`/import`)
3. "Put our name, logo and colours on the documents." (edit `brand.json`, then `npm run docs`)
4. "What sails this week and what could miss its cut-off?" (`/morning-check`)
5. "Which export entries do we still have to lodge?" (`/entries`)
6. "Check every CPTPP claim against our tariff codes and origin evidence." (`/origin-check`)
7. "When do the Dubai documents have to be at the bank?" (`/lcs`)
8. "Write to the chamber for the certificate on S-2044." (`/draft-docs-request`)
9. "Add a field for the halal certificate number on each shipment." (`/customise`)
10. "Give me a page I can print for the Monday meeting." (`/new-view`)

## Architecture

```
export-documentation-for-claude-code/
  CLAUDE.md                 how the operator wants this run (routing table + house rules)
  AGENTS.md                 the same, for Codex / OpenCode / Cursor / Gemini CLI
  .claude/commands/         the slash commands
  scripts/                  the CLI the commands drive
  scripts/lib/db.mjs        one adapter: DATABASE_URL (pg) or embedded PGlite
  supabase/migrations/      plain SQL schema
  supabase/seed.sql         demo data
  docs/                     the thesis and the migration guide
```

## Built for coding agents

The database, CLI and command recipes work with Claude Code, Codex, OpenCode or Cursor. Ask your coding agent for a new command and have it implement and test the change against the same records.

## Contributing

Issues and pull requests are welcome. Keep the shape: plain SQL, a small CLI, a slash command per recurring job, no front end.

## Want it installed and run for you?

Enterprise DNA installs Export Documentation for Claude Code for your business, migrates your TradeWindow Prodoc data, connects it to the rest of your tools, and runs it for you as part of **Omni**, our managed Command Center. One setup fee, then a monthly retainer.

- Book a call: [enterprisedna.co/omni/book](https://enterprisedna.co/omni/book/?offer=replace-software&utm_source=github&utm_medium=readme&utm_campaign=tradewindow-prodoc)
- Read more: [enterprisedna.co/omni/instead-of/tradewindow-prodoc](https://enterprisedna.co/omni/instead-of/tradewindow-prodoc?utm_source=github&utm_medium=readme&utm_campaign=tradewindow-prodoc)

## License

MIT. Copyright (c) 2026 Enterprise DNA.
