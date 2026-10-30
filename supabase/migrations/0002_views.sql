-- The views every weekly command reads. Read-only; change them in a new migration.

-- "1 day", "3 days".
create or replace function trade.days(n int) returns text language sql immutable as $$
  select n || case when abs(n) = 1 then ' day' else ' days' end $$;

-- Order totals. Line prices are the goods price; freight and insurance go on the invoice under C and D terms.
-- FOB value (for the export entry threshold) is the goods value, converted to the base currency.
create view trade.order_value as
select o.id, o.code, o.customer_id, o.currency, o.fx_rate, o.incoterm, o.claim_agreement, o.lc_id, o.status,
  coalesce(sum(round(l.qty * l.unit_price_cents)), 0)::bigint goods_cents,
  (coalesce(sum(round(l.qty * l.unit_price_cents)), 0)
    + case when o.incoterm in ('CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP') then o.freight_cents else 0 end
    + case when o.incoterm in ('CIF', 'CIP') then o.insurance_cents else 0 end)::bigint invoice_cents,
  round(coalesce(sum(round(l.qty * l.unit_price_cents)), 0) * o.fx_rate)::bigint fob_base_cents,
  coalesce(sum(l.qty), 0) packages,
  round(coalesce(sum(l.qty * p.net_kg), 0), 1) net_kg,
  round(coalesce(sum(l.qty * p.gross_kg), 0), 1) gross_kg,
  round(coalesce(sum(l.qty * p.cbm), 0), 2) cbm
from trade.orders o
left join trade.order_lines l on l.order_id = o.id
left join trade.products p on p.id = l.product_id
group by o.id;

-- Every document each shipment needs, and why: the market, the customer, the letter of credit,
-- the agreement claimed, the incoterm, or a product that needs a health certificate or permit.
create view trade.shipment_required_docs as
with s as (
  select sh.id shipment_id, o.id order_id, o.incoterm, o.claim_agreement, o.lc_id, c.extra_docs, m.required_docs, a.self_certified
  from trade.shipments sh
  join trade.orders o on o.id = sh.order_id
  join trade.customers c on c.id = o.customer_id
  left join trade.markets m on m.code = c.country
  left join trade.agreements a on a.code = o.claim_agreement
  where sh.status <> 'cancelled'
)
select shipment_id, doc_type, string_agg(distinct why, ', ' order by why) why from (
  select shipment_id, unnest(array['CI', 'PL']) doc_type, 'every shipment' why from s
  union all select shipment_id, unnest(required_docs), 'market' from s
  union all select shipment_id, unnest(extra_docs), 'customer' from s
  union all select s.shipment_id, unnest(lc.docs_required), 'letter of credit' from s join trade.letters_of_credit lc on lc.id = s.lc_id
  union all select shipment_id, 'ORIGIN', 'agreement claim' from s where claim_agreement is not null and self_certified
  union all select shipment_id, 'COO', 'agreement claim' from s where claim_agreement is not null and not self_certified
  union all select shipment_id, 'INS', 'incoterm' from s where incoterm in ('CIF', 'CIP')
  union all select distinct s.shipment_id, 'EHC', 'product' from s join trade.order_lines l on l.order_id = s.order_id
    join trade.products p on p.id = l.product_id where p.needs_ehc
  union all select distinct s.shipment_id, 'PERMIT', 'product' from s join trade.order_lines l on l.order_id = s.order_id
    join trade.products p on p.id = l.product_id where p.needs_permit
) x
group by shipment_id, doc_type;

-- Each required document against what is on file (the latest record of that type).
create view trade.shipment_docs as
select r.shipment_id, sh.code shipment, r.doc_type, dt.name doc_name, dt.issuer, dt.before_loading, r.why,
  d.id document_id, coalesce(d.status, 'missing') status, d.ref_no, d.issued_on, d.valid_to, d.sent_on, d.sent_to
from trade.shipment_required_docs r
join trade.shipments sh on sh.id = r.shipment_id
join trade.doc_types dt on dt.code = r.doc_type
left join lateral (
  select * from trade.documents d where d.shipment_id = r.shipment_id and d.doc_type = r.doc_type order by d.created_at desc limit 1
) d on true;

-- One row per shipment: where it is, what it is worth, what is still outstanding, and the export entry deadline.
create view trade.shipment_board as
select sh.id, sh.code, o.code order_code, o.po_ref, c.code customer, c.name customer_name, c.country, sh.mode, sh.carrier, sh.vessel,
  sh.port_load, sh.port_discharge, sh.container_no, sh.cutoff_at, sh.etd, sh.eta, sh.shipped_on, sh.bl_no, sh.status,
  o.currency, ov.invoice_cents, ov.fob_base_cents, o.incoterm, o.claim_agreement, lc.code lc,
  ov.fob_base_cents > st.entry_threshold_cents entry_required, sh.export_entry_no, sh.entry_lodged_at,
  coalesce(sh.cutoff_at, sh.etd::timestamp) - make_interval(hours => case sh.mode when 'sea' then st.sea_entry_hours else st.air_entry_hours end) entry_due_at,
  (coalesce(sh.cutoff_at::date, sh.etd) - current_date) days_to_cutoff,
  (sh.eta - current_date) days_to_eta,
  (select count(*)::int from trade.shipment_docs d where d.shipment_id = sh.id) docs_needed,
  (select count(*)::int from trade.shipment_docs d where d.shipment_id = sh.id and d.status in ('issued', 'sent')) docs_ready,
  coalesce((select string_agg(d.doc_type, ', ' order by d.doc_type) from trade.shipment_docs d
    where d.shipment_id = sh.id and d.status in ('missing', 'draft', 'rejected')), '') outstanding,
  coalesce((select string_agg(d.doc_type, ', ' order by d.doc_type) from trade.shipment_docs d
    where d.shipment_id = sh.id and d.status <> 'sent' and d.issuer <> 'regulator'), '') not_sent
from trade.shipments sh
join trade.orders o on o.id = sh.order_id
join trade.order_value ov on ov.id = o.id
join trade.customers c on c.id = o.customer_id
left join trade.letters_of_credit lc on lc.id = o.lc_id
cross join trade.settings st;

-- Origin: every line on a shipment that claims an agreement, against the product's tariff code and its origin evidence
-- on the day it ships.
create view trade.origin_check as
select sh.id shipment_id, sh.code shipment, o.claim_agreement agreement, p.id product_id, p.code product, p.name product_name, p.hs_code,
  od.criterion, od.basis, od.determined_on, od.valid_to,
  case
    when coalesce(p.hs_code, '') !~ '^\d{6}' then 'no six-digit tariff code'
    when od.id is null and lapsed.id is not null then 'origin evidence lapsed ' || lapsed.valid_to
    when od.id is null then 'no origin determination'
    when od.criterion = 'NO' then 'recorded as not originating'
    else ''
  end problem
from trade.shipments sh
join trade.orders o on o.id = sh.order_id and o.claim_agreement is not null
join trade.order_lines l on l.order_id = o.id
join trade.products p on p.id = l.product_id
left join lateral (
  select * from trade.origin_determinations d where d.product_id = p.id and d.agreement = o.claim_agreement
    and d.determined_on <= coalesce(sh.shipped_on, sh.etd, current_date) and (d.valid_to is null or d.valid_to >= coalesce(sh.shipped_on, sh.etd, current_date))
  order by d.determined_on desc limit 1
) od on true
left join lateral (
  select * from trade.origin_determinations d where d.product_id = p.id and d.agreement = o.claim_agreement and d.valid_to < coalesce(sh.shipped_on, sh.etd, current_date)
  order by d.valid_to desc limit 1
) lapsed on true
where sh.status <> 'cancelled';

-- Letters of credit: each shipment drawn under a credit, with the date documents must reach the bank.
create view trade.lc_shipments as
select lc.id lc_id, lc.code lc, lc.lc_number, c.name customer, lc.issuing_bank, lc.currency, lc.amount_cents, lc.tolerance_pct,
  lc.latest_shipment_on, lc.expiry_on, lc.presentation_days, lc.status lc_status,
  sh.id shipment_id, sh.code shipment, sh.etd, sh.shipped_on, sh.lc_presented_on, ov.invoice_cents,
  case when sh.shipped_on is not null then least(lc.expiry_on, sh.shipped_on + lc.presentation_days) end present_by,
  case when sh.shipped_on is not null then least(lc.expiry_on, sh.shipped_on + lc.presentation_days) - current_date end days_to_present
from trade.letters_of_credit lc
join trade.customers c on c.id = lc.customer_id
left join trade.orders o on o.lc_id = lc.id and o.status <> 'cancelled'
left join trade.order_value ov on ov.id = o.id
left join trade.shipments sh on sh.order_id = o.id and sh.status <> 'cancelled';

create view trade.lc_position as
select lc.id, lc.code, lc.lc_number, c.name customer, lc.issuing_bank, lc.currency, lc.amount_cents,
  round(lc.amount_cents * (1 + lc.tolerance_pct / 100.0))::bigint ceiling_cents,
  coalesce((select sum(ov.invoice_cents) from trade.orders o join trade.order_value ov on ov.id = o.id where o.lc_id = lc.id and o.status <> 'cancelled'), 0)::bigint drawn_cents,
  lc.latest_shipment_on, lc.expiry_on, lc.expiry_on - current_date days_to_expiry, lc.presentation_days, lc.status,
  (select min(s.present_by) from trade.lc_shipments s where s.lc_id = lc.id and s.lc_presented_on is null) next_present_by
from trade.letters_of_credit lc
join trade.customers c on c.id = lc.customer_id;

-- Invoices: what is owed, in the order currency and the base currency, and how late.
create view trade.invoice_balance as
select i.id, i.code, i.customer_id, c.code customer, c.name customer_name, sh.code shipment, i.currency, i.amount_cents, i.paid_cents,
  i.amount_cents - i.paid_cents owing_cents, round((i.amount_cents - i.paid_cents) * i.fx_rate)::bigint owing_base_cents,
  i.issued_on, i.due_on, greatest(current_date - i.due_on, 0) days_overdue, i.paid_on, i.status
from trade.invoices i
join trade.customers c on c.id = i.customer_id
join trade.shipments sh on sh.id = i.shipment_id;

-- How each customer pays: average days late on paid invoices in the last year.
create view trade.customer_payment as
select c.id, c.code, c.name, c.country, c.payment_terms,
  count(i.id) filter (where i.status = 'paid' and i.paid_on >= current_date - 365)::int paid_invoices,
  round(avg(i.paid_on - i.due_on) filter (where i.status = 'paid' and i.paid_on >= current_date - 365), 1) avg_days_late,
  coalesce(sum(round((i.amount_cents - i.paid_cents) * i.fx_rate)) filter (where i.status = 'open'), 0)::bigint owing_base_cents,
  coalesce(max(greatest(current_date - i.due_on, 0)) filter (where i.status = 'open'), 0)::int oldest_overdue_days
from trade.customers c
left join trade.invoices i on i.customer_id = c.id
group by c.id;

-- Trade lanes over the last year: where the goods went and what they were worth.
create view trade.lanes as
select c.country, m.name market, count(sh.id)::int shipments, count(distinct c.id)::int customers,
  coalesce(sum(ov.fob_base_cents), 0)::bigint fob_base_cents, coalesce(sum(ov.net_kg), 0) net_kg,
  count(sh.id) filter (where o.claim_agreement is not null)::int agreement_claims
from trade.shipments sh
join trade.orders o on o.id = sh.order_id
join trade.order_value ov on ov.id = o.id
join trade.customers c on c.id = o.customer_id
join trade.markets m on m.code = c.country
where sh.status <> 'cancelled' and coalesce(sh.shipped_on, sh.etd) >= current_date - 365
group by c.country, m.name;

-- Rule findings. Each rule and its source is in docs/compliance.md.
create view trade.compliance_findings as
-- The export entry: required above the threshold, lodged before loading.
select 'export-entry' rule, case when b.entry_due_at < localtimestamp or b.status <> 'booked' then 'breach' else 'warning' end severity,
  'shipment ' || b.code ref, b.customer_name subject,
  case when b.status <> 'booked' then 'shipped with no export entry recorded (FOB ' || st.base_currency || ' ' || to_char(b.fob_base_cents / 100.0, 'FM999G999G990D00') || ')'
    else 'no export entry; lodge by ' || to_char(b.entry_due_at, 'YYYY-MM-DD HH24:MI') || ' (FOB ' || st.base_currency || ' ' || to_char(b.fob_base_cents / 100.0, 'FM999G999G990D00') || ')' end detail
from trade.shipment_board b cross join trade.settings st
where b.entry_required and b.export_entry_no is null and b.status in ('booked', 'shipped') and b.entry_due_at < localtimestamp + interval '48 hours'
union all
select 'entry-late', 'warning', 'shipment ' || b.code, b.customer_name,
  'entry lodged ' || to_char(b.entry_lodged_at, 'YYYY-MM-DD HH24:MI') || ', after the ' || to_char(b.entry_due_at, 'YYYY-MM-DD HH24:MI') || ' lodgement time'
from trade.shipment_board b where b.entry_lodged_at > b.entry_due_at and b.status = 'booked'
union all
-- Origin: a claimed preference needs a tariff code and origin evidence for every line.
select 'origin', 'breach', 'shipment ' || oc.shipment, oc.product || ' ' || oc.product_name, oc.agreement || ' claimed: ' || oc.problem
from trade.origin_check oc join trade.shipments sh on sh.id = oc.shipment_id
where oc.problem <> '' and (sh.status = 'booked' or sh.shipped_on >= current_date - 30)
union all
-- A certification of origin used after its validity.
select 'origin-validity', 'breach', 'shipment ' || sh.code, d.ref_no,
  d.doc_type || ' issued ' || d.issued_on || ' is valid to ' || coalesce(least(d.valid_to, d.issued_on + a.validity_days), d.issued_on + a.validity_days)
    || ', before the ' || coalesce(sh.shipped_on, sh.etd) || ' shipment'
from trade.shipments sh
join trade.orders o on o.id = sh.order_id
join trade.agreements a on a.code = o.claim_agreement
join trade.shipment_docs d on d.shipment_id = sh.id and d.doc_type in ('ORIGIN', 'COO') and d.issued_on is not null
where sh.status <> 'cancelled' and coalesce(least(d.valid_to, d.issued_on + a.validity_days), d.issued_on + a.validity_days) < coalesce(sh.shipped_on, sh.etd)
  and (sh.status = 'booked' or sh.shipped_on >= current_date - 30)
union all
-- The certifier's details a self-certified claim must carry.
select 'certifier-details', 'breach', 'settings', st.business_name, 'certifications of origin need the certifier''s name, address, phone and email; missing: ' ||
  concat_ws(', ', case when st.certifier_name is null then 'name' end, case when st.business_address is null then 'address' end,
    case when st.certifier_phone is null then 'phone' end, case when st.certifier_email is null then 'email' end)
from trade.settings st
where (st.certifier_name is null or st.business_address is null or st.certifier_phone is null or st.certifier_email is null)
  and exists (select 1 from trade.shipments sh join trade.orders o on o.id = sh.order_id join trade.agreements a on a.code = o.claim_agreement
    where a.self_certified and sh.status = 'booked')
union all
-- Health certificates and permits before loading; the rest before the cut-off.
select case when d.before_loading then 'before-loading' else 'documents' end,
  case when d.before_loading or b.status <> 'booked' then 'breach' else 'warning' end,
  'shipment ' || b.code, b.customer_name,
  d.doc_name || ' (' || d.doc_type || ') ' || d.status || case when b.status = 'booked' then ', cut-off in ' || trade.days(b.days_to_cutoff) else ', and the goods have shipped' end
from trade.shipment_board b join trade.shipment_docs d on d.shipment_id = b.id cross join trade.settings st
where d.status in ('missing', 'draft', 'rejected')
  and ((b.status = 'booked' and b.days_to_cutoff <= st.cutoff_warn_days and d.doc_type <> 'BL')
    or (b.status = 'shipped' and b.shipped_on >= current_date - 30 and (d.before_loading or d.issuer = 'us')))
union all
-- Documents not with the customer before the goods arrive: the importer cannot clear them.
select 'documents-to-customer', 'warning', 'shipment ' || b.code, b.customer_name,
  'arrives ' || b.eta || ' (' || trade.days(b.days_to_eta) || '); not yet sent: ' || b.not_sent
from trade.shipment_board b cross join trade.settings st
where b.status = 'shipped' and b.not_sent <> '' and b.days_to_eta <= st.arrival_warn_days and b.lc is null
union all
-- Letters of credit: ship by the latest shipment date, present within the period and before expiry, stay inside the amount.
select 'lc-shipment-date', 'breach', 'shipment ' || s.shipment, s.lc || ' ' || s.customer,
  case when s.shipped_on is not null then 'shipped ' || s.shipped_on else 'booked to sail ' || s.etd end || ', after the latest shipment date ' || s.latest_shipment_on
from trade.lc_shipments s where s.shipment is not null and coalesce(s.shipped_on, s.etd) > s.latest_shipment_on and s.lc_status = 'open'
union all
select 'lc-presentation', case when s.days_to_present < 0 then 'breach' else 'warning' end, 'shipment ' || s.shipment, s.lc || ' ' || s.customer,
  case when s.days_to_present < 0 then 'documents not presented; the last day was ' || s.present_by
    else 'present documents to the bank by ' || s.present_by || ' (' || trade.days(s.days_to_present) || ')' end
from trade.lc_shipments s cross join trade.settings st
where s.shipped_on is not null and s.lc_presented_on is null and s.days_to_present <= st.lc_warn_days and s.lc_status = 'open'
union all
select 'lc-amount', 'breach', p.code, p.customer,
  'orders under this credit come to ' || p.currency || ' ' || to_char(p.drawn_cents / 100.0, 'FM999G999G990D00') || ', over its ceiling of ' || p.currency || ' '
    || to_char(p.ceiling_cents / 100.0, 'FM999G999G990D00')
from trade.lc_position p where p.drawn_cents > p.ceiling_cents and p.status = 'open'
union all
select 'lc-expiry', 'warning', p.code, p.customer, 'expires ' || p.expiry_on || ' (' || trade.days(p.days_to_expiry) || ') with goods still to ship'
from trade.lc_position p cross join trade.settings st
where p.status = 'open' and p.days_to_expiry <= st.lc_warn_days * 2
  and exists (select 1 from trade.lc_shipments s where s.lc_id = p.id and s.shipped_on is null)
union all
-- The records kept for the years the law asks: a shipped consignment missing a record of its own documents.
select 'records', 'warning', 'shipment ' || b.code, b.customer_name,
  'shipped ' || b.shipped_on || ' with no record of: ' || (select string_agg(d.doc_type, ', ' order by d.doc_type) from trade.shipment_docs d
    where d.shipment_id = b.id and d.status = 'missing')
from trade.shipment_board b
where b.status in ('shipped', 'arrived') and exists (select 1 from trade.shipment_docs d where d.shipment_id = b.id and d.status = 'missing')
  and b.shipped_on < current_date - 30;
