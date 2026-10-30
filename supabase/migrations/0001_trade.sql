-- Export Documentation for Claude Code: the records an exporter's documentation desk runs on.
-- Markets and the paperwork each one asks for, overseas customers, products with tariff codes and
-- origin, export orders, shipments with their cut-offs and export entries, every document on each
-- shipment, trade agreement claims, letters of credit, and the invoices waiting to be paid.
-- Plain Postgres. Runs the same on PGlite (no extensions) and on any hosted Postgres.
-- Money is stored in cents of the order's currency unless a column says _base_cents (the exporter's own currency).

create schema if not exists trade;

create or replace function trade.touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- One row: how this exporter works. Change it with /customise or a direct update.
create table trade.settings (
  id int primary key default 1 check (id = 1),
  business_name text not null default 'Your Export Business',
  jurisdiction text not null default 'NZ' check (jurisdiction in ('NZ', 'AU')),
  base_currency text not null default 'NZD',
  business_address text,
  business_number text,                              -- NZBN or ABN
  certifier_name text,                               -- who signs certifications of origin
  certifier_phone text,
  certifier_email text,
  entry_threshold_cents bigint not null default 100000, -- NZ: a full export entry above NZ$1,000 FOB. AU: an export declaration above A$2,000.
  sea_entry_hours int not null default 48,           -- lodge the entry this long before loading by sea
  air_entry_hours int not null default 9,            -- and this long before loading by air
  records_years int not null default 7,              -- NZ: seven years. AU: five years after export.
  cutoff_warn_days int not null default 3,           -- documents still outstanding this close to cut-off are flagged
  arrival_warn_days int not null default 7,          -- documents not with the customer this close to arrival are flagged
  lc_warn_days int not null default 5,               -- a letter of credit deadline this close is flagged
  invoice_due_days int not null default 30,          -- payment terms when the customer has none
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into trade.settings (id) values (1) on conflict (id) do nothing;

-- The documents an export can need, and who produces each.
create table trade.doc_types (
  code text primary key,
  name text not null,
  issuer text not null,                              -- us, carrier, chamber, regulator, insurer, treatment provider, bank
  before_loading boolean not null default false,     -- must exist before the goods are loaded (health certificates, permits)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Trade agreements a shipment can claim a preferential tariff under.
create table trade.agreements (
  code text primary key,
  name text not null,
  self_certified boolean not null,                   -- true: the exporter writes its own certification of origin
  validity_days int not null default 365,            -- how long a certification of origin stays valid
  declaration text,                                  -- the statement the agreement requires on the certification
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Destination markets and the paperwork each one asks for.
create table trade.markets (
  code text primary key,                             -- ISO country code
  name text not null,
  agreements text[] not null default '{}',           -- agreements in force with this market
  required_docs text[] not null default '{}',        -- doc_types codes every shipment to this market needs
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade.customers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  country text not null references trade.markets(code),
  address text,
  contact text,
  email text,
  phone text,
  tax_id text,                                       -- the importer's own tax or customs number
  currency text not null default 'USD',
  incoterm text not null default 'FOB',
  payment_terms text not null default 'TT 30 days',
  due_days int,                                      -- days from invoice to due; settings.invoice_due_days when empty
  extra_docs text[] not null default '{}',           -- documents this customer asks for on top of the market's
  doc_instructions text,                             -- marks, wording, copies: what their bank or broker insists on
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  hs_code text,                                      -- tariff classification, at least six digits
  hs_checked_on date,
  origin_country text not null default 'NZ',
  unit text not null default 'carton',
  net_kg numeric(10,3) not null default 0,           -- per unit
  gross_kg numeric(10,3) not null default 0,
  cbm numeric(10,4) not null default 0,
  needs_ehc boolean not null default false,          -- food and animal products: an official health certificate
  needs_permit boolean not null default false,       -- strategic or controlled goods: an export permit
  storage text,                                      -- chilled, frozen, ambient
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The evidence that a product originates under an agreement: who decided, on what basis, and until when.
create table trade.origin_determinations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references trade.products(id),
  agreement text not null references trade.agreements(code),
  criterion text not null,                           -- WO wholly obtained, PE from originating materials, PSR product-specific rule, NO not originating
  basis text not null,                               -- the rule met and the evidence held
  determined_on date not null,
  determined_by text not null,
  valid_to date,                                     -- empty: until the recipe or supplier changes
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, agreement, determined_on)
);

create table trade.letters_of_credit (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  customer_id uuid not null references trade.customers(id),
  lc_number text not null,
  issuing_bank text not null,
  advising_bank text,
  currency text not null,
  amount_cents bigint not null check (amount_cents > 0),
  tolerance_pct numeric(5,2) not null default 0,     -- the credit's plus or minus on the amount
  latest_shipment_on date not null,
  expiry_on date not null,
  presentation_days int not null default 21,         -- days after shipment to present documents
  docs_required text[] not null default '{}',
  partial_shipments boolean not null default false,
  status text not null default 'open' check (status in ('open', 'presented', 'paid', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  customer_id uuid not null references trade.customers(id),
  po_ref text,
  ordered_on date not null default current_date,
  currency text not null,
  fx_rate numeric(12,6) not null default 1,          -- units of the base currency for one unit of the order currency
  incoterm text not null,
  named_place text,
  freight_cents bigint not null default 0,           -- charged on the invoice under C and D terms
  insurance_cents bigint not null default 0,         -- charged on the invoice under CIF and CIP
  claim_agreement text references trade.agreements(code),
  lc_id uuid references trade.letters_of_credit(id),
  status text not null default 'open' check (status in ('open', 'shipped', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references trade.orders(id) on delete cascade,
  product_id uuid not null references trade.products(id),
  qty numeric(12,2) not null check (qty > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0), -- the goods price, before freight and insurance
  marks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade.shipments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  order_id uuid not null references trade.orders(id),
  mode text not null check (mode in ('sea', 'air')),
  carrier text,
  vessel text,                                       -- vessel and voyage, or flight
  booking_ref text,
  port_load text,
  port_discharge text,
  container_no text,
  seal_no text,
  cutoff_at timestamp,                               -- the carrier's cargo cut-off, treated as loading time
  etd date,
  eta date,
  export_entry_no text,
  entry_lodged_at timestamp,
  shipped_on date,                                   -- on board
  bl_no text,                                        -- bill of lading or air waybill number
  lc_presented_on date,
  status text not null default 'booked' check (status in ('booked', 'shipped', 'arrived', 'cancelled')),
  cancel_reason text,
  override_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every document produced or received for a shipment.
create table trade.documents (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references trade.shipments(id),
  doc_type text not null references trade.doc_types(code),
  ref_no text,
  status text not null default 'issued' check (status in ('draft', 'issued', 'sent', 'rejected')),
  issued_on date,
  issued_by text,
  valid_to date,                                     -- a blanket certification of origin: the end of its period
  sent_on date,
  sent_to text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade.invoices (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  shipment_id uuid not null unique references trade.shipments(id),
  customer_id uuid not null references trade.customers(id),
  currency text not null,
  fx_rate numeric(12,6) not null default 1,
  amount_cents bigint not null,
  issued_on date not null default current_date,
  due_on date not null,
  paid_cents bigint not null default 0,
  paid_on date,
  status text not null default 'open' check (status in ('open', 'paid', 'void')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trade.notes (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('customer', 'product', 'order', 'shipment', 'lc', 'market')),
  subject_id text not null,
  author text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Import ledger: a re-run of the same file skips the rows it already brought in.
create table trade.import_rows (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  file_name text not null,
  row_number int not null,
  row_hash text not null,
  target_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, row_hash)
);

create unique index shipments_one_live_per_order on trade.shipments (order_id) where status <> 'cancelled';
create index on trade.order_lines (order_id);
create index on trade.documents (shipment_id, doc_type);
create index on trade.origin_determinations (product_id, agreement);
create index on trade.orders (customer_id);
create index on trade.invoices (customer_id);

do $$
declare t text;
begin
  foreach t in array array['settings', 'doc_types', 'agreements', 'markets', 'customers', 'products', 'origin_determinations', 'letters_of_credit',
    'orders', 'order_lines', 'shipments', 'documents', 'invoices', 'notes', 'import_rows'] loop
    execute format('create trigger touch before update on trade.%I for each row execute function trade.touch()', t);
    execute format('alter table trade.%I enable row level security', t);
  end loop;
end $$;
