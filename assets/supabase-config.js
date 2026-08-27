/* =====================================================================
   supabase-config.js — the two public values the portal needs.

   BOTH OF THESE ARE SAFE IN PUBLIC SOURCE. The project URL is a hostname
   and the publishable key is designed to ship in browsers. Anyone can read
   them; that is the intended design.

   WHAT MAKES THAT SAFE IS ROW LEVEL SECURITY, AND ONLY THAT.
   The publishable key grants exactly the access your RLS policies grant.
   A table with RLS switched off is readable by anyone who opens DevTools,
   copies this key, and queries it directly. There is no second lock.
   Every table holding client data must have RLS enabled and a policy.
   See supabase/schema.sql, which turns it on for each table it creates.

   NEVER PUT THE SECRET KEY HERE. The secret (service_role) key bypasses
   RLS entirely and would hand every client's records to anyone who viewed
   source. It belongs only in Vercel environment variables, used from
   server-side functions.
   ===================================================================== */
window.SUPABASE_CONFIG = {
  /* Settings → Data API → Project URL */
  url: "https://sirgapdqygrtimaadqfn.supabase.co",

  /* Settings → API Keys → publishable key (or the legacy "anon" key).
     Starts with "sb_publishable_" or, if legacy, "eyJ...". */
  publishableKey: "sb_publishable_pzeRkEsbDcCq-cXMKz_suw_7XHFXMuQ",

  /* Show the "Continue with Google" button?
     Leave FALSE until Google sign-in is fully set up: a Google OAuth client
     created in Google Cloud, its Client ID and Secret pasted into Supabase,
     and the Supabase callback URL registered as an authorised redirect URI.
     Switched on before that is finished, the button sends people to a Google
     error page — worse than no button at all. Flip to true when it works. */
  enableGoogle: false
};
