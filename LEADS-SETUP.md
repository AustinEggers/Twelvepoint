# Lead capture — setup

Every public form on the site now posts to one place, which saves the lead
and then notifies you.

```
Form  →  /api/lead  →  validate  →  Supabase  →  email  →  SMS
```

The lead is saved **before** either notification is attempted, and neither
failure can undo it. A visitor never sees success unless the database
confirmed the write.

---

## What you need to do

### 1. Run the schema

`supabase/schema.sql`, same as before. Part 9 adds the `leads` table.

### 2. Get a Resend API key — 5 minutes

resend.com → sign up → **API Keys** → Create.

You can send immediately using their `onboarding@resend.dev` sender while
testing. To send from your own domain (better deliverability, looks like
you), add the domain under **Domains** and paste the DNS records — that
needs the real domain, which is still unconfirmed.

### 3. Get your Supabase service role key

Supabase → **Settings → API Keys** → the **secret** key (`sb_secret_…`).

**This one is different from the publishable key.** It bypasses Row Level
Security, which is exactly why the lead API uses it and why it must never
appear in any file the browser downloads. It goes in Vercel only.

### 4. Set these in Vercel

Project → Settings → **Environment Variables**. Production *and* Preview.

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://sirgapdqygrtimaadqfn.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the `sb_secret_…` key |
| `LEAD_NOTIFICATION_EMAIL` | `austin.eggers@gregtxrealty.com` |
| `RESEND_API_KEY` | from step 2 |
| `LEAD_FROM_EMAIL` | `onboarding@resend.dev` until your domain is verified |

That is everything email needs. **SMS is optional and can wait.**

### 5. Point your phone at the email

Until SMS is registered, this is how you get an instant alert: mark the
sender as a VIP in Mail on iPhone, or give it a starred rule in Gmail.
Your phone already pushes email — a lead reaches you in seconds, with no
carrier registration and no cost.

---

## SMS, when you are ready

US carriers require **A2P 10DLC registration** before any service may text
a US mobile from a normal number. This is a carrier mandate, not a Twilio
rule, and unregistered traffic is blocked rather than delayed.

Registration needs your business name and EIN, takes several days to a
couple of weeks, and costs a few dollars a month. Twilio itself is cheap:
about $1.15/month for a number and under a cent per message.

When it clears, add these and SMS starts working with no code change:

| Variable | Value |
|---|---|
| `LEAD_NOTIFICATION_PHONE` | `+17138284185` |
| `TWILIO_ACCOUNT_SID` | from Twilio |
| `TWILIO_AUTH_TOKEN` | from Twilio |
| `TWILIO_FROM_NUMBER` | your Twilio number, `+1…` |

Until those exist the SMS step is skipped silently — not logged as an
error, because it is not one.

---

## The forms this covers

| Form | `form_type` | Where |
|---|---|---|
| Contact dialog | `contact` | every marketing page |
| Buyer search | `buyer_inquiry` | buyers.html |
| Home valuation wizard | `home_valuation` | home-value.html |
| Join the team | `join_team` | join.html |
| Agent contact | `agent_contact` | agent pages |
| Property enquiry | `property_inquiry` | listing-template.html |

**The property enquiry form had no `data-form` attribute at all** and would
have been missed by any handler keyed on one. That template seeds every
future listing page, so it would have quietly dropped your highest-intent
leads. It is tagged now.

A new form needs three things: a `data-form` value, an entry in
`LEAD_TYPES` in `assets/site.js`, and named fields. Nothing else.

---

## Where leads appear

**Agent portal → Leads.** Newest first, unworked ones edged in gold.
Filter by status, change status inline, tap the phone number to call.

Anything a form asked that has no column of its own is kept in `extra` and
shown on the card — the answer to "what condition is the kitchen in" is
exactly what makes a valuation lead worth reading.

A lead whose email alert failed is **flagged on the card**. Otherwise a
provider outage looks like a quiet week.

---

## Security

- **Anonymous visitors have no access to the `leads` table.** Not read, not
  write. There is no anon policy at all. The browser talks to `/api/lead`;
  only the server talks to Postgres.
- Clients cannot read leads either — including their own. A lead is a
  business record, not a user record.
- No secret reaches the browser. The service role key, the Resend key and
  the Twilio credentials exist only in Vercel environment variables and
  only inside `api/lead.js`.
- Spam: honeypot field, a submit-too-fast check, and per-IP rate limiting.
  Both bot checks answer `200` so a bot learns nothing from being caught.

## Deliberately not done

- **No delete policy on leads.** Junk gets `status = 'spam'` rather than
  being destroyed — the row is also evidence the form was working that day.
- **No CAPTCHA yet.** The honeypot and timing check handle ordinary bots.
  Add Turnstile if real abuse appears; it is not free of friction.
