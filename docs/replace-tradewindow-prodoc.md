# Moving off TradeWindow Prodoc

Prodoc holds two kinds of data: the static lists (consignees, products, document templates per customer and market) and the shipments you produce documents for. Bring the lists across in an afternoon, set your markets and customers' document needs, then run both side by side for a month of shipments.

## 1. Save the lists

TradeWindow does not publish an export format. Save each list as CSV from Prodoc's list screens or reports, or from the ERP that feeds Prodoc (Abel, MYOB, SAP Business One and others hold the same consignees and products). Ask TradeWindow support for a data extract if your version has no list export. Put the files in `imports/` (it is ignored by git).

## 2. Set up markets first

Every customer belongs to a market. Add the markets you ship to with the documents each needs:

```bash
npm run trade -- add markets --data=imports/markets.json
```

```json
[{ "code": "JP", "name": "Japan", "agreements": "CPTPP", "required_docs": "BL" },
 { "code": "AE", "name": "United Arab Emirates", "required_docs": "BL,COO" }]
```

Health certificates and permits are set on the product, not the market, so a market that takes both fruit and seafood only asks for a certificate on the seafood.

## 3. Import consignees and products

```bash
npm run trade -- import prodoc-customers --file=imports/consignees.csv --dry-run
npm run trade -- import prodoc-customers --file=imports/consignees.csv
npm run trade -- import prodoc-products --file=imports/products.csv --dry-run
npm run trade -- import prodoc-products --file=imports/products.csv
```

The dry run shows the counts and writes nothing. A code that already exists stops the whole file, so nothing half-imports. Running the same file again skips the rows it already brought in.

### Columns the import reads

Column names are matched without regard to case. The first one found wins.

| Field | Accepted column names |
|---|---|
| Customer code | Consignee Code, Customer Code, Code, Account, Customer ID |
| Customer name | Consignee Name, Customer Name, Name, Consignee |
| Country | Country Code, Country, Destination Country, Consignee Country (code or name, must match a market) |
| Address, contact, email, phone | Address, Consignee Address, Street Address; Contact, Contact Name, Attention; Email, E-mail, Contact Email; Phone, Telephone, Phone Number |
| Importer tax number | Tax ID, Importer Tax Number, VAT Number, Customs Number |
| Currency | Currency, Invoice Currency |
| Incoterm | Incoterm, Incoterms, Terms of Delivery, Delivery Terms (the first word: "CFR Tokyo" reads as CFR) |
| Payment terms | Payment Terms, Terms of Payment, Terms |
| Product code | Product Code, Item Code, Code, SKU, Product |
| Description | Description, Product Description, Goods Description, Name |
| Tariff code | HS Code, Tariff Code, Commodity Code, HS, Tariff (six to ten digits, dots allowed) |
| Unit | Unit, Package Type, Packaging, UOM |
| Weights and volume | Net Weight, Net Wt; Gross Weight, Gross Wt; Volume, CBM (per unit) |
| Origin, health certificate, storage | Country of Origin, Origin; Health Certificate, EHC, Official Assurance (Yes or No); Storage, Temperature |

See `examples/prodoc-customers.csv` and `examples/prodoc-products.csv`.

## 4. What carries over and what does not

Carries over: consignees with addresses, contacts, tax numbers, currency, incoterm and terms; products with tariff codes, weights, volume and the health certificate flag.

Does not carry over, and how to replace it:

- **Per-customer document rules.** Add them with `extra_docs` and `doc_instructions` on each customer (`/customise` or `add customers`).
- **Origin evidence.** Prodoc and TradeWindow Origin keep the certificates, not your evidence behind them. Record each product's determination with `/origin`, and the end date of the supplier declarations it rests on.
- **Document templates.** The four documents here are in `documents.json`. Change a layout or add a document type in plain language with `/customise`.
- **Electronic lodgement and messaging.** Prodoc exchanges data with customs, ports, shipping lines, forwarders and banks. This base records the entry number and the documents; it does not lodge or transmit. Your broker or forwarder keeps lodging, or Enterprise DNA connects those links into your version.
- **Shipment history.** Bring open orders across by hand with `/new-order` and `/book`. Keep Prodoc's archive for the years your records must be kept (seven in New Zealand, five in Australia), or ask for an extract.

## 5. Run both for a month

Enter each new order and booking here as well as in Prodoc. Each morning compare `/morning-check` with Prodoc's document status. When a month of shipments matches (documents needed, issued and sent, entries and credits), stop entering into Prodoc.
