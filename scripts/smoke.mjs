// npm test: a temporary database, every command, the rules and the edge cases. Never touches a live database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDb, REPO_ROOT } from './lib/db.mjs';
import { migrate } from './migrate.mjs';
import { seed } from './seed.mjs';
import { run, READS, TABLES, date, stamp, cents, hsCode, mapCustomerRow, mapProductRow } from './trade.mjs';
import { parseCsv } from './lib/csv.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-test-'));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
process.env.DATA_DIR = path.join(temp, 'db');
process.env.OUTPUT_DIR = temp;
let db; let checks = 0;
const ok = (v, msg) => { assert.ok(v, msg); checks++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); checks++; };
const rejects = async (fn, re) => { await assert.rejects(fn, re); checks++; };
const file = (name, v) => { const f = path.join(temp, `${name}.json`); fs.writeFileSync(f, JSON.stringify(v)); return `--data=${f}`; };
function cli(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args], { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout); checks++;
  return r.stdout;
}
const one = async (sql, p = []) => (await db.query(sql, p))[0];
const rules = async () => (await db.query('select rule, ref, severity from trade.compliance_findings')).map((r) => `${r.rule}|${r.ref}`).sort();
const has = async (rule, ref) => (await rules()).includes(`${rule}|${ref}`);
const plus = async (days) => (await one(`select (current_date + ${Number(days)})::text d`)).d;

try {
  db = await getDb();
  if (process.env.TEST_DATABASE_URL) await db.exec('drop schema if exists trade cascade; drop table if exists schema_migrations');
  await migrate(db);
  eq((await migrate(db)).ran.length, 0, 'repeat migration is a no-op');
  await seed(db); await seed(db);
  eq((await run(db, ['customers'])).length, 5, 'seed is idempotent');
  eq((await one('select count(*)::int n from trade.order_lines')).n, 19, 'order lines seeded once');
  eq((await one('select count(*)::int n from trade.documents')).n, 35, 'documents seeded once');

  // Every read runs.
  for (const c of Object.keys(READS)) ok(Array.isArray(await run(db, [c])), c);
  eq((await run(db, ['help'])).reads.length, Object.keys(READS).length + 1, 'help lists every read');

  // Order value: goods plus freight under CFR; FOB value is the goods in the base currency.
  const ov = await one("select goods_cents, invoice_cents, fob_base_cents from trade.order_value where code = 'O-3141'");
  eq(Number(ov.goods_cents), 12074000, 'goods value');
  eq(Number(ov.invoice_cents), 12534000, 'CFR adds freight');
  eq(Number(ov.fob_base_cents), Math.round(12074000 * 1.71), 'FOB in NZD');
  eq(Number((await one("select invoice_cents from trade.order_value where code = 'O-3139'")).invoice_cents), 4674000, 'CIF adds freight and insurance');

  // Required documents come from the market, customer, credit, claim, incoterm and products.
  const req = await db.query("select doc_type, why from trade.shipment_required_docs r join trade.shipments s on s.id = r.shipment_id where s.code = 'S-2043' order by doc_type");
  eq(req.map((r) => r.doc_type).join(','), 'BL,CI,COO,EHC,INS,PL', 'credit shipment needs six documents');
  ok(req.find((r) => r.doc_type === 'INS').why.includes('incoterm'), 'insurance because CIF');
  eq((await db.query("select doc_type from trade.shipment_required_docs r join trade.shipments s on s.id = r.shipment_id where s.code = 'S-2042'")).map((r) => r.doc_type).sort().join(','),
    'BL,CI,ORIGIN,PL', 'no health certificate for fruit; origin statement for the claim');

  // The demo's rule findings, exactly.
  eq((await rules()).join(' '), ['before-loading|shipment S-2041', 'certifier-details|settings', 'documents-to-customer|shipment S-2038', 'documents|shipment S-2044',
    'entry-late|shipment S-2044', 'export-entry|shipment S-2041', 'lc-amount|LC-7002', 'lc-expiry|LC-7002', 'lc-presentation|shipment S-2039', 'lc-shipment-date|shipment S-2043',
    'origin-validity|shipment S-2042', 'origin|shipment S-2041', 'origin|shipment S-2041', 'origin|shipment S-2042', 'records|shipment S-2035'].sort().join(' '), 'demo findings');
  eq((await run(db, ['attention']))[0].area, 'rules', 'breaches first');
  const entries = await run(db, ['entries']);
  eq(entries.find((r) => r.code === 'S-2041').state, 'OVERDUE', 'entry overdue');
  eq(entries.find((r) => r.code === 'S-2044').state, 'lodged late', 'entry lodged late');
  eq(entries.find((r) => r.code === 'S-2042').lodge_by.slice(11), '23:00', 'air: nine hours before an 08:00 cut-off');
  eq((await run(db, ['origin-check'])).filter((r) => r.problem).map((r) => r.problem).sort().join('; '),
    'no origin determination; no six-digit tariff code; origin evidence lapsed ' + await plus(-30), 'origin problems');
  eq((await run(db, ['receivables']))[0].code, 'TBP-INV-3135', 'oldest debt first');
  eq((await run(db, ['payers'])).find((r) => r.code === 'KANTO').avg_days_late, '11.0', 'Kanto pays 11 days late');
  eq((await run(db, ['hs-codes']))[0].code, 'GLM-PWD-500', 'missing tariff code first');
  eq((await run(db, ['lanes']))[0].country, 'JP', 'Japan is the biggest lane');

  // Origin: fix the tariff code, then the evidence, and the findings clear.
  await rejects(async () => run(db, ['hs', 'GLM-PWD-500', '--code=21069']), /six to ten digits/);
  eq((await run(db, ['hs', 'GLM-PWD-500', '--code=2106.90'])).hs_code, '210690', 'tariff code stored without dots');
  await run(db, ['origin', 'GLM-PWD-500', '--agreement=cptpp', '--criterion=PE', '--basis=Mussels farmed in NZ; capsules local', '--by=Test']);
  await run(db, ['origin', 'MAN-UMF10-250', '--agreement=CPTPP', '--criterion=WO', '--basis=Hives in Northland', '--by=Test']);
  ok(!(await has('origin', 'shipment S-2041')), 'S-2041 origin clear');
  await rejects(async () => run(db, ['origin', 'KIWI-PUR-10', '--agreement=CPTPP', '--criterion=XX', '--basis=x', '--by=x']), /criterion/);
  await rejects(async () => run(db, ['origin', 'KIWI-PUR-10', '--agreement=RCEP', '--criterion=PE', '--basis=x', '--by=x']), /Unknown agreement/);

  // A fresh certification of origin replaces last year's blanket one.
  await run(db, ['issue', 'S-2042', 'origin', '--ref=TBP-CPTPP-3142']);
  ok(!(await has('origin-validity', 'shipment S-2042')), 'new certification clears the validity breach');
  await rejects(async () => run(db, ['issue', 'S-2042', 'XYZ', '--ref=1']), /Unknown document type/);

  // Loading: refused without the export entry and the health certificate.
  await rejects(async () => run(db, ['ship', 'S-2041', `--on=${await plus(3)}`, '--bl=ONEY1']), /no export entry recorded.*Export health certificate is missing/);
  const ent = await run(db, ['enter', 'S-2041', '--entry=NZE-TEST-1']);
  eq(ent.late, 'yes: after the lodgement time', 'entry after the lodgement time is marked late');
  ok(await has('entry-late', 'shipment S-2041'), 'late entry stays on the record');
  await rejects(async () => run(db, ['ship', 'S-2041', `--on=${await plus(3)}`, '--bl=ONEY1']), /Export health certificate is missing/);
  await run(db, ['issue', 'S-2041', 'EHC', '--ref=MPI-EHC-TEST', '--by=MPI']);
  ok(!(await has('before-loading', 'shipment S-2041')), 'health certificate clears');
  const shipped = await run(db, ['ship', 'S-2041', `--on=${await plus(3)}`, '--bl=ONEYNSN0961X']);
  eq(shipped.still_outstanding, '', 'nothing outstanding after loading (bill of lading recorded)');
  eq((await one("select status from trade.orders where code = 'O-3141'")).status, 'shipped', 'order shipped');
  eq((await one("select ref_no from trade.documents d join trade.shipments s on s.id = d.shipment_id where s.code = 'S-2041' and d.doc_type = 'BL'")).ref_no, 'ONEYNSN0961X', 'bill of lading on file');
  await rejects(async () => run(db, ['ship', 'S-2041', `--on=${await plus(3)}`, '--bl=X']), /is shipped/);

  // Documents to the customer, the shipping advice, the invoice and payment.
  eq((await run(db, ['send', 'S-2041', '--to=Kanto Seafood'])).sent, 'BL, CI, EHC, ORIGIN, PL', 'documents sent');
  await rejects(async () => run(db, ['send', 'S-2041', '--to=Kanto']), /no issued documents/);
  const advice = fs.readFileSync((await run(db, ['draft-shipping-advice', 'S-2041'])).draft, 'utf8');
  ok(advice.includes('ONEYNSN0961X') && advice.includes('KST-2324'), 'shipping advice names the bill of lading and their order');
  await rejects(async () => run(db, ['draft-shipping-advice', 'S-2040']), /on board/);
  const inv = await run(db, ['invoice', 'S-2041']);
  eq(inv.code, 'INV-2041', 'invoice numbered from the shipment');
  eq(inv.due_on, await plus(30), 'due on Kanto terms');
  await rejects(async () => run(db, ['invoice', 'S-2041']), /already invoiced/);
  await rejects(async () => run(db, ['pay', 'INV-2041', '--amount=999999']), /more than that/);
  eq((await run(db, ['pay', 'INV-2041', '--amount=125,000'])).still_owing, 'USD 340.00', 'part payment');
  await run(db, ['pay', 'INV-2041', '--amount=340']);
  eq((await one("select status from trade.invoices where code = 'INV-2041'")).status, 'paid', 'paid in full');
  await run(db, ['arrive', 'S-2041']);
  await rejects(async () => run(db, ['arrive', 'S-2040']), /has not shipped/);

  // Shipping advice clears the documents-to-customer warning once sent.
  await run(db, ['send', 'S-2038', '--to=Pacific Gourmet']);
  ok(!(await has('documents-to-customer', 'shipment S-2038')), 'documents with the customer');

  // Letters of credit: presentation, latest shipment date, amount.
  const pres = await run(db, ['present', 'S-2039']);
  eq(pres.late, 'no', 'presented in time');
  ok(!(await has('lc-presentation', 'shipment S-2039')), 'presentation clears');
  eq((await one("select status from trade.letters_of_credit where code = 'LC-7001'")).status, 'presented', 'credit fully presented');
  await rejects(async () => run(db, ['present', 'S-2039']), /was presented/);
  await rejects(async () => run(db, ['present', 'S-2040']), /not under a letter of credit/);
  await run(db, ['cancel', 'S-2043', '--reason=Buyer amending the credit']);
  ok(!(await has('lc-shipment-date', 'shipment S-2043')), 'cancelled booking drops off');
  await rejects(async () => run(db, ['book', 'O-3143', '--mode=sea', `--cutoff=${await plus(8)}T16:00`, `--etd=${await plus(10)}`, `--eta=${await plus(42)}`]), /latest shipment date/);
  const rebook = await run(db, ['book', 'O-3143', '--mode=sea', `--cutoff=${await plus(8)}T16:00`, `--etd=${await plus(10)}`, `--eta=${await plus(42)}`, '--override-by=Aroha Mitchell']);
  eq(rebook.shipment, 'S-2045', 'rebooked under a new code');
  ok(rebook.documents_needed.includes('INS'), 'rebooking lists what is needed');
  ok(await has('lc-shipment-date', 'shipment S-2045'), 'override is recorded, the finding stays');
  eq((await one("select count(*)::int n from trade.notes where body like '%Accepted by Aroha Mitchell%'")).n, 1, 'override noted');
  ok(await has('lc-amount', 'LC-7002'), 'credit amount still exceeded');
  await rejects(async () => run(db, ['book', 'O-3143', '--mode=sea', `--cutoff=${await plus(8)}T16:00`, `--etd=${await plus(10)}`, `--eta=${await plus(42)}`, '--override-by=x']), /already booked/);

  // New order: lines, claim checked against the market, booking, the export entry due time.
  await rejects(async () => run(db, ['new-order', 'SHOH', '--lines=GLM-HS-1KG:100:47', '--claim=CPTPP']), /not in force with CN/);
  await rejects(async () => run(db, ['new-order', 'SHOH', '--lines=GLM-HS-1KG:100']), /CODE:qty:price/);
  const no = await run(db, ['new-order', 'LION', '--lines=APL-CHIP-1KG:50:51,KIWI-PUR-10:20:63', '--fx=1.3', '--claim=CPTPP', '--po=LCP-1000']);
  eq(no.order, 'O-3145', 'order numbered');
  eq(no.invoice_total, 'SGD 3,810.00', 'order total in its own currency');
  const bk = await run(db, ['book', no.order, '--mode=air', `--cutoff=${await plus(2)}T08:00`, `--etd=${await plus(2)}`, `--eta=${await plus(3)}`]);
  eq(bk.export_entry, `lodge by ${await plus(1)} 23:00`, 'air entry nine hours before cut-off');
  ok(await has('origin', `shipment ${bk.shipment}`), 'lapsed kiwifruit evidence caught on the new booking');
  await rejects(async () => run(db, ['book', no.order, '--mode=rail', '--cutoff=2026-01-01T10:00', '--etd=2026-01-01', '--eta=2026-01-02']), /mode/);

  // A controlled product needs a permit before loading.
  await run(db, ['add', 'products', file('permit', [{ code: 'NV-CAM', name: 'Marine thermal camera', hs_code: '8525.89', needs_permit: true }])]);
  const po = await run(db, ['new-order', 'PACG', '--lines=NV-CAM:2:4800']);
  const pb = await run(db, ['book', po.order, '--mode=air', `--cutoff=${await plus(1)}T08:00`, `--etd=${await plus(1)}`, `--eta=${await plus(2)}`]);
  ok(pb.documents_needed.includes('PERMIT'), 'permit required');
  ok(await has('before-loading', `shipment ${pb.shipment}`), 'permit missing before loading');
  ok(await has('export-entry', `shipment ${pb.shipment}`), 'entry needed above the threshold');
  await run(db, ['enter', pb.shipment, '--entry=NZE-P1', `--at=${await plus(-1)}T09:00`]);
  await rejects(async () => run(db, ['ship', pb.shipment, `--on=${await plus(1)}`, '--bl=618-1']), /Export permit is missing/);
  ok((await run(db, ['ship', pb.shipment, `--on=${await plus(1)}`, '--bl=618-1', '--override-by=Test Manager'])).shipped_on, 'override loads it');
  ok((await one('select override_by from trade.shipments where code = $1', [pb.shipment])).override_by === 'Test Manager', 'override recorded on the shipment');

  // Below the threshold: no entry needed.
  const small = await run(db, ['new-order', 'PACG', '--lines=APL-CHIP-1KG:10:37', '--fx=1.7']);
  const sb = await run(db, ['book', small.order, '--mode=air', `--cutoff=${await plus(5)}T08:00`, `--etd=${await plus(5)}`, `--eta=${await plus(6)}`]);
  eq(sb.export_entry, 'not needed', 'under NZ$1,000 FOB no full entry');

  // The certifier's details.
  await db.query("update trade.settings set certifier_phone = '+64 3 555 0199'");
  ok(!(await has('certifier-details', 'settings')), 'certifier details complete');

  // Adds, logs, look-ups.
  eq((await run(db, ['add', 'markets', file('mk', [{ code: 'KR', name: 'South Korea', required_docs: 'bl, ehc' }])])).codes[0], 'KR', 'market added');
  eq((await one("select array_to_string(required_docs, ',') d from trade.markets where code = 'KR'")).d, 'BL,EHC', 'docs upper-cased');
  await rejects(async () => run(db, ['add', 'markets', file('bad', [{ code: 'XX', colour: 'red' }])]), /no field "colour"/);
  await run(db, ['add', 'letters_of_credit', file('lc', [{ code: 'LC-9', customer: 'GULF', lc_number: 'N1', issuing_bank: 'Bank', currency: 'USD', amount_cents: 100000, latest_shipment_on: await plus(30), expiry_on: await plus(45) }])]);
  eq((await run(db, ['lc', 'LC-9'])).letter_of_credit.applicant, 'Gulf Fine Foods LLC', 'credit added against its customer');
  eq((await run(db, ['log', 'shipment', 'S-2040', '--author=Test', '--text=Called ONE about space'])).logged, 'S-2040', 'note logged');
  await rejects(async () => run(db, ['log', 'truck', 'x', '--author=a', '--text=b']), /log needs/);
  eq((await run(db, ['shipment', 'S-2040'])).notes.length, 1, 'note on the shipment');
  eq((await run(db, ['customer', 'kanto'])).customer.code, 'KANTO', 'case-insensitive name match');
  eq((await run(db, ['market', 'jp'])).agreements[0].code, 'CPTPP', 'market agreements');
  ok((await run(db, ['product', 'GLM-HS'])).origin_evidence.length >= 1, 'partial code match');
  await rejects(async () => run(db, ['shipment', 'S-20']), /Ambiguous shipments/);
  await rejects(async () => run(db, ['customer', 'Nobody Ltd']), /No customers match/);
  eq((await run(db, ['order', 'O-3140'])).lines.length, 2, 'order lines');

  // Import from TradeWindow Prodoc exports.
  const custCsv = path.join(temp, 'customers.csv');
  fs.copyFileSync(path.join(REPO_ROOT, 'examples', 'prodoc-customers.csv'), custCsv);
  const dry = await run(db, ['import', 'prodoc-customers', `--file=${custCsv}`, '--dry-run']);
  eq(dry.inserted, 3, 'dry run counts');
  eq((await one("select count(*)::int n from trade.customers where code like 'PD%'")).n, 0, 'dry run writes nothing');
  eq((await run(db, ['import', 'prodoc-customers', `--file=${custCsv}`])).inserted, 3, 'customers imported');
  eq((await run(db, ['import', 'prodoc-customers', `--file=${custCsv}`])).skipped_identical, 3, 're-run skips');
  eq((await one("select country, incoterm from trade.customers where code = 'PD1002'")).country, 'SG', 'country name matched to its market');
  eq((await one("select incoterm from trade.customers where code = 'PD1001'")).incoterm, 'CFR', 'incoterm read from "CFR Tokyo"');
  const prodCsv = path.join(temp, 'products.csv');
  fs.copyFileSync(path.join(REPO_ROOT, 'examples', 'prodoc-products.csv'), prodCsv);
  const pr = await run(db, ['import', 'prodoc-products', `--file=${prodCsv}`]);
  eq(pr.inserted, 4, 'products imported');
  eq(pr.without_hs_code, 1, 'products without a tariff code counted');
  eq((await one("select hs_code, needs_ehc from trade.products where code = 'PD-GLM-2KG'")).hs_code, '030732', 'tariff code read');
  fs.writeFileSync(path.join(temp, 'clash.csv'), 'Consignee Code,Consignee Name,Country\nPD9,Fine,JP\nKANTO,Clash,JP\n');
  await rejects(async () => run(db, ['import', 'prodoc-customers', `--file=${path.join(temp, 'clash.csv')}`]), /KANTO already exists/);
  eq((await one("select count(*)::int n from trade.customers where code = 'PD9'")).n, 0, 'clash rolls back the whole file');
  fs.writeFileSync(path.join(temp, 'nomarket.csv'), 'Consignee Code,Consignee Name,Country\nPD8,Far Away,Narnia\n');
  await rejects(async () => run(db, ['import', 'prodoc-customers', `--file=${path.join(temp, 'nomarket.csv')}`]), /no market "Narnia"/);
  await assert.rejects(async () => mapProductRow({ 'Product Code': 'X', Description: 'Y', 'HS Code': '12' }, 2), /HS code "12"/); checks++;
  await assert.rejects(async () => mapCustomerRow({ 'Consignee Code': 'X', 'Consignee Name': 'Y' }, 2), /country is required/); checks++;
  eq(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')[0].b, 'say "hi"', 'csv quoting');

  // Drafts never send; they land in drafts/.
  const req2 = fs.readFileSync((await run(db, ['draft-docs-request', 'S-2044'])).draft, 'utf8');
  ok(req2.includes('To the chamber') && req2.includes('finalise'), 'documents request to the chamber');
  await rejects(async () => run(db, ['draft-docs-request', 'S-2041']), /not waiting/);
  ok(fs.readFileSync((await run(db, ['draft-overdue', 'PACG'])).draft, 'utf8').includes('TBP-INV-3135'), 'overdue letter');
  await rejects(async () => run(db, ['draft-overdue', 'KANTO']), /nothing overdue/);
  eq((await run(db, ['draft-weekly'])).sections, 6, 'weekly review drafted');

  // Export covers every table.
  const ex = await run(db, ['export', `--out=${path.join(temp, 'export.json')}`]);
  eq(ex.tables, TABLES.length, 'every table exported');

  // Helpers and argument checks.
  eq(cents('$1,249.50'), 124950, 'cents parse');
  eq(hsCode('0307.32'), '030732', 'tariff code parse');
  eq(stamp('2026-11-02T16:00'), '2026-11-02 16:00', 'time parse');
  await assert.rejects(async () => date('2026-02-30'), /Invalid date/); checks++;
  await assert.rejects(async () => stamp('2026-11-02 25:00'), /Invalid time/); checks++;
  await rejects(async () => run(db, ['cutoffs', '--colour=red']), /Unknown option/);
  await rejects(async () => run(db, ['nonsense']), /Unknown command/);

  // The CLI, views and documents run as a person would run them.
  await db.close(); db = null;
  ok(cli('trade.mjs', ['attention']).includes('area'), 'CLI prints a table');
  ok(JSON.parse(cli('trade.mjs', ['cutoffs', '--json'])).length >= 1, 'CLI --json');
  ok(cli('view.mjs').includes('view:'), 'views render');
  ok(cli('docs.mjs').includes('document(s) rendered'), 'documents render');
  for (const v of JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'views.json'), 'utf8'))) ok(fs.existsSync(path.join(temp, 'views', `${v.name}.html`)), `view ${v.name} written`);
  for (const d of JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'documents.json'), 'utf8'))) ok(fs.readdirSync(path.join(temp, 'docs-out', d.name)).length >= 1, `${d.name} written`);

  console.log(`PASS: ${checks} checks`);
} finally {
  if (db) await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
