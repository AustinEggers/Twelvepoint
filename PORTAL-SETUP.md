# Portal setup — Supabase

## Status

Built and wired. It needs a Supabase project, one SQL script, and two values
pasted into a config file. No code left to write.

| Piece | File | State |
|---|---|---|
| Sign-in page | `login.html` | Built |
| Auth + data rendering | `assets/portal.js` | Built |
| Project URL + key | `assets/supabase-config.js` | **Placeholders — fill in** |
| Schema and RLS policies | `supabase/schema.sql` | Built — run it once |
| Page access control | `middleware.js` — Vercel edge | Built |
| Host config | `vercel.json` | Built |
| Agent landing page | `portal/agent/index.html` | Built, content to fill |
| Transactions list | `portal/client/index.html` | Built, renders live data |
| Transaction detail | `portal/client/transaction.html` | Built — Overview / Contacts / Documents / Messages |
| Portal styling | `assets/portal.css` | Built |
| Local preview | `portal/_preview-*.html` | Sample data, excluded from deploys |

## Looking at it before Supabase exists

Open `portal/_preview-list.html` and `portal/_preview-detail.html` on the local
server. They stub the database with one invented client and two invented
transactions, so the whole layout can be clicked through with no project set up.

They are excluded from the deploy zip by the leading underscore in the filename,
and `tools/build-zip.ps1` enforces that. Delete them once the real portal runs.

## The two layers that protect this

**1. Row Level Security, in the database.** Every table has RLS on and a policy
keyed to `auth.uid()`. A client can only ever read their own rows — enforced by
Postgres on every query regardless of what the browser asks for. This is the
real boundary.

Note what the client portal does *not* do: it never sends a client id. It asks
for "all transactions" and the database decides what that means for the caller.
That is the correct shape. Any code that filters by an id from the browser is
asking the attacker which records to return.

**2. Vercel Edge Middleware** (`middleware.js`) verifies the token and role
before serving anything under `/portal/`. It checks the JWT *signature* against
your project's public JWKS — not just the payload, because an unverified JWT is
a string the visitor typed.

It fails closed twice over: an unset `SUPABASE_URL` denies everyone rather than
letting everyone through, and any path under `/portal/` that matches no explicit
rule still requires a recognised role. Adding a page there cannot accidentally
publish it.

## Setup

### 1. Create the project

supabase.com → New project. Pick the region closest to Houston (`us-east-1`).

**Save the database password in a password manager.** Not in a text file, not
in a chat window. It cannot be shown again.

### 2. Run the schema

SQL Editor → New query → paste all of `supabase/schema.sql` → Run.

It creates `profiles` and `transactions`, turns on RLS, and writes the policies.
It is safe to run more than once.

### 3. Open signup, with the two guards

Authentication → Sign In / Providers → turn **on** "Allow new users to sign up".
Buyers and sellers create their own accounts from the login page.

Then turn on both of these, because open signup without them is a problem:

- **Confirm email.** Otherwise anyone can register using someone else's
  address. The confirmation step is what stops a stranger claiming a client's
  email before that client does.
- **CAPTCHA** (Authentication → Attack Protection). A public signup form
  attracts bots, and every bot signup sends a confirmation email from your
  domain. Skipping this is how a domain earns a poor sending reputation.

**Why this is safe:** a new account gets the `client` role and nothing more.
Every table is filtered by RLS on `auth.uid()`, so a stranger who signs up sees
an *empty* portal — saved properties and no one's transaction. `agent` is never
self-granted; it is set by hand in step 6.

### 4. Fill in the config

Settings → Data API → **Project URL**, and Settings → API Keys → **publishable
key**. Paste both into `assets/supabase-config.js`.

Both are safe in public source — the publishable key is designed to ship in
browsers. What makes that safe is RLS, and only RLS.

**Never put the secret (`service_role`) key in that file, or in any file the
browser downloads, or in a chat message.** It bypasses RLS completely and would
hand every client record to anyone who viewed source.

### 5. Deploy to Vercel and set its variable

The project has no build step. `package.json` exists only so Vercel can install
the two packages `middleware.js` imports — there is no bundler, and the HTML,
CSS and JS are served exactly as written.

Vercel deploys from Git rather than a zip upload, so this folder needs to be a
repository first:

```bash
git init && git add -A && git commit -m "TwelvePoint site"
```

Push it to GitHub, then import it at vercel.com. Framework preset: **Other**.
No build command. Output directory: leave blank.

Then Vercel → Project → Settings → Environment Variables:

```
SUPABASE_URL = https://your-project.supabase.co
```

Same URL as the config file, set for Production **and** Preview. The gate fails
closed without it — nobody gets in rather than everybody, which is the right way
round but looks like a broken login if you forget.

**Do not deploy before this step.** `middleware.js` is the only thing keeping
strangers out of `/portal/`, and the old Netlify gate does not run on Vercel.

### 6. Invite someone and grant a role

Authentication → Users → Invite user.

Roles live in `app_metadata`, which the dashboard cannot edit, so grant it in
the SQL editor:

```sql
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('portal_role', 'client')
 where email = 'someone@example.com';
```

Use `'agent'` for team members.

**Why `app_metadata` and not `user_metadata`:** the account holder can write
their own `user_metadata`. A role kept there could be granted by the very person
it is meant to restrict.

**Roles apply at next sign-in.** The claim is baked into the JWT, so an existing
session keeps the old role until its token refreshes.

A user with no role signs in fine and reaches nothing. The login page says so
in plain language. This is the step that gets forgotten.

## Verifying it actually works

Do this on the deployed site. Localhost cannot enforce any of it — no edge
middleware, no gate.

**Sign-in works locally** once the config is filled in, because Supabase is a
remote service. Page gating does not.

Test with **two client accounts**, A and B, each with a transaction:

1. Signed out, open `/portal/agent/` → bounced to login.
2. Signed in as client A, open `/portal/agent/` → still bounced.
3. Signed in as client A → sees A's transaction, and **not B's**.
4. Signed in as an agent → agent portal loads.
5. Sign out, press Back → no cached page.

Step 3 is the one that matters. Everything else is a door; that is the vault.
An RLS policy nobody tested is a policy nobody has.

To be certain the database is doing the work rather than the page, open
DevTools as client A and run:

```js
const { data } = await window.supabase
  .createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey)
  .from('transactions').select('*');
console.log(data);
```

It must return only A's rows. If it returns B's, stop and re-check the policies
before a single real client is invited.

## Documents

The schema creates a **private** `transaction-docs` Storage bucket. Objects are
keyed `<transaction_id>/<filename>`, and the Storage policy reads that
transaction id straight out of the path to decide who may read the file.

The browser never receives a durable URL. Clicking a document asks Supabase for
a signed URL that lasts 60 seconds, and Storage re-checks the policy at that
moment — so a link copied out of the page is dead within a minute.

**Before you put contracts in it, decide whether you should.** Texas record
retention runs through the broker, and Goldmount most likely already carries a
transaction platform. A second copy of executed contracts in a second system is
a liability rather than a feature. The bucket is there if you want it; using it
is a business decision, not a technical one.

## Content still to fill

Marked with yellow `todo` chips on the pages:

- Agent: listing checklist, marketing templates, **vendor list** (left empty on
  purpose — placeholder vendors eventually get called by a real client),
  transaction platform link.
- Client: transaction platform link.

## Things that are easy to get wrong

- **A new table without RLS is public.** The publishable key is in the page
  source. Anyone can copy it and query any table that has RLS off. Every
  migration that creates a table must enable RLS in the same migration.
- **`select` policies are not `insert` policies.** A table with only a read
  policy still refuses writes, which is usually what you want — but check both
  when you add a table people write to.
- **Never filter by an id taken from the browser** and treat that as security.
  Filter server-side with `auth.uid()` in the policy.
- **Don't add a `/portal/*` rewrite to `vercel.json`.** A rewrite is resolved
  before middleware and would serve the page ungated.
- **`netlify.toml` and `netlify/` are superseded** and excluded from the deploy
  package. They are kept only in case the site ever moves back. Editing them
  changes nothing on the live site.
- **Don't email documents as a workaround.** Use the brokerage's platform or a
  link that expires.

## Google sign-in (optional, add any time)

The "Continue with Google" button is built but **hidden**, controlled by
`enableGoogle` in `assets/supabase-config.js`. Leave it `false` until all three
of these are true, because a half-configured button sends people to a Google
error page:

1. **Google Cloud** (console.cloud.google.com — a different site from Supabase):
   create a project, configure the OAuth consent screen as **External**, and
   **Publish** it. Left in Testing mode only listed test users can sign in, so
   it works for you and fails for every client.
2. **Create an OAuth client**, application type **Web application**, and add the
   Supabase callback URL (`https://<project-ref>.supabase.co/auth/v1/callback`,
   copied from the Supabase Google panel) as an authorised redirect URI.
3. **Paste the Client ID and Secret into Supabase** → Authentication → Sign In /
   Providers → Google. The Client ID ends in `.apps.googleusercontent.com` — the
   name you gave the client in Google Cloud is not the Client ID.

Also set Authentication → **URL Configuration** → Site URL and Redirect URLs, or
Google returns people to Supabase and Supabase refuses to forward them on.

Then flip `enableGoogle` to `true`. Nothing else changes: the same trigger grants
`client` whether the account arrives by password or by Google.

## vercel.json — two things that will bite

**It is strict JSON and it is schema-validated.** No `//` comments, and no
extra keys inside a headers entry either — only `source`, `headers`, `has`
and `missing` are allowed. A stray key does not warn, it fails the build,
and the site keeps serving the last good deployment while every push
quietly errors. If pushes stop appearing on the live site, check the
Deployments tab before you check your code.

**Header rule order matters.** Vercel applies every rule that matches and a
later rule wins for the same header name. The `/portal/(.*)` block must
stay LAST in the `headers` array: if it sits above `/(.*)\.html`, that rule
overwrites its `Cache-Control` with `public`, which would let a shared
proxy store a signed-in client's transaction page. There is no comment in
the file saying so, because the file cannot carry one.
