-- =====================================================================
-- PART 10 — agent transaction dashboard
--
-- Additive only. No table is dropped, no column is dropped or renamed,
-- no row is deleted. Every constraint this drops is re-added on the very
-- next statement with a WIDER set of allowed values, never a narrower
-- one, so no existing row can be invalidated.
--
-- Safe to run twice.
--
-- WHAT THIS IS FOR
-- The agent backend is being rebuilt as a transaction-management tool
-- rather than a styled form. That needs a handful of fields the schema
-- does not have yet, one new table, and four functions. The client
-- portal reads none of the new objects and is unaffected by all of it.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 10.1  contract facts
-- ---------------------------------------------------------------------
-- Step 3 of the new-transaction wizard collects these and today there is
-- nowhere to put them. Nullable, so every existing row stays valid.
alter table public.transactions
  add column if not exists title_company  text,
  add column if not exists lender         text,
  add column if not exists financing_type text;


-- ---------------------------------------------------------------------
-- 10.2  archive
-- ---------------------------------------------------------------------
-- Archive is the normal way a transaction leaves the active list. Hard
-- delete exists but is admin-only and deliberately awkward — see 10.9.
--
-- A null archived_at means active. This is a soft delete: nothing is
-- removed, and the audit trail stays intact and readable.
alter table public.transactions
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users (id) on delete set null;

create index if not exists transactions_active_idx
  on public.transactions (agent_id) where archived_at is null;


-- ---------------------------------------------------------------------
-- 10.3  document categories
-- ---------------------------------------------------------------------
-- Existing rows land in 'other', which is accurate: they were filed
-- before categories existed.
alter table public.transaction_documents
  add column if not exists category text not null default 'other';

alter table public.transaction_documents
  drop constraint if exists transaction_documents_category_check;
alter table public.transaction_documents
  add constraint transaction_documents_category_check
  check (category in ('contract','addenda','inspection','title','hoa',
                      'financing','appraisal','closing','other'));


-- ---------------------------------------------------------------------
-- 10.4  action item priority and client notification
-- ---------------------------------------------------------------------
-- notify_client records the AGENT'S INTENT to notify. It does not send
-- anything: there is no mail integration on this table yet. Naming it
-- honestly now avoids ending up with a column called "notified" that
-- never notified anybody.
alter table public.transaction_action_items
  add column if not exists priority      text not null default 'normal',
  add column if not exists notify_client boolean not null default false;

alter table public.transaction_action_items
  drop constraint if exists transaction_action_items_priority_check;
alter table public.transaction_action_items
  add constraint transaction_action_items_priority_check
  check (priority in ('normal','high','urgent'));


-- ---------------------------------------------------------------------
-- 10.5  timestamped internal notes
-- ---------------------------------------------------------------------
-- public.transaction_internal holds ONE text blob per transaction. It is
-- left in place and still readable by the old code path; this table is
-- the new one. The blob is copied across below as a single note so that
-- nothing an agent has already written disappears from view.
--
-- Staff only. There is no client policy here and there must never be one.
create table if not exists public.transaction_notes (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  body           text not null check (length(btrim(body)) > 0),
  author_id      uuid references auth.users (id) on delete set null,
  author_email   text,
  created_at     timestamptz not null default now()
);

create index if not exists tn_transaction_idx
  on public.transaction_notes (transaction_id, created_at desc);

alter table public.transaction_notes enable row level security;

drop policy if exists "notes: staff read" on public.transaction_notes;
create policy "notes: staff read"
  on public.transaction_notes for select
  using (exists (
    select 1 from public.transactions t
     where t.id = transaction_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ));

-- author_id is pinned to the caller, so an agent cannot post a note under
-- somebody else's name.
drop policy if exists "notes: staff write" on public.transaction_notes;
create policy "notes: staff write"
  on public.transaction_notes for insert
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.transactions t
       where t.id = transaction_id
         and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
    )
  );

-- Notes are a record. They may be removed by their author or an admin,
-- but not edited: an editable internal note is not much of a record.
drop policy if exists "notes: author or admin delete" on public.transaction_notes;
create policy "notes: author or admin delete"
  on public.transaction_notes for delete
  using (author_id = auth.uid() or public.is_admin());

-- Carry the old single blob across, once. The NOT EXISTS guard makes this
-- a no-op on any later run.
insert into public.transaction_notes (transaction_id, body, author_id, created_at)
select i.transaction_id,
       i.notes,
       i.updated_by,
       coalesce(i.updated_at, now())
  from public.transaction_internal i
 where coalesce(btrim(i.notes), '') <> ''
   and not exists (
     select 1 from public.transaction_notes n
      where n.transaction_id = i.transaction_id
   );


-- ---------------------------------------------------------------------
-- 10.6  audit: record whether a change was made by a person
-- ---------------------------------------------------------------------
-- Existing rows become 'user', which is what they were.
alter table public.transaction_audit
  add column if not exists source text not null default 'user';

alter table public.transaction_audit
  drop constraint if exists transaction_audit_source_check;
alter table public.transaction_audit
  add constraint transaction_audit_source_check
  check (source in ('user','system'));


-- ---------------------------------------------------------------------
-- 10.7  auto-advance the stage when closing completes
-- ---------------------------------------------------------------------
-- Approved behaviour: marking the Closing milestone Complete moves the
-- transaction to stage 4 (Closed). The client's portal shows the stage,
-- so this changes what they see without an agent saying so explicitly —
-- which is exactly why it is written to the audit trail as 'system'
-- rather than attributed to whoever happened to tick the box.
--
-- BEFORE UPDATE, so the change is part of the same row write. It sets a
-- transaction-local flag that the audit trigger reads; the flag dies with
-- the statement, so it cannot leak into an unrelated write.
create or replace function public.auto_advance_stage()
returns trigger
language plpgsql
as $fn$
begin
  if new.ms_closing = 'complete'
     and old.ms_closing is distinct from 'complete'
     and coalesce(new.progress_step, 1) < 4
  then
    new.progress_step  := 4;
    new.closing_status := case
                            when new.closing_status in ('terminated','cancelled')
                              then new.closing_status
                            else 'closed'
                          end;
    perform set_config('app.audit_source', 'system', true);
  end if;
  return new;
end;
$fn$;

drop trigger if exists transactions_auto_stage on public.transactions;
create trigger transactions_auto_stage
  before update on public.transactions
  for each row execute function public.auto_advance_stage();

-- Same body as Part 8, plus the four new fields and the source flag.
create or replace function public.log_transaction_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_email  text;
  v_field  text;
  v_old    text;
  v_new    text;
  v_source text;
begin
  select email into v_email from auth.users where id = auth.uid();
  v_source := coalesce(nullif(current_setting('app.audit_source', true), ''), 'user');

  foreach v_field in array array[
    'progress_step','closing_status','status','expected_close','contract_date',
    'earnest_due','option_ends','financing_deadline','appraisal_deadline',
    'walkthrough_date','sales_price','file_number','address','kind','agent_id',
    'title_company','lender','financing_type','archived_at',
    'ms_earnest_money','ms_option_fee','ms_inspection','ms_repairs',
    'ms_title_commit','ms_survey','ms_hoa_docs','ms_loan_docs','ms_appraisal',
    'ms_ready_close','ms_final_walkthrough','ms_closing'
  ]
  loop
    v_old := to_jsonb(old) ->> v_field;
    v_new := to_jsonb(new) ->> v_field;
    if v_old is distinct from v_new then
      insert into public.transaction_audit
        (transaction_id, actor_id, actor_email, field, old_value, new_value, source)
      values (new.id, auth.uid(), v_email, v_field, v_old, v_new,
              case when v_field = 'progress_step' then v_source else 'user' end);
    end if;
  end loop;

  perform set_config('app.audit_source', '', true);
  return new;
end;
$fn$;


-- ---------------------------------------------------------------------
-- 10.8  client search for the new-transaction wizard
-- ---------------------------------------------------------------------
-- Why a function rather than a plain select: an agent cannot read a
-- profile that is not already linked to them, which is correct and stays
-- correct. The picker needs to find a client before that link exists, so
-- this runs SECURITY DEFINER and applies its own narrower rule.
--
-- Returns the four fields the picker draws and nothing else. No phone,
-- no agent_id, no created_at — a search box is not a directory export.
--
-- There is no brokerage/organisation column anywhere in this schema, so
-- there is no org scoping to respect. The scoping that does exist is
-- profiles.agent_id, and it is honoured: an agent sees their own clients
-- plus unclaimed ones, an admin sees all. Staff-only either way.
--
-- profiles has full_name and no first/last columns. Rather than add two
-- columns nothing maintains, the name is split here for display.
create or replace function public.search_clients(q text)
returns table (id uuid, first_name text, last_name text, email text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_q text := btrim(coalesce(q, ''));
begin
  if not public.is_staff() then
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  -- An empty box must not dump the client list.
  if length(v_q) < 2 then
    return;
  end if;

  return query
    select u.id,
           split_part(coalesce(p.full_name, ''), ' ', 1)                       as first_name,
           nullif(btrim(substr(coalesce(p.full_name, ''),
                               strpos(coalesce(p.full_name, ''), ' '))), '')   as last_name,
           u.email::text
      from auth.users u
      left join public.profiles p on p.id = u.id
     where coalesce(u.raw_app_meta_data ->> 'portal_role', 'client') = 'client'
       and (public.is_admin() or p.agent_id is null or p.agent_id = auth.uid())
       and (p.full_name ilike '%' || v_q || '%'
            or u.email   ilike '%' || v_q || '%'
            or p.phone   ilike '%' || v_q || '%')
     order by p.full_name nulls last
     limit 20;
end;
$fn$;

revoke all on function public.search_clients(text) from public, anon;
grant execute on function public.search_clients(text) to authenticated;


-- ---------------------------------------------------------------------
-- 10.9  archive, restore, hard delete
-- ---------------------------------------------------------------------
-- These are functions rather than plain updates because the rules differ
-- by role in a way a row policy cannot express: an agent may set
-- archived_at but not clear it. RLS filters rows, not columns.

create or replace function public.archive_transaction(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not exists (
    select 1 from public.transactions t
     where t.id = p_id
       and (public.is_admin() or (public.is_agent() and t.agent_id = auth.uid()))
  ) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  update public.transactions
     set archived_at = now(), archived_by = auth.uid()
   where id = p_id and archived_at is null;
end;
$fn$;

-- Restore is admin-only on purpose. An agent who archives the wrong file
-- should have to say so out loud rather than quietly putting it back.
create or replace function public.restore_transaction(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can restore a transaction'
      using errcode = '42501';
  end if;

  update public.transactions
     set archived_at = null, archived_by = null
   where id = p_id;
end;
$fn$;

-- HARD DELETE. Admin only, and it takes the address back as confirmation
-- so it cannot be called with an id alone.
--
-- This is the one genuinely destructive operation in the whole schema.
-- The row cascades: documents, contacts, messages, action items, notes
-- and the entire audit trail for this transaction go with it. Storage
-- objects are NOT removed by the cascade and must be cleared separately.
--
-- Texas brokerages have record-retention obligations. Archive is the
-- normal path; this exists for a file created in error, not for tidying.
create or replace function public.delete_transaction_hard(p_id uuid, p_confirm_address text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_address text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can delete a transaction'
      using errcode = '42501';
  end if;

  select address into v_address from public.transactions where id = p_id;
  if v_address is null then
    raise exception 'No such transaction' using errcode = '22023';
  end if;

  if lower(btrim(coalesce(p_confirm_address, ''))) <> lower(btrim(v_address)) then
    raise exception 'The typed address does not match this transaction'
      using errcode = '22023';
  end if;

  delete from public.transactions where id = p_id;
end;
$fn$;

revoke all on function public.archive_transaction(uuid)                from public, anon;
revoke all on function public.restore_transaction(uuid)                from public, anon;
revoke all on function public.delete_transaction_hard(uuid, text)      from public, anon;
grant execute on function public.archive_transaction(uuid)             to authenticated;
grant execute on function public.restore_transaction(uuid)             to authenticated;
grant execute on function public.delete_transaction_hard(uuid, text)   to authenticated;


-- ---------------------------------------------------------------------
-- 10.10  create_transaction_v2
-- ---------------------------------------------------------------------
-- The Part 5 create_transaction(text,text,text,text,text,date) is LEFT
-- EXACTLY AS IT IS. The old agent page still calls it, and it keeps
-- working until that page is replaced.
--
-- What is new here: the client is chosen by id from the picker rather
-- than typed as an email, and the wizard collects contract facts and
-- deadlines that the old signature has no room for.
--
-- p_client_email is still accepted as a fallback for the case where the
-- client has an account but no profile row yet.
create or replace function public.create_transaction_v2(
  p_client_id          uuid    default null,
  p_client_email       text    default null,
  p_address            text    default null,
  p_kind               text    default 'purchase',
  p_agent_id           uuid    default null,
  p_file_number        text    default null,
  p_sales_price        numeric default null,
  p_contract_date      date    default null,
  p_financing_type     text    default null,
  p_title_company      text    default null,
  p_lender             text    default null,
  p_expected_close     date    default null,
  p_earnest_due        date    default null,
  p_option_ends        date    default null,
  p_financing_deadline date    default null,
  p_appraisal_deadline date    default null,
  p_walkthrough_date   date    default null,
  p_status             text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_client uuid;
  v_agent  uuid;
  v_txn    uuid;
begin
  if not public.is_staff() then
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  if coalesce(btrim(p_address), '') = '' then
    raise exception 'An address is required' using errcode = '22023';
  end if;

  v_client := p_client_id;
  if v_client is null then
    select id into v_client
      from auth.users
     where lower(email) = lower(btrim(coalesce(p_client_email, '')));
  end if;

  if v_client is null then
    raise exception 'No account exists for that client. They create one themselves from the portal login.'
      using errcode = '22023';
  end if;

  -- Only an admin may assign a file to somebody else. An agent creating a
  -- transaction always gets their own name on it, whatever was submitted.
  v_agent := case when public.is_admin() then coalesce(p_agent_id, auth.uid())
                  else auth.uid() end;

  insert into public.transactions
    (client_id, agent_id, address, kind, file_number, status,
     sales_price, contract_date, financing_type, title_company, lender,
     expected_close, earnest_due, option_ends, financing_deadline,
     appraisal_deadline, walkthrough_date,
     closing_status, progress_step)
  values
    (v_client, v_agent, btrim(p_address), coalesce(p_kind, 'purchase'),
     nullif(btrim(coalesce(p_file_number, '')), ''),
     nullif(btrim(coalesce(p_status, '')), ''),
     p_sales_price, p_contract_date,
     nullif(btrim(coalesce(p_financing_type, '')), ''),
     nullif(btrim(coalesce(p_title_company, '')), ''),
     nullif(btrim(coalesce(p_lender, '')), ''),
     p_expected_close, p_earnest_due, p_option_ends, p_financing_deadline,
     p_appraisal_deadline, p_walkthrough_date,
     'active', 1)
  returning id into v_txn;

  -- Link the client to this agent so the agent can read their profile from
  -- now on. Fills an empty slot only: it never reassigns someone else's
  -- client out from under them.
  update public.profiles
     set agent_id = v_agent
   where id = v_client and agent_id is null;

  return v_txn;
end;
$fn$;

revoke all on function public.create_transaction_v2(
  uuid, text, text, text, uuid, text, numeric, date, text, text, text,
  date, date, date, date, date, date, text) from public, anon;
grant execute on function public.create_transaction_v2(
  uuid, text, text, text, uuid, text, numeric, date, text, text, text,
  date, date, date, date, date, date, text) to authenticated;


-- ---------------------------------------------------------------------
-- 10.11  staff list for the "assigned agent" dropdown
-- ---------------------------------------------------------------------
-- staff_directory() from Part 5 is admin-only and returns roles. An agent
-- filling in the wizard needs the names, not the administration. Returns
-- staff only, never clients.
create or replace function public.agent_options()
returns table (id uuid, full_name text, email text)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_staff() then
    raise exception 'Not permitted' using errcode = '42501';
  end if;

  return query
    select u.id,
           coalesce(p.full_name, split_part(u.email::text, '@', 1)),
           u.email::text
      from auth.users u
      left join public.profiles p on p.id = u.id
     where coalesce(u.raw_app_meta_data ->> 'portal_role', '') in ('agent', 'admin')
     order by 2;
end;
$fn$;

revoke all on function public.agent_options() from public, anon;
grant execute on function public.agent_options() to authenticated;
