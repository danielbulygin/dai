-- Where a client's ad performance data comes from.
--
-- Decision (Dan, 2026-07-25): external Ada customers' data must NEVER land in
-- the agency warehouse tables (account_daily / campaign_daily / adset_daily /
-- ad_daily / creatives). Those stay agency-only.
--
--   'warehouse' — agency clients. Filled by the nightly Python sync in
--                 bmad/pma/tools using an agency Meta token.
--   'guard'     — external Ada customers. Filled by Ada Guard from the
--                 customer's OWN OAuth connection, into guard_snapshots.
--                 Refreshed three times a day, so there is no second sync to
--                 build or babysit.
--
-- The chat tools branch on this column, so an Ada customer can never read an
-- agency table and vice versa.

alter table public.clients
  add column if not exists data_source text not null default 'warehouse'
  check (data_source in ('warehouse', 'guard'));

comment on column public.clients.data_source is
  'warehouse = agency client (account_daily et al, nightly Python sync); guard = external Ada customer (guard_snapshots, own OAuth token). Ada customer data never enters agency tables.';
