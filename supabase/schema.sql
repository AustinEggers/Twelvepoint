-- =====================================================================
-- TwelvePoint portal — schema and Row Level Security
--
-- Run this once in Supabase → SQL Editor → New query → Run.
-- It is written to be re-runnable: every statement is guarded, so running
-- it twice does not error and does not destroy data.
--
-- RLS IS THE SECURITY BOUNDARY FOR THIS ENTIRE PORTAL.
-- The publishable key in assets/supabase-config.js is public by design.
-- It grants exactly what the policies below grant and nothing more. A
-- table created later WITHOUT rls enabled is readable by anyone on the
-- internet who copies that key out of the page source. There is no second
-- lock, no firewall, and no obscurity to fall back on.
--
-- So: every new table holding client data gets `enable row level security`
-- in the same migration that creates it. Not afterwards.
-- =====================================================================


-- ---------------------------------------------------------------------
-- profiles — one row per auth user, readable by that user
-- ---------------------------------------------------------------------
-- The authoritative role lives in auth.users.app_metadata.portal_role,
-- because app_metadata can only be written with the secret key. This
-- table is for display and for linking clients to their agent; it is NOT
-- what any access decision reads.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  phone       text,
  agent_id    uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Helper: is the caller an agent? Reads the JWT claim, so it cannot be
-- spoofed by writing to a table. SECURITY DEFINER is deliberately NOT
-- used — this needs no elevated rights.
create or replace function public.is_agent()
returns boolean
language sql
stable
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb
      -> 'app_metadata' ->> 'portal_role') = 'agent',
    false
  );
$$;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own"
  on public.profiles for select
  using (id = auth.uid());

drop policy if exists "profiles: agents read their clients" on public.profiles;
create policy "profiles: agents read their clients"
  on public.profiles for select
  using (public.is_agent() and agent_id = auth.uid());

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Deliberately no INSERT or DELETE policy for clients. Rows are created by
-- the trigger below and removed only by cascade. Nobody signs themselves up.


-- ---------------------------------------------------------------------
-- transactions — the per-client data the portal renders
-- ---------------------------------------------------------------------
create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references auth.users (id) on delete cascade,
  agent_id        uuid references auth.users (id) on delete set null,
  address         text not null,
  kind            text not null default 'purchase'
                    check (kind in ('purchase', 'sale')),
  status          text,
  current_step    text,
  expected_close  date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists transactions_client_idx on public.transactions (client_id);
create index if not exists transactions_agent_idx  on public.transactions (agent_id);

alter table public.transactions enable row level security;

-- A client sees their own rows. This is the policy that makes it safe for
-- the browser to ask for "all transactions" with no filter: the database
-- resolves auth.uid() and hands back only what belongs to the caller.
drop policy if exists "transactions: clients read own" on public.transactions;
create policy "transactions: clients read own"
  on public.transactions for select
  using (client_id = auth.uid());

-- An agent sees the ones assigned to them. Scoped to agent_id rather than
-- "any agent sees everything", so adding a second agent later does not
-- silently widen access to the whole book of business.
drop policy if exists "transactions: agents read assigned" on public.transactions;
create policy "transactions: agents read assigned"
  on public.transactions for select
  using (public.is_agent() and agent_id = auth.uid());

drop policy if exists "transactions: agents write assigned" on public.transactions;
create policy "transactions: agents write assigned"
  on public.transactions for all
  using (public.is_agent() and agent_id = auth.uid())
  with check (public.is_agent() and agent_id = auth.uid());

-- Clients get no insert, update, or delete. They read their record; they
-- do not author it.


-- ---------------------------------------------------------------------
-- keep updated_at honest
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists transactions_touch on public.transactions;
create trigger transactions_touch
  before update on public.transactions
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------
-- create a profile row whenever a user is invited
-- ---------------------------------------------------------------------
-- SECURITY DEFINER is required here: the trigger runs as the auth system
-- inserting into a table the new user cannot yet write to themselves.
-- search_path is pinned so the function cannot be hijacked by a shadowing
-- object in a schema earlier on the path.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =====================================================================
-- AFTER RUNNING THIS
--
-- 1. Authentication → Sign In / Providers → turn OFF "Allow new users to
--    sign up". Both audiences are invited; open signup on a brokerage
--    portal invites impersonation.
--
-- 2. Invite a user: Authentication → Users → Invite user.
--
-- 3. Grant the role. app_metadata is not editable in the dashboard UI, so
--    run this in the SQL editor, replacing the email and the role:
--
--      update auth.users
--         set raw_app_meta_data =
--               coalesce(raw_app_meta_data, '{}'::jsonb)
--               || jsonb_build_object('portal_role', 'client')
--       where email = 'someone@example.com';
--
--    Use 'agent' for team members. The role only appears in their token
--    after they sign out and back in — JWTs carry the claim, so an
--    existing session keeps the old one until it refreshes.
--
-- 4. Link a client to their agent and give them a transaction:
--
--      update public.profiles
--         set agent_id = (select id from auth.users where email = 'austin.eggers@gregtxrealty.com')
--       where id = (select id from auth.users where email = 'someone@example.com');
--
--      insert into public.transactions (client_id, agent_id, address, kind, status, current_step, expected_close)
--      values (
--        (select id from auth.users where email = 'someone@example.com'),
--        (select id from auth.users where email = 'austin.eggers@gregtxrealty.com'),
--        '1234 Example Lane, Cypress TX',
--        'sale', 'Active on the market', 'Option period', '2026-10-15'
--      );
--
-- 5. VERIFY THE POLICIES actually bite, with two accounts. Sign in as
--    client A and confirm the portal shows A's transaction and not B's.
--    An RLS policy nobody tested is a policy nobody has.
-- =====================================================================


-- =====================================================================
-- PART 2 — the tabbed transaction view
--
-- Adds the milestones, contacts, documents and messages the portal
-- renders. Same rule as Part 1, and it is the only rule that matters:
-- every table gets RLS in the same block that creates it.
-- =====================================================================


-- ---------------------------------------------------------------------
-- transactions: milestone and progress columns
-- ---------------------------------------------------------------------
-- Added with `if not exists` so this runs cleanly over the Part 1 table.
alter table public.transactions
  add column if not exists file_number     text,
  add column if not exists closing_status  text
       check (closing_status in ('in_process','closed','cancelled')),
  add column if not exists progress_step   smallint
       check (progress_step between 1 and 4),
  add column if not exists action_items    text[];

-- The five milestones shown as a row of markers on the list page. Each is
-- 'complete', 'blocked', or 'na'; anything else renders as pending, which
-- is the honest default for a field nobody has set yet.
alter table public.transactions
  add column if not exists ms_earnest_money text,
  add column if not exists ms_title_commit  text,
  add column if not exists ms_hoa_docs      text,
  add column if not exists ms_loan_docs     text,
  add column if not exists ms_ready_close   text;


-- ---------------------------------------------------------------------
-- transaction_contacts — who is on the file
-- ---------------------------------------------------------------------
-- A lender's phone number is not a secret, but it is still shown only to
-- people on that file.
create table if not exists public.transaction_contacts (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references public.transactions (id) on delete cascade,
  role            text not null,
  company         text,
  person          text,
  phone           text,
  email           text,
  address         text,
  sort_order      smallint not null default 100,
  created_at      timestamptz not null default now()
);

create index if not exists tc_transaction_idx on public.transaction_contacts (transaction_id);
alter table public.transaction_contacts enable row level security;

-- Visibility is inherited from the transaction rather than restated. If
-- the rule for who may see a file changes, it changes in one place.
drop policy if exists "contacts: visible with the transaction" on public.transaction_contacts;
create policy "contacts: visible with the transaction"
  on public.transaction_contacts for select
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (t.client_id = auth.uid()
            or (public.is_agent() and t.agent_id = auth.uid()))
  ));

drop policy if exists "contacts: agents manage" on public.transaction_contacts;
create policy "contacts: agents manage"
  on public.transaction_contacts for all
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id and public.is_agent() and t.agent_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.transactions t
     where t.id = transaction_id and public.is_agent() and t.agent_id = auth.uid()
  ));


-- ---------------------------------------------------------------------
-- transaction_documents — metadata only; the file lives in Storage
-- ---------------------------------------------------------------------
-- storage_path points into the private 'transaction-docs' bucket. The
-- browser never receives a public URL: it asks for a short-lived signed
-- URL, and Storage re-checks the policy at that moment.
create table if not exists public.transaction_documents (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references public.transactions (id) on delete cascade,
  name            text not null,
  storage_path    text not null,
  status          text not null default 'available'
                    check (status in ('available','received','needs_signature')),
  uploaded_by     uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists td_transaction_idx on public.transaction_documents (transaction_id);
alter table public.transaction_documents enable row level security;

drop policy if exists "documents: visible with the transaction" on public.transaction_documents;
create policy "documents: visible with the transaction"
  on public.transaction_documents for select
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (t.client_id = auth.uid()
            or (public.is_agent() and t.agent_id = auth.uid()))
  ));

drop policy if exists "documents: agents manage" on public.transaction_documents;
create policy "documents: agents manage"
  on public.transaction_documents for all
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id and public.is_agent() and t.agent_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.transactions t
     where t.id = transaction_id and public.is_agent() and t.agent_id = auth.uid()
  ));


-- ---------------------------------------------------------------------
-- transaction_messages
-- ---------------------------------------------------------------------
create table if not exists public.transaction_messages (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references public.transactions (id) on delete cascade,
  sender_id       uuid not null references auth.users (id) on delete cascade,
  body            text not null check (length(btrim(body)) > 0 and length(body) <= 5000),
  created_at      timestamptz not null default now()
);

create index if not exists tm_transaction_idx on public.transaction_messages (transaction_id, created_at);
alter table public.transaction_messages enable row level security;

drop policy if exists "messages: visible with the transaction" on public.transaction_messages;
create policy "messages: visible with the transaction"
  on public.transaction_messages for select
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (t.client_id = auth.uid()
            or (public.is_agent() and t.agent_id = auth.uid()))
  ));

-- The sender_id check is the important half. Without it, someone on the
-- file could post a message attributed to the agent.
drop policy if exists "messages: participants write" on public.transaction_messages;
create policy "messages: participants write"
  on public.transaction_messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.transactions t
       where t.id = transaction_id
         and (t.client_id = auth.uid()
              or (public.is_agent() and t.agent_id = auth.uid()))
    )
  );

-- No update or delete policy, deliberately. A message thread on a real
-- estate file is a record of what was said and when; quietly editable
-- history is worse than no history.


-- ---------------------------------------------------------------------
-- Storage bucket for documents
-- ---------------------------------------------------------------------
-- Private. Objects are keyed <transaction_id>/<filename>, so the policy
-- reads the transaction id straight out of the object path.
insert into storage.buckets (id, name, public)
values ('transaction-docs', 'transaction-docs', false)
on conflict (id) do nothing;

drop policy if exists "docs: read own transaction files" on storage.objects;
create policy "docs: read own transaction files"
  on storage.objects for select
  using (
    bucket_id = 'transaction-docs'
    and exists (
      select 1 from public.transactions t
       where t.id::text = (storage.foldername(name))[1]
         and (t.client_id = auth.uid()
              or (public.is_agent() and t.agent_id = auth.uid()))
    )
  );

drop policy if exists "docs: agents upload" on storage.objects;
create policy "docs: agents upload"
  on storage.objects for insert
  with check (
    bucket_id = 'transaction-docs'
    and exists (
      select 1 from public.transactions t
       where t.id::text = (storage.foldername(name))[1]
         and public.is_agent() and t.agent_id = auth.uid()
    )
  );


-- =====================================================================
-- PART 3 — self-registration
--
-- Buyers and sellers create their own accounts. This REVERSES the
-- invite-only setting from Part 1, so read why it is safe before running.
--
-- WHY OPEN SIGNUP DOES NOT EXPOSE ANYTHING
-- A new account gets the 'client' role, which opens /portal/client/ — and
-- nothing else. Every table is filtered by RLS on auth.uid():
--
--   transactions          client_id = auth.uid()      -> no rows
--   transaction_contacts  inherits from transactions  -> no rows
--   transaction_documents inherits from transactions  -> no rows
--   transaction_messages  inherits from transactions  -> no rows
--
-- So a stranger who signs up sees an empty portal. That is exactly the
-- intended experience for a lead who is not yet a client: favourites and
-- saved searches, and nothing about anybody's transaction. The moment an
-- agent assigns them a transaction, it appears.
--
-- THE LINE THAT DOES NOT MOVE
-- 'agent' is never self-granted. It is set by hand, deliberately, by
-- whoever administers the project. The trigger below can only ever write
-- 'client'. Do not "simplify" it into taking a role from user metadata —
-- user_metadata is writable by the account holder, so that would let
-- anyone promote themselves to agent and read every client file.
-- =====================================================================


-- ---------------------------------------------------------------------
-- grant every new account the client role
-- ---------------------------------------------------------------------
-- Replaces the Part 1 version of this function. SECURITY DEFINER is
-- required to write auth.users; search_path is pinned so the function
-- cannot be hijacked by a shadowing object.
-- Google returns the display name under different keys than an email signup
-- does, so fall through them rather than ending up with an empty name for
-- everyone who signs in with Google.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name',
                           new.raw_user_meta_data ->> 'name',
                           trim(concat_ws(' ', new.raw_user_meta_data ->> 'given_name',
                                               new.raw_user_meta_data ->> 'family_name'))))
  on conflict (id) do nothing;

  -- Only ever 'client', and only when no role has been set already, so an
  -- invited agent who is granted their role first is never demoted.
  if coalesce(new.raw_app_meta_data -> 'portal_role', 'null'::jsonb) = 'null'::jsonb then
    update auth.users
       set raw_app_meta_data =
             coalesce(raw_app_meta_data, '{}'::jsonb)
             || jsonb_build_object('portal_role', 'client')
     where id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------
-- saved properties
-- ---------------------------------------------------------------------
-- Favourites are stored here rather than only inside the IDX, so they
-- survive changing IDX provider and can be read alongside a transaction.
-- listing_key is whatever the IDX calls its listing id (MLS number for
-- most Houston feeds).
create table if not exists public.saved_properties (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  listing_key   text not null,
  address       text,
  price         numeric,
  beds          smallint,
  baths         numeric,
  sqft          integer,
  photo_url     text,
  listing_url   text,
  note          text,
  created_at    timestamptz not null default now(),
  unique (user_id, listing_key)
);

create index if not exists saved_user_idx on public.saved_properties (user_id, created_at desc);
alter table public.saved_properties enable row level security;

-- Owners manage their own saved list, and nobody else's — not even an
-- agent. What a buyer browses at midnight is not the agent's business
-- unless the buyer chooses to share it.
drop policy if exists "saved: owner reads" on public.saved_properties;
create policy "saved: owner reads"
  on public.saved_properties for select
  using (user_id = auth.uid());

drop policy if exists "saved: owner writes" on public.saved_properties;
create policy "saved: owner writes"
  on public.saved_properties for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- =====================================================================
-- AFTER RUNNING THIS
--
-- 1. Authentication -> Sign In / Providers -> turn ON "Allow new users to
--    sign up".
--
-- 2. Turn ON "Confirm email". Without it anyone can register using
--    somebody else's address, and the confirmation step is what stops a
--    stranger claiming a client's email before that client does.
--
-- 3. Authentication -> Attack Protection -> enable CAPTCHA (hCaptcha or
--    Cloudflare Turnstile). Open signup on a public site attracts bots,
--    and every bot signup sends a confirmation email from your domain.
--    Skipping this is how a domain ends up with a poor sending reputation.
--
-- 4. Leave "agent" grants manual:
--
--      update auth.users
--         set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
--                                 || jsonb_build_object('portal_role', 'agent')
--       where email = 'austin.eggers@gregtxrealty.com';
-- =====================================================================


-- =====================================================================
-- PART 4 — the admin role
--
-- Three roles now, each a strict superset of the one below it:
--
--   client  their own transactions, and nothing else
--   agent   the files assigned to them
--   admin   every file, and the ability to assign work to an agent
--
-- WHY ADMIN IS A SEPARATE ROLE AND NOT JUST "AGENT WITH MORE"
-- Today Austin is both, so the distinction looks academic. It stops being
-- academic the first time a second agent joins: 'agent' is deliberately
-- scoped to agent_id = auth.uid(), so adding someone does not hand them
-- the whole book of business. If admin powers were folded into 'agent',
-- every future hire would silently get them.
--
-- 'admin' is granted by hand, in this editor, and by nobody else. The
-- signup trigger can only ever write 'client'.
-- =====================================================================


create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb
      -> 'app_metadata' ->> 'portal_role') = 'admin',
    false
  );
$$;

-- Anyone on the team side. Used where the rule is "not a client" rather
-- than "specifically an agent".
create or replace function public.is_staff()
returns boolean
language sql
stable
as $$
  select public.is_agent() or public.is_admin();
$$;


-- ---------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------
drop policy if exists "transactions: admins read all" on public.transactions;
create policy "transactions: admins read all"
  on public.transactions for select
  using (public.is_admin());

-- Admins may create a file and assign it to any agent, which the agent
-- policy cannot express: its WITH CHECK pins agent_id to the caller.
drop policy if exists "transactions: admins write all" on public.transactions;
create policy "transactions: admins write all"
  on public.transactions for all
  using (public.is_admin())
  with check (public.is_admin());


-- ---------------------------------------------------------------------
-- profiles — admins need the client list to assign work
-- ---------------------------------------------------------------------
drop policy if exists "profiles: admins read all" on public.profiles;
create policy "profiles: admins read all"
  on public.profiles for select
  using (public.is_admin());

drop policy if exists "profiles: admins write all" on public.profiles;
create policy "profiles: admins write all"
  on public.profiles for all
  using (public.is_admin())
  with check (public.is_admin());


-- ---------------------------------------------------------------------
-- everything hanging off a transaction
-- ---------------------------------------------------------------------
drop policy if exists "contacts: admins manage" on public.transaction_contacts;
create policy "contacts: admins manage"
  on public.transaction_contacts for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "documents: admins manage" on public.transaction_documents;
create policy "documents: admins manage"
  on public.transaction_documents for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "messages: admins read" on public.transaction_messages;
create policy "messages: admins read"
  on public.transaction_messages for select
  using (public.is_admin());

-- Admins post as themselves like everyone else. sender_id is still pinned
-- to auth.uid(): being an admin does not mean being able to put words in
-- another person's mouth on a transaction record.
drop policy if exists "messages: admins write" on public.transaction_messages;
create policy "messages: admins write"
  on public.transaction_messages for insert
  with check (public.is_admin() and sender_id = auth.uid());


-- ---------------------------------------------------------------------
-- storage
-- ---------------------------------------------------------------------
drop policy if exists "docs: admins read all" on storage.objects;
create policy "docs: admins read all"
  on storage.objects for select
  using (bucket_id = 'transaction-docs' and public.is_admin());

drop policy if exists "docs: admins upload" on storage.objects;
create policy "docs: admins upload"
  on storage.objects for insert
  with check (bucket_id = 'transaction-docs' and public.is_admin());


-- NOT granted to admins, on purpose:
--   saved_properties. What a buyer browses at midnight is theirs. There is
--   no business reason for anyone else to read it, so no policy exists.


-- =====================================================================
-- MAKE YOURSELF AN ADMIN
-- Replace the email, run it, then sign out and back in — the role travels
-- inside the token, so an existing session keeps the old one.
--
--   update auth.users
--      set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
--                              || jsonb_build_object('portal_role', 'admin')
--    where email = 'YOUR-EMAIL-HERE';
--
-- To check what a user currently has:
--
--   select email, raw_app_meta_data ->> 'portal_role' as role
--     from auth.users order by created_at;
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
