-- =====================================================================
-- CATCH-UP MIGRATION — Parts 5 through 9
--
-- Parts 1-4 are already applied to the project. Parts 5-9 are not, which
-- is why the Team page, Client Action Items, Transaction Documents and
-- History all fail to load: the functions, tables and columns they query
-- do not exist yet. Verified 30 Aug 2026 against information_schema.
--
-- This file is an exact copy of lines 683-end of supabase/schema.sql. No
-- statement here drops a table, drops a column, or deletes a row. Every
-- object is created with "if not exists", "create or replace", or a
-- "drop policy if exists" immediately followed by its replacement, so
-- running it twice is harmless.
--
-- Run it whole, in the Supabase SQL Editor, in one go.
-- =====================================================================



-- =====================================================================
-- PART 5 — agents create their own files, and a team directory
--
-- Two problems this solves:
--
-- 1. An agent could already INSERT a transaction (the "agents write
--    assigned" policy allows it), but had no way to pick the client. RLS
--    only lets an agent read profiles already linked to them, so a brand
--    new client was invisible and unattachable. Chicken and egg.
--
-- 2. Granting roles meant opening the SQL editor. That does not scale past
--    one person, and it is the kind of chore that gets skipped.
--
-- Both are solved with SECURITY DEFINER functions rather than by loosening
-- the policies. A policy wide enough to let agents browse every profile
-- would also let them enumerate the brokerage's entire client list. These
-- functions do one narrow thing each and check the caller first.
-- =====================================================================


-- ---------------------------------------------------------------------
-- create a transaction for a client, by email
-- ---------------------------------------------------------------------
-- Looks the client up by email, creates the file, and links client to
-- agent in one step. Staff only.
--
-- Deliberately does NOT expose a general "look up any user by email"
-- endpoint. It either creates a transaction or it does not; it never just
-- answers "does this person have an account", which would turn the portal
-- into a way to test whether someone is a client here.
create or replace function public.create_transaction(
  p_client_email   text,
  p_address        text,
  p_kind           text default 'purchase',
  p_file_number    text default null,
  p_status         text default null,
  p_expected_close date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_txn    uuid;
begin
  if not public.is_staff() then
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  if coalesce(btrim(p_address), '') = '' then
    raise exception 'An address is required' using errcode = '22023';
  end if;

  select id into v_client
    from auth.users
   where lower(email) = lower(btrim(p_client_email));

  if v_client is null then
    raise exception 'No account exists for that email. Ask them to create one from the portal login first.'
      using errcode = '22023';
  end if;

  insert into public.transactions
    (client_id, agent_id, address, kind, file_number, status,
     expected_close, closing_status, progress_step)
  values
    (v_client, auth.uid(), btrim(p_address), coalesce(p_kind, 'purchase'),
     nullif(btrim(coalesce(p_file_number, '')), ''),
     nullif(btrim(coalesce(p_status, '')), ''),
     p_expected_close, 'in_process', 1)
  returning id into v_txn;

  -- Link the client to this agent so the agent can see their profile from
  -- now on. Only fills an empty slot: it never reassigns someone else's
  -- client out from under them.
  update public.profiles
     set agent_id = auth.uid()
   where id = v_client and agent_id is null;

  return v_txn;
end;
$$;

revoke all on function public.create_transaction(text, text, text, text, text, date) from public, anon;
grant execute on function public.create_transaction(text, text, text, text, text, date) to authenticated;


-- ---------------------------------------------------------------------
-- team directory
-- ---------------------------------------------------------------------
-- Admin only. auth.users is not reachable through the Data API, so this
-- is the only way to show the team without handing out a secret key.
create or replace function public.staff_directory()
returns table (id uuid, email text, role text, full_name text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  return query
    select u.id,
           u.email::text,
           coalesce(u.raw_app_meta_data ->> 'portal_role', 'none')::text,
           p.full_name,
           u.created_at
      from auth.users u
      left join public.profiles p on p.id = u.id
     order by u.created_at;
end;
$$;

revoke all on function public.staff_directory() from public, anon;
grant execute on function public.staff_directory() to authenticated;


-- ---------------------------------------------------------------------
-- change someone's role
-- ---------------------------------------------------------------------
-- Admin only, and with two guards that matter:
--
--   * an admin cannot change their OWN role. Otherwise one wrong click
--     demotes the only admin and the role can never be granted again from
--     the UI — recoverable solely by going back to the SQL editor.
--   * only the three known roles are accepted. A typo would otherwise
--     write a role nothing recognises, quietly locking the person out of
--     everything.
create or replace function public.set_portal_role(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
begin
  if not public.is_admin() then
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  if p_role not in ('client', 'agent', 'admin') then
    raise exception 'Unknown role: %', p_role using errcode = '22023';
  end if;

  select id into v_target from auth.users where lower(email) = lower(btrim(p_email));
  if v_target is null then
    raise exception 'No account with that email' using errcode = '22023';
  end if;

  if v_target = auth.uid() then
    raise exception 'You cannot change your own role' using errcode = '42501';
  end if;

  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object('portal_role', p_role)
   where id = v_target;
end;
$$;

revoke all on function public.set_portal_role(text, text) from public, anon;
grant execute on function public.set_portal_role(text, text) to authenticated;


-- =====================================================================
-- NOTE ON SECURITY DEFINER
-- These three functions run with the privileges of their owner, which is
-- how they can reach auth.users at all. That makes the first line of each
-- one — the is_staff() / is_admin() check — load-bearing. Removing it does
-- not merely widen access; it hands every signed-in user the ability to
-- read the team list or grant themselves admin. Do not edit these without
-- that check in place.
-- =====================================================================


-- =====================================================================
-- PART 6 — show the client's name, and let staff edit a file
-- =====================================================================


-- ---------------------------------------------------------------------
-- link transactions to profiles so the client's name can be joined
-- ---------------------------------------------------------------------
-- transactions.client_id and profiles.id both point at auth.users, but
-- there was no foreign key BETWEEN them — so PostgREST had no relationship
-- to follow and the portal could only ever show an address.
--
-- Adding it is safe: every account gets a profiles row from the signup
-- trigger, so every existing client_id already has a match.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_client_profile_fkey'
  ) then
    alter table public.transactions
      add constraint transactions_client_profile_fkey
      foreign key (client_id) references public.profiles (id) on delete cascade;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- backfill any profile rows that are missing
-- ---------------------------------------------------------------------
-- Accounts created before the trigger existed would have no profile and
-- would break the constraint above. Harmless if there are none.
insert into public.profiles (id, full_name)
select u.id,
       coalesce(u.raw_user_meta_data ->> 'full_name',
                u.raw_user_meta_data ->> 'name',
                split_part(u.email, '@', 1))
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- staff can read the profile of anyone they hold a transaction for
-- ---------------------------------------------------------------------
-- The existing policy keyed off profiles.agent_id, which is only set when
-- a file is created through create_transaction(). This covers the rest:
-- if you can see the transaction, you can see whose it is. Without it the
-- name column would silently come back empty for some rows and not others,
-- which is worse than never showing it.
drop policy if exists "profiles: staff read their transaction clients" on public.profiles;
create policy "profiles: staff read their transaction clients"
  on public.profiles for select
  using (exists (
    select 1 from public.transactions t
     where t.client_id = profiles.id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ));


-- =====================================================================
-- PART 7 — transaction management fields
--
-- ADDITIVE ONLY. No column is dropped, renamed, or retyped, and no data
-- is deleted. Every existing row keeps working; new columns start null.
--
-- WHAT IS REUSED RATHER THAN DUPLICATED
--   expected_close   is the Closing Date. No second column for it.
--   kind             gains 'lease'. purchase = Buyer, sale = Seller.
--   closing_status   gains the File Status vocabulary. 'in_process' is
--                    kept and read as Active, so old rows still make sense.
--   ms_loan_docs     becomes Loan Approval.
--   ms_ready_close   becomes Clear to Close.
--   transaction_documents gains a type, rather than a second table.
-- =====================================================================


-- ---------------------------------------------------------------------
-- transaction details
-- ---------------------------------------------------------------------
alter table public.transactions
  add column if not exists sales_price         numeric(12,2),
  add column if not exists contract_date       date,
  add column if not exists earnest_due         date,
  add column if not exists option_ends         date,
  add column if not exists financing_deadline  date,
  add column if not exists appraisal_deadline  date,
  add column if not exists walkthrough_date    date;

-- Lease work is a real part of the business and had nowhere to go.
alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions
  add constraint transactions_kind_check
  check (kind in ('purchase', 'sale', 'lease'));

-- File Status: Active / On Hold / Terminated / Closed.
-- 'in_process' and 'cancelled' stay legal so existing rows remain valid —
-- the app reads 'in_process' as Active and 'cancelled' as Terminated.
alter table public.transactions drop constraint if exists transactions_closing_status_check;
alter table public.transactions
  add constraint transactions_closing_status_check
  check (closing_status in ('active','on_hold','terminated','closed','in_process','cancelled'));


-- ---------------------------------------------------------------------
-- the remaining milestones
-- ---------------------------------------------------------------------
-- Status vocabulary across all twelve: null or 'not_started', 'pending',
-- 'blocked' (shown as Needs attention), 'na', 'complete'. 'blocked' is
-- kept rather than renamed because existing rows and the client-facing
-- list already use it.
alter table public.transactions
  add column if not exists ms_option_fee        text,
  add column if not exists ms_inspection        text,
  add column if not exists ms_repairs           text,
  add column if not exists ms_survey            text,
  add column if not exists ms_appraisal         text,
  add column if not exists ms_final_walkthrough text,
  add column if not exists ms_closing           text;


-- ---------------------------------------------------------------------
-- internal notes — a SEPARATE TABLE, deliberately
-- ---------------------------------------------------------------------
-- These must never reach a client. A column on `transactions` could not
-- guarantee that: RLS filters rows, not columns, so any client selecting
-- their own transaction would receive the note along with it. The only
-- reliable answer is to keep the data in a table clients cannot read at
-- all.
--
-- Do not "simplify" this back into a column later.
create table if not exists public.transaction_internal (
  transaction_id uuid primary key references public.transactions (id) on delete cascade,
  notes          text,
  updated_by     uuid references auth.users (id) on delete set null,
  updated_at     timestamptz not null default now()
);

alter table public.transaction_internal enable row level security;

-- Staff only. There is no client policy here, and there must never be one.
drop policy if exists "internal: staff read" on public.transaction_internal;
create policy "internal: staff read"
  on public.transaction_internal for select
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ));

drop policy if exists "internal: staff write" on public.transaction_internal;
create policy "internal: staff write"
  on public.transaction_internal for all
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ))
  with check (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ));


-- ---------------------------------------------------------------------
-- client action items — a real table
-- ---------------------------------------------------------------------
-- Replaces the text[] column, which could hold only a bare sentence. The
-- old column is LEFT IN PLACE and backfilled from below, so nothing that
-- still reads it breaks during the changeover.
create table if not exists public.transaction_action_items (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  title          text not null check (length(btrim(title)) > 0),
  note           text,
  due_date       date,
  status         text not null default 'pending'
                   check (status in ('pending','complete')),
  sort_order     smallint not null default 100,
  created_at     timestamptz not null default now()
);

create index if not exists tai_transaction_idx on public.transaction_action_items (transaction_id, sort_order);
alter table public.transaction_action_items enable row level security;

-- Clients READ these — that is the whole point of the section — but only
-- staff may write them.
drop policy if exists "action items: visible with the transaction" on public.transaction_action_items;
create policy "action items: visible with the transaction"
  on public.transaction_action_items for select
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (t.client_id = auth.uid()
            or public.is_admin()
            or (public.is_agent() and t.agent_id = auth.uid()))
  ));

drop policy if exists "action items: staff manage" on public.transaction_action_items;
create policy "action items: staff manage"
  on public.transaction_action_items for all
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ))
  with check (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ));

-- Move anything already in the old array across. Runs once in practice:
-- the guard stops it duplicating on a re-run.
insert into public.transaction_action_items (transaction_id, title, sort_order)
select t.id, item.value, item.ordinality * 10
  from public.transactions t,
       lateral unnest(t.action_items) with ordinality as item(value, ordinality)
 where t.action_items is not null
   and not exists (
     select 1 from public.transaction_action_items a
      where a.transaction_id = t.id and a.title = item.value
   );


-- ---------------------------------------------------------------------
-- documents: a checklist type, and a wider status vocabulary
-- ---------------------------------------------------------------------
-- Reuses the existing table rather than adding a second document system.
alter table public.transaction_documents
  add column if not exists doc_type text;

alter table public.transaction_documents drop constraint if exists transaction_documents_status_check;
alter table public.transaction_documents
  add constraint transaction_documents_status_check
  check (status in ('uploaded','missing','requested','waiting',
                    'available','received','needs_signature'));
-- The last three are the original vocabulary, kept so existing rows stay
-- valid. New rows use the first four.

-- storage_path is required today, which makes it impossible to record a
-- document that has been REQUESTED but not yet uploaded. Relaxing it is
-- what lets the checklist show a missing document as a real row.
alter table public.transaction_documents alter column storage_path drop not null;


-- =====================================================================
-- PART 8 — client-visible documents, audit trail, remaining vocabulary
-- =====================================================================


-- ---------------------------------------------------------------------
-- transaction type gains "Other"
-- ---------------------------------------------------------------------
alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions
  add constraint transactions_kind_check
  check (kind in ('purchase', 'sale', 'lease', 'other'));


-- ---------------------------------------------------------------------
-- action items gain "Needs Attention"
-- ---------------------------------------------------------------------
alter table public.transaction_action_items
  drop constraint if exists transaction_action_items_status_check;
alter table public.transaction_action_items
  add constraint transaction_action_items_status_check
  check (status in ('pending','needs_attention','complete'));


-- ---------------------------------------------------------------------
-- CLIENT-VISIBLE DOCUMENTS  ** behaviour change, read this **
-- ---------------------------------------------------------------------
-- Until now a client could read EVERY document row on their own
-- transaction. That was wrong: a commission agreement or an internal
-- worksheet filed against the transaction would have been visible.
--
-- Documents are now internal by default and shared deliberately.
--
-- The default is false rather than true on purpose. An agent who uploads
-- a survey and forgets the toggle causes mild annoyance; an agent who
-- uploads a commission statement and forgets it causes real harm. The
-- failure mode has to point the safe way.
--
-- EXISTING rows are backfilled to true, because they were already visible
-- and silently hiding them would be its own surprise.
alter table public.transaction_documents
  add column if not exists client_visible boolean not null default false;

do $$
begin
  if not exists (select 1 from public.transaction_documents where client_visible) then
    update public.transaction_documents set client_visible = true;
  end if;
end $$;

-- Clients: only what has been shared with them.
drop policy if exists "documents: visible with the transaction" on public.transaction_documents;
drop policy if exists "documents: clients read shared" on public.transaction_documents;
create policy "documents: clients read shared"
  on public.transaction_documents for select
  using (
    client_visible = true
    and exists (
      select 1 from public.transactions t
       where t.id = transaction_id and t.client_id = auth.uid()
    )
  );

-- Staff: everything on files they hold.
drop policy if exists "documents: staff read all" on public.transaction_documents;
create policy "documents: staff read all"
  on public.transaction_documents for select
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ));

-- The Storage policy has to agree with the table policy, or a client who
-- learns an object path could fetch a signed URL for a file whose row they
-- cannot read.
drop policy if exists "docs: read own transaction files" on storage.objects;
create policy "docs: read own transaction files"
  on storage.objects for select
  using (
    bucket_id = 'transaction-docs'
    and exists (
      select 1
        from public.transactions t
        left join public.transaction_documents d
               on d.transaction_id = t.id and d.storage_path = storage.objects.name
       where t.id::text = (storage.foldername(storage.objects.name))[1]
         and (
           public.is_admin()
           or (public.is_agent() and t.agent_id = auth.uid())
           or (t.client_id = auth.uid() and coalesce(d.client_visible, false) = true)
         )
    )
  );


-- ---------------------------------------------------------------------
-- audit trail
-- ---------------------------------------------------------------------
create table if not exists public.transaction_audit (
  id             bigserial primary key,
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  actor_id       uuid references auth.users (id) on delete set null,
  actor_email    text,
  field          text not null,
  old_value      text,
  new_value      text,
  created_at     timestamptz not null default now()
);

create index if not exists ta_transaction_idx on public.transaction_audit (transaction_id, created_at desc);
alter table public.transaction_audit enable row level security;

-- Staff only. History is an internal record; there is no client policy and
-- there should not be one without a deliberate decision.
drop policy if exists "audit: staff read" on public.transaction_audit;
create policy "audit: staff read"
  on public.transaction_audit for select
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ));

-- No insert policy: rows are written by the trigger below, which runs as
-- SECURITY DEFINER. Nobody writes history by hand, so nobody can forge it.

create or replace function public.log_transaction_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_field text;
  v_old   text;
  v_new   text;
begin
  select email into v_email from auth.users where id = auth.uid();

  foreach v_field in array array[
    'progress_step','closing_status','status','expected_close','contract_date',
    'earnest_due','option_ends','financing_deadline','appraisal_deadline',
    'walkthrough_date','sales_price','file_number','address','kind','agent_id',
    'ms_earnest_money','ms_option_fee','ms_inspection','ms_repairs',
    'ms_title_commit','ms_survey','ms_hoa_docs','ms_loan_docs','ms_appraisal',
    'ms_ready_close','ms_final_walkthrough','ms_closing'
  ]
  loop
    v_old := to_jsonb(old) ->> v_field;
    v_new := to_jsonb(new) ->> v_field;
    if v_old is distinct from v_new then
      insert into public.transaction_audit
        (transaction_id, actor_id, actor_email, field, old_value, new_value)
      values (new.id, auth.uid(), v_email, v_field, v_old, v_new);
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists transactions_audit on public.transactions;
create trigger transactions_audit
  after update on public.transactions
  for each row execute function public.log_transaction_change();


-- =====================================================================
-- PART 9 — website leads
--
-- Every public form on the site lands here. One table, one shape, a
-- form_type column to tell them apart.
--
-- HOW THIS TABLE IS WRITTEN TO
-- Only by the server, through /api/lead, using the SERVICE ROLE key.
-- That key bypasses RLS, which is exactly why there is no insert policy
-- below for anon or authenticated.
--
-- The alternative — letting the browser insert directly with the
-- publishable key — would need an anon INSERT policy, and an anon INSERT
-- policy on a lead table is an open pipe for bots. Keeping the write
-- server-side also means validation, rate limiting and notification all
-- happen somewhere a visitor cannot skip.
--
-- So: anonymous visitors have NO access to this table at all. Not read,
-- not write. They talk to the function; the function talks to Postgres.
-- =====================================================================

create table if not exists public.leads (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  -- which form this came from: contact, buyer_inquiry, seller_inquiry,
  -- property_inquiry, showing_request, home_valuation, agent_contact,
  -- join_team, newsletter, consultation, other
  form_type      text not null,

  -- the person
  first_name     text,
  last_name      text,
  full_name      text,
  email          text,
  phone          text,
  message        text,

  -- what they want
  intent         text,          -- buying / selling / both / not sure
  property_address text,
  listing_id     text,
  mls_number     text,
  property_url   text,
  preferred_area text,
  price_range    text,
  timeline       text,

  -- who it belongs to
  agent_name     text,
  agent_email    text,
  assigned_agent uuid references auth.users (id) on delete set null,
  user_id        uuid references auth.users (id) on delete set null,

  -- where it came from
  lead_source    text,
  page_name      text,
  page_url       text,
  referrer       text,
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_content    text,
  utm_term       text,

  -- Anything a particular form asks that does not deserve its own column.
  -- No answer is discarded just because one form asks something another
  -- does not.
  extra          jsonb not null default '{}'::jsonb,

  -- workflow
  status         text not null default 'new'
                   check (status in ('new','contacted','qualified','converted','archived','spam')),
  notes          text,

  -- notification outcomes. Recorded so a lead that arrived safely can be
  -- told apart from one where the alert merely failed to send.
  email_sent     boolean not null default false,
  email_sent_at  timestamptz,
  email_error    text,
  sms_sent       boolean not null default false,
  sms_sent_at    timestamptz,
  sms_error      text
);

create index if not exists leads_created_idx  on public.leads (created_at desc);
create index if not exists leads_type_idx     on public.leads (form_type, created_at desc);
create index if not exists leads_status_idx   on public.leads (status, created_at desc);
create index if not exists leads_assigned_idx on public.leads (assigned_agent);

alter table public.leads enable row level security;

-- ---------------------------------------------------------------------
-- policies
-- ---------------------------------------------------------------------
-- Staff read and manage. Nobody else gets anything.
--
-- There is deliberately NO policy granting anon or authenticated any
-- access. A signed-in client cannot read the lead table either — their
-- own enquiry included. Leads are a business record, not a user record.
drop policy if exists "leads: staff read" on public.leads;
create policy "leads: staff read"
  on public.leads for select
  using (public.is_staff());

drop policy if exists "leads: staff update" on public.leads;
create policy "leads: staff update"
  on public.leads for update
  using (public.is_staff())
  with check (public.is_staff());

-- No delete policy. A lead is a record of someone asking for help; if it
-- is junk, mark it status = 'spam' rather than destroying the evidence
-- that a form was working on a given day.


-- =====================================================================
-- VERIFY the table is closed to the public. Run this in the SQL editor
-- and it should return zero rows for anon:
--
--   select polname, polroles::regrole[], polcmd
--     from pg_policy
--    where polrelid = 'public.leads'::regclass;
--
-- Both policies should apply to {public} with the is_staff() check —
-- meaning a caller without the agent or admin claim matches neither.
-- =====================================================================
