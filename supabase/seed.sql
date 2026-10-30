-- Demo data: Tasman Bay Provisions, a fictional Nelson food exporter shipping mussels, honey and fruit
-- to Japan, Singapore, the United States, the United Arab Emirates and China.
-- Every date is relative to today, so the attention list always has something to say.
-- Deliberate problems: a sea shipment one day from cut-off with no export entry and no health certificate,
-- a CPTPP claim on a product with no tariff code and another with no origin evidence, a blanket certification
-- of origin reused after its twelve months, fruit purée whose origin evidence lapsed last month, an entry lodged
-- after the lodgement time, a chamber certificate still in draft the day before cut-off, a letter of credit
-- whose latest shipment date falls before the sailing and whose amount the order exceeds, documents due at the
-- bank in three days, documents not yet sent to a customer whose goods land in four days, a shipment with no
-- packing list on file, an invoice a month overdue, and no phone number for the person who signs origin statements.
-- Safe to run twice: every insert skips rows that are already there.

update trade.settings set business_name = 'Tasman Bay Provisions Ltd', jurisdiction = 'NZ', base_currency = 'NZD',
  business_address = '22 Vickerman Street, Port Nelson, Nelson 7010, New Zealand', business_number = 'NZBN 9429000000000',
  certifier_name = 'Aroha Mitchell, Export Manager', certifier_email = 'exports@tasmanbayprovisions.example'
where id = 1 and business_name = 'Your Export Business';

insert into trade.doc_types (code, name, issuer, before_loading) values
  ('CI', 'Commercial invoice', 'us', false),
  ('PL', 'Packing list', 'us', false),
  ('BL', 'Bill of lading or air waybill', 'carrier', false),
  ('ORIGIN', 'Certification of origin (self-certified)', 'us', false),
  ('COO', 'Certificate of origin (chamber)', 'chamber', false),
  ('EHC', 'Export health certificate', 'regulator', true),
  ('PERMIT', 'Export permit', 'regulator', true),
  ('INS', 'Insurance certificate', 'insurer', false),
  ('FUM', 'Fumigation or treatment certificate', 'treatment provider', false)
on conflict (code) do nothing;

insert into trade.agreements (code, name, self_certified, validity_days, declaration, source) values
  ('CPTPP', 'Comprehensive and Progressive Agreement for Trans-Pacific Partnership', true, 365,
   'I certify that the goods described in this document qualify as originating and the information contained in this document is true and accurate. I assume responsibility for proving such representations and agree to maintain and present upon request or to make available during a verification visit, documentation necessary to support this certification.',
   'https://www.customs.govt.nz/media/yunbg2u2/information-guide-cpttp.pdf')
on conflict (code) do nothing;

insert into trade.markets (code, name, agreements, required_docs, notes) values
  ('JP', 'Japan', '{CPTPP}', '{BL}', 'Frozen shellfish and honey travel with the official health certificate (set on the product).'),
  ('SG', 'Singapore', '{CPTPP}', '{BL}', null),
  ('US', 'United States', '{}', '{BL}', 'The importer files the food prior notice.'),
  ('AE', 'United Arab Emirates', '{}', '{BL,COO}', 'Chamber certificate of origin on every consignment.'),
  ('CN', 'China', '{}', '{BL}', null),
  ('AU', 'Australia', '{}', '{BL}', null)
on conflict (code) do nothing;

insert into trade.customers (code, name, country, address, contact, email, phone, tax_id, currency, incoterm, payment_terms, due_days, extra_docs, doc_instructions) values
  ('KANTO', 'Kanto Seafood Trading KK', 'JP', '3-4-1 Tsukiji, Chuo-ku, Tokyo 104-0045, Japan', 'Kenji Watanabe', 'k.watanabe@kanto-seafood.example', '+81 3 5550 0101', 'JP-T1234567890123', 'USD', 'CFR', 'TT 30 days', 30, '{}', 'Origin statement on the commercial invoice. Two original packing lists.'),
  ('LION', 'Lion City Provisions Pte Ltd', 'SG', '18 Fishery Port Road, Singapore 619742', 'Grace Tan', 'grace@lioncity.example', '+65 6555 0102', 'SG-201912345K', 'SGD', 'FCA', 'TT 14 days', 14, '{}', null),
  ('PACG', 'Pacific Gourmet Imports Inc', 'US', '1200 S Alameda St, Los Angeles CA 90021, USA', 'Dana Ruiz', 'dana@pacificgourmet.example', '+1 213 555 0103', 'US-95-1234567', 'USD', 'FOB', 'TT 30 days', 30, '{}', 'Scan documents to Dana and the broker the day the vessel sails.'),
  ('GULF', 'Gulf Fine Foods LLC', 'AE', 'Warehouse 14, Al Quoz Industrial 3, Dubai, UAE', 'Omar Haddad', 'omar@gulffinefoods.example', '+971 4 555 0104', 'AE-100234567800003', 'USD', 'CIF', 'Letter of credit at sight', 0, '{}', 'Documents exactly as the credit lists them. No extra wording.'),
  ('SHOH', 'Shanghai Ocean Harvest Co Ltd', 'CN', '88 Yangshupu Road, Shanghai 200082, China', 'Li Wei', 'liwei@oceanharvest.example', '+86 21 5555 0105', 'CN-91310000MA1234567X', 'USD', 'CFR', 'TT 50% deposit, 50% on copy documents', 21, '{COO}', 'Chamber certificate of origin requested by their broker.')
on conflict (code) do nothing;

insert into trade.products (code, name, hs_code, hs_checked_on, unit, net_kg, gross_kg, cbm, needs_ehc, storage) values
  ('GLM-HS-1KG', 'Frozen half-shell green-lipped mussels, 10 x 1 kg', '030732', current_date - 200, 'carton', 10, 11.2, 0.028, true, 'frozen'),
  ('GLM-PWD-500', 'Freeze-dried green-lipped mussel powder, 12 x 500 g', null, null, 'carton', 6, 7.4, 0.021, true, 'ambient'),
  ('MAN-UMF10-250', 'Manuka honey UMF 10+, 24 x 250 g', '040900', current_date - 400, 'carton', 6, 9.5, 0.014, true, 'ambient'),
  ('APL-CHIP-1KG', 'Dried apple chips, 6 x 1 kg', '081330', current_date - 120, 'carton', 6, 6.8, 0.045, false, 'ambient'),
  ('KIWI-PUR-10', 'Frozen gold kiwifruit puree, 10 kg pail', '200799', current_date - 90, 'pail', 10, 10.6, 0.012, false, 'frozen')
on conflict (code) do nothing;

insert into trade.origin_determinations (product_id, agreement, criterion, basis, determined_on, determined_by, valid_to)
select p.id, d.agreement, d.criterion, d.basis, current_date + d.det, d.who, current_date + d.valid
from (values
  ('GLM-HS-1KG', 'CPTPP', 'WO', 'Farmed and harvested in Pelorus Sound, processed in Nelson. Marine farm licence and harvest records on file.', -200, 'Aroha Mitchell', null::int),
  ('APL-CHIP-1KG', 'CPTPP', 'WO', 'Apples grown in Motueka and dried in Nelson. Grower declarations for the season on file.', -120, 'Aroha Mitchell', null),
  ('KIWI-PUR-10', 'CPTPP', 'PE', 'Kiwifruit from Te Puke packhouses; sugar from a New Zealand refiner. Supplier declarations to the date shown.', -395, 'Aroha Mitchell', -30)
) d(product, agreement, criterion, basis, det, who, valid)
join trade.products p on p.code = d.product
on conflict (product_id, agreement, determined_on) do nothing;

insert into trade.letters_of_credit (code, customer_id, lc_number, issuing_bank, advising_bank, currency, amount_cents, tolerance_pct,
  latest_shipment_on, expiry_on, presentation_days, docs_required, status)
select d.code, c.id, d.num, d.bank, 'ANZ Bank New Zealand, Wellington', 'USD', d.amount, d.tol, current_date + d.latest, current_date + d.expiry, 21, '{CI,PL,BL,EHC,COO,INS}', 'open'
from (values
  ('LC-7001', 'DXB-ILC-25-0418', 'Emirates NBD, Dubai', 4600000, 5.0, -15, 14),
  ('LC-7002', 'DXB-ILC-25-0533', 'Emirates NBD, Dubai', 3000000, 0.0, 7, 8)
) d(code, num, bank, amount, tol, latest, expiry)
join trade.customers c on c.code = 'GULF'
on conflict (code) do nothing;

insert into trade.orders (code, customer_id, po_ref, ordered_on, currency, fx_rate, incoterm, named_place, freight_cents, insurance_cents, claim_agreement, lc_id, status)
select d.code, c.id, d.po, current_date + d.ordered, d.cur, d.fx, d.inco, d.place, d.freight, d.ins, d.claim, lc.id, d.status
from (values
  ('O-3135', 'PACG', 'PG-7781', -80, 'USD', 1.68, 'FOB', 'Port Nelson', 0, 0, null, null, 'shipped'),
  ('O-3136', 'KANTO', 'KST-2291', -65, 'USD', 1.68, 'CFR', 'Tokyo', 420000, 0, 'CPTPP', null, 'shipped'),
  ('O-3137', 'LION', 'LCP-0912', -40, 'SGD', 1.29, 'FCA', 'Auckland Airport', 0, 0, 'CPTPP', null, 'shipped'),
  ('O-3138', 'PACG', 'PG-7802', -30, 'USD', 1.70, 'FOB', 'Port Nelson', 0, 0, null, null, 'shipped'),
  ('O-3139', 'GULF', 'GFF-PO-118', -40, 'USD', 1.70, 'CIF', 'Jebel Ali', 380000, 24000, null, 'LC-7001', 'shipped'),
  ('O-3140', 'KANTO', 'KST-2318', -12, 'USD', 1.71, 'CFR', 'Tokyo', 420000, 0, 'CPTPP', null, 'open'),
  ('O-3141', 'KANTO', 'KST-2324', -9, 'USD', 1.71, 'CFR', 'Yokohama', 460000, 0, 'CPTPP', null, 'open'),
  ('O-3142', 'LION', 'LCP-0955', -6, 'SGD', 1.30, 'FCA', 'Auckland Airport', 0, 0, 'CPTPP', null, 'open'),
  ('O-3143', 'GULF', 'GFF-PO-131', -14, 'USD', 1.71, 'CIF', 'Jebel Ali', 390000, 26000, null, 'LC-7002', 'open'),
  ('O-3144', 'SHOH', 'SOH-5520', -10, 'USD', 1.71, 'CFR', 'Shanghai', 410000, 0, null, null, 'open')
) d(code, cust, po, ordered, cur, fx, inco, place, freight, ins, claim, lc, status)
join trade.customers c on c.code = d.cust
left join trade.letters_of_credit lc on lc.code = d.lc
on conflict (code) do nothing;

insert into trade.order_lines (order_id, product_id, qty, unit_price_cents)
select o.id, p.id, d.qty, d.price
from (values
  ('O-3135', 'GLM-HS-1KG', 1400, 4650), ('O-3135', 'MAN-UMF10-250', 120, 21600),
  ('O-3136', 'GLM-HS-1KG', 1800, 4800), ('O-3136', 'APL-CHIP-1KG', 300, 3900),
  ('O-3137', 'KIWI-PUR-10', 160, 6200),
  ('O-3138', 'GLM-HS-1KG', 1500, 4650), ('O-3138', 'APL-CHIP-1KG', 200, 3700),
  ('O-3139', 'MAN-UMF10-250', 180, 21000), ('O-3139', 'GLM-HS-1KG', 100, 4900),
  ('O-3140', 'APL-CHIP-1KG', 900, 3900), ('O-3140', 'GLM-HS-1KG', 1200, 4800),
  ('O-3141', 'GLM-HS-1KG', 1600, 4850), ('O-3141', 'GLM-PWD-500', 140, 16800), ('O-3141', 'MAN-UMF10-250', 90, 21800),
  ('O-3142', 'KIWI-PUR-10', 220, 6300), ('O-3142', 'APL-CHIP-1KG', 80, 5100),
  ('O-3143', 'MAN-UMF10-250', 130, 21000), ('O-3143', 'GLM-HS-1KG', 120, 4900),
  ('O-3144', 'GLM-HS-1KG', 1700, 4700)
) d(ord, prod, qty, price)
join trade.orders o on o.code = d.ord
join trade.products p on p.code = d.prod
where not exists (select 1 from trade.order_lines l where l.order_id = o.id and l.product_id = p.id);

insert into trade.shipments (code, order_id, mode, carrier, vessel, booking_ref, port_load, port_discharge, container_no, seal_no,
  cutoff_at, etd, eta, export_entry_no, entry_lodged_at, shipped_on, bl_no, status)
select d.code, o.id, d.mode, d.carrier, d.vessel, d.booking, d.pol, d.pod, d.cntr, d.seal,
  current_date + d.cutoff + d.cut_time::time, current_date + d.etd, current_date + d.eta, d.entry,
  case when d.lodged is null then null else current_date + d.lodged + d.lodged_time::time end,
  current_date + d.shipped, d.bl, d.status
from (values
  ('S-2035', 'O-3135', 'sea', 'Maersk', 'Maersk Nelson 412N', 'MAEU261004411', 'NZNSN', 'USLAX', 'MNBU3381904', 'ML-882011', -63, '16:00', -61, -40, 'NZE-2611-40021', -64, '11:00', -61, 'MAEU261004411', 'arrived'),
  ('S-2036', 'O-3136', 'sea', 'ONE', 'ONE Tasman 208N', 'ONEYNSN2208', 'NZNSN', 'JPTYO', 'TRIU8802113', 'ONE-552031', -48, '16:00', -46, -28, 'NZE-2611-40388', -50, '14:00', -46, 'ONEYNSN220811', 'arrived'),
  ('S-2037', 'O-3137', 'air', 'Singapore Airlines Cargo', 'SQ286', 'SQC-618-2241', 'NZAKL', 'SGSIN', null, null, -31, '08:00', -31, -30, 'NZE-2611-40712', -32, '09:00', -31, '618-55512340', 'arrived'),
  ('S-2038', 'O-3138', 'sea', 'Maersk', 'Maersk Nelson 418N', 'MAEU261005102', 'NZNSN', 'USLAX', 'MNBU3392617', 'ML-882944', -14, '16:00', -12, 4, 'NZE-2611-41106', -16, '10:00', -12, 'MAEU261005102', 'shipped'),
  ('S-2039', 'O-3139', 'sea', 'CMA CGM', 'CMA CGM Pegasus 0FE2', 'CMAU-NSN-7710', 'NZNSN', 'AEJEA', 'CMAU5507731', 'CMA-330912', -20, '16:00', -18, 14, 'NZE-2611-40990', -22, '15:00', -18, 'CMDUNSN7710118', 'shipped'),
  ('S-2040', 'O-3140', 'sea', 'ONE', 'ONE Tasman 214N', 'ONEYNSN2214', 'NZNSN', 'JPTYO', null, null, 6, '16:00', 8, 26, null, null, null, null, null, 'booked'),
  ('S-2041', 'O-3141', 'sea', 'ONE', 'ONE Matariki 096N', 'ONEYNSN0961', 'NZNSN', 'JPYOK', 'TRIU8815540', null, 1, '16:00', 3, 21, null, null, null, null, null, 'booked'),
  ('S-2042', 'O-3142', 'air', 'Singapore Airlines Cargo', 'SQ286', 'SQC-618-2307', 'NZAKL', 'SGSIN', null, null, 5, '08:00', 5, 6, null, null, null, null, null, 'booked'),
  ('S-2043', 'O-3143', 'sea', 'CMA CGM', 'CMA CGM Orion 0FE8', 'CMAU-NSN-7744', 'NZNSN', 'AEJEA', null, null, 7, '16:00', 9, 41, null, null, null, null, null, 'booked'),
  ('S-2044', 'O-3144', 'sea', 'COSCO', 'COSCO Auckland 051S', 'COSU6402215', 'NZNSN', 'CNSHA', 'CSNU7140228', 'CS-118733', 1, '10:00', 2, 18, 'NZE-2611-41520', 0, '09:00', null, null, 'booked')
) d(code, ord, mode, carrier, vessel, booking, pol, pod, cntr, seal, cutoff, cut_time, etd, eta, entry, lodged, lodged_time, shipped, bl, status)
join trade.orders o on o.code = d.ord
on conflict (code) do nothing;

insert into trade.documents (shipment_id, doc_type, ref_no, status, issued_on, issued_by, valid_to, sent_on, sent_to)
select s.id, d.doc, d.ref, d.status, current_date + d.issued, d.by, current_date + d.valid, current_date + d.sent, d.sent_to
from (values
  -- S-2035 (arrived): no packing list ever recorded.
  ('S-2035', 'CI', 'TBP-INV-3135', 'sent', -61, 'Aroha Mitchell', null::int, -60, 'Pacific Gourmet'),
  ('S-2035', 'BL', 'MAEU261004411', 'sent', -61, 'Maersk', null, -60, 'Pacific Gourmet'),
  ('S-2035', 'EHC', 'MPI-EHC-26-118204', 'sent', -63, 'MPI', null, -60, 'Pacific Gourmet'),
  ('S-2036', 'CI', 'TBP-INV-3136', 'sent', -46, 'Aroha Mitchell', null, -45, 'Kanto Seafood'),
  ('S-2036', 'PL', 'TBP-PL-3136', 'sent', -46, 'Aroha Mitchell', null, -45, 'Kanto Seafood'),
  ('S-2036', 'BL', 'ONEYNSN220811', 'sent', -46, 'ONE', null, -45, 'Kanto Seafood'),
  ('S-2036', 'EHC', 'MPI-EHC-26-118690', 'sent', -48, 'MPI', null, -45, 'Kanto Seafood'),
  ('S-2036', 'ORIGIN', 'TBP-CPTPP-3136', 'sent', -46, 'Aroha Mitchell', null, -45, 'Kanto Seafood'),
  ('S-2037', 'CI', 'TBP-INV-3137', 'sent', -31, 'Aroha Mitchell', null, -31, 'Lion City'),
  ('S-2037', 'PL', 'TBP-PL-3137', 'sent', -31, 'Aroha Mitchell', null, -31, 'Lion City'),
  ('S-2037', 'BL', '618-55512340', 'sent', -31, 'Singapore Airlines Cargo', null, -31, 'Lion City'),
  ('S-2037', 'ORIGIN', 'TBP-CPTPP-BLANKET-24', 'sent', -400, 'Aroha Mitchell', -35, -31, 'Lion City'),
  -- S-2038 (on the water, lands in four days): everything issued, nothing sent.
  ('S-2038', 'CI', 'TBP-INV-3138', 'issued', -12, 'Aroha Mitchell', null, null, null),
  ('S-2038', 'PL', 'TBP-PL-3138', 'issued', -12, 'Aroha Mitchell', null, null, null),
  ('S-2038', 'BL', 'MAEU261005102', 'issued', -11, 'Maersk', null, null, null),
  ('S-2038', 'EHC', 'MPI-EHC-26-121055', 'issued', -14, 'MPI', null, null, null),
  -- S-2039 (letter of credit): documents ready, not yet at the bank.
  ('S-2039', 'CI', 'TBP-INV-3139', 'issued', -18, 'Aroha Mitchell', null, null, null),
  ('S-2039', 'PL', 'TBP-PL-3139', 'issued', -18, 'Aroha Mitchell', null, null, null),
  ('S-2039', 'BL', 'CMDUNSN7710118', 'issued', -17, 'CMA CGM', null, null, null),
  ('S-2039', 'EHC', 'MPI-EHC-26-120711', 'issued', -20, 'MPI', null, null, null),
  ('S-2039', 'COO', 'NCC-26-08817', 'issued', -17, 'Nelson Tasman Chamber of Commerce', null, null, null),
  ('S-2039', 'INS', 'NZI-MC-26-55310', 'issued', -19, 'NZI Marine', null, null, null),
  -- S-2040: on track, cut-off in six days.
  ('S-2040', 'CI', 'TBP-INV-3140', 'issued', -1, 'Aroha Mitchell', null, null, null),
  ('S-2040', 'PL', 'TBP-PL-3140', 'draft', null, 'Aroha Mitchell', null, null, null),
  ('S-2040', 'ORIGIN', 'TBP-CPTPP-3140', 'issued', -1, 'Aroha Mitchell', null, null, null),
  -- S-2041: cut-off tomorrow, health certificate not applied for.
  ('S-2041', 'CI', 'TBP-INV-3141', 'issued', -2, 'Aroha Mitchell', null, null, null),
  ('S-2041', 'PL', 'TBP-PL-3141', 'issued', -2, 'Aroha Mitchell', null, null, null),
  ('S-2041', 'ORIGIN', 'TBP-CPTPP-3141', 'issued', -2, 'Aroha Mitchell', null, null, null),
  -- S-2042: last year's blanket certification reused.
  ('S-2042', 'CI', 'TBP-INV-3142', 'issued', -1, 'Aroha Mitchell', null, null, null),
  ('S-2042', 'ORIGIN', 'TBP-CPTPP-BLANKET-24', 'issued', -400, 'Aroha Mitchell', -35, null, null),
  -- S-2043 (letter of credit): early paperwork.
  ('S-2043', 'CI', 'TBP-PI-3143', 'draft', null, 'Aroha Mitchell', null, null, null),
  -- S-2044: chamber certificate still in draft the day before cut-off.
  ('S-2044', 'CI', 'TBP-INV-3144', 'issued', -1, 'Aroha Mitchell', null, null, null),
  ('S-2044', 'PL', 'TBP-PL-3144', 'issued', -1, 'Aroha Mitchell', null, null, null),
  ('S-2044', 'EHC', 'MPI-EHC-26-122480', 'issued', 0, 'MPI', null, null, null),
  ('S-2044', 'COO', 'NCC-26-09102', 'draft', null, 'Nelson Tasman Chamber of Commerce', null, null, null)
) d(ship, doc, ref, status, issued, by, valid, sent, sent_to)
join trade.shipments s on s.code = d.ship
where not exists (select 1 from trade.documents x where x.shipment_id = s.id and x.doc_type = d.doc);

insert into trade.invoices (code, shipment_id, customer_id, currency, fx_rate, amount_cents, issued_on, due_on, paid_cents, paid_on, status)
select d.code, s.id, o.customer_id, o.currency, o.fx_rate, ov.invoice_cents, current_date + d.issued, current_date + d.due,
  case when d.paid is null then 0 else ov.invoice_cents end, current_date + d.paid, case when d.paid is null then 'open' else 'paid' end
from (values
  ('TBP-INV-3135', 'S-2035', -61, -31, null::int),
  ('TBP-INV-3136', 'S-2036', -46, -16, -5),
  ('TBP-INV-3137', 'S-2037', -31, -17, -18),
  ('TBP-INV-3138', 'S-2038', -12, 18, null),
  ('TBP-INV-3139', 'S-2039', -18, 5, null)
) d(code, ship, issued, due, paid)
join trade.shipments s on s.code = d.ship
join trade.orders o on o.id = s.order_id
join trade.order_value ov on ov.id = o.id
on conflict (code) do nothing;

insert into trade.notes (subject_type, subject_id, author, body)
select 'shipment', s.id::text, 'Aroha Mitchell', 'Booked the MPI verifier for Thursday; certificate application not lodged yet.'
from trade.shipments s where s.code = 'S-2041'
  and not exists (select 1 from trade.notes n where n.subject_type = 'shipment' and n.subject_id = s.id::text);
