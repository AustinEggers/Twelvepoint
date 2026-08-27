# Launch checklist

Everything that must be true before the site is public on a real domain with
real clients using it. Grouped by what happens if you skip it.

Nothing here is a nice-to-have. The nice-to-haves are not in this file.

---

## Will break, or expose something

- [ ] **CAPTCHA on the signup form.**
      Cloudflare Turnstile → Supabase → Authentication → Attack Protection.
      **Requires code first**: once CAPTCHA is enabled, every auth call must
      pass a `captchaToken`, and the login page has to render the widget to
      produce one. Enabling the setting alone breaks sign-in, sign-up, and
      password reset with an error that does not mention captcha.
      *Do the code and the setting in the same sitting.*

- [ ] **Custom SMTP.**
      Supabase's built-in email is rate-limited to a handful per hour and is
      explicitly dev-only. With email confirmation on, real signups will
      silently stop receiving their confirmation and the portal will look
      broken. Resend, Postmark, SendGrid or SES — Authentication → Emails →
      SMTP Settings. Verify the sending domain.

- [ ] **`SUPABASE_URL` set in Vercel** for Production *and* Preview.
      `middleware.js` fails closed without it: nobody reaches the portal.
      Right direction, but it looks like a broken login.

- [ ] **Two-account RLS test, on the deployed site.**
      Client A and client B, each with a transaction. A must not see B's rows.
      Localhost cannot test this — no edge middleware, no gate.
      Full procedure in `PORTAL-SETUP.md`. **This is the one that matters.**

- [ ] **Delete `portal/_preview-*.html`.**
      Stubbed sample data with a fake signed-in client. Excluded from the
      deploy package today, but delete them once the real portal works so
      nobody can ever ship one by hand.

---

## Wrong information going out

- [ ] **Confirm the live domain and re-run the SEO build.**
      `SITE_URL` at the top of `tools/build-seo.sh` currently assumes
      `https://twelvepointrealty.com`. Every canonical, `og:url`, absolute
      share image, sitemap entry and JSON-LD `@id` derives from it.
      Change it, run `bash tools/build-seo.sh`, and confirm with `--check`.
      *Canonicals pointing at a domain that is not live tell Google to index
      nothing — useful while staging, fatal at launch.*

- [ ] **Replace `assets/hero.mp4`.**
      It is a watermarked iStock comp (`istockphoto-…-640_adpp_is.mp4`) — an
      unlicensed preview, and the watermark is visible in frames. Licensed
      footage, or cut the section.

- [ ] **Broker of record — name and licence number.**
      Still missing for Goldmount Real Estate Group, LLC. The footer carries a
      `todo` chip for it.

- [ ] **Listing photography.**
      Stock or AI imagery must never sit against a real listing address —
      that is misleading advertising. The `data-preview` attributes on the
      three real listings are deliberately empty and the hover preview stays
      off until real photos exist.

- [ ] **Vendor list.**
      `portal/agent/vendors.html` has categories and no names, on purpose.
      Clients are told the network is vetted and they call these numbers at
      the worst moment of a transaction.

- [ ] **Real Notes posts, or hide the section.**
      The entries are placeholders. `Article` structured data is deliberately
      not emitted for them.

---

## Leads go nowhere

- [ ] **Wire the forms.**
      Contact dialog, buyer search, home valuation wizard, join-the-team.
      All currently post nowhere and say so with a `todo` chip.
      Destination and the `FUB_DRY_RUN` plan are in the conversation history;
      the broker's Follow Up Boss ownership question needs settling first.

- [ ] **IDX connected.**
      `listings.html` is the IDX page with an empty `#idx-search` slot.
      HAR approval plus broker sign-off takes weeks — start it early.

---

## Optional, any time

- [ ] Google sign-in — built and hidden behind `enableGoogle` in
      `assets/supabase-config.js`. Setup steps in `PORTAL-SETUP.md`.
- [ ] Agent admin screens — create and edit transactions from the portal
      instead of the Supabase Table Editor.
- [ ] Neighbourhood pages — the thing that actually ranks for
      "Cypress TX homes for sale". Needs real local knowledge, not filler.
