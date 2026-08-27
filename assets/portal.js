/* =====================================================================
   portal.js — Supabase Auth and rendering for the TwelvePoint portal.

   WHAT ACTUALLY PROTECTS THINGS
   -----------------------------
   Two layers, and neither of them is this file.

   1. Row Level Security in Postgres. Every table has RLS on and a policy
      keyed to auth.uid(). Queries here send no client id and no
      transaction filter for authorisation — they ask for what they want
      and the database returns only what belongs to the caller.

   2. netlify/edge-functions/portal-gate.js verifies the token and role
      before serving anything under /portal/.

   Anything this file decides is convenience. Treat every value it touches
   as attacker-controlled: all database strings reach the DOM through
   textContent, never innerHTML.
   ===================================================================== */
(function () {
  "use strict";

  var CFG = window.SUPABASE_CONFIG || {};
  var LIB = window.supabase;
  var COOKIE = "sb-portal-token";
  var LOGIN  = "/login.html";

  /* Set once the session is known. Decides what gets RENDERED and nothing
     else — never what may be read. RLS answers that, in the database. */
  var STAFF = false;

  var configured =
    LIB &&
    CFG.url && CFG.url.indexOf("REPLACE-WITH") === -1 &&
    CFG.publishableKey && CFG.publishableKey.indexOf("REPLACE-WITH") === -1;

  var sb = configured ? LIB.createClient(CFG.url, CFG.publishableKey) : null;

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   /* never innerHTML */
    return n;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function fmtDate(v) {
    if (!v) return "";
    var d = new Date(String(v).length <= 10 ? v + "T00:00:00" : v);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtDateTime(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d)) return "";
    return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  /* ------------------------------------------------------------------ */
  /* session cookie mirror                                               */
  /* ------------------------------------------------------------------ */
  /* supabase-js keeps its session in localStorage, which the edge
     function cannot read, so the access token is mirrored to a cookie.
     Not HttpOnly, because script sets it — but the same token is already
     in localStorage, so this grants script nothing new. */
  function setCookie(token) {
    var secure = location.protocol === "https:" ? "; secure" : "";
    document.cookie = COOKIE + "=" + token + "; path=/; samesite=lax" + secure;
  }
  function clearCookie() {
    document.cookie = COOKIE + "=; path=/; max-age=0; samesite=lax";
  }
  if (sb) {
    sb.auth.onAuthStateChange(function (event, session) {
      if (session && session.access_token) setCookie(session.access_token);
      else clearCookie();
    });
  }

  /* Roles live in app_metadata, never user_metadata — the latter is
     writable by the account holder. */
  function roleOf(session) {
    var m = (session && session.user && session.user.app_metadata) || {};
    return m.portal_role || null;
  }
  /* Admins land in the agent portal, not somewhere separate. The login page
     shows two tabs and always will; which of them someone clicks changes
     nothing, because the destination comes from the role on the account. */
  function homeFor(session) {
    var r = roleOf(session);
    if (r === "admin" || r === "agent") return "/portal/agent/";
    if (r === "client") return "/portal/client/";
    return null;
  }

  /* ================================================================== */
  /* login page                                                          */
  /* ================================================================== */
  function initLogin() {
    var forms = $$("[data-portal-login]");
    if (!forms.length) return;

    var next = new URLSearchParams(location.search).get("next");
    if (!next || next.charAt(0) !== "/" || next.slice(0, 2) === "//") next = null;

    forms.forEach(function (form) {
      var status = $("[data-portal-status]", form);
      var submit = $("button[type=submit]", form);
      var label  = submit ? submit.innerHTML : "";

      function say(msg, kind) {
        if (!status) return;
        status.textContent = msg || "";
        status.className = "portal__status" + (kind ? " portal__status--" + kind : "");
        status.hidden = !msg;
      }
      function release() { if (submit) { submit.disabled = false; submit.innerHTML = label; } }

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!configured) {
          say("Sign-in is not configured yet — assets/supabase-config.js still has its placeholder values. See PORTAL-SETUP.md.", "err");
          return;
        }
        var email = form.elements.email.value.trim();
        var pass  = form.elements.password.value;
        if (!email || !pass) { say("Enter your email and password.", "err"); return; }

        if (submit) { submit.disabled = true; submit.textContent = "Signing in…"; }
        say("");

        sb.auth.signInWithPassword({ email: email, password: pass })
          .then(function (res) {
            if (res.error) throw res.error;
            setCookie(res.data.session.access_token);
            var dest = next || homeFor(res.data.session);
            if (!dest) {
              say("You are signed in, but this account has not been given portal access yet. Your agent or the broker needs to grant it.", "warn");
              release();
              return;
            }
            location.assign(dest);
          })
          .catch(function (err) {
            /* Vague on purpose: naming which half was wrong confirms
               whether an email is registered. */
            var m = (err && err.message) || "";
            say(/confirm/i.test(m) ? "Check your email and confirm your account first."
              : /rate|too many/i.test(m) ? "Too many attempts. Wait a minute and try again."
              : "That email and password do not match an account.", "err");
            release();
          });
      });
    });

    $$("[data-portal-recover]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var form = a.closest("form");
        var status = form && $("[data-portal-status]", form);
        function say(msg, kind) {
          if (!status) return;
          status.textContent = msg;
          status.className = "portal__status" + (kind ? " portal__status--" + kind : "");
          status.hidden = false;
        }
        if (!configured) { say("Not configured yet — see PORTAL-SETUP.md.", "err"); return; }
        var email = form && form.elements.email.value.trim();
        if (!email) { say("Enter your email address first, then press this again.", "warn"); return; }

        sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + LOGIN })
          .then(function () {
            /* Same message either way, or this becomes a way to find out
               which of your clients has an account. */
            say("If that address has an account, a reset link is on its way.", "warn");
          })
          .catch(function () { say("Could not send a reset link just now. Call 713-828-4185.", "err"); });
      });
    });

    /* ---------------------------------------------------------------- */
    /* Google sign-in                                                    */
    /* ---------------------------------------------------------------- */
    /* Same account system as email/password — Supabase creates the user,
       the database trigger grants 'client', and RLS decides the rest.
       Nothing about the role is negotiated in the browser. */
    /* Hidden until CFG.enableGoogle is true. The button is only useful once
       Google Cloud, Supabase and the redirect URI all agree; before that it
       leads to a Google error page, so it should not be on screen. */
    if (!CFG.enableGoogle) {
      $$("[data-portal-google], .portal__or").forEach(function (n) { n.hidden = true; });
    }

    $$("[data-portal-google]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var status = $("[data-portal-status]");
        function say(msg, kind) {
          if (!status) return;
          status.textContent = msg;
          status.className = "portal__status" + (kind ? " portal__status--" + kind : "");
          status.hidden = false;
        }
        if (!configured) { say("Sign-in is not configured yet. See PORTAL-SETUP.md.", "err"); return; }

        btn.disabled = true;
        sb.auth.signInWithOAuth({
          provider: "google",
          options: {
            /* Come back to the login page rather than straight to the
               portal: this page knows how to read the role and route, and
               how to wait when the role has not landed yet (below). */
            redirectTo: location.origin + LOGIN + (next ? "?next=" + encodeURIComponent(next) : "")
          }
        }).then(function (res) {
          if (res.error) { btn.disabled = false; say("Could not reach Google just now. Try the password form.", "err"); }
        });
      });
    });
    /* No role is sent from here, and none should be. A database trigger
       grants every new account the client role server-side. If this form
       could name its own role, anyone could sign up as an agent and read
       every client file. */
    var signupForm = $("[data-portal-signup]");
    var clientPanel = document.getElementById("panel-client");

    function showSignup(on) {
      if (!signupForm || !clientPanel) return;
      signupForm.hidden = !on;
      /* Hide the sign-in form and its aside, leaving the tabs in place. */
      $$("#panel-client > *", document).forEach(function (n) {
        if (n === signupForm) return;
        if (n.hasAttribute("data-portal-signup")) return;
        n.hidden = on && !n.classList.contains("portal__tabs");
      });
      if (on) { var f = $("#s-name"); if (f) f.focus(); }
    }
    $$("[data-portal-showsignup]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); showSignup(true); });
    });
    $$("[data-portal-showsignin]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); showSignup(false); });
    });

    if (signupForm) {
      var sStatus = $("[data-portal-status]", signupForm);
      var sBtn = $("button[type=submit]", signupForm);
      var sLabel = sBtn ? sBtn.innerHTML : "";
      function sSay(msg, kind) {
        if (!sStatus) return;
        sStatus.textContent = msg || "";
        sStatus.className = "portal__status" + (kind ? " portal__status--" + kind : "");
        sStatus.hidden = !msg;
      }

      signupForm.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!configured) { sSay("Sign-up is not configured yet. See PORTAL-SETUP.md.", "err"); return; }

        var name  = signupForm.elements.full_name.value.trim();
        var email = signupForm.elements.email.value.trim();
        var pass  = signupForm.elements.password.value;
        if (!name || !email)  { sSay("Enter your name and email.", "err"); return; }
        if (pass.length < 8)  { sSay("Use a password of at least 8 characters.", "err"); return; }

        if (sBtn) { sBtn.disabled = true; sBtn.textContent = "Creating…"; }
        sSay("");

        sb.auth.signUp({
          email: email,
          password: pass,
          options: {
            /* full_name lands in user_metadata, which the account holder
               may edit. That is fine for a display name and is exactly why
               the role does NOT live there. */
            data: { full_name: name },
            /* Back to the LOGIN page, never straight to /portal/.
               The confirmation link arrives with tokens in the URL hash and
               no cookie set yet — and /portal/ is gated on that cookie, so
               the edge would bounce them straight back out. The login page
               is ungated: it reads the hash, sets the cookie, then routes by
               role. It also does not depend on directory-index behaviour,
               which differs between the local server and the host. */
            emailRedirectTo: location.origin + LOGIN
          }
        }).then(function (res) {
          if (sBtn) { sBtn.disabled = false; sBtn.innerHTML = sLabel; }
          if (res.error) throw res.error;

          /* With email confirmation on, Supabase returns a user but no
             session, and returns the same shape for an address that is
             already registered — so this message must not imply either
             way, or it becomes a way to test whether someone has an
             account here. */
          if (!res.data.session) {
            sSay("Check your email to confirm the address, then sign in.", "warn");
            return;
          }
          setCookie(res.data.session.access_token);
          location.assign("/portal/client/");
        }).catch(function (err) {
          var m = (err && err.message) || "";
          if (sBtn) { sBtn.disabled = false; sBtn.innerHTML = sLabel; }
          sSay(/password/i.test(m) ? "That password was rejected — try a longer one."
             : /rate|too many/i.test(m) ? "Too many attempts. Wait a minute and try again."
             : "That did not work. Check the address and try again.", "err");
        });
      });
    }

    /* Send a signed-in visitor to their side of the portal.
       THE RETRY IS NOT OPTIONAL. On a brand new account the role is granted
       by a database trigger just after the user row is created, and the
       first access token can be minted before that lands — most visibly on
       a first Google sign-in, where there is no email-confirmation round
       trip to absorb the gap. Without one refresh, a new user's very first
       visit tells them they have no portal access, which is both wrong and
       alarming. One retry, then believe the answer. */
    var roleRetried = false;
    function routeSignedIn(session) {
      var dest = next || homeFor(session);
      if (dest) { location.replace(dest); return; }

      if (!roleRetried) {
        roleRetried = true;
        sb.auth.refreshSession().then(function (res) {
          var fresh = res.data && res.data.session;
          var d = fresh && (next || homeFor(fresh));
          if (d) { setCookie(fresh.access_token); location.replace(d); return; }
          noRole();
        }, noRole);
        return;
      }
      noRole();
    }

    function noRole() {
      var s = $("[data-portal-status]");
      if (!s) return;
      s.textContent = "You are signed in, but this account has not been given portal " +
                      "access yet. Your agent or the broker needs to grant it.";
      s.className = "portal__status portal__status--warn";
      s.hidden = false;
    }

    if (sb) {
      sb.auth.onAuthStateChange(function (event, session) {
        if (event === "PASSWORD_RECOVERY") {
          var s = $("[data-portal-status]");
          if (s) { s.textContent = "Enter a new password below, then press Sign in."; s.className = "portal__status portal__status--warn"; s.hidden = false; }
          return;
        }
        if ((event === "INITIAL_SESSION" || event === "SIGNED_IN") && session) {
          routeSignedIn(session);
        }
      });
    }
  }

  /* ================================================================== */
  /* signed-in pages                                                     */
  /* ================================================================== */
  function initPortal() {
    var root = $("[data-portal-page]");
    if (!root) return;

    $$("[data-portal-logout]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        btn.disabled = true;
        var done = function () { clearCookie(); location.assign(LOGIN); };
        if (sb) sb.auth.signOut().then(done, done); else done();
      });
    });

    if (!sb) { renderUnconfigured(); return; }

    sb.auth.getSession().then(function (res) {
      var session = res.data.session;
      if (!session) {
        /* The edge gate should have caught this; reaching here means the
           session lapsed while the page sat open. */
        location.replace(LOGIN + "?next=" + encodeURIComponent(location.pathname + location.search));
        return;
      }
      setCookie(session.access_token);

      var u = session.user;
      var name = (u.user_metadata && u.user_metadata.full_name) || u.email;
      $$("[data-portal-name]").forEach(function (n) { n.textContent = name; });

      /* Reveal admin-only controls. This is presentation only — hiding a
         button stops nobody. What actually stops a non-admin creating a
         transaction is the RLS policy, which re-checks the role in the
         database on every insert. */
      var role = roleOf(session);
      STAFF = (role === "admin" || role === "agent");
      if (STAFF) {
        $$("[data-staff-only]").forEach(function (n) { n.hidden = false; });
      }
      if (role === "admin") {
        $$("[data-admin-only]").forEach(function (n) { n.hidden = false; });
        $$("[data-portal-rolelabel]").forEach(function (n) { n.textContent = "Admin"; });
      }

      if ($("[data-staff-detail]")) initStaffDetail(session);
      else if ($("[data-portal-detail]")) loadDetail(session);
      else if ($("[data-leads-list]")) initLeads(session, role);
      else if ($("[data-team-list]")) initTeam(session, role);
      else if ($("[data-txn-list]")) { loadList(); initNewTransaction(session, role); }
    });
  }

  function renderUnconfigured() {
    /* Without this the page sits on "Loading…" forever, which reads as
       broken rather than unfinished. */
    var msg = LIB
      ? "The portal is not configured yet — assets/supabase-config.js still has its placeholder values."
      : "Could not reach the sign-in service. Check your connection, or call 713-828-4185.";
    [ $("[data-txn-list]"), $("[data-dtl-error]") ].forEach(function (host) {
      if (!host) return;
      clear(host);
      host.hidden = false;
      host.textContent = msg;
      host.className = "note note--err";
    });
  }

  /* ------------------------------------------------------------------ */
  /* transaction list                                                    */
  /* ------------------------------------------------------------------ */
  var MILESTONES = [
    { key: "ms_earnest_money", label: "Earnest money" },
    { key: "ms_title_commit",  label: "Title commitment" },
    { key: "ms_hoa_docs",      label: "HOA docs" },
    { key: "ms_loan_docs",     label: "Loan docs" },
    { key: "ms_ready_close",   label: "Ready to close" }
  ];
  /* Glyph as well as colour, so the strip still reads without colour. */
  var MS_STATE = {
    complete: { cls: "complete", glyph: "✓", word: "complete" },
    blocked:  { cls: "blocked",  glyph: "×", word: "needs attention" },
    na:       { cls: "na",       glyph: "–", word: "not applicable" }
  };
  function msState(v) {
    return MS_STATE[v] || { cls: "pending", glyph: "·", word: "pending" };
  }

  function loadList() {
    var host = $("[data-txn-list]");
    var count = $("[data-txn-count]");

    /* No client id in this query. RLS decides what "my transactions"
       means for whoever is asking. */
    var COLS = "id, file_number, address, kind, status, closing_status, expected_close, updated_at, " +
               MILESTONES.map(function (m) { return m.key; }).join(", ");

    /* The embedded profile is what puts a client's name on the row. A client
       reading their own list gets their own name back, which is harmless;
       staff get the name of whoever the file belongs to, which is the point.
       RLS decides both — the query is the same either way. */
    var WITH_NAME = COLS + ", client:profiles!transactions_client_profile_fkey(full_name)";

    function show(rows) {
      if (count) count.textContent = rows.length === 1 ? "1 transaction" : rows.length + " transactions";
      renderList(host, rows);
    }

    /* The embed needs a foreign key that arrives with a later migration. If
       the database has not been migrated yet, PostgREST cannot resolve the
       relationship and fails the WHOLE query — so a pending migration would
       otherwise black out the page rather than merely omit a name.
       Retry once without the embed instead. */
    sb.from("transactions").select(WITH_NAME).order("updated_at", { ascending: false })
      .then(function (res) {
        if (!res.error) { show(res.data || []); return; }

        var missingRelationship = res.error.code === "PGRST200" ||
          /relationship|schema cache|foreign key/i.test(res.error.message || "");
        if (!missingRelationship) {
          fail(host, res.error, "Could not load your transactions just now.");
          if (count) count.textContent = "";
          return;
        }
        if (window.console) console.warn("[portal] client names need the Part 6 migration — run supabase/schema.sql");

        sb.from("transactions").select(COLS).order("updated_at", { ascending: false })
          .then(function (r2) {
            if (r2.error) {
              fail(host, r2.error, "Could not load your transactions just now.");
              if (count) count.textContent = "";
              return;
            }
            show(r2.data || []);
          });
      });
  }

  function renderList(host, rows) {
    clear(host);
    if (!rows.length) {
      var e = el("div", "empty");
      e.appendChild(el("h3", null, "Nothing here yet"));
      e.appendChild(el("p", null, "When we start working together, your purchase or sale will appear here."));
      host.appendChild(e);
      return;
    }

    var list = el("div", "txnlist");
    rows.forEach(function (t) {
      var row = el("div", "txn");
      /* Staff open the dashboard; clients open their own view. Same row,
         two very different pages. */
      var href = (STAFF ? "/portal/agent/transaction.html?id="
                        : "/portal/client/transaction.html?id=") + encodeURIComponent(t.id);

      var left = el("div");
      if (t.file_number) {
        var f = el("a", "txn__file", t.file_number);
        f.href = href;
        left.appendChild(f);
      }
      var a = el("a", "txn__addr", t.address || "Your property");
      a.href = href;
      left.appendChild(a);

      /* Whose file this is. Only rendered on the staff side — a client
         already knows their own name, and seeing it labelled back at them
         reads oddly. */
      var who = t.client && t.client.full_name;
      if (who && STAFF) left.appendChild(el("span", "txn__client", who));

      row.appendChild(left);

      var right = el("div", "txn__right");
      var closed = t.closing_status === "closed";
      var cancelled = t.closing_status === "cancelled";
      right.appendChild(el("span", "pill " + (closed ? "pill--closed" : cancelled ? "pill--quiet" : "pill--open"),
        closed ? "Closed" : cancelled ? "Cancelled" : "In process"));
      if (t.expected_close) {
        right.appendChild(el("span", "txn__date",
          (closed ? "Closed " : "Expected ") + fmtDate(t.expected_close)));
      }
      row.appendChild(right);

      var ms = el("ul", "ms");
      MILESTONES.forEach(function (m) {
        var st = msState(t[m.key]);
        var li = el("li", "ms__item");
        var dot = el("span", "ms__dot ms__dot--" + st.cls, st.glyph);
        /* The visible glyph is decorative; the real state is announced. */
        dot.setAttribute("aria-hidden", "true");
        var lab = el("span", "ms__label", m.label);
        li.appendChild(dot);
        li.appendChild(lab);
        li.setAttribute("title", m.label + " — " + st.word);
        var sr = el("span", "sr-only", m.label + ": " + st.word);
        li.appendChild(sr);
        ms.appendChild(li);
      });
      row.appendChild(ms);

      list.appendChild(row);
    });
    host.appendChild(list);
  }

  /* ------------------------------------------------------------------ */
  /* admin: create a transaction                                         */
  /* ------------------------------------------------------------------ */
  /* Replaces opening the Supabase Table Editor. Only rendered for admins,
     and only *accepted* for admins — the insert is checked again by RLS. */
  function initNewTransaction(session, role) {
    var form = $("[data-newtxn-form]");
    if (!form || (role !== "admin" && role !== "agent")) return;

    var status = $("[data-newtxn-status]", form);
    var submit = $("button[type=submit]", form);
    var label = submit ? submit.innerHTML : "";

    function say(msg, err) {
      if (!status) return;
      status.textContent = msg || "";
      status.className = "note" + (err ? " note--err" : "");
      status.hidden = !msg;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = form.elements;
      if (!f.client_email.value.trim()) { say("Enter the client's email.", true); return; }
      if (!f.address.value.trim())      { say("Enter the property address.", true); return; }

      if (submit) { submit.disabled = true; submit.textContent = "Creating…"; }
      say("");

      /* One database function rather than a raw insert: it looks the client
         up by email, creates the file, and links client to agent together.
         An agent cannot read a profile that is not theirs yet, so a plain
         insert could never name a brand new client. */
      sb.rpc("create_transaction", {
        p_client_email:   f.client_email.value.trim(),
        p_address:        f.address.value.trim(),
        p_kind:           f.kind.value,
        p_file_number:    f.file_number.value.trim() || null,
        p_status:         f.status.value.trim() || null,
        p_expected_close: f.expected_close.value || null
      }).then(function (res) {
        if (submit) { submit.disabled = false; submit.innerHTML = label; }
        if (res.error) {
          fail(null, res.error);
          /* The function raises readable messages for the cases someone
             will actually hit — no such account, missing address — so pass
             those straight through instead of burying them. */
          say(res.error.message || "Could not create it.", true);
          return;
        }
        form.reset();
        say("Created. Reloading…");
        location.reload();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* admin: the team                                                     */
  /* ------------------------------------------------------------------ */
  function initTeam(session, role) {
    var host = $("[data-team-list]");
    if (!host || role !== "admin") return;

    function load() {
      sb.rpc("staff_directory").then(function (res) {
        if (res.error) { fail(host, res.error, "Could not load the team."); return; }
        render(res.data || []);
      });
    }

    function render(rows) {
      clear(host);
      var wrap = el("div", "docwrap");
      var table = el("table", "docs");
      var thead = el("thead"), hr = el("tr");
      ["Name", "Email", "Role", ""].forEach(function (h) { hr.appendChild(el("th", null, h)); });
      thead.appendChild(hr); table.appendChild(thead);

      var tb = el("tbody");
      rows.forEach(function (u) {
        var tr = el("tr");
        tr.appendChild(el("td", null, u.full_name || "—"));
        tr.appendChild(el("td", "docs__date", u.email));

        var td = el("td");
        var sel = el("select");
        ["client", "agent", "admin"].forEach(function (r) {
          var o = el("option", null, r.charAt(0).toUpperCase() + r.slice(1));
          o.value = r;
          if (u.role === r) o.selected = true;
          sel.appendChild(o);
        });

        var self = u.id === session.user.id;
        if (self) {
          /* Matches the database guard. An admin who demotes themselves
             locks the role out of the UI entirely, recoverable only from
             the SQL editor — so the control is not offered at all. */
          sel.disabled = true;
          sel.title = "You cannot change your own role";
        }
        td.appendChild(sel);
        tr.appendChild(td);

        var act = el("td");
        if (!self) {
          var btn = el("button", "btn btn--ghost btn--sm", "Save");
          btn.type = "button";
          btn.addEventListener("click", function () {
            btn.disabled = true; btn.textContent = "Saving…";
            sb.rpc("set_portal_role", { p_email: u.email, p_role: sel.value })
              .then(function (r2) {
                btn.disabled = false; btn.textContent = "Save";
                if (r2.error) { fail(null, r2.error); alert(r2.error.message || "Could not change that role."); return; }
                /* Roles ride inside the JWT, so this does nothing until
                   they next sign in. Say so, or it looks like it failed. */
                alert(u.email + " is now " + sel.value + ".\n\nIt takes effect the next time they sign in.");
                load();
              });
          });
          act.appendChild(btn);
        }
        tr.appendChild(act);
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      wrap.appendChild(table);
      host.appendChild(wrap);
    }

    load();
  }

  /* ------------------------------------------------------------------ */
  /* transaction detail                                                  */
  /* ------------------------------------------------------------------ */
  function loadDetail(session) {
    var id = new URLSearchParams(location.search).get("id");
    var addr = $("[data-dtl-addr]");
    var err  = $("[data-dtl-error]");
    var body = $("[data-dtl-body]");

    function bail(msg) {
      if (addr) addr.textContent = "Transaction";
      if (err) { err.textContent = msg; err.hidden = false; }
    }
    if (!id) { bail("No transaction was specified. Go back and pick one from your list."); return; }

    sb.from("transactions").select("*").eq("id", id).maybeSingle()
      .then(function (res) {
        if (res.error) { fail(err, res.error, "Could not load this transaction."); return; }
        var t = res.data;
        if (!t) {
          /* Either it does not exist or it is not theirs. Same message for
             both — distinguishing them would confirm the id is real. */
          bail("That transaction is not available on your account.");
          return;
        }
        if (addr) addr.textContent = t.address || "Your property";
        document.title = (t.address || "Transaction") + " — TwelvePoint Realty Group";
        if (body) body.hidden = false;

        renderOverview(t);
        initEdit(t);
        wireTabs();
        loadContacts(id);
        loadDocuments(id);
        loadMessages(id, session);
      });
  }

  var PROGRESS_LABEL = ["Under contract", "Option & inspection", "Ready for closing", "Closed"];

  function renderOverview(t) {
    var status = $("[data-dtl-status]");
    if (status) status.textContent = t.status || t.current_step || PROGRESS_LABEL[(t.progress_step || 1) - 1] || "In progress";

    var step = Number(t.progress_step) || 1;
    $$("[data-dtl-progress] .prog__step").forEach(function (li, i) {
      li.classList.remove("prog__step--done", "prog__step--now");
      if (i + 1 < step) li.classList.add("prog__step--done");
      if (i + 1 === step) { li.classList.add("prog__step--now"); li.setAttribute("aria-current", "step"); }
      else li.removeAttribute("aria-current");
    });

    /* Action items live in their own table now, so what staff add on the
       dashboard is what the client sees here. The legacy text[] column is
       still read as a fallback for any row that predates the migration and
       has not been backfilled. */
    var box = $("[data-dtl-actions]");
    var list = $("[data-dtl-actionlist]");
    if (!box || !list) return;

    sb.from("transaction_action_items")
      .select("title, note, due_date, status")
      .eq("transaction_id", t.id)
      .order("sort_order")
      .then(function (res) {
        var rows = (!res.error && res.data) ? res.data : null;

        if (!rows || !rows.length) {
          var legacy = t.action_items || [];
          if (!legacy.length) return;
          clear(list);
          legacy.forEach(function (s) { list.appendChild(el("li", null, s)); });
          box.hidden = false;
          return;
        }

        /* Completed items stay visible but struck through — a client who
           did the thing should see that it landed, not watch it vanish. */
        clear(list);
        rows.forEach(function (a) {
          var li = el("li", a.status === "complete" ? "actions__done" : null);
          li.appendChild(document.createTextNode(a.title));
          var bits = [];
          if (a.due_date) bits.push("due " + fmtDate(a.due_date));
          if (a.status === "complete") bits.push("done");
          if (bits.length) li.appendChild(el("span", "actions__meta", " — " + bits.join(", ")));
          if (a.note) li.appendChild(el("span", "actions__note", a.note));
          list.appendChild(li);
        });
        box.hidden = false;
      });
  }

  /* ------------------------------------------------------------------ */
  /* staff: edit a transaction                                           */
  /* ------------------------------------------------------------------ */
  function initEdit(t) {
    var form = $("[data-edit-form]");
    if (!form || !STAFF) return;

    var status = $("[data-edit-status]", form);
    var submit = $("button[type=submit]", form);
    var label = submit ? submit.innerHTML : "";
    var f = form.elements;

    function say(msg, err) {
      if (!status) return;
      status.textContent = msg || "";
      status.className = "note" + (err ? " note--err" : "");
      status.hidden = !msg;
    }

    /* Prefill from the record, so saving never silently blanks a field the
       editor did not touch. */
    f.status.value          = t.status || "";
    f.progress_step.value   = String(t.progress_step || 1);
    f.closing_status.value  = t.closing_status || "in_process";
    f.expected_close.value  = t.expected_close || "";
    f.file_number.value     = t.file_number || "";
    MILESTONES.forEach(function (m) {
      if (f[m.key]) f[m.key].value = t[m.key] || "";
    });
    f.action_items.value = (t.action_items || []).join("\n");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }
      say("");

      var patch = {
        status:         f.status.value.trim() || null,
        progress_step:  Number(f.progress_step.value),
        closing_status: f.closing_status.value,
        expected_close: f.expected_close.value || null,
        file_number:    f.file_number.value.trim() || null,
        /* Split on newlines and drop blanks, so a stray return does not
           become an empty bullet on the client's page. */
        action_items:   f.action_items.value.split("\n")
                          .map(function (s) { return s.trim(); })
                          .filter(function (s) { return s.length > 0; })
      };
      MILESTONES.forEach(function (m) {
        patch[m.key] = f[m.key] && f[m.key].value ? f[m.key].value : null;
      });

      sb.from("transactions").update(patch).eq("id", t.id).then(function (res) {
        if (submit) { submit.disabled = false; submit.innerHTML = label; }
        if (res.error) {
          fail(null, res.error);
          say(res.error.code === "42501"
                ? "The database refused that — this file may not be assigned to you."
                : "Could not save. " + (res.error.message || ""), true);
          return;
        }
        say("Saved. Reloading…");
        location.reload();
      });
    });
  }

  function wireTabs() {
    var tabs = $$(".tabs__tab");
    if (!tabs.length) return;

    function select(tab) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab); });
      /* Arrow-key roving, which is what a tablist is expected to do. */
      tab.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var next = tabs[(i + d + tabs.length) % tabs.length];
        select(next);
        next.focus();
      });
    });
  }

  /* ---- contacts ---- */
  function loadContacts(id) {
    var host = $("[data-dtl-contacts]");
    if (!host) return;
    sb.from("transaction_contacts")
      .select("id, role, company, person, phone, email, address")
      .eq("transaction_id", id)
      .order("sort_order", { ascending: true })
      .then(function (res) {
        if (res.error) { fail(host, res.error, "Could not load contacts."); return; }
        var rows = res.data || [];
        clear(host);
        if (!rows.length) {
          var e = el("div", "empty");
          e.appendChild(el("h3", null, "No contacts listed yet"));
          e.appendChild(el("p", null, "Everyone working on your file will appear here as they are added."));
          host.appendChild(e);
          return;
        }
        rows.forEach(function (c) {
          var card = el("div", "contact");
          card.appendChild(el("p", "contact__role", c.role || "Contact"));
          var b = el("div", "contact__body");
          if (c.company) b.appendChild(el("p", "contact__co", c.company));
          if (c.person)  b.appendChild(el("p", null, c.person));
          if (c.phone) {
            var pp = el("p");
            var pa = el("a", null, c.phone);
            pa.href = "tel:" + String(c.phone).replace(/[^0-9+]/g, "");
            pp.appendChild(pa);
            b.appendChild(pp);
          }
          if (c.email) {
            var ep = el("p");
            var ea = el("a", null, c.email);
            /* mailto only — a database string must never become an href
               scheme of its own choosing. */
            ea.href = "mailto:" + c.email;
            ep.appendChild(ea);
            b.appendChild(ep);
          }
          if (c.address) b.appendChild(el("p", "contact__where", c.address));
          card.appendChild(b);
          host.appendChild(card);
        });
      });
  }

  /* ---- documents ---- */
  function loadDocuments(id) {
    var host = $("[data-dtl-documents]");
    if (!host) return;
    sb.from("transaction_documents")
      .select("id, name, storage_path, status, created_at")
      .eq("transaction_id", id)
      .order("created_at", { ascending: false })
      .then(function (res) {
        if (res.error) { fail(host, res.error, "Could not load documents."); return; }
        var rows = res.data || [];
        clear(host);
        if (!rows.length) {
          var e = el("div", "empty");
          e.appendChild(el("h3", null, "No documents yet"));
          e.appendChild(el("p", null, "Anything we share with you during the transaction will be here."));
          host.appendChild(e);
          return;
        }

        var wrap = el("div", "docwrap");
        var table = el("table", "docs");
        var thead = el("thead");
        var hr = el("tr");
        ["Name", "Date", "Status"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
        thead.appendChild(hr);
        table.appendChild(thead);

        var tb = el("tbody");
        rows.forEach(function (d) {
          var tr = el("tr");

          var td1 = el("td");
          var a = el("a", "docs__name", d.name || "Document");
          a.href = "#";
          /* Files are private. The href is resolved to a short-lived
             signed URL at click time, so nothing durable is ever printed
             into the page for someone to copy or for a proxy to cache. */
          a.addEventListener("click", function (ev) {
            ev.preventDefault();
            if (a.dataset.busy) return;
            a.dataset.busy = "1";
            var was = a.textContent;
            a.textContent = "Preparing…";
            sb.storage.from("transaction-docs").createSignedUrl(d.storage_path, 60)
              .then(function (r) {
                a.textContent = was;
                delete a.dataset.busy;
                if (r.error || !r.data) { alert("That file could not be opened. Call 713-828-4185 and we will send it."); return; }
                window.open(r.data.signedUrl, "_blank", "noopener");
              });
          });
          td1.appendChild(a);
          tr.appendChild(td1);

          tr.appendChild(el("td", "docs__date", fmtDate(d.created_at)));

          var td3 = el("td");
          var s = d.status || "available";
          td3.appendChild(el("span", "pill " + (s === "received" ? "pill--good" : s === "needs_signature" ? "pill--open" : "pill--quiet"),
            s === "received" ? "Received" : s === "needs_signature" ? "Needs signature" : "Available"));
          tr.appendChild(td3);

          tb.appendChild(tr);
        });
        table.appendChild(tb);
        wrap.appendChild(table);
        host.appendChild(wrap);
      });
  }

  /* ---- messages ---- */
  function loadMessages(id, session) {
    var host = $("[data-dtl-messages]");
    var form = $("[data-msg-form]");
    if (!host) return;
    var me = session.user.id;

    function paint(rows) {
      clear(host);
      if (!rows.length) {
        var e = el("div", "empty");
        e.appendChild(el("h3", null, "No messages yet"));
        e.appendChild(el("p", null, "Anything written here goes to your agent and stays with the file."));
        host.appendChild(e);
        return;
      }
      rows.forEach(function (m) {
        var box = el("div", "msg" + (m.sender_id === me ? " msg--mine" : ""));
        box.appendChild(el("p", "msg__meta",
          (m.sender_id === me ? "You" : "TwelvePoint") + " · " + fmtDateTime(m.created_at)));
        box.appendChild(el("p", "msg__body", m.body));
        host.appendChild(box);
      });
    }

    function refresh() {
      return sb.from("transaction_messages")
        .select("id, sender_id, body, created_at")
        .eq("transaction_id", id)
        .order("created_at", { ascending: true })
        .then(function (res) {
          if (res.error) { fail(host, res.error, "Could not load messages."); return; }
          paint(res.data || []);
        });
    }
    refresh();

    if (!form) return;
    var status = $("[data-msg-status]", form);
    var submit = $("button[type=submit]", form);
    var label = submit ? submit.innerHTML : "";

    function say(msg, err) {
      if (!status) return;
      status.textContent = msg || "";
      status.className = "note" + (err ? " note--err" : "");
      status.hidden = !msg;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var body = form.elements.body.value.trim();
      if (!body) { say("Write something first.", true); return; }

      if (submit) { submit.disabled = true; submit.textContent = "Sending…"; }
      say("");

      /* sender_id is set from the session, and the RLS policy re-checks it
         server-side — so a message cannot be posted as someone else even
         if this line were tampered with. */
      sb.from("transaction_messages")
        .insert({ transaction_id: id, sender_id: me, body: body })
        .then(function (res) {
          if (submit) { submit.disabled = false; submit.innerHTML = label; }
          if (res.error) { fail(null, res.error); say("That message did not send. Call 713-828-4185.", true); return; }
          form.elements.body.value = "";
          refresh();
        });
    });
  }

  /* ------------------------------------------------------------------ */
  /* errors                                                              */
  /* ------------------------------------------------------------------ */
  /* Real reason to the console for whoever is debugging; never a database
     error in front of a client. */
  function fail(host, error, message) {
    if (window.console) console.error("[portal]", error);
    if (!host || !message) return;
    clear(host);
    host.hidden = false;
    var p = el("p", "note note--err", message + " Call 713-828-4185 and we will tell you where things stand.");
    if (host.tagName === "P") { host.className = "note note--err"; host.textContent = p.textContent; }
    else host.appendChild(p);
  }


  /* ================================================================== */
  /* STAFF TRANSACTION DASHBOARD                                         */
  /* ================================================================== */
  /* Drives portal/agent/transaction.html. Reads and writes the same rows
     the client page reads, so there is one source of truth and no sync
     step. Everything here is additionally enforced by RLS. */

  var MILE_DEFS = [
    { key: "ms_earnest_money",     label: "Earnest money" },
    { key: "ms_option_fee",        label: "Option fee" },
    { key: "ms_inspection",        label: "Inspection" },
    { key: "ms_repairs",           label: "Repair negotiations" },
    { key: "ms_title_commit",      label: "Title commitment" },
    { key: "ms_survey",            label: "Survey" },
    { key: "ms_hoa_docs",          label: "HOA documents" },
    { key: "ms_loan_docs",         label: "Loan approval" },
    { key: "ms_appraisal",         label: "Appraisal" },
    { key: "ms_ready_close",       label: "Clear to close" },
    { key: "ms_final_walkthrough", label: "Final walkthrough" },
    { key: "ms_closing",           label: "Closing" }
  ];

  /* Stored value -> label. null and 'not_started' are the same thing; both
     exist because older rows used null. */
  var MILE_STATES = [
    { v: "",         label: "Not started" },
    { v: "pending",  label: "Pending" },
    { v: "blocked",  label: "Needs attention" },
    { v: "complete", label: "Complete" }
  ];

  /* `deadline: false` means the date RECORDS something that happened rather
     than something owed — a contract date in the past is normal, not late.
     `done` names the milestone that settles the deadline: once that reads
     complete, the date stops being chased.

     Both matter. Without them the summary flags a past contract date and a
     paid earnest deposit on every single file, and a panel that cries wolf
     on every file is one nobody reads. */
  var DATE_FIELDS = [
    { key: "contract_date",      label: "Contract date",      deadline: false },
    { key: "earnest_due",        label: "Earnest money due",  done: "ms_earnest_money" },
    { key: "option_ends",        label: "Option period ends", done: "ms_inspection" },
    { key: "financing_deadline", label: "Financing approval", done: "ms_loan_docs" },
    { key: "appraisal_deadline", label: "Appraisal deadline", done: "ms_appraisal" },
    { key: "walkthrough_date",   label: "Final walkthrough",  done: "ms_final_walkthrough" },
    { key: "expected_close",     label: "Closing date",       done: "ms_closing" }
  ];

  var FILE_STATUS_LABEL = {
    active: "Active", on_hold: "On hold", terminated: "Terminated",
    closed: "Closed", in_process: "Active", cancelled: "Terminated"
  };

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var d = new Date(dateStr + "T00:00:00");
    if (isNaN(d)) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  }

  /* Wording, and how loud to be about it. Red is reserved for genuinely
     overdue — everything else is a quiet amber or nothing at all. */
  function deadlineFlag(days) {
    if (days === null) return null;
    if (days < 0)  return { text: Math.abs(days) + (Math.abs(days) === 1 ? " day past due" : " days past due"), tone: "bad" };
    if (days === 0) return { text: "Due today",    tone: "warn" };
    if (days === 1) return { text: "Due tomorrow", tone: "warn" };
    if (days <= 5)  return { text: "Due in " + days + " days", tone: "warn" };
    return { text: "In " + days + " days", tone: "calm" };
  }

  function initStaffDetail(session) {
    var root = $("[data-staff-detail]");
    if (!root) return;

    var id = new URLSearchParams(location.search).get("id");
    var errBox = $("[data-dtl-error]");
    var body = $("[data-dtl-body]");
    var bar = $("[data-savebar]");
    var saveState = $("[data-save-state]");

    function bail(msg) { if (errBox) { errBox.textContent = msg; errBox.hidden = false; } }
    if (!id) { bail("No transaction was specified."); return; }

    var TX = null;          /* the record as last loaded */
    var dirty = {};         /* pending edits, field -> value */

    /* ---------------------------------------------------------------- */
    function markDirty(field, value) {
      dirty[field] = value;
      if (bar) bar.hidden = false;
      if (saveState) { saveState.textContent = "Unsaved changes"; saveState.className = "savebar__state"; }
    }
    function clean(msg) {
      dirty = {};
      if (bar) bar.hidden = true;
      if (saveState) saveState.textContent = msg || "";
    }

    /* ---------------------------------------------------------------- */
    function ready(row) {
      TX = row;
      if (body) body.hidden = false;
      paint();
      loadActionItems();
      loadDocuments();
      loadInternal();
      loadAudit();
    }

    /* Same shape as the list page: try with the client name embedded, and
       fall back without it if the foreign key is not in PostgREST's schema
       cache yet. A pending migration should cost a name, not the page.

       This is a STAFF page, so a failure shows the real database message.
       A client gets a phone number; an agent gets something they can act
       on or paste to whoever can. */
    sb.from("transactions")
      .select("*, client:profiles!transactions_client_profile_fkey(full_name)")
      .eq("id", id).maybeSingle()
      .then(function (res) {
        if (!res.error) {
          if (!res.data) { bail("That transaction is not available on your account."); return; }
          ready(res.data);
          return;
        }
        if (window.console) console.error("[portal] embedded query failed:", res.error);

        sb.from("transactions").select("*").eq("id", id).maybeSingle().then(function (r2) {
          if (r2.error) {
            if (window.console) console.error("[portal] plain query failed:", r2.error);
            bail("Could not load this transaction — " +
                 (r2.error.message || "unknown error") +
                 (r2.error.code ? " (" + r2.error.code + ")" : ""));
            return;
          }
          if (!r2.data) { bail("That transaction is not available on your account."); return; }
          ready(r2.data);
        });
      });

    /* ---------------------------------------------------------------- */
    function paint() {
      document.title = (TX.address || "Transaction") + " — TwelvePoint Agent Portal";
      $("[data-dtl-addr]").textContent = TX.address || "Transaction";

      var who = TX.client && TX.client.full_name;
      $("[data-dtl-client]").textContent = who || "";
      $("[data-dtl-clientname]").textContent = who || "—";
      $("[data-dtl-agentname]").textContent =
        (session.user.user_metadata && session.user.user_metadata.full_name) || session.user.email;
      $("[data-dtl-filenumber]").textContent = TX.file_number ? "File " + TX.file_number : "";

      var fs = TX.closing_status || "active";
      var pill = $("[data-dtl-filestatus]");
      pill.textContent = FILE_STATUS_LABEL[fs] || fs;
      pill.className = "pill " + (fs === "closed" ? "pill--closed"
                                : fs === "terminated" || fs === "cancelled" ? "pill--quiet"
                                : fs === "on_hold" ? "pill--quiet" : "pill--open");

      paintStages();
      paintFields();
      paintMilestones();
      paintAttention();
    }

    /* ---- stages ---------------------------------------------------- */
    function paintStages() {
      var step = Number(TX.progress_step) || 1;
      $$("[data-stages] .tstage").forEach(function (b) {
        var n = Number(b.dataset.stage);
        b.classList.toggle("tstage--done", n < step);
        b.classList.toggle("tstage--now", n === step);
        b.setAttribute("aria-current", n === step ? "step" : "false");
      });
    }
    $$("[data-stages] .tstage").forEach(function (b) {
      b.addEventListener("click", function () {
        var n = Number(b.dataset.stage);
        if (!TX || n === Number(TX.progress_step)) return;
        var prev = TX.progress_step;
        TX.progress_step = n;
        paintStages();
        /* Written immediately rather than queued. Stage is what an agent
           changes mid-call, and the client should see it at once. */
        sb.from("transactions").update({ progress_step: n }).eq("id", id).then(function (r) {
          if (r.error) {
            TX.progress_step = prev; paintStages();
            fail(null, r.error);
            alert("Could not change the stage. " + (r.error.message || ""));
            return;
          }
          if (saveState) saveState.textContent = "Stage saved · client portal updated";
          if (bar) bar.hidden = false;
          paintAttention();
          loadAudit();
        });
      });
    });

    /* ---- plain fields ---------------------------------------------- */
    function paintFields() {
      $$("[data-fld]").forEach(function (input) {
        var k = input.dataset.fld;
        var v = TX[k];
        if (k === "closing_status") v = ({ in_process: "active", cancelled: "terminated" })[v] || v || "active";
        input.value = v == null ? "" : v;
        input.addEventListener("change", function () {
          var val = input.value === "" ? null : input.value;
          if (input.type === "number" && val !== null) val = Number(val);
          markDirty(k, val);
          if (DATE_FIELDS.some(function (d) { return d.key === k; })) { flagDates(); paintAttention(); }
        });
      });
      flagDates();
    }

    function flagDates() {
      $$("[data-dates] .dt").forEach(function (row) {
        var input = $(".f__in", row);
        var out = $(".dt__flag", row);
        var def = DATE_FIELDS.filter(function (d) { return d.key === input.dataset.fld; })[0] || {};

        /* Same rules as the summary, so the two never disagree — a field
           reading "past due" next to a panel that says nothing is worse
           than either alone. */
        if (def.deadline === false) { out.textContent = ""; out.className = "dt__flag"; return; }
        if (def.done && TX[def.done] === "complete") {
          out.textContent = "Complete";
          out.className = "dt__flag dt__flag--calm";
          return;
        }
        var f = deadlineFlag(daysUntil(input.value));
        out.textContent = f ? f.text : "";
        out.className = "dt__flag" + (f ? " dt__flag--" + f.tone : "");
      });
    }

    /* ---- milestones ------------------------------------------------ */
    function paintMilestones() {
      var host = $("[data-milestones]");
      clear(host);
      MILE_DEFS.forEach(function (m) {
        var row = el("div", "mile");
        row.appendChild(el("span", "mile__label", m.label));

        var group = el("div", "mile__opts");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", m.label);

        MILE_STATES.forEach(function (s) {
          var cur = TX[m.key] || "";
          if (cur === "na") cur = "";
          var b = el("button", "milebtn milebtn--" + (s.v || "none"), s.label);
          b.type = "button";
          if (cur === s.v) b.classList.add("is-on");
          b.setAttribute("aria-pressed", cur === s.v ? "true" : "false");
          b.addEventListener("click", function () {
            TX[m.key] = s.v || null;
            markDirty(m.key, s.v || null);
            paintMilestones();
            paintAttention();
          });
          group.appendChild(b);
        });
        row.appendChild(group);
        host.appendChild(row);
      });
    }

    /* ---- needs attention ------------------------------------------- */
    /* Derived, never stored. A stored summary is a summary that goes stale
       the moment someone edits the thing it summarises. */
    function paintAttention() {
      var host = $("[data-attention]");
      clear(host);
      var items = [];

      DATE_FIELDS.forEach(function (d) {
        if (d.deadline === false) return;                 /* a record, not a debt */
        if (d.done && TX[d.done] === "complete") return;  /* already settled */
        var input = $('[data-fld="' + d.key + '"]');
        var val = input ? input.value : TX[d.key];
        var f = deadlineFlag(daysUntil(val));
        if (f && (f.tone === "bad" || f.tone === "warn")) {
          items.push({ tone: f.tone, text: d.label + " — " + f.text.toLowerCase() });
        }
      });

      MILE_DEFS.forEach(function (m) {
        if (TX[m.key] === "blocked") items.push({ tone: "bad", text: m.label + " needs attention" });
        else if (TX[m.key] === "pending") items.push({ tone: "warn", text: m.label + " pending" });
      });

      (window.__AI_CACHE__ || []).forEach(function (a) {
        if (a.status === "needs_attention") items.push({ tone: "bad", text: "Client: " + a.title });
      });
      (window.__DOC_CACHE__ || []).forEach(function (d) {
        if (d.status === "missing") items.push({ tone: "warn", text: (d.name || "Document") + " missing" });
      });

      if (!items.length) {
        host.appendChild(el("li", "attn__none", "Nothing needs attention."));
        return;
      }
      var order = { bad: 0, warn: 1 };
      items.sort(function (a, b) { return order[a.tone] - order[b.tone]; });
      items.slice(0, 8).forEach(function (i) {
        var li = el("li", "attn__i attn__i--" + i.tone);
        li.appendChild(el("span", "attn__dot"));
        li.appendChild(el("span", null, i.text));
        host.appendChild(li);
      });
    }

    /* ---- client action items --------------------------------------- */
    function loadActionItems() {
      var host = $("[data-actionitems]");
      sb.from("transaction_action_items")
        .select("id, title, note, due_date, status, sort_order")
        .eq("transaction_id", id).order("sort_order").then(function (res) {
          if (res.error) { fail(host, res.error, "Could not load action items."); return; }
          window.__AI_CACHE__ = res.data || [];
          renderActionItems(host, window.__AI_CACHE__);
          paintAttention();
        });
    }

    function renderActionItems(host, rows) {
      clear(host);
      if (!rows.length) { host.appendChild(el("p", "muted", "Nothing for the client to do right now.")); return; }
      rows.forEach(function (a) {
        var row = el("div", "ai" + (a.status === "complete" ? " ai--done" : ""));
        var main = el("div", "ai__main");
        main.appendChild(el("span", "ai__title", a.title));
        var meta = [];
        if (a.due_date) meta.push("Due " + fmtDate(a.due_date));
        if (a.status === "needs_attention") meta.push("Needs attention");
        if (meta.length) main.appendChild(el("span", "ai__meta", meta.join(" · ")));
        row.appendChild(main);

        var acts = el("div", "ai__acts");
        var done = el("button", "btn btn--ghost btn--sm", a.status === "complete" ? "Reopen" : "Complete");
        done.type = "button";
        done.addEventListener("click", function () {
          var next = a.status === "complete" ? "pending" : "complete";
          sb.from("transaction_action_items").update({ status: next }).eq("id", a.id)
            .then(function (r) { if (r.error) { fail(null, r.error); alert("Could not update that item."); return; } loadActionItems(); });
        });
        acts.appendChild(done);

        var del = el("button", "btn btn--ghost btn--sm", "Remove");
        del.type = "button";
        del.addEventListener("click", function () {
          if (!confirm("Remove “" + a.title + "” from the client's list?")) return;
          sb.from("transaction_action_items").delete().eq("id", a.id)
            .then(function (r) { if (r.error) { fail(null, r.error); alert("Could not remove that item."); return; } loadActionItems(); });
        });
        acts.appendChild(del);
        row.appendChild(acts);
        host.appendChild(row);
      });
    }

    var aiForm = $("[data-ai-form]");
    if (aiForm) {
      aiForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var title = aiForm.elements.title.value.trim();
        if (!title) return;
        sb.from("transaction_action_items").insert({
          transaction_id: id,
          title: title,
          due_date: aiForm.elements.due_date.value || null,
          sort_order: ((window.__AI_CACHE__ || []).length + 1) * 10
        }).then(function (r) {
          if (r.error) { fail(null, r.error); alert("Could not add that. " + (r.error.message || "")); return; }
          aiForm.reset();
          loadActionItems();
        });
      });
    }

    /* ---- documents -------------------------------------------------- */
    function loadDocuments() {
      var host = $("[data-documents]");
      sb.from("transaction_documents")
        .select("id, name, doc_type, storage_path, status, client_visible, created_at")
        .eq("transaction_id", id).order("created_at").then(function (res) {
          if (res.error) { fail(host, res.error, "Could not load documents."); return; }
          window.__DOC_CACHE__ = res.data || [];
          renderDocuments(host, window.__DOC_CACHE__);
          paintAttention();
        });
    }

    function renderDocuments(host, rows) {
      clear(host);
      if (!rows.length) {
        host.appendChild(el("p", "muted", "No documents on this file yet."));
      } else {
        var wrap = el("div", "docwrap");
        var table = el("table", "docs");
        var thead = el("thead"), hr = el("tr");
        ["Document", "Status", "Shared", ""].forEach(function (h) { hr.appendChild(el("th", null, h)); });
        thead.appendChild(hr); table.appendChild(thead);
        var tb = el("tbody");

        rows.forEach(function (d) {
          var tr = el("tr");
          tr.appendChild(el("td", null, d.name || d.doc_type || "Document"));

          var st = el("td");
          var s = d.status || "waiting";
          st.appendChild(el("span", "pill " + (s === "uploaded" || s === "available" || s === "received" ? "pill--good"
                                             : s === "missing" ? "pill--open" : "pill--quiet"),
            s.charAt(0).toUpperCase() + s.slice(1).replace("_", " ")));
          tr.appendChild(st);

          /* The toggle mirrors the RLS rule. Unticked means the client's
             query does not return the row at all — not that it is merely
             hidden in this page. */
          var sh = el("td");
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = !!d.client_visible;
          cb.setAttribute("aria-label", "Share " + (d.name || "document") + " with the client");
          cb.addEventListener("change", function () {
            sb.from("transaction_documents").update({ client_visible: cb.checked }).eq("id", d.id)
              .then(function (r) {
                if (r.error) { cb.checked = !cb.checked; fail(null, r.error); alert("Could not change sharing."); return; }
                if (saveState) saveState.textContent = "Client portal updated";
                if (bar) bar.hidden = false;
              });
          });
          sh.appendChild(cb);
          tr.appendChild(sh);

          var act = el("td");
          if (d.storage_path) {
            var view = el("button", "btn btn--ghost btn--sm", "View");
            view.type = "button";
            view.addEventListener("click", function () {
              sb.storage.from("transaction-docs").createSignedUrl(d.storage_path, 60).then(function (r) {
                if (r.error || !r.data) { alert("Could not open that file."); return; }
                window.open(r.data.signedUrl, "_blank", "noopener");
              });
            });
            act.appendChild(view);
          }
          tr.appendChild(act);
          tb.appendChild(tr);
        });
        table.appendChild(tb); wrap.appendChild(table); host.appendChild(wrap);
      }

      /* Upload. Objects are keyed <transaction_id>/<file>, which is what the
         Storage policy reads to decide access. */
      var up = el("div", "upload");
      var input = document.createElement("input");
      input.type = "file";
      input.className = "f__in";
      input.setAttribute("aria-label", "Choose a document to upload");
      var btn = el("button", "btn btn--sm", "Upload");
      btn.type = "button";
      btn.addEventListener("click", function () {
        var file = input.files && input.files[0];
        if (!file) { alert("Choose a file first."); return; }
        btn.disabled = true; btn.textContent = "Uploading…";
        var path = id + "/" + Date.now() + "-" + file.name.replace(/[^\w.\-]+/g, "_");
        sb.storage.from("transaction-docs").upload(path, file).then(function (r) {
          if (r.error) { btn.disabled = false; btn.textContent = "Upload"; fail(null, r.error); alert("Upload failed. " + (r.error.message || "")); return; }
          sb.from("transaction_documents").insert({
            transaction_id: id, name: file.name, storage_path: path,
            status: "uploaded", client_visible: false, uploaded_by: session.user.id
          }).then(function (r2) {
            btn.disabled = false; btn.textContent = "Upload"; input.value = "";
            if (r2.error) { fail(null, r2.error); alert("Uploaded, but could not record it. " + (r2.error.message || "")); return; }
            loadDocuments();
          });
        });
      });
      up.appendChild(input); up.appendChild(btn);
      up.appendChild(el("p", "field__hint", "Uploads start unshared. Tick Shared to let the client see one."));
      host.appendChild(up);
    }

    /* ---- internal notes --------------------------------------------- */
    function loadInternal() {
      var ta = $("[data-internal-notes]");
      if (!ta) return;
      sb.from("transaction_internal").select("notes").eq("transaction_id", id).maybeSingle()
        .then(function (res) {
          if (!res.error && res.data) ta.value = res.data.notes || "";
          ta.addEventListener("input", function () { markDirty("__internal", ta.value); });
        });
    }

    /* ---- history ----------------------------------------------------- */
    function loadAudit() {
      var host = $("[data-audit]");
      if (!host) return;
      sb.from("transaction_audit")
        .select("field, old_value, new_value, actor_email, created_at")
        .eq("transaction_id", id).order("created_at", { ascending: false }).limit(25)
        .then(function (res) {
          clear(host);
          if (res.error) { fail(host, res.error, "Could not load history."); return; }
          var rows = res.data || [];
          if (!rows.length) { host.appendChild(el("p", "muted", "No changes recorded yet.")); return; }
          var ul = el("ul", "audit");
          rows.forEach(function (a) {
            var li = el("li", "audit__i");
            var name = (a.actor_email || "Someone").split("@")[0];
            li.appendChild(el("span", "audit__what",
              name + " changed " + prettyField(a.field) +
              (a.old_value ? " from " + a.old_value : "") +
              " to " + (a.new_value || "empty")));
            li.appendChild(el("span", "audit__when", fmtDateTime(a.created_at)));
            ul.appendChild(li);
          });
          host.appendChild(ul);
        });
    }

    function prettyField(f) {
      var m = MILE_DEFS.filter(function (x) { return x.key === f; })[0];
      if (m) return m.label;
      var d = DATE_FIELDS.filter(function (x) { return x.key === f; })[0];
      if (d) return d.label;
      return ({ progress_step: "the stage", closing_status: "file status",
                status: "the client status note", sales_price: "sales price",
                file_number: "file number", address: "the address",
                kind: "transaction type" })[f] || f;
    }

    /* ---- save -------------------------------------------------------- */
    $$("[data-save]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var keys = Object.keys(dirty);
        if (!keys.length) { clean("Nothing to save"); return; }

        btn.disabled = true;
        if (saveState) saveState.textContent = "Saving…";

        var notes = dirty.__internal;
        var patch = {};
        keys.forEach(function (k) { if (k !== "__internal") patch[k] = dirty[k]; });

        var jobs = [];
        if (Object.keys(patch).length) {
          jobs.push(sb.from("transactions").update(patch).eq("id", id));
        }
        if (notes !== undefined) {
          jobs.push(sb.from("transaction_internal")
            .upsert({ transaction_id: id, notes: notes, updated_by: session.user.id, updated_at: new Date().toISOString() },
                    { onConflict: "transaction_id" }));
        }

        Promise.all(jobs).then(function (results) {
          btn.disabled = false;
          var bad = results.filter(function (r) { return r && r.error; })[0];
          if (bad) {
            /* Never claim success before the database confirms it. */
            fail(null, bad.error);
            if (saveState) { saveState.textContent = "Could not save — " + (bad.error.message || "try again"); saveState.className = "savebar__state savebar__state--err"; }
            return;
          }
          /* Only mention the client portal when something they can see
             actually moved. */
          var clientFacing = keys.some(function (k) {
            return k !== "__internal" && k !== "file_number";
          });
          clean("Saved " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) +
                (clientFacing ? " · client portal updated" : ""));
          if (bar) bar.hidden = false;
          Object.keys(patch).forEach(function (k) { TX[k] = patch[k]; });
          paint();
          loadAudit();
        });
      });
    });

    /* A tab closed mid-edit loses the edit. Worth one prompt. */
    window.addEventListener("beforeunload", function (e) {
      if (Object.keys(dirty).length) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  /* ------------------------------------------------------------------ */
  /* staff: leads inbox                                                  */
  /* ------------------------------------------------------------------ */
  /* Reads public.leads, which only staff can select — RLS refuses the
     table entirely to clients and to anonymous callers. Writes go through
     /api/lead with the service role key, so nothing here inserts. */

  var LEAD_TYPE_LABEL = {
    contact: "General enquiry", buyer_inquiry: "Buyer", seller_inquiry: "Seller",
    property_inquiry: "Property enquiry", showing_request: "Showing request",
    home_valuation: "Home valuation", agent_contact: "Agent contact",
    join_team: "Join the team", newsletter: "Newsletter",
    consultation: "Consultation", community_inquiry: "Community", other: "Other"
  };

  var LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "archived", "spam"];

  function initLeads(session, role) {
    var host = $("[data-leads-list]");
    if (!host || (role !== "admin" && role !== "agent")) return;

    var countEl = $("[data-leads-count]");
    var filter = "all";
    var CACHE = [];

    $$("[data-lead-filter]").forEach(function (b) {
      b.addEventListener("click", function () {
        filter = b.dataset.leadFilter;
        $$("[data-lead-filter]").forEach(function (x) { x.classList.toggle("is-on", x === b); });
        render();
      });
    });

    function load() {
      sb.from("leads").select("*").order("created_at", { ascending: false }).limit(200)
        .then(function (res) {
          if (res.error) { fail(host, res.error, "Could not load leads."); return; }
          CACHE = res.data || [];
          render();
        });
    }

    function render() {
      var rows = filter === "all"
        ? CACHE.filter(function (l) { return l.status !== "archived" && l.status !== "spam"; })
        : CACHE.filter(function (l) { return l.status === filter; });

      if (countEl) {
        var fresh = CACHE.filter(function (l) { return l.status === "new"; }).length;
        countEl.textContent = rows.length + (rows.length === 1 ? " lead" : " leads") +
                              (fresh ? " · " + fresh + " new" : "");
      }

      clear(host);
      if (!rows.length) {
        var e = el("div", "empty");
        e.appendChild(el("h3", null, filter === "all" ? "No leads yet" : "Nothing here"));
        e.appendChild(el("p", null, filter === "all"
          ? "Every enquiry from the website lands here the moment it is submitted."
          : "No leads with that status."));
        host.appendChild(e);
        return;
      }

      rows.forEach(function (l) {
        var card = el("div", "leadcard" + (l.status === "new" ? " leadcard--new" : ""));

        var top = el("div", "leadcard__top");
        var who = el("div", "leadcard__who");
        who.appendChild(el("span", "leadcard__name", l.full_name || l.email || l.phone || "Someone"));
        who.appendChild(el("span", "leadcard__type", LEAD_TYPE_LABEL[l.form_type] || l.form_type));
        top.appendChild(who);
        top.appendChild(el("span", "leadcard__when", fmtDateTime(l.created_at)));
        card.appendChild(top);

        /* Phone and email as real links: on a phone this is a tap to call,
           which is the whole point of getting the alert. */
        var contact = el("p", "leadcard__contact");
        if (l.phone) {
          var a = el("a", null, l.phone);
          a.href = "tel:" + String(l.phone).replace(/[^0-9+]/g, "");
          contact.appendChild(a);
        }
        if (l.phone && l.email) contact.appendChild(document.createTextNode(" · "));
        if (l.email) {
          var m = el("a", null, l.email);
          m.href = "mailto:" + l.email;
          contact.appendChild(m);
        }
        card.appendChild(contact);

        var facts = [];
        if (l.property_address) facts.push(l.property_address);
        if (l.intent) facts.push(l.intent);
        if (l.price_range) facts.push(l.price_range);
        if (l.preferred_area) facts.push(l.preferred_area);
        if (l.timeline) facts.push(l.timeline);
        if (facts.length) card.appendChild(el("p", "leadcard__facts", facts.join(" · ")));

        if (l.message) card.appendChild(el("p", "leadcard__msg", l.message));

        /* Everything a particular form asked that has no column of its own.
           Shown rather than hidden — the answer to "what condition is the
           roof in" is exactly what makes a valuation lead useful. */
        var extra = l.extra && Object.keys(l.extra).length ? l.extra : null;
        if (extra) {
          var dl = el("dl", "leadcard__extra");
          Object.keys(extra).forEach(function (k) {
            if (k === "source") return;
            dl.appendChild(el("dt", null, k.replace(/_/g, " ")));
            dl.appendChild(el("dd", null, String(extra[k])));
          });
          if (dl.children.length) card.appendChild(dl);
        }

        var foot = el("div", "leadcard__foot");
        var src = [l.page_name, l.utm_source && ("via " + l.utm_source)].filter(Boolean).join(" · ");
        foot.appendChild(el("span", "leadcard__src", src || "Website"));

        /* Notification outcome. A lead that saved but failed to alert should
           be visible as such, not indistinguishable from one that worked. */
        if (!l.email_sent) {
          foot.appendChild(el("span", "leadcard__warn", l.email_error ? "Email alert failed" : "No email alert"));
        }

        var sel = el("select", "leadcard__status");
        LEAD_STATUSES.forEach(function (s) {
          var o = el("option", null, s.charAt(0).toUpperCase() + s.slice(1));
          o.value = s;
          if (l.status === s) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener("change", function () {
          var prev = l.status;
          l.status = sel.value;
          sb.from("leads").update({ status: sel.value }).eq("id", l.id).then(function (r) {
            if (r.error) { l.status = prev; sel.value = prev; fail(null, r.error); alert("Could not change that status."); return; }
            render();
          });
        });
        foot.appendChild(sel);
        card.appendChild(foot);

        host.appendChild(card);
      });
    }

    load();
  }
  initLogin();
  initPortal();
})();
