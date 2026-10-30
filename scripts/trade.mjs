#!/usr/bin/env node
// The one CLI. Every slash command drives this file.
//   npm run trade -- help
//   npm run trade -- cutoffs [--json]
// Reads print aligned tables; --json prints rows for machines. Writes run in one transaction.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getDb, REPO_ROOT } from './lib/db.mjs';
import { parseCsv, pick, yesNo } from './lib/csv.mjs';
import { table } from './lib/format.mjs';

export const TABLES = ['settings', 'doc_types', 'agreements', 'markets', 'customers', 'products', 'origin_determinations', 'letters_of_credit',
  'orders', 'order_lines', 'shipments', 'documents', 'invoices', 'notes', 'import_rows'];

// Money in the row's own currency, or the base currency.
const money = (col, cur = 'currency') => `case when ${col} is null then null else ${cur} || ' ' || to_char((${col}) / 100.0, 'FM999G999G990D00') end`;
const base = (col) => money(col, '(select base_currency from trade.settings)');
const ts = (col) => `to_char(${col}, 'YYYY-MM-DD HH24:MI')`;
const LIVE = "status in ('booked', 'shipped')";

export const READS = {
  shipments: `select code, customer, country, mode, coalesce(vessel, '') vessel, ${ts('cutoff_at')} cutoff, etd, eta, status,
    docs_ready || '/' || docs_needed docs, outstanding, coalesce(export_entry_no, case when entry_required then 'needed' else 'not needed' end) export_entry
    from trade.shipment_board where ${LIVE} order by coalesce(cutoff_at, etd::timestamp)`,
  cutoffs: `select code, customer, mode, coalesce(vessel, '') vessel, ${ts('cutoff_at')} cutoff, days_to_cutoff days,
    case when export_entry_no is not null then export_entry_no when entry_required then 'lodge by ' || ${ts('entry_due_at')} else 'not needed' end export_entry,
    case when outstanding = 'BL' then '' else trim(both ', ' from replace(outstanding, 'BL', '')) end outstanding
    from trade.shipment_board where status = 'booked' and days_to_cutoff <= 14 order by cutoff_at`,
  'docs-due': `select d.shipment, b.customer, d.doc_type, d.doc_name, d.issuer, d.status, d.why, b.days_to_cutoff days_to_cutoff, b.status shipment_status
    from trade.shipment_docs d join trade.shipment_board b on b.id = d.shipment_id
    where d.status in ('missing', 'draft', 'rejected') and b.${LIVE} and not (b.status = 'booked' and d.doc_type = 'BL')
    order by b.status = 'shipped' desc, d.before_loading desc, b.days_to_cutoff, d.shipment, d.doc_type`,
  entries: `select code, customer, mode, ${base('fob_base_cents')} fob_value, ${ts('cutoff_at')} cutoff, ${ts('entry_due_at')} lodge_by,
    coalesce(export_entry_no, '') entry_no, coalesce(${ts('entry_lodged_at')}, '') lodged_at,
    case when export_entry_no is null and entry_due_at < localtimestamp then 'OVERDUE' when export_entry_no is null then 'to lodge'
      when entry_lodged_at > entry_due_at then 'lodged late' else 'lodged' end state
    from trade.shipment_board where status = 'booked' and entry_required order by entry_due_at`,
  'origin-check': `select oc.shipment, oc.agreement, oc.product, coalesce(oc.hs_code, '') hs_code, coalesce(oc.criterion, '') criterion,
    coalesce(oc.determined_on::text, '') determined_on, coalesce(oc.valid_to::text, '') valid_to, oc.problem
    from trade.origin_check oc join trade.shipments sh on sh.id = oc.shipment_id
    where sh.status = 'booked' or sh.shipped_on >= current_date - 30 order by oc.problem = '', oc.shipment, oc.product`,
  lcs: `select code, lc_number, customer, issuing_bank, ${money('amount_cents')} amount, ${money('ceiling_cents')} ceiling, ${money('drawn_cents')} drawn,
    latest_shipment_on, expiry_on, days_to_expiry, coalesce(next_present_by::text, '') present_by, status
    from trade.lc_position order by status = 'open' desc, expiry_on`,
  receivables: `select code, customer_name customer, shipment, ${money('owing_cents')} owing, ${base('owing_base_cents')} owing_base, issued_on, due_on, days_overdue
    from trade.invoice_balance where status = 'open' order by days_overdue desc, due_on`,
  payers: `select code, name, country, payment_terms, paid_invoices, coalesce(avg_days_late::text, '') avg_days_late, ${base('owing_base_cents')} owing,
    oldest_overdue_days from trade.customer_payment order by avg_days_late desc nulls last, owing_base_cents desc`,
  lanes: `select country, market, shipments, customers, ${base('fob_base_cents')} fob_value, net_kg, agreement_claims from trade.lanes order by fob_base_cents desc`,
  arrivals: `select code, customer, port_discharge, eta, days_to_eta days, coalesce(bl_no, '') bl, case when not_sent = '' then 'all sent' else not_sent end not_sent
    from trade.shipment_board where status = 'shipped' and days_to_eta <= 14 order by eta`,
  markets: `select m.code, m.name, array_to_string(m.agreements, ', ') agreements, array_to_string(m.required_docs, ', ') required_docs, coalesce(m.notes, '') notes,
    (select count(*)::int from trade.customers c where c.country = m.code) customers from trade.markets m order by m.name`,
  customers: `select c.code, c.name, c.country, c.currency, c.incoterm, c.payment_terms, array_to_string(c.extra_docs, ', ') extra_docs,
    coalesce(cp.avg_days_late::text, '') avg_days_late from trade.customers c join trade.customer_payment cp on cp.id = c.id where c.active order by c.name`,
  products: `select p.code, p.name, coalesce(p.hs_code, 'MISSING') hs_code, p.unit, p.net_kg, p.gross_kg, case when p.needs_ehc then 'yes' else '' end health_cert,
    case when p.needs_permit then 'yes' else '' end permit,
    coalesce((select string_agg(d.agreement || ' ' || d.criterion, ', ') from trade.origin_determinations d where d.product_id = p.id
      and (d.valid_to is null or d.valid_to >= current_date)), '') origin_evidence
    from trade.products p where p.active order by p.code`,
  'hs-codes': `select code, name, hs_code, checked_on, flag from (select code, name, coalesce(hs_code, 'MISSING') hs_code, coalesce(hs_checked_on::text, '') checked_on,
    case when hs_code is null or hs_code !~ '^\\d{6}' then 'no six-digit code' when hs_checked_on is null or hs_checked_on < current_date - 365 then 'check it this year' else '' end flag,
    hs_checked_on from trade.products where active) p order by flag = '', hs_checked_on nulls first`,
  agreements: `select code, name, case when self_certified then 'exporter self-certifies' else 'issued by an authority' end certification, validity_days, source
    from trade.agreements order by code`,
  'doc-types': `select code, name, issuer, case when before_loading then 'yes' else '' end before_loading from trade.doc_types order by code`,
  compliance: `select rule, severity, ref, subject, detail from trade.compliance_findings order by severity = 'breach' desc, rule, ref`,
  orders: `select o.code, c.name customer, coalesce(o.po_ref, '') po, o.ordered_on, o.incoterm, ${money('ov.invoice_cents', 'o.currency')} value,
    coalesce(o.claim_agreement, '') claim, coalesce(lc.code, '') lc, coalesce(sh.code, 'not booked') shipment, o.status
    from trade.orders o join trade.order_value ov on ov.id = o.id join trade.customers c on c.id = o.customer_id
    left join trade.letters_of_credit lc on lc.id = o.lc_id left join trade.shipments sh on sh.order_id = o.id
    where o.status = 'open' order by o.ordered_on`,
};

const ADD_FIELDS = {
  markets: ['code', 'name', 'agreements', 'required_docs', 'notes'],
  agreements: ['code', 'name', 'self_certified', 'validity_days', 'declaration', 'source'],
  doc_types: ['code', 'name', 'issuer', 'before_loading'],
  customers: ['code', 'name', 'country', 'address', 'contact', 'email', 'phone', 'tax_id', 'currency', 'incoterm', 'payment_terms', 'due_days',
    'extra_docs', 'doc_instructions'],
  products: ['code', 'name', 'hs_code', 'hs_checked_on', 'origin_country', 'unit', 'net_kg', 'gross_kg', 'cbm', 'needs_ehc', 'needs_permit', 'storage'],
  letters_of_credit: ['code', 'customer_id', 'lc_number', 'issuing_bank', 'advising_bank', 'currency', 'amount_cents', 'tolerance_pct',
    'latest_shipment_on', 'expiry_on', 'presentation_days', 'docs_required', 'partial_shipments'],
};
const REFS = { customer_id: 'customers' };
const LOOKUP = {
  customers: { label: 'customers', sql: 'select id, code, name from trade.customers' },
  products: { label: 'products', sql: 'select id, code, name from trade.products' },
  orders: { label: 'orders', sql: 'select id, code, coalesce(po_ref, code) as name from trade.orders' },
  shipments: { label: 'shipments', sql: 'select id, code, coalesce(booking_ref, code) as name from trade.shipments' },
  invoices: { label: 'invoices', sql: 'select id, code, code as name from trade.invoices' },
  lcs: { label: 'letters of credit', sql: 'select id, code, lc_number as name from trade.letters_of_credit' },
  markets: { label: 'markets', sql: 'select code as id, code, name from trade.markets' },
};

const HELP = {
  reads: [...Object.keys(READS), 'attention'].sort(),
  details: ['shipment <ref>', 'order <ref>', 'customer <ref>', 'product <ref>', 'lc <ref>', 'market <code>'],
  writes: ['add <markets|agreements|doc_types|customers|products|letters_of_credit> --data=<file.json>',
    'new-order <customer> --lines=CODE:qty:price,... [--po=] [--incoterm=] [--currency=] [--fx=] [--place=] [--freight=] [--insurance=] [--claim=] [--lc=]',
    'book <order> --mode=sea|air --cutoff=YYYY-MM-DDTHH:MM --etd= --eta= [--carrier=] [--vessel=] [--booking=] [--pol=] [--pod=] [--container=] [--seal=] [--override-by=]',
    'issue <shipment> <doc type> --ref= [--on=] [--by=] [--valid-to=] [--draft]', 'send <shipment> --to= [--types=CI,PL] [--on=]',
    'enter <shipment> --entry= [--at=YYYY-MM-DDTHH:MM]', 'ship <shipment> --on= --bl= [--container=] [--override-by=]', 'arrive <shipment>',
    'cancel <shipment> --reason=', 'present <shipment> [--on=]', 'invoice <shipment> [--on=]', 'pay <invoice> --amount= [--on=]',
    'origin <product> --agreement= --criterion=WO|PE|PSR|NO --basis= --by= [--on=] [--to=]', 'hs <product> --code=',
    'log <customer|product|order|shipment|lc|market> <ref> --author= --text=',
    'import prodoc-customers|prodoc-products --file=<csv> [--dry-run]', 'export --out=<file.json>',
    'draft-weekly', 'draft-shipping-advice <shipment>', 'draft-docs-request <shipment>', 'draft-overdue <customer>'],
};

// ------------------------------------------------------------------ helpers
export function date(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw Error(`Invalid date "${v}". Use YYYY-MM-DD.`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw Error(`Invalid date "${v}".`);
  return v;
}
export function stamp(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(String(v));
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) throw Error(`Invalid time "${v}". Use YYYY-MM-DDTHH:MM.`);
  return `${date(m[1])} ${m[2]}:${m[3]}`;
}
// "129", "129.00", "$1,249.50", "USD 129" -> cents
export function cents(v, label = 'amount') {
  const s = String(v ?? '').trim().replace(/^[A-Z]{3}\s*/i, '').replace(/^[$€£¥]/, '').replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw Error(`${label} "${v}" is not an amount. Use 129 or 129.50.`);
  return Math.round(Number(s) * 100);
}
// Six to ten digits, dots and spaces allowed: "0307.32" -> "030732"
export function hsCode(v) {
  const s = String(v ?? '').replace(/[.\s]/g, '');
  if (!/^\d{6,10}$/.test(s)) throw Error(`Tariff code "${v}" needs six to ten digits (0307.32 or 030732)`);
  return s;
}
function num(v, label) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw Error(`${label} "${v}" must be a number above zero`);
  return n;
}
function parseArgs(args) {
  const pos = []; const opts = {};
  for (const a of args) {
    if (a.startsWith('--')) { const eq = a.indexOf('='); opts[eq < 0 ? a.slice(2) : a.slice(2, eq)] = eq < 0 ? true : a.slice(eq + 1); }
    else pos.push(a);
  }
  return { pos, opts };
}
function allow(opts, names) {
  for (const k of Object.keys(opts)) if (!['json', ...names].includes(k)) throw Error(`Unknown option --${k}`);
}
function need(opts, k) { if (opts[k] === undefined || opts[k] === true || String(opts[k]).trim() === '') throw Error(`--${k} is required`); return String(opts[k]).trim(); }
function noExtra(pos, n) { if (pos.length > n) throw Error(`Unexpected argument "${pos[n]}"`); }
function oneOf(v, list, label) { if (!list.includes(v)) throw Error(`${label} must be one of: ${list.join(', ')}`); return v; }

// Code, name (case insensitive), or UUID prefix. Ambiguity lists the candidates.
export async function resolve(db, kind, ref) {
  const l = LOOKUP[kind];
  if (!ref) throw Error(`Name one of the ${l.label}`);
  const rows = await db.query(`select * from (${l.sql}) t where lower(code) = lower($1) or lower(name) = lower($1) or id::text like lower($1) || '%'
    or lower(name) like '%' || lower($1) || '%' or lower(code) like lower($1) || '%'`, [ref]);
  const exact = rows.filter((r) => r.code.toLowerCase() === ref.toLowerCase() || r.name.toLowerCase() === ref.toLowerCase());
  const hits = exact.length ? exact : rows;
  if (!hits.length) throw Error(`No ${l.label} match "${ref}"`);
  if (hits.length > 1) throw Error(`Ambiguous ${l.label} "${ref}": ${hits.map((r) => `${r.code} (${r.name})`).join(', ')}`);
  return hits[0];
}
async function tx(db, fn, { dryRun = false } = {}) {
  await db.exec('BEGIN');
  try { const out = await fn(); await db.exec(dryRun ? 'ROLLBACK' : 'COMMIT'); return out; }
  catch (e) { await db.exec('ROLLBACK'); throw e; }
}
async function nextCode(db, tableName, prefix) {
  const [{ n }] = await db.query(`select coalesce(max(substring(code from '\\d+$')::int), 0) + 1 n from trade.${tableName} where code like $1 || '%'`, [prefix]);
  return `${prefix}${n}`;
}
async function note(db, type, id, author, body) {
  await db.query('insert into trade.notes (subject_type, subject_id, author, body) values ($1, $2, $3, $4)', [type, String(id), author, body]);
}
const findingsFor = (db, ref) => db.query('select rule, severity, detail from trade.compliance_findings where ref = $1 order by severity', [ref]);

// ------------------------------------------------------------------ commands
export async function run(db, argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  if (!cmd || cmd === 'help') return HELP;
  if (READS[cmd]) { allow(opts, []); noExtra(pos, 0); return db.query(READS[cmd]); }

  switch (cmd) {
    case 'attention': { allow(opts, []); noExtra(pos, 0); return attention(db); }
    case 'shipment': {
      allow(opts, []); noExtra(pos, 1);
      const s = await resolve(db, 'shipments', pos[0]);
      return {
        shipment: (await db.query(`select b.code, b.order_code, b.po_ref, b.customer_name customer, b.country, b.mode, b.carrier, b.vessel, sh.booking_ref,
          b.port_load, b.port_discharge, b.container_no, sh.seal_no, ${ts('b.cutoff_at')} cutoff, b.etd, b.eta, b.shipped_on, b.bl_no, b.status, b.incoterm,
          ${money('b.invoice_cents')} invoice_value, ${base('b.fob_base_cents')} fob_value, coalesce(b.claim_agreement, 'none') agreement_claim, coalesce(b.lc, 'none') letter_of_credit,
          coalesce(b.export_entry_no, case when b.entry_required then 'needed by ' || ${ts('b.entry_due_at')} else 'not needed' end) export_entry
          from trade.shipment_board b join trade.shipments sh on sh.id = b.id where b.id = $1`, [s.id]))[0],
        lines: await db.query(`select p.code, p.name, coalesce(p.hs_code, '') hs_code, l.qty, p.unit, ${money('l.unit_price_cents', 'o.currency')} unit_price,
          ${money('round(l.qty * l.unit_price_cents)', 'o.currency')} line_value, round(l.qty * p.net_kg, 1) net_kg, round(l.qty * p.gross_kg, 1) gross_kg
          from trade.shipments sh join trade.orders o on o.id = sh.order_id join trade.order_lines l on l.order_id = o.id join trade.products p on p.id = l.product_id
          where sh.id = $1 order by l.created_at, p.code`, [s.id]),
        documents: await db.query(`select doc_type, doc_name, issuer, status, coalesce(ref_no, '') ref, coalesce(issued_on::text, '') issued_on,
          coalesce(sent_on::text, '') sent_on, why from trade.shipment_docs where shipment_id = $1 order by doc_type`, [s.id]),
        origin: await db.query("select product, coalesce(hs_code, '') hs_code, coalesce(criterion, '') criterion, problem from trade.origin_check where shipment_id = $1", [s.id]),
        rule_findings: await findingsFor(db, `shipment ${s.code}`),
        notes: await db.query("select created_at, author, body from trade.notes where subject_type = 'shipment' and subject_id = $1 order by created_at", [s.id]),
      };
    }
    case 'order': {
      allow(opts, []); noExtra(pos, 1);
      const o = await resolve(db, 'orders', pos[0]);
      return {
        order: (await db.query(`select o.code, c.name customer, o.po_ref, o.ordered_on, o.incoterm, o.named_place, o.currency, o.fx_rate,
          ${money('ov.goods_cents', 'o.currency')} goods, ${money('o.freight_cents', 'o.currency')} freight, ${money('o.insurance_cents', 'o.currency')} insurance,
          ${money('ov.invoice_cents', 'o.currency')} invoice_total, ${base('ov.fob_base_cents')} fob_value, ov.packages, ov.net_kg, ov.gross_kg, ov.cbm,
          coalesce(o.claim_agreement, 'none') claim, coalesce(lc.code, 'none') lc, o.status
          from trade.orders o join trade.order_value ov on ov.id = o.id join trade.customers c on c.id = o.customer_id
          left join trade.letters_of_credit lc on lc.id = o.lc_id where o.id = $1`, [o.id]))[0],
        lines: await db.query(`select p.code, p.name, l.qty, p.unit, ${money('l.unit_price_cents', 'o.currency')} unit_price
          from trade.order_lines l join trade.products p on p.id = l.product_id join trade.orders o on o.id = l.order_id where l.order_id = $1 order by l.created_at`, [o.id]),
        shipment: await db.query('select code, mode, vessel, etd, status from trade.shipments where order_id = $1', [o.id]),
      };
    }
    case 'customer': {
      allow(opts, []); noExtra(pos, 1);
      const c = await resolve(db, 'customers', pos[0]);
      return {
        customer: (await db.query(`select c.code, c.name, c.country, m.name market, c.address, c.contact, c.email, c.phone, c.tax_id, c.currency, c.incoterm,
          c.payment_terms, array_to_string(m.required_docs || c.extra_docs, ', ') documents_asked_for, c.doc_instructions
          from trade.customers c join trade.markets m on m.code = c.country where c.id = $1`, [c.id]))[0],
        payment: (await db.query(`select paid_invoices, avg_days_late, ${base('owing_base_cents')} owing, oldest_overdue_days from trade.customer_payment where id = $1`, [c.id]))[0],
        shipments: await db.query(`select code, mode, etd, eta, status, outstanding from trade.shipment_board where customer = $1 order by etd desc limit 10`, [c.code]),
        open_invoices: await db.query(`select code, shipment, ${money('owing_cents')} owing, due_on, days_overdue from trade.invoice_balance
          where customer_id = $1 and status = 'open' order by due_on`, [c.id]),
        letters_of_credit: await db.query(`select code, lc_number, ${money('amount_cents')} amount, expiry_on, status from trade.letters_of_credit where customer_id = $1`, [c.id]),
        notes: await db.query("select created_at, author, body from trade.notes where subject_type = 'customer' and subject_id = $1 order by created_at", [c.id]),
      };
    }
    case 'product': {
      allow(opts, []); noExtra(pos, 1);
      const p = await resolve(db, 'products', pos[0]);
      return {
        product: (await db.query(`select code, name, coalesce(hs_code, 'MISSING') hs_code, hs_checked_on, origin_country, unit, net_kg, gross_kg, cbm,
          needs_ehc health_certificate, needs_permit export_permit, storage from trade.products where id = $1`, [p.id]))[0],
        origin_evidence: await db.query(`select agreement, criterion, basis, determined_on, determined_by, coalesce(valid_to::text, 'open') valid_to,
          case when valid_to < current_date then 'LAPSED' else '' end flag from trade.origin_determinations where product_id = $1 order by agreement, determined_on desc`, [p.id]),
        shipped_last_year: await db.query(`select c.country, count(*)::int shipments, sum(l.qty) qty from trade.order_lines l join trade.orders o on o.id = l.order_id
          join trade.customers c on c.id = o.customer_id join trade.shipments sh on sh.order_id = o.id
          where l.product_id = $1 and sh.status <> 'cancelled' and coalesce(sh.shipped_on, sh.etd) >= current_date - 365 group by c.country order by 2 desc`, [p.id]),
      };
    }
    case 'lc': {
      allow(opts, []); noExtra(pos, 1);
      const l = await resolve(db, 'lcs', pos[0]);
      return {
        letter_of_credit: (await db.query(`select lc.code, lc.lc_number, c.name applicant, lc.issuing_bank, lc.advising_bank, ${money('lc.amount_cents', 'lc.currency')} amount,
          lc.tolerance_pct, lc.latest_shipment_on, lc.expiry_on, lc.presentation_days, array_to_string(lc.docs_required, ', ') documents_required,
          lc.partial_shipments, lc.status from trade.letters_of_credit lc join trade.customers c on c.id = lc.customer_id where lc.id = $1`, [l.id]))[0],
        position: (await db.query(`select ${money('ceiling_cents')} ceiling, ${money('drawn_cents')} drawn, days_to_expiry, next_present_by from trade.lc_position where id = $1`, [l.id]))[0],
        shipments: await db.query(`select shipment, etd, shipped_on, present_by, days_to_present, lc_presented_on presented_on, ${money('invoice_cents')} value
          from trade.lc_shipments where lc_id = $1 and shipment is not null order by etd`, [l.id]),
        rule_findings: await db.query("select rule, severity, detail from trade.compliance_findings where ref = $1 or subject like $1 || ' %'", [l.code]),
      };
    }
    case 'market': {
      allow(opts, []); noExtra(pos, 1);
      const m = await resolve(db, 'markets', pos[0]);
      return {
        market: (await db.query(`select code, name, array_to_string(agreements, ', ') agreements, array_to_string(required_docs, ', ') required_docs, notes
          from trade.markets where code = $1`, [m.code]))[0],
        customers: await db.query(`select code, name, incoterm, payment_terms, array_to_string(extra_docs, ', ') extra_docs from trade.customers where country = $1 order by name`, [m.code]),
        agreements: await db.query('select a.code, a.name, a.self_certified, a.validity_days, a.source from trade.agreements a join trade.markets m on a.code = any(m.agreements) where m.code = $1', [m.code]),
      };
    }
    case 'add': return add(db, pos, opts);
    case 'log': {
      allow(opts, ['author', 'text']); noExtra(pos, 2);
      const kinds = { customer: 'customers', product: 'products', order: 'orders', shipment: 'shipments', lc: 'lcs', market: 'markets' };
      if (!kinds[pos[0]]) throw Error('log needs customer, product, order, shipment, lc or market first');
      const t = await resolve(db, kinds[pos[0]], pos[1]);
      await note(db, pos[0], t.id, need(opts, 'author'), need(opts, 'text'));
      return { logged: t.code, author: opts.author, text: opts.text };
    }
    case 'new-order': return newOrder(db, pos, opts);
    case 'book': return book(db, pos, opts);
    case 'issue': {
      allow(opts, ['ref', 'on', 'by', 'valid-to', 'draft']); noExtra(pos, 2);
      const s = await resolve(db, 'shipments', pos[0]);
      const type = String(pos[1] || '').toUpperCase();
      if (!(await db.query('select 1 from trade.doc_types where code = $1', [type])).length) throw Error(`Unknown document type "${pos[1]}". Run doc-types for the list.`);
      const draft = opts.draft === true;
      const [row] = await db.query(`insert into trade.documents (shipment_id, doc_type, ref_no, status, issued_on, issued_by, valid_to)
        values ($1, $2, $3, $4, case when $4 = 'draft' then null else coalesce($5::date, current_date) end, $6, $7::date)
        returning doc_type, ref_no, status, issued_on`,
        [s.id, type, need(opts, 'ref'), draft ? 'draft' : 'issued', opts.on ? date(opts.on) : null, opts.by || null, opts['valid-to'] ? date(opts['valid-to']) : null]);
      return { shipment: s.code, ...row, findings: await findingsFor(db, `shipment ${s.code}`) };
    }
    case 'send': {
      allow(opts, ['to', 'types', 'on']); noExtra(pos, 1);
      const s = await resolve(db, 'shipments', pos[0]);
      const types = opts.types ? String(opts.types).toUpperCase().split(',').map((x) => x.trim()).filter(Boolean) : null;
      const rows = await db.query(`update trade.documents d set status = 'sent', sent_on = coalesce($3::date, current_date), sent_to = $2
        where d.shipment_id = $1 and d.status = 'issued' and ($4::text[] is null or d.doc_type = any($4::text[]))
        and d.id in (select document_id from trade.shipment_docs where shipment_id = $1) returning doc_type`,
        [s.id, need(opts, 'to'), opts.on ? date(opts.on) : null, types]);
      if (!rows.length) throw Error(`${s.code} has no issued documents${types ? ` of type ${types.join(', ')}` : ''} to send`);
      const [b] = await db.query('select outstanding from trade.shipment_board where id = $1', [s.id]);
      return { shipment: s.code, sent: rows.map((r) => r.doc_type).sort().join(', '), to: opts.to, still_outstanding: b.outstanding };
    }
    case 'enter': {
      allow(opts, ['entry', 'at']); noExtra(pos, 1);
      const s = await resolve(db, 'shipments', pos[0]);
      const [row] = await db.query(`update trade.shipments set export_entry_no = $2, entry_lodged_at = coalesce($3::timestamp, localtimestamp(0))
        where id = $1 and status in ('booked', 'shipped') returning code, export_entry_no, ${ts('entry_lodged_at')} lodged_at`, [s.id, need(opts, 'entry'), opts.at ? stamp(opts.at) : null]);
      if (!row) throw Error(`${s.code} is not booked`);
      const [late] = await db.query(`select entry_lodged_at > entry_due_at late, ${ts('entry_due_at')} due from trade.shipment_board where id = $1`, [s.id]);
      return { ...row, lodge_by: late.due, late: late.late ? 'yes: after the lodgement time' : 'no' };
    }
    case 'ship': return ship(db, pos, opts);
    case 'arrive': {
      allow(opts, []); noExtra(pos, 1);
      const s = await resolve(db, 'shipments', pos[0]);
      const [row] = await db.query("update trade.shipments set status = 'arrived' where id = $1 and status = 'shipped' returning code, status", [s.id]);
      if (!row) throw Error(`${s.code} has not shipped`);
      return row;
    }
    case 'cancel': {
      allow(opts, ['reason']); noExtra(pos, 1);
      const s = await resolve(db, 'shipments', pos[0]);
      const [row] = await db.query("update trade.shipments set status = 'cancelled', cancel_reason = $2 where id = $1 and status = 'booked' returning code, status, cancel_reason",
        [s.id, need(opts, 'reason')]);
      if (!row) throw Error(`${s.code} is not booked: only a booking that has not sailed can be cancelled`);
      return row;
    }
    case 'present': {
      allow(opts, ['on']); noExtra(pos, 1);
      const s = await resolve(db, 'shipments', pos[0]);
      return tx(db, async () => {
        const [l] = await db.query('select lc, present_by, shipped_on, lc_presented_on from trade.lc_shipments where shipment_id = $1', [s.id]);
        if (!l) throw Error(`${s.code} is not under a letter of credit`);
        if (!l.shipped_on) throw Error(`${s.code} has not shipped: documents go to the bank after loading`);
        if (l.lc_presented_on) throw Error(`${s.code} was presented on ${l.lc_presented_on}`);
        const on = opts.on ? date(opts.on) : (await db.query('select current_date::text d'))[0].d;
        await db.query('update trade.shipments set lc_presented_on = $2 where id = $1', [s.id, on]);
        const [left] = await db.query('select count(*)::int n from trade.lc_shipments where lc = $1 and lc_presented_on is null', [l.lc]);
        if (!left.n) await db.query("update trade.letters_of_credit set status = 'presented' where code = $1 and status = 'open'", [l.lc]);
        return { shipment: s.code, lc: l.lc, presented_on: on, last_day: l.present_by, late: on > l.present_by ? 'yes' : 'no' };
      });
    }
    case 'invoice': {
      allow(opts, ['on']); noExtra(pos, 1);
      const s = await resolve(db, 'shipments', pos[0]);
      const [r] = await db.query(`select sh.status, o.customer_id, o.currency, o.fx_rate, ov.invoice_cents, coalesce(c.due_days, st.invoice_due_days) due_days
        from trade.shipments sh join trade.orders o on o.id = sh.order_id join trade.order_value ov on ov.id = o.id join trade.customers c on c.id = o.customer_id
        cross join trade.settings st where sh.id = $1`, [s.id]);
      if (r.status === 'cancelled') throw Error(`${s.code} is cancelled`);
      if ((await db.query('select 1 from trade.invoices where shipment_id = $1', [s.id])).length) throw Error(`${s.code} is already invoiced`);
      const [row] = await db.query(`insert into trade.invoices (code, shipment_id, customer_id, currency, fx_rate, amount_cents, issued_on, due_on)
        values ($1, $2, $3, $4, $5, $6, coalesce($7::date, current_date), coalesce($7::date, current_date) + $8::int)
        returning code, ${money('amount_cents')} amount, issued_on, due_on`,
        [`INV-${s.code.replace(/^S-/, '')}`, s.id, r.customer_id, r.currency, r.fx_rate, r.invoice_cents, opts.on ? date(opts.on) : null, r.due_days]);
      return row;
    }
    case 'pay': {
      allow(opts, ['amount', 'on']); noExtra(pos, 1);
      const i = await resolve(db, 'invoices', pos[0]);
      const amount = cents(need(opts, 'amount'));
      if (amount <= 0) throw Error('--amount must be above zero');
      return tx(db, async () => {
        const [b] = await db.query('select owing_cents, currency, status from trade.invoice_balance where id = $1', [i.id]);
        if (b.status !== 'open') throw Error(`${i.code} is not open`);
        if (amount > Number(b.owing_cents)) throw Error(`${i.code} has ${b.currency} ${(Number(b.owing_cents) / 100).toFixed(2)} owing; that payment is more than that`);
        const left = Number(b.owing_cents) - amount;
        await db.query(`update trade.invoices set paid_cents = paid_cents + $2, paid_on = coalesce($3::date, current_date),
          status = case when $4::bigint = 0 then 'paid' else status end where id = $1`, [i.id, amount, opts.on ? date(opts.on) : null, left]);
        return { invoice: i.code, paid: `${b.currency} ${(amount / 100).toFixed(2)}`, still_owing: `${b.currency} ${(left / 100).toFixed(2)}` };
      });
    }
    case 'origin': {
      allow(opts, ['agreement', 'criterion', 'basis', 'by', 'on', 'to']); noExtra(pos, 1);
      const p = await resolve(db, 'products', pos[0]);
      const agreement = need(opts, 'agreement').toUpperCase();
      if (!(await db.query('select 1 from trade.agreements where code = $1', [agreement])).length) throw Error(`Unknown agreement "${opts.agreement}". Run agreements for the list.`);
      const criterion = oneOf(need(opts, 'criterion').toUpperCase(), ['WO', 'PE', 'PSR', 'NO'], '--criterion');
      const [row] = await db.query(`insert into trade.origin_determinations (product_id, agreement, criterion, basis, determined_on, determined_by, valid_to)
        values ($1, $2, $3, $4, coalesce($5::date, current_date), $6, $7::date) returning agreement, criterion, determined_on, valid_to`,
        [p.id, agreement, criterion, need(opts, 'basis'), opts.on ? date(opts.on) : null, need(opts, 'by'), opts.to ? date(opts.to) : null]);
      return { product: p.code, ...row };
    }
    case 'hs': {
      allow(opts, ['code']); noExtra(pos, 1);
      const p = await resolve(db, 'products', pos[0]);
      const [row] = await db.query('update trade.products set hs_code = $2, hs_checked_on = current_date where id = $1 returning code, hs_code, hs_checked_on', [p.id, hsCode(need(opts, 'code'))]);
      return row;
    }
    case 'import': return importCsv(db, pos, opts);
    case 'export': {
      allow(opts, ['out']); noExtra(pos, 0);
      const out = need(opts, 'out');
      const data = { exported_at: new Date().toISOString(), tables: {} };
      for (const t of TABLES) data.tables[t] = await db.query(`select * from trade.${t}`);
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(data, null, 2));
      return { file: out, tables: TABLES.length, rows: Object.values(data.tables).reduce((n, r) => n + r.length, 0) };
    }
    case 'draft-weekly': { allow(opts, []); noExtra(pos, 0); return draftWeekly(db); }
    case 'draft-shipping-advice': { allow(opts, []); noExtra(pos, 1); return draftShippingAdvice(db, pos[0]); }
    case 'draft-docs-request': { allow(opts, []); noExtra(pos, 1); return draftDocsRequest(db, pos[0]); }
    case 'draft-overdue': { allow(opts, []); noExtra(pos, 1); return draftOverdue(db, pos[0]); }
    default: throw Error(`Unknown command "${cmd}". Run help for the list.`);
  }
}

const ARRAYS = ['agreements', 'required_docs', 'extra_docs', 'docs_required'];
async function add(db, pos, opts) {
  allow(opts, ['data']); noExtra(pos, 1);
  const kind = pos[0];
  if (!ADD_FIELDS[kind]) throw Error(`add needs one of: ${Object.keys(ADD_FIELDS).join(', ')}`);
  const raw = JSON.parse(fs.readFileSync(need(opts, 'data'), 'utf8'));
  const rows = Array.isArray(raw) ? raw : [raw];
  return tx(db, async () => {
    const added = [];
    for (const r of rows) {
      const cols = []; const vals = [];
      for (const [k, v] of Object.entries(r)) {
        const key = k === 'customer' ? 'customer_id' : k;
        if (!ADD_FIELDS[kind].includes(key)) throw Error(`${kind} has no field "${k}". Fields: ${ADD_FIELDS[kind].join(', ')}`);
        cols.push(key);
        if (REFS[key]) vals.push((await resolve(db, REFS[key], String(v))).id);
        else if (key === 'hs_code' && v) vals.push(hsCode(v));
        else if (ARRAYS.includes(key)) vals.push(Array.isArray(v) ? v.map((x) => String(x).toUpperCase()) : String(v).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
        else vals.push(v);
      }
      const [row] = await db.query(`insert into trade.${kind} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning code`, vals);
      added.push(row.code);
    }
    return { added: kind, codes: added };
  });
}

// "GLM-HS-1KG:1600:48.50,APL-CHIP-1KG:300" -> lines. The price is per unit in the order currency.
function parseLines(text) {
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [code, n, price] = s.split(':').map((x) => x?.trim());
    if (!code || !n || !price) throw Error(`Cannot read line "${s}". Use CODE:qty:price`);
    return { code, qty: num(n, `${code} quantity`), price: cents(price, `${code} price`) };
  });
}
async function newOrder(db, pos, opts) {
  allow(opts, ['lines', 'po', 'incoterm', 'currency', 'fx', 'place', 'freight', 'insurance', 'claim', 'lc']); noExtra(pos, 1);
  const c = await resolve(db, 'customers', pos[0]);
  const lines = parseLines(need(opts, 'lines'));
  return tx(db, async () => {
    const [cust] = await db.query(`select c.currency, c.incoterm, c.country, m.agreements from trade.customers c join trade.markets m on m.code = c.country where c.id = $1`, [c.id]);
    const claim = opts.claim ? String(opts.claim).toUpperCase() : null;
    if (claim && !cust.agreements.includes(claim)) throw Error(`${claim} is not in force with ${cust.country} in the markets table (${cust.agreements.join(', ') || 'none'})`);
    const lc = opts.lc ? await resolve(db, 'lcs', String(opts.lc)) : null;
    const code = await nextCode(db, 'orders', 'O-');
    const [o] = await db.query(`insert into trade.orders (code, customer_id, po_ref, currency, fx_rate, incoterm, named_place, freight_cents, insurance_cents, claim_agreement, lc_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id, code`,
      [code, c.id, opts.po || null, String(opts.currency || cust.currency).toUpperCase(), opts.fx ? num(opts.fx, '--fx') : 1, String(opts.incoterm || cust.incoterm).toUpperCase(),
        opts.place || null, opts.freight ? cents(opts.freight, '--freight') : 0, opts.insurance ? cents(opts.insurance, '--insurance') : 0, claim, lc?.id || null]);
    for (const l of lines) {
      const p = await resolve(db, 'products', l.code);
      await db.query('insert into trade.order_lines (order_id, product_id, qty, unit_price_cents) values ($1, $2, $3, $4)', [o.id, p.id, l.qty, l.price]);
    }
    const [v] = await db.query(`select ${money('invoice_cents')} invoice_total, ${base('fob_base_cents')} fob_value, packages, gross_kg from trade.order_value where id = $1`, [o.id]);
    return { order: o.code, customer: c.code, lines: lines.length, ...v, next: `book ${o.code} --mode= --cutoff= --etd= --eta=` };
  });
}
async function book(db, pos, opts) {
  allow(opts, ['mode', 'cutoff', 'etd', 'eta', 'carrier', 'vessel', 'booking', 'pol', 'pod', 'container', 'seal', 'override-by']); noExtra(pos, 1);
  const o = await resolve(db, 'orders', pos[0]);
  const mode = oneOf(need(opts, 'mode'), ['sea', 'air'], '--mode');
  const etd = date(need(opts, 'etd'));
  const eta = date(need(opts, 'eta'));
  if (eta < etd) throw Error('--eta is before --etd');
  return tx(db, async () => {
    const [ord] = await db.query("select o.status, lc.code lc, lc.latest_shipment_on::text latest, lc.expiry_on::text expiry from trade.orders o left join trade.letters_of_credit lc on lc.id = o.lc_id where o.id = $1", [o.id]);
    if (ord.status !== 'open') throw Error(`${o.code} is ${ord.status}`);
    if ((await db.query("select 1 from trade.shipments where order_id = $1 and status <> 'cancelled'", [o.id])).length) throw Error(`${o.code} is already booked`);
    if (ord.lc && etd > ord.latest && !opts['override-by'])
      throw Error(`${o.code} is under ${ord.lc}, whose latest shipment date is ${ord.latest}. Sailing ${etd} breaks the credit: ask the buyer to amend it, or book with --override-by=<who accepts it>.`);
    // A cancelled booking keeps its code and history; the order books again under a new one.
    const code = await nextCode(db, 'shipments', 'S-');
    const [s] = await db.query(`insert into trade.shipments (code, order_id, mode, carrier, vessel, booking_ref, port_load, port_discharge, container_no, seal_no, cutoff_at, etd, eta, override_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamp, $12, $13, $14) returning id, code`,
      [code, o.id, mode, opts.carrier || null, opts.vessel || null, opts.booking || null, opts.pol || null, opts.pod || null, opts.container || null, opts.seal || null,
        stamp(need(opts, 'cutoff')), etd, eta, opts['override-by'] || null]);
    if (opts['override-by']) await note(db, 'shipment', s.id, String(opts['override-by']), `Booked to sail ${etd}, after the ${ord.latest} latest shipment date on ${ord.lc}. Accepted by ${opts['override-by']}.`);
    const [b] = await db.query(`select outstanding, case when entry_required then 'lodge by ' || ${ts('entry_due_at')} else 'not needed' end export_entry from trade.shipment_board where id = $1`, [s.id]);
    return { shipment: s.code, order: o.code, documents_needed: b.outstanding, export_entry: b.export_entry };
  });
}
async function ship(db, pos, opts) {
  allow(opts, ['on', 'bl', 'container', 'override-by']); noExtra(pos, 1);
  const s = await resolve(db, 'shipments', pos[0]);
  const on = date(need(opts, 'on'));
  const bl = need(opts, 'bl');
  return tx(db, async () => {
    const [b] = await db.query('select status, entry_required, export_entry_no, carrier from trade.shipment_board where id = $1', [s.id]);
    if (b.status !== 'booked') throw Error(`${s.code} is ${b.status}`);
    const blocks = [];
    if (b.entry_required && !b.export_entry_no) blocks.push('no export entry recorded (run enter first)');
    for (const d of await db.query("select doc_type, doc_name, status from trade.shipment_docs where shipment_id = $1 and before_loading and status not in ('issued', 'sent')", [s.id]))
      blocks.push(`${d.doc_name} is ${d.status}`);
    if (blocks.length && !opts['override-by']) throw Error(`${s.code} cannot be loaded: ${blocks.join('; ')}. Fix it, or record who accepts it with --override-by.`);
    await db.query(`update trade.shipments set status = 'shipped', shipped_on = $2, bl_no = $3, container_no = coalesce($4, container_no), override_by = coalesce($5, override_by)
      where id = $1`, [s.id, on, bl, opts.container || null, opts['override-by'] || null]);
    await db.query("update trade.orders set status = 'shipped' where id = (select order_id from trade.shipments where id = $1)", [s.id]);
    if (!(await db.query("select 1 from trade.documents where shipment_id = $1 and doc_type = 'BL' and status <> 'rejected'", [s.id])).length)
      await db.query("insert into trade.documents (shipment_id, doc_type, ref_no, status, issued_on, issued_by) values ($1, 'BL', $2, 'issued', $3, $4)", [s.id, bl, on, b.carrier]);
    if (blocks.length) await note(db, 'shipment', s.id, String(opts['override-by']), `Loaded with: ${blocks.join('; ')}. Accepted by ${opts['override-by']}.`);
    const [after] = await db.query(`select outstanding, not_sent, coalesce((select present_by::text from trade.lc_shipments where shipment_id = $1), '') lc_present_by
      from trade.shipment_board where id = $1`, [s.id]);
    return { shipment: s.code, shipped_on: on, bl, still_outstanding: after.outstanding, not_yet_sent: after.not_sent,
      ...(after.lc_present_by ? { present_to_bank_by: after.lc_present_by } : {}), next: after.lc_present_by ? 'present the documents to the bank' : 'draft-shipping-advice' };
  });
}

// ------------------------------------------------------------------ import from TradeWindow Prodoc
// Prodoc keeps its consignees and products as static data; save each list from Prodoc (or the ERP behind it) as CSV.
const CUSTOMER_COLUMNS = {
  code: ['Consignee Code', 'Customer Code', 'Code', 'Account', 'Customer ID'], name: ['Consignee Name', 'Customer Name', 'Name', 'Consignee'],
  country: ['Country Code', 'Country', 'Destination Country', 'Consignee Country'], address: ['Address', 'Consignee Address', 'Street Address'],
  contact: ['Contact', 'Contact Name', 'Attention'], email: ['Email', 'E-mail', 'Contact Email'], phone: ['Phone', 'Telephone', 'Phone Number'],
  tax: ['Tax ID', 'Importer Tax Number', 'VAT Number', 'Customs Number'], currency: ['Currency', 'Invoice Currency'],
  incoterm: ['Incoterm', 'Incoterms', 'Terms of Delivery', 'Delivery Terms'], terms: ['Payment Terms', 'Terms of Payment', 'Terms'],
};
export function mapCustomerRow(r, n) {
  const get = (k) => pick(r, ...CUSTOMER_COLUMNS[k]);
  const code = get('code'); const name = get('name'); const country = get('country');
  if (!code || !name) throw Error(`Row ${n}: consignee code and name are required`);
  if (!country) throw Error(`Row ${n}: country is required`);
  const inco = get('incoterm').toUpperCase().split(/\s/)[0];
  return { code, name, country, address: get('address') || null, contact: get('contact') || null, email: get('email') || null, phone: get('phone') || null,
    tax_id: get('tax') || null, currency: (get('currency') || 'USD').toUpperCase().slice(0, 3), incoterm: inco || 'FOB', payment_terms: get('terms') || 'TT 30 days' };
}
const PRODUCT_COLUMNS = {
  code: ['Product Code', 'Item Code', 'Code', 'SKU', 'Product'], name: ['Description', 'Product Description', 'Goods Description', 'Name'],
  hs: ['HS Code', 'Tariff Code', 'Commodity Code', 'HS', 'Tariff'], unit: ['Unit', 'Package Type', 'Packaging', 'UOM'],
  net: ['Net Weight', 'Net Wt', 'Net Weight (kg)', 'Net kg'], gross: ['Gross Weight', 'Gross Wt', 'Gross Weight (kg)', 'Gross kg'],
  cbm: ['Volume', 'CBM', 'Cubic Metres', 'Volume (m3)'], origin: ['Country of Origin', 'Origin', 'Origin Country'],
  ehc: ['Health Certificate', 'EHC', 'Needs EHC', 'Official Assurance'], storage: ['Storage', 'Temperature', 'Temp'],
};
export function mapProductRow(r, n) {
  const get = (k) => pick(r, ...PRODUCT_COLUMNS[k]);
  const code = get('code'); const name = get('name');
  if (!code || !name) throw Error(`Row ${n}: product code and description are required`);
  const weight = (v, label) => { if (v === '') return 0; const x = Number(String(v).replace(/,/g, '').replace(/\s?kg$/i, '')); if (!Number.isFinite(x) || x < 0) throw Error(`Row ${n}: ${label} "${v}" is not a number`); return x; };
  let hs = null;
  if (get('hs')) { try { hs = hsCode(get('hs')); } catch { throw Error(`Row ${n}: HS code "${get('hs')}" needs six to ten digits`); } }
  return { code, name, hs_code: hs, unit: (get('unit') || 'carton').toLowerCase(), net_kg: weight(get('net'), 'net weight'), gross_kg: weight(get('gross'), 'gross weight'),
    cbm: weight(get('cbm'), 'volume'), origin_country: (get('origin') || 'NZ').toUpperCase().slice(0, 2), needs_ehc: yesNo(get('ehc')), storage: get('storage').toLowerCase() || null };
}
async function importCsv(db, pos, opts) {
  allow(opts, ['file', 'dry-run']); noExtra(pos, 1);
  const kind = oneOf(pos[0], ['prodoc-customers', 'prodoc-products'], 'import');
  const file = need(opts, 'file');
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) throw Error('The file has no rows');
  const mapped = rows.map((r, i) => (kind === 'prodoc-customers' ? mapCustomerRow(r, i + 2) : mapProductRow(r, i + 2)));
  const dryRun = opts['dry-run'] === true;
  return tx(db, async () => {
    const result = { file: path.basename(file), rows: rows.length, inserted: 0, skipped_identical: 0, without_hs_code: 0, dry_run: dryRun };
    for (let i = 0; i < mapped.length; i++) {
      const m = mapped[i];
      const hash = crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');
      if ((await db.query('select 1 from trade.import_rows where source = $1 and row_hash = $2', [kind, hash])).length) { result.skipped_identical++; continue; }
      let id;
      if (kind === 'prodoc-customers') {
        if ((await db.query('select 1 from trade.customers where lower(code) = lower($1)', [m.code])).length) throw Error(`Row ${i + 2}: customer ${m.code} already exists. Nothing was imported.`);
        const [mk] = await db.query('select code from trade.markets where lower(code) = lower($1) or lower(name) = lower($1)', [m.country]);
        if (!mk) throw Error(`Row ${i + 2}: no market "${m.country}". Add it first (add markets). Nothing was imported.`);
        [{ id }] = await db.query(`insert into trade.customers (code, name, country, address, contact, email, phone, tax_id, currency, incoterm, payment_terms)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [m.code, m.name, mk.code, m.address, m.contact, m.email, m.phone, m.tax_id, m.currency, m.incoterm, m.payment_terms]);
      } else {
        if ((await db.query('select 1 from trade.products where lower(code) = lower($1)', [m.code])).length) throw Error(`Row ${i + 2}: product ${m.code} already exists. Nothing was imported.`);
        [{ id }] = await db.query(`insert into trade.products (code, name, hs_code, unit, net_kg, gross_kg, cbm, origin_country, needs_ehc, storage)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [m.code, m.name, m.hs_code, m.unit, m.net_kg, m.gross_kg, m.cbm, m.origin_country, m.needs_ehc, m.storage]);
        if (!m.hs_code) result.without_hs_code++;
      }
      result.inserted++;
      await db.query('insert into trade.import_rows (source, file_name, row_number, row_hash, target_id) values ($1, $2, $3, $4, $5)', [kind, path.basename(file), i + 2, hash, id]);
    }
    return result;
  }, { dryRun });
}

// ------------------------------------------------------------------ attention
async function attention(db) {
  const out = [];
  const push = (area, item, why, next) => out.push({ area, item, why, next });
  const FIX = {
    'export-entry': 'lodge the export entry, then /enter', 'before-loading': 'apply for it now; the goods cannot load without it',
    origin: 'record the tariff code (/hs) or the origin evidence (/origin), or drop the claim', 'origin-validity': 'issue a fresh certification of origin',
    'certifier-details': "add the certifier's details in settings", documents: '/draft-docs-request', 'lc-shipment-date': 'ask the buyer to amend the credit before it sails',
    'lc-presentation': 'present the documents to the bank, then /present', 'lc-amount': 'ask for an amendment or split the order', 'documents-to-customer': '/send, then /draft-shipping-advice',
  };
  for (const r of await db.query("select rule, ref, subject, detail from trade.compliance_findings where severity = 'breach' order by rule"))
    push('rules', r.ref, `${r.rule}: ${r.detail}`, FIX[r.rule] || '/compliance');
  for (const r of await db.query("select code, customer, cutoff_at, outstanding, days_to_cutoff from trade.shipment_board, trade.settings st where status = 'booked' and days_to_cutoff between 0 and st.cutoff_warn_days order by cutoff_at"))
    push('cut-off', r.code, `${r.customer} cut-off in ${r.days_to_cutoff === 1 ? '1 day' : `${r.days_to_cutoff} days`}${r.outstanding ? `; outstanding: ${r.outstanding}` : ''}`, '/docs-due');
  for (const r of await db.query("select rule, ref, subject, detail from trade.compliance_findings where severity = 'warning' order by rule"))
    push('rules', r.ref, `${r.rule}: ${r.detail}`, FIX[r.rule] || '/compliance');
  for (const r of await db.query(`select code, customer_name, ${money('owing_cents')} owing, days_overdue from trade.invoice_balance where status = 'open' and days_overdue > 0 order by days_overdue desc`))
    push('money', r.code, `${r.customer_name} owes ${r.owing}, ${r.days_overdue} days overdue`, '/draft-overdue');
  return out;
}

// ------------------------------------------------------------------ drafts (never sent)
function draftsDir() { const d = path.resolve(process.env.OUTPUT_DIR || REPO_ROOT, 'drafts'); fs.mkdirSync(d, { recursive: true }); return d; }
function md(rows) {
  if (!rows.length) return '_None._\n';
  const keys = Object.keys(rows[0]);
  return [`| ${keys.join(' | ')} |`, `| ${keys.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${keys.map((k) => String(r[k] ?? '').replace(/\|/g, '/')).join(' | ')} |`)].join('\n') + '\n';
}
async function today(db) { return (await db.query('select current_date::text today'))[0].today; }
const first = (s) => String(s || '').split(/[\s,]/)[0];
async function draftWeekly(db) {
  const d = await today(db);
  const body = [`# Export desk review, week of ${d}`, '',
    'Draft for the Monday meeting. Figures come from the database at the time of writing. Nothing has been sent.', '',
    '## What needs attention', md(await attention(db)),
    '## Cut-offs in the next 14 days', md(await db.query(READS.cutoffs)),
    '## Documents outstanding', md(await db.query(READS['docs-due'])),
    '## Letters of credit', md(await db.query(READS.lcs)),
    '## Money owed', md(await db.query(READS.receivables)),
    '## Rule checks', md(await db.query(READS.compliance))].join('\n');
  const file = path.join(draftsDir(), `weekly-review-${d}.md`);
  fs.writeFileSync(file, body);
  return { draft: file, sections: 6 };
}
async function draftShippingAdvice(db, ref) {
  const s = await resolve(db, 'shipments', ref);
  const [r] = await db.query(`select b.*, c.contact, st.business_name, st.certifier_name from trade.shipment_board b join trade.orders o on o.code = b.order_code
    join trade.customers c on c.id = o.customer_id cross join trade.settings st where b.id = $1`, [s.id]);
  if (r.status === 'booked' || r.status === 'cancelled') throw Error(`${r.code} is ${r.status}: shipping advice goes once the goods are on board`);
  const docs = await db.query("select doc_name, coalesce(ref_no, '') ref, status from trade.shipment_docs where shipment_id = $1 order by doc_type", [s.id]);
  const [inv] = await db.query(`select code, ${money('amount_cents')} amount, due_on from trade.invoices where shipment_id = $1`, [s.id]);
  const body = [`Subject: Shipping advice ${r.code}, your order ${r.po_ref || r.order_code}`, '', `Hi ${first(r.contact || r.customer_name)},`, '',
    `Your order ${r.po_ref || r.order_code} is on board.`, '',
    `- Vessel or flight: ${r.vessel || ''} (${r.carrier || ''})`, `- ${r.mode === 'air' ? 'Air waybill' : 'Bill of lading'}: ${r.bl_no || ''}`,
    r.container_no ? `- Container: ${r.container_no}` : '', `- From ${r.port_load || ''} on ${r.shipped_on}, arriving ${r.port_discharge || ''} about ${r.eta}`, '',
    'Documents:', ...docs.map((d) => `- ${d.doc_name}${d.ref ? ` ${d.ref}` : ''}${['missing', 'draft'].includes(d.status) ? ' (to follow)' : ''}`), '',
    inv ? `Invoice ${inv.code} for ${inv.amount} is due ${inv.due_on}.` : '', '', r.certifier_name || '', r.business_name, '']
    .filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
  const file = path.join(draftsDir(), `shipping-advice-${r.code}-${await today(db)}.md`);
  fs.writeFileSync(file, body);
  return { draft: file, shipment: r.code, documents_to_follow: docs.filter((d) => ['missing', 'draft'].includes(d.status)).length };
}
async function draftDocsRequest(db, ref) {
  const s = await resolve(db, 'shipments', ref);
  const [r] = await db.query('select b.code, b.vessel, b.etd, b.cutoff_at, b.port_discharge, b.customer_name, st.business_name, st.certifier_name from trade.shipment_board b cross join trade.settings st where b.id = $1', [s.id]);
  const docs = await db.query(`select doc_type, doc_name, issuer, status from trade.shipment_docs where shipment_id = $1 and status in ('missing', 'draft', 'rejected')
    and issuer <> 'us' and doc_type <> 'BL' order by issuer, doc_type`, [s.id]);
  if (!docs.length) throw Error(`${r.code} is not waiting on anyone else's documents`);
  const lines = await db.query(`select p.name, l.qty, p.unit, coalesce(p.hs_code, '') hs_code, round(l.qty * p.net_kg, 1) net_kg from trade.shipments sh
    join trade.order_lines l on l.order_id = sh.order_id join trade.products p on p.id = l.product_id where sh.id = $1 order by l.created_at`, [s.id]);
  const byIssuer = {};
  for (const d of docs) (byIssuer[d.issuer] ||= []).push(d);
  const parts = Object.entries(byIssuer).map(([issuer, list]) => [`## To the ${issuer}`, '', 'Hi,', '',
    `Please issue the following for shipment ${r.code}, ${r.customer_name}, on ${r.vessel || 'the booked sailing'} to ${r.port_discharge || ''}. Cargo cut-off is ${String(r.cutoff_at).slice(0, 16)}.`, '',
    ...list.map((d) => `- ${d.doc_name}${d.status === 'draft' ? ' (we have a draft; please finalise)' : ''}`), '', 'The goods:', md(lines),
    'Thanks,', r.certifier_name || '', r.business_name, ''].join('\n'));
  const file = path.join(draftsDir(), `docs-request-${r.code}-${await today(db)}.md`);
  fs.writeFileSync(file, parts.join('\n'));
  return { draft: file, shipment: r.code, documents: docs.map((d) => d.doc_type).join(', ') };
}
async function draftOverdue(db, ref) {
  const c = await resolve(db, 'customers', ref);
  const [cust] = await db.query('select contact, name, (select business_name from trade.settings) seller from trade.customers where id = $1', [c.id]);
  const inv = await db.query(`select code, shipment, issued_on, due_on, ${money('owing_cents')} owing, days_overdue from trade.invoice_balance
    where customer_id = $1 and status = 'open' and days_overdue > 0 order by due_on`, [c.id]);
  if (!inv.length) throw Error(`${c.code} has nothing overdue`);
  const body = [`Hi ${first(cust.contact || cust.name)},`, '', `Our records show these ${cust.seller} invoices past their due date:`, '',
    md(inv.map((i) => ({ invoice: i.code, shipment: i.shipment, issued: i.issued_on, due: i.due_on, owing: i.owing, days_overdue: i.days_overdue }))),
    'Please arrange payment, or let me know the date it will be sent. The next shipment releases once the account is up to date.', ''].join('\n');
  const file = path.join(draftsDir(), `overdue-${c.code}-${await today(db)}.md`);
  fs.writeFileSync(file, body);
  return { draft: file, customer: c.code, invoices: inv.length };
}

// ------------------------------------------------------------------ main
function print(out) {
  if (Array.isArray(out)) {
    if (!out.length) return console.log('  (none)');
    const keys = Object.keys(out[0]);
    return console.log(table(out, keys.map((k) => ({ key: k, label: k.replace(/_/g, ' '), width: 70,
      align: typeof out[0][k] === 'number' || /^-?\d+(\.\d+)?$/.test(String(out[0][k] ?? '')) ? 'right' : 'left' }))));
  }
  if (out && typeof out === 'object') {
    for (const [k, v] of Object.entries(out)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') { console.log(`\n${k.replace(/_/g, ' ')}`); print(v); }
      else if (Array.isArray(v) && !v.length) console.log(`\n${k.replace(/_/g, ' ')}\n  (none)`);
      else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) { console.log(`\n${k.replace(/_/g, ' ')}`); for (const [k2, v2] of Object.entries(v)) console.log(`  ${k2.replace(/_/g, ' ')}: ${v2 ?? ''}`); }
      else console.log(`${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : v ?? ''}`);
    }
  }
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const db = await getDb();
  try {
    const out = await run(db, args.filter((a) => a !== '--json'));
    if (json) console.log(JSON.stringify(out, null, 2)); else print(out);
  } catch (e) {
    console.error(e.message); process.exitCode = 1;
  } finally { await db.close(); }
}
