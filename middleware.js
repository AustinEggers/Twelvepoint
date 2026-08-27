/* =====================================================================
   middleware.js — server-side access control for /portal/*

   This is the Vercel port of netlify/edge-functions/portal-gate.js. It
   runs at Vercel's edge before any portal HTML is served.

   IT IS THE ONLY THING KEEPING STRANGERS OUT OF THE PORTAL PAGES. If this
   file stops running — renamed, matcher narrowed, deps missing — the
   portal is served to the open internet with no error anywhere. After any
   change here, re-run the four-step check in PORTAL-SETUP.md against the
   deployed site, not localhost.

   It verifies the Supabase access token properly: signature checked
   against the project's public JWKS, plus issuer and expiry. It does not
   merely decode the payload and read the role — an unverified JWT is a
   string the visitor typed, and anyone can type {"portal_role":"agent"}.

   WHAT THIS IS AND IS NOT
   This guards the door. It is NOT what protects client data — Row Level
   Security does that, in Postgres, on every query. If this file vanished,
   a stranger could load an empty page shell and still read nothing.
   ===================================================================== */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { next } from "@vercel/functions";

const COOKIE = "sb-portal-token";

/* Which role may open which branch.

   There is deliberately no /portal/admin/. An admin signs in on the same
   Agent tab as everyone else and lands in the agent portal; the extra
   powers appear inside it because of their role, not because of a
   separate address. Nothing on the public site hints that an admin tier
   exists, and there is no admin-only URL to discover or guess.

   Staff are allowed into the client view so they can see what a client
   sees; the data they get there is still whatever RLS grants them. */
const RULES = [
  { prefix: "/portal/agent/",  roles: ["agent", "admin"] },
  { prefix: "/portal/client/", roles: ["client", "agent", "admin"] },
];

/* Anything under /portal/ matching no rule above still requires a
   recognised portal role. This default matters: without it, adding a page
   at a new path under /portal/ would ship it to the open internet until
   somebody remembered to add a rule. Widening access should take a
   deliberate edit; it must never be what happens by forgetting. */
const FALLBACK_ROLES = ["client", "agent", "admin"];

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

/* Vercel's framework-agnostic middleware gets a plain Request, so there is
   no cookies helper — parse the header. Split on the first "=" only: a JWT
   contains no "=" but a future cookie value might, and truncating a token
   would fail in a way that looks like an expired session. */
function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const raw = part.trim();
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    if (raw.slice(0, eq) === name) return raw.slice(eq + 1);
  }
  return null;
}

function bounce(request, reason) {
  const url = new URL(request.url);
  const to = new URL("/login.html", url.origin);
  to.searchParams.set("next", url.pathname + url.search);
  if (reason) to.searchParams.set("why", reason);
  return Response.redirect(to.toString(), 302);
}

export default async function middleware(request) {
  const url = new URL(request.url);

  const rule =
    RULES.find((r) => url.pathname.startsWith(r.prefix)) ||
    { prefix: "/portal/", roles: FALLBACK_ROLES };

  const projectUrl = process.env.SUPABASE_URL;
  if (!projectUrl) {
    /* Misconfiguration must fail CLOSED. An unset variable that let
       everyone through would be a silent hole nobody notices, because
       nothing appears broken. */
    console.error("[portal-gate] SUPABASE_URL is not set — denying access");
    return bounce(request, "unconfigured");
  }

  const token = readCookie(request, COOKIE);
  if (!token) return bounce(request);

  let payload;
  try {
    const verified = await jwtVerify(token, getJwks(projectUrl), {
      issuer: `${projectUrl}/auth/v1`,
      /* jose enforces exp and nbf itself; clockTolerance covers the small
         drift between Supabase's clock and the edge node's. */
      clockTolerance: 5,
    });
    payload = verified.payload;
  } catch {
    /* Expired, tampered with, or signed by something else. Same answer to
       all three: back to the login page. */
    return bounce(request, "expired");
  }

  const role = payload?.app_metadata?.portal_role;
  if (!role || !rule.roles.includes(role)) return bounce(request, "role");

  return next();
}

export const config = {
  matcher: "/portal/:path*",
};
