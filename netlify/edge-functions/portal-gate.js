/* =====================================================================
   SUPERSEDED — this site now deploys to VERCEL.
   The live gate is middleware.js at the project root. This file no longer
   runs; it is kept only in case the site ever moves back to Netlify.
   ===================================================================== */
/* =====================================================================
   portal-gate.js — server-side access control for /portal/*

   Netlify's built-in role redirects only read Netlify Identity's cookie,
   so moving to Supabase means the gate has to be written. This runs at
   Netlify's edge before any portal HTML is served.

   It verifies the Supabase access token properly: signature checked
   against the project's public JWKS, plus issuer and expiry. It does not
   merely decode the payload and read the role — an unverified JWT is a
   string the visitor typed, and anyone can type {"portal_role":"agent"}.

   WHAT THIS IS AND IS NOT
   This keeps strangers out of the portal pages. It is NOT what protects
   client data — Row Level Security does that, in the database, on every
   query. If this function were deleted tomorrow, a stranger could load an
   empty page shell and still read nothing. That layering is deliberate:
   this layer is for the door, RLS is for the records.
   ===================================================================== */

import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5";

const COOKIE = "sb-portal-token";

/* Which role may open which branch. Agents are allowed into the client
   view so they can see what their clients see; the data they get there is
   still whatever RLS grants them, which is their own assigned rows. */
const RULES = [
  { prefix: "/portal/agent/",  roles: ["agent"] },
  { prefix: "/portal/client/", roles: ["client", "agent"] },
];

/* Anything under /portal/ that matches no rule above still requires a
   recognised portal role. This default matters: without it, adding a page
   at a new path under /portal/ would ship it to the open internet until
   somebody remembered to add a rule here. Widening access should take a
   deliberate edit; it should never be what happens by forgetting. */
const FALLBACK_ROLES = ["client", "agent"];

/* createRemoteJWKSet caches the fetched keys, so keep one instance across
   invocations rather than refetching per request. Supabase rotates signing
   keys; the set re-fetches on an unknown key id automatically. */
let jwks;
let jwksIssuer;

function getJwks(projectUrl) {
  if (!jwks || jwksIssuer !== projectUrl) {
    jwks = createRemoteJWKSet(new URL(`${projectUrl}/auth/v1/.well-known/jwks.json`));
    jwksIssuer = projectUrl;
  }
  return jwks;
}

function bounce(request, reason) {
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  const to = new URL("/login.html", url.origin);
  to.searchParams.set("next", next);
  if (reason) to.searchParams.set("why", reason);
  return Response.redirect(to.toString(), 302);
}

export default async function handler(request, context) {
  const url = new URL(request.url);

  const rule =
    RULES.find((r) => url.pathname.startsWith(r.prefix)) ||
    { prefix: "/portal/", roles: FALLBACK_ROLES };

  const projectUrl = Deno.env.get("SUPABASE_URL");
  if (!projectUrl) {
    /* Misconfiguration must fail CLOSED. An unset variable that let
       everyone through would be a silent hole nobody notices, because
       nothing appears broken. */
    console.error("[portal-gate] SUPABASE_URL is not set — denying access");
    return bounce(request, "unconfigured");
  }

  const token = context.cookies.get(COOKIE);
  if (!token) return bounce(request);

  let payload;
  try {
    const verified = await jwtVerify(token, getJwks(projectUrl), {
      issuer: `${projectUrl}/auth/v1`,
      /* jose enforces exp and nbf on its own; clockTolerance covers the
         small drift between Supabase's clock and the edge node's. */
      clockTolerance: 5,
    });
    payload = verified.payload;
  } catch (err) {
    /* Expired, tampered with, or signed by something else. All the same
       answer: back to the login page. */
    return bounce(request, "expired");
  }

  const role = payload?.app_metadata?.portal_role;
  if (!role || !rule.roles.includes(role)) return bounce(request, "role");

  return context.next();
}

export const config = {
  path: "/portal/*",
  /* Excluded so the gate itself cannot lock out the assets the portal
     pages need to render once someone is through it. */
  excludedPath: ["/portal/*.css", "/portal/*.js", "/portal/*.png", "/portal/*.jpg"],
};
