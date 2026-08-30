/* =====================================================================
   agent.js — the agent and admin backend.

   LOADED ONLY BY PAGES UNDER /portal/agent/. The client portal and the
   marketing site never see this file.

   WHY A SECOND FILE
   portal.js is 1,800 lines and serves login, the client portal and the
   agent portal at once. The backend is about to grow considerably. Rather
   than let one file become the place where everything lives, agent-only
   behaviour moves here and portal.js keeps what is genuinely shared:
   session handling, the sidebar identity, logout, and the client pages.

   No build step. Plain script tags, in order:
       supabase-js  ->  supabase-config.js  ->  portal.js  ->  agent.js
   Edit the file, refresh the browser. That is the whole toolchain.

   HOW IT IS ORGANISED
   One IIFE exposing a single global, window.AG, whose properties are the
   modules. Everything is a plain function; nothing here needs a class.

       AG.dom      element helpers
       AG.fmt      formatting
       AG.icon     inline SVG sprites
       AG.err      the agent error surface — concise, Retry, details
       AG.shell    sidebar: collapse, mobile drawer, active link

   Later steps add AG.dash, AG.wizard, AG.detail, AG.attention and so on
   as siblings. Each module is independent and named after what it draws,
   so a change to documents cannot reach the milestone list.
   ===================================================================== */

window.AG = (function () {
  "use strict";

  var AG = {};

  /* ================================================================== */
  /* AG.dom                                                             */
  /* ================================================================== */
  var dom = AG.dom = {
    q: function (sel, root) { return (root || document).querySelector(sel); },
    qa: function (sel, root) {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    },

    /* el("div", "cls", "text") — text is always set with textContent, never
       innerHTML. Everything drawn here comes out of the database and some
       of it was typed by a member of the public into a lead form. */
    el: function (tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },

    clear: function (node) {
      while (node && node.firstChild) node.removeChild(node.firstChild);
      return node;
    },

    /* Replace a node's children in one shot. */
    fill: function (node, children) {
      if (!node) return node;
      dom.clear(node);
      (children || []).forEach(function (c) { if (c) node.appendChild(c); });
      return node;
    },

    on: function (node, evt, fn) {
      if (node) node.addEventListener(evt, fn);
      return node;
    }
  };

  /* ================================================================== */
  /* AG.fmt                                                             */
  /* ================================================================== */
  var fmt = AG.fmt = {
    /* "2026-09-28" -> "Sep 28". Parsed as local noon rather than through
       the Date string parser, which reads a bare yyyy-mm-dd as UTC and
       can show the previous day west of Greenwich. */
    date: function (v) {
      var d = fmt.parse(v);
      if (!d) return "";
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    },

    dateLong: function (v) {
      var d = fmt.parse(v);
      if (!d) return "";
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    },

    parse: function (v) {
      if (!v) return null;
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
      var d = m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : new Date(v);
      return isNaN(d.getTime()) ? null : d;
    },

    /* Whole days from today. Negative is in the past. */
    daysUntil: function (v) {
      var d = fmt.parse(v);
      if (!d) return null;
      d.setHours(0, 0, 0, 0);
      var t = new Date();
      t.setHours(0, 0, 0, 0);
      return Math.round((d - t) / 86400000);
    },

    /* "6 days", "Today", "2 days ago" */
    countdown: function (days) {
      if (days == null) return "";
      if (days === 0) return "Today";
      if (days === 1) return "Tomorrow";
      if (days === -1) return "Yesterday";
      if (days < 0) return Math.abs(days) + " days ago";
      return days + " days";
    },

    money: function (v) {
      if (v == null || v === "") return "";
      var n = Number(v);
      if (isNaN(n)) return "";
      return n.toLocaleString("en-US", {
        style: "currency", currency: "USD", maximumFractionDigits: 0
      });
    },

    /* "10 min ago" for the Last Updated column. */
    ago: function (v) {
      if (!v) return "";
      var then = new Date(v);
      if (isNaN(then.getTime())) return "";
      var s = Math.floor((Date.now() - then.getTime()) / 1000);
      if (s < 60) return "just now";
      if (s < 3600) return Math.floor(s / 60) + " min ago";
      if (s < 86400) { var h = Math.floor(s / 3600); return h + (h === 1 ? " hour ago" : " hours ago"); }
      if (s < 604800) { var d = Math.floor(s / 86400); return d + (d === 1 ? " day ago" : " days ago"); }
      return fmt.date(v);
    },

    dateTime: function (v) {
      if (!v) return "";
      var d = new Date(v);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      });
    },

    /* snake_case column name -> words an agent recognises. */
    field: function (k) {
      var MAP = {
        progress_step: "stage", closing_status: "file status",
        expected_close: "closing date", ms_earnest_money: "earnest money",
        ms_option_fee: "option fee", ms_inspection: "inspection",
        ms_repairs: "repair negotiations", ms_title_commit: "title commitment",
        ms_survey: "survey", ms_hoa_docs: "HOA documents",
        ms_loan_docs: "loan approval", ms_appraisal: "appraisal",
        ms_ready_close: "clear to close", ms_final_walkthrough: "final walkthrough",
        ms_closing: "closing", archived_at: "archive state"
      };
      return MAP[k] || String(k || "").replace(/_/g, " ");
    },

    initials: function (name) {
      var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return "?";
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
  };

  /* ================================================================== */
  /* AG.icon                                                            */
  /* ================================================================== */
  /* Inline SVG rather than an icon font or a sprite sheet: no extra
     request, no flash of missing glyph, and stroke follows currentColor
     so a single definition works on the dark rail and on white cards.

     Paths are written into a namespaced element, so this is the one place
     that builds SVG by hand. The strings are literals in this file — none
     of them comes from the database. */
  var ICONS = {
    transactions: "M3 5h13M3 10h9M3 15h13M16 13l3 3-3 3",
    contracts:    "M5 2h7l4 4v12H5zM12 2v4h4",
    marketing:    "M4 8v4h3l5 3V5L7 8zM15 8a3 3 0 0 1 0 4",
    vendors:      "M3 17V8l7-5 7 5v9M8 17v-5h4v5",
    team:         "M7 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 16c0-2.5 2.2-4 5-4s5 1.5 5 4M14 7.5a2 2 0 1 0 0-4M18 16c0-2-1.5-3.2-3.5-3.6",
    leads:        "M3 5h14v10H3zM3 6l7 5 7-5",
    menu:         "M3 6h14M3 10h14M3 14h14",
    collapse:     "M12 5l-4 5 4 5M4 4v12",
    eye:          "M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    lock:         "M4 7h8v6H4zM6 7V5a2 2 0 0 1 4 0v2",
    plus:         "M10 4v12M4 10h12",
    search:       "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5L18 18",
    check:        "M4 10.5l4 4 8-9",
    alert:        "M10 3l8 14H2zM10 8v4M10 14.5v.5",
    clock:        "M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM10 5v5l3 2",
    retry:        "M16 10a6 6 0 1 1-2-4.5M16 3v3h-3",
    chevron:      "M7 4l6 6-6 6"
  };

  AG.icon = function (name, size) {
    var d = ICONS[name];
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (size) { svg.setAttribute("width", size); svg.setAttribute("height", size); }
    if (!d) return svg;
    var p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
    return svg;
  };

  /* ================================================================== */
  /* AG.err                                                             */
  /* ================================================================== */
  /* The agent error surface.

     portal.js has its own fail(), which appends "Call 713-828-4185 and we
     will tell you where things stand." That is right for a client staring
     at a page that will not load. It is wrong here — an agent needs to
     know what broke and be able to retry, and telling them to ring the
     office they work in is noise.

     portal.js's fail() is NOT modified. This is a separate surface used by
     agent code only, so the client portal keeps its own wording. */
  AG.err = {
    /* show(host, error, message, retryFn)
       host    element to draw into
       error   the raw Supabase/PostgREST error, for the details panel
       message one short sentence: "Documents couldn't load."
       retry   optional function; a Retry button appears when given */
    show: function (host, error, message, retry) {
      if (window.console) console.error("[agent]", message, error);
      if (!host) return;

      dom.clear(host);
      host.hidden = false;

      var box  = dom.el("div", "ag-err");
      var mark = AG.icon("alert");
      mark.style.flex = "none";
      mark.style.width = "16px";
      mark.style.height = "16px";
      mark.style.marginTop = "1px";
      mark.style.stroke = "var(--ag-bad)";
      mark.style.fill = "none";
      mark.setAttribute("stroke-width", "1.7");
      box.appendChild(mark);

      var body = dom.el("div", "ag-err__body");
      body.appendChild(dom.el("div", "ag-err__msg", message || "Something went wrong."));

      var actions = dom.el("div", "ag-err__actions");
      if (typeof retry === "function") {
        var again = dom.el("button", "ag-btn ag-btn--sm", "Retry");
        again.type = "button";
        dom.on(again, "click", function () { retry(); });
        actions.appendChild(again);
      }

      var detail = AG.err.describe(error);
      if (detail) {
        var toggle = dom.el("button", "ag-btn ag-btn--sm ag-btn--quiet", "View error details");
        toggle.type = "button";
        var pre = dom.el("pre", "ag-err__detail", detail);
        pre.hidden = true;
        dom.on(toggle, "click", function () {
          pre.hidden = !pre.hidden;
          toggle.textContent = pre.hidden ? "View error details" : "Hide error details";
        });
        actions.appendChild(toggle);
        body.appendChild(actions);
        body.appendChild(pre);
      } else {
        body.appendChild(actions);
      }

      box.appendChild(body);
      host.appendChild(box);
    },

    /* Turn a PostgREST error into something readable. The codes are worth
       naming: they are the difference between "you cannot see this" and
       "this does not exist", and guessing between them wastes an hour. */
    describe: function (error) {
      if (!error) return "";
      var bits = [];
      if (error.code) {
        var HINT = {
          "42501":   "Permission denied by a row-level security policy.",
          "42P01":   "That table does not exist in the database.",
          "42703":   "That column does not exist in the database.",
          "PGRST202":"That database function does not exist.",
          "PGRST116":"No matching row was returned.",
          "23505":   "A record with that value already exists.",
          "23503":   "A related record is missing."
        };
        bits.push(error.code + (HINT[error.code] ? "  " + HINT[error.code] : ""));
      }
      if (error.message) bits.push(error.message);
      if (error.details) bits.push(error.details);
      if (error.hint) bits.push("Hint: " + error.hint);
      return bits.join("\n");
    },

    /* A quiet inline note for a section that loaded fine but is empty. */
    empty: function (host, text) {
      if (!host) return;
      dom.clear(host);
      host.hidden = false;
      host.appendChild(dom.el("p", "ag-empty", text || "Nothing here yet."));
    }
  };

  /* ================================================================== */
  /* AG.shell                                                           */
  /* ================================================================== */
  /* Sidebar behaviour. Three jobs and nothing else:

       1. Mark the current page, so the nav is honest after a rename.
       2. Collapse to icons on desktop, remembered per browser.
       3. Behave as a drawer under 60rem.

     The collapsed state is a per-viewer convenience, so localStorage is
     the right home for it. Wrapped in try/catch because a browser set to
     block site data throws on access rather than returning null. */
  var RAIL_KEY = "tp-agent-rail";

  AG.shell = {
    init: function () {
      var body = document.body;
      if (!body || !body.classList.contains("agentui")) return;

      AG.shell.markCurrent();
      AG.shell.decorateNav();
      AG.shell.buildBar();
      AG.shell.restore();
    },

    /* aria-current is hand-written in the markup today, which rots the
       moment a file is renamed. Recomputing from the URL keeps it true. */
    markCurrent: function () {
      var here = location.pathname.replace(/index\.html$/, "");
      var links = dom.qa(".rail__nav a");
      var hit = null;

      links.forEach(function (a) {
        a.removeAttribute("aria-current");
        var path = (a.getAttribute("href") || "").replace(/index\.html$/, "");
        /* Skip the section root here — it matches everything under it and
           would win over the more specific page. It is the fallback below. */
        if (path === "/portal/agent/") return;
        if (path === here) hit = a;
      });

      /* Pages that hang off a section rather than being one: the detail
         view lives at transaction.html and belongs under Transactions. */
      if (!hit) {
        hit = links.filter(function (a) {
          return (a.getAttribute("href") || "").replace(/index\.html$/, "") === "/portal/agent/";
        })[0] || null;
      }

      if (hit) hit.setAttribute("aria-current", "page");
    },

    /* Wrap each label in a span and prepend its icon. Done in script so
       the markup stays readable and the icon set lives in one place. */
    decorateNav: function () {
      dom.qa(".rail__nav a").forEach(function (a) {
        if (a.querySelector("svg")) return;
        var name = a.getAttribute("data-icon");
        var label = dom.el("span", "rail__label", a.textContent.trim());
        dom.clear(a);
        if (name) a.appendChild(AG.icon(name));
        a.appendChild(label);
      });
    },

    /* The desktop collapse button, and the mobile top bar. Both are built
       here rather than repeated in seven HTML files. */
    buildBar: function () {
      var rail = dom.q(".rail");
      var app  = dom.q(".app");
      if (!rail || !app) return;

      var nav = dom.q(".rail__nav");
      if (nav && !dom.q(".rail__toggle")) {
        var t = dom.el("button", "rail__toggle");
        t.type = "button";
        t.appendChild(AG.icon("collapse"));
        t.appendChild(dom.el("span", "rail__label", "Collapse"));
        t.setAttribute("aria-label", "Collapse sidebar");
        dom.on(t, "click", function () {
          var tight = document.body.classList.toggle("is-railtight");
          t.setAttribute("aria-label", tight ? "Expand sidebar" : "Collapse sidebar");
          try { localStorage.setItem(RAIL_KEY, tight ? "1" : "0"); } catch (e) {}
        });
        nav.parentNode.insertBefore(t, nav.nextSibling);
      }

      if (dom.q(".railbar")) return;

      var bar = dom.el("div", "railbar");
      var menu = dom.el("button", "railbar__menu");
      menu.type = "button";
      menu.setAttribute("aria-label", "Open menu");
      menu.setAttribute("aria-expanded", "false");
      menu.appendChild(AG.icon("menu"));
      bar.appendChild(menu);

      var mark = document.createElement("img");
      mark.src = "/assets/mark-cream.png";
      mark.alt = "TwelvePoint Realty Group";
      bar.appendChild(mark);

      app.insertBefore(bar, app.firstChild);

      function close() {
        document.body.classList.remove("is-railopen");
        menu.setAttribute("aria-expanded", "false");
        var s = dom.q(".railscrim");
        if (s) s.parentNode.removeChild(s);
      }

      dom.on(menu, "click", function () {
        var open = document.body.classList.toggle("is-railopen");
        menu.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
          var scrim = dom.el("button", "railscrim");
          scrim.type = "button";
          scrim.setAttribute("aria-label", "Close menu");
          dom.on(scrim, "click", close);
          document.body.appendChild(scrim);
        } else {
          close();
        }
      });

      dom.on(document, "keydown", function (e) {
        if (e.key === "Escape") close();
      });

      /* Following a link inside the drawer should shut it. */
      dom.qa(".rail__nav a").forEach(function (a) { dom.on(a, "click", close); });
    },

    restore: function () {
      var v = null;
      try { v = localStorage.getItem(RAIL_KEY); } catch (e) {}
      if (v === "1") {
        document.body.classList.add("is-railtight");
        var t = dom.q(".rail__toggle");
        if (t) t.setAttribute("aria-label", "Expand sidebar");
      }
    }
  };

  /* ================================================================== */
  /* AG.model — the shared vocabulary                                    */
  /* ================================================================== */
  /* Column names, labels and orderings that both the dashboard and the
     detail page need. Defined once so a renamed milestone cannot mean two
     different things on two screens. */
  AG.model = {
    /* Order matters: this is the order milestones appear, and the order
       the attention engine reports them in. */
    milestones: [
      { key: "ms_earnest_money",     label: "Earnest money",       required: true  },
      { key: "ms_option_fee",        label: "Option fee",          required: false },
      { key: "ms_inspection",        label: "Inspection",          required: false },
      { key: "ms_repairs",           label: "Repair negotiations", required: false },
      { key: "ms_title_commit",      label: "Title commitment",    required: true  },
      { key: "ms_survey",            label: "Survey",              required: false },
      { key: "ms_hoa_docs",          label: "HOA documents",       required: false },
      { key: "ms_loan_docs",         label: "Loan approval",       required: true  },
      { key: "ms_appraisal",         label: "Appraisal",           required: false },
      { key: "ms_ready_close",       label: "Clear to close",      required: true  },
      { key: "ms_final_walkthrough", label: "Final walkthrough",   required: false },
      { key: "ms_closing",           label: "Closing",             required: true  }
    ],

    /* "" and null are the same thing. Both exist because early rows used
       null and the UI wrote "" — neither is worth a migration. */
    msStates: [
      { v: "",         label: "Not started",     tone: "idle" },
      { v: "pending",  label: "Pending",         tone: "warn" },
      { v: "blocked",  label: "Needs attention", tone: "bad"  },
      { v: "complete", label: "Complete",        tone: "good" }
    ],

    msState: function (v) {
      var want = v || "";
      for (var i = 0; i < AG.model.msStates.length; i++) {
        if (AG.model.msStates[i].v === want) return AG.model.msStates[i];
      }
      return AG.model.msStates[0];
    },

    isDone: function (v) { return v === "complete"; },

    /* Each dated deadline and the milestone that satisfies it. A date that
       has passed only matters if the thing it was waiting for is not done,
       which is the whole basis of the attention engine. */
    dates: [
      { key: "contract_date",      label: "Contract",    deadline: false, done: null },
      { key: "earnest_due",        label: "Earnest",     deadline: true,  done: "ms_earnest_money" },
      { key: "option_ends",        label: "Option ends", deadline: true,  done: "ms_inspection" },
      { key: "financing_deadline", label: "Financing",   deadline: true,  done: "ms_loan_docs" },
      { key: "appraisal_deadline", label: "Appraisal",   deadline: true,  done: "ms_appraisal" },
      { key: "walkthrough_date",   label: "Walkthrough", deadline: true,  done: "ms_final_walkthrough" },
      { key: "expected_close",     label: "Closing",     deadline: true,  done: "ms_closing" }
    ],

    stages: ["Under contract", "Option & inspection", "Ready for closing", "Closed"],

    kindLabel: { purchase: "Buyer", sale: "Seller", lease: "Lease", other: "Other" },

    fileStatus: {
      active: "Active", on_hold: "On hold", terminated: "Terminated",
      closed: "Closed", in_process: "Active", cancelled: "Terminated"
    },

    fileStatusTone: {
      active: "info", in_process: "info", on_hold: "idle",
      terminated: "idle", cancelled: "idle", closed: "good"
    },

    docCategories: [
      { v: "contract",   label: "Contract"   },
      { v: "addenda",    label: "Addenda"    },
      { v: "inspection", label: "Inspection" },
      { v: "title",      label: "Title"      },
      { v: "hoa",        label: "HOA"        },
      { v: "financing",  label: "Financing"  },
      { v: "appraisal",  label: "Appraisal"  },
      { v: "closing",    label: "Closing"    },
      { v: "other",      label: "Other"      }
    ]
  };

  /* ================================================================== */
  /* AG.rules — the attention engine                                     */
  /* ================================================================== */
  /* Needs Attention is DERIVED, never stored. A stored flag goes stale the
     moment a date moves, and changing a threshold would need a migration.
     Everything here is computed from the row in front of us.

     Every threshold lives in AG.rules.thresholds so they can be tuned in
     one place. Adding a rule means adding a function to CHECKS — nothing
     else in the file needs to know about it.

     Each rule returns zero or more items:
       tone   "bad" | "warn" | "info"
       text   one sentence an agent can act on
       target the section to scroll to when the item is clicked
       sort   lower sorts first; overdue things float to the top */
  AG.rules = {
    thresholds: {
      dueSoonDays:      5,   /* amber once a deadline is this close      */
      closingSoonDays:  5,   /* flag incomplete required milestones      */
      staleDays:       14    /* nothing touched in this long             */
    },

    /* tx      the transaction row
       extra   { actionItems: [], documents: [] } — optional; rules that
               need them simply return nothing when they are absent, so
               the same engine works on the dashboard (where we have not
               loaded them) and on the detail page (where we have). */
    evaluate: function (tx, extra) {
      if (!tx) return [];
      extra = extra || {};
      var out = [];
      AG.rules.CHECKS.forEach(function (fn) {
        try {
          var got = fn(tx, extra, AG.rules.thresholds);
          if (got) out = out.concat(got);
        } catch (e) {
          if (window.console) console.error("[agent] attention rule failed", e);
        }
      });
      out.sort(function (a, b) { return (a.sort || 50) - (b.sort || 50); });
      return out;
    },

    /* Convenience for the dashboard, which only wants the count. */
    count: function (tx, extra) { return AG.rules.evaluate(tx, extra).length; },

    worstTone: function (items) {
      if (!items || !items.length) return null;
      if (items.some(function (i) { return i.tone === "bad"; })) return "bad";
      if (items.some(function (i) { return i.tone === "warn"; })) return "warn";
      return "info";
    },

    /* ---------------------------------------------------------------- */
    CHECKS: [
      /* A dated deadline whose milestone is not complete. */
      function deadlines(tx, extra, T) {
        var out = [];
        AG.model.dates.forEach(function (d) {
          if (!d.deadline || !tx[d.key]) return;
          if (d.done && AG.model.isDone(tx[d.done])) return;
          var days = fmt.daysUntil(tx[d.key]);
          if (days == null) return;

          if (days < 0) {
            out.push({
              tone: "bad", target: "dates", sort: 0 + days / 1000,
              text: d.label + " passed " + fmt.countdown(days).replace(" ago", " ago") +
                    " and is not marked complete"
            });
          } else if (days <= T.dueSoonDays) {
            out.push({
              tone: "warn", target: "dates", sort: 10 + days,
              text: d.label + " " + (days === 0 ? "is due today"
                                   : days === 1 ? "is due tomorrow"
                                   : "is due in " + days + " days")
            });
          }
        });
        return out;
      },

      /* Closing is close and something required is still open. */
      function closingReadiness(tx, extra, T) {
        var days = fmt.daysUntil(tx.expected_close);
        if (days == null || days < 0 || days > T.closingSoonDays) return [];
        var open = AG.model.milestones.filter(function (m) {
          return m.required && m.key !== "ms_closing" && !AG.model.isDone(tx[m.key]);
        });
        if (!open.length) return [];
        return [{
          tone: days <= 2 ? "bad" : "warn",
          target: "milestones",
          sort: 5,
          text: "Closing in " + days + " day" + (days === 1 ? "" : "s") + " with " +
                open.length + " required milestone" + (open.length === 1 ? "" : "s") +
                " still open: " + open.map(function (m) { return m.label; }).join(", ")
        }];
      },

      /* A milestone an agent has explicitly flagged. */
      function flagged(tx) {
        return AG.model.milestones.filter(function (m) {
          return tx[m.key] === "blocked";
        }).map(function (m) {
          return { tone: "bad", target: "milestones", sort: 2, text: m.label + " is flagged as needing attention" };
        });
      },

      /* Title commitment still outstanding once the option period is over.
         Before that it is simply early, and flagging it would be noise. */
      function titleAfterOption(tx) {
        var days = fmt.daysUntil(tx.option_ends);
        if (days == null || days > 0) return [];
        if (AG.model.isDone(tx.ms_title_commit)) return [];
        return [{ tone: "warn", target: "milestones", sort: 20,
                  text: "Title commitment not received and the option period has ended" }];
      },

      /* Overdue client tasks. Only when the detail page has loaded them. */
      function overdueTasks(tx, extra) {
        var items = extra.actionItems;
        if (!items || !items.length) return [];
        return items.filter(function (a) {
          return a.status !== "complete" && a.due_date && fmt.daysUntil(a.due_date) < 0;
        }).map(function (a) {
          var days = Math.abs(fmt.daysUntil(a.due_date));
          return { tone: "bad", target: "actions", sort: 1,
                   text: "Client task overdue by " + days + " day" + (days === 1 ? "" : "s") +
                         ": " + a.title };
        });
      },

      /* Information the file cannot be run without. Informational rather
         than alarming — a new file legitimately has gaps for a day or two. */
      function missingInfo(tx) {
        var out = [];
        if (!tx.expected_close) out.push({ tone: "info", target: "dates",   sort: 40, text: "No closing date set" });
        if (!tx.contract_date)  out.push({ tone: "info", target: "dates",   sort: 41, text: "No contract date set" });
        if (tx.sales_price == null) out.push({ tone: "info", target: "details", sort: 42, text: "No sales price recorded" });
        if (!tx.client_id)      out.push({ tone: "warn", target: "details", sort: 30, text: "No client is linked to this file" });
        return out;
      }
    ]
  };

  /* ================================================================== */
  /* AG.dash — the transactions dashboard                                */
  /* ================================================================== */
  /* Replaces renderList() FOR AGENTS ONLY. The client index page keeps
     portal.js's renderList untouched: it hangs off [data-txn-list] and
     this hangs off [data-ag-dash], so the two never meet.

     One query, then everything else — KPIs, filters, search, sort — is
     computed in the browser. A brokerage's active book is tens of rows,
     not thousands, and round-tripping a filter to the database to re-sort
     twenty rows would be slower than doing it here. */
  AG.dash = (function () {
    var sb = null, ROWS = [], AGENTS = {}, VIEW = "all", SORT = "deadline", Q = "";

    var FILTERS = [
      { v: "all",       label: "All"             },
      { v: "buyers",    label: "Buyers"          },
      { v: "sellers",   label: "Sellers"         },
      { v: "contract",  label: "Under Contract"  },
      { v: "soon",      label: "Closing Soon"    },
      { v: "attention", label: "Needs Attention" },
      { v: "closed",    label: "Closed"          },
      { v: "archived",  label: "Archived"        }
    ];

    var SORTS = [
      { v: "deadline", label: "Next deadline" },
      { v: "closing",  label: "Closing date"  },
      { v: "updated",  label: "Last updated"  },
      { v: "attention",label: "Needs attention" },
      { v: "client",   label: "Client name"   }
    ];

    /* ---- derived helpers ------------------------------------------- */

    /* The soonest unmet deadline on a file. Drives both the column and
       the default sort, because "what is next" is the question an agent
       actually opens this page to answer. */
    function nextDeadline(tx) {
      var best = null;
      AG.model.dates.forEach(function (d) {
        if (!d.deadline || !tx[d.key]) return;
        if (d.done && AG.model.isDone(tx[d.done])) return;
        var days = fmt.daysUntil(tx[d.key]);
        if (days == null) return;
        if (!best || days < best.days) best = { label: d.label, date: tx[d.key], days: days };
      });
      return best;
    }

    function clientName(tx) {
      return (tx.client && tx.client.full_name) || tx.client_name || "—";
    }

    function agentName(tx) {
      return AGENTS[tx.agent_id] || "—";
    }

    function isArchived(tx) { return !!tx.archived_at; }

    function isClosed(tx) {
      return Number(tx.progress_step) === 4 ||
             tx.closing_status === "closed" ||
             tx.closing_status === "terminated" ||
             tx.closing_status === "cancelled";
    }

    /* ---- filtering -------------------------------------------------- */
    function matches(tx) {
      /* Archived files are out of every view except their own. Otherwise
         a closed-out file keeps turning up in the daily list forever. */
      if (VIEW === "archived") return isArchived(tx);
      if (isArchived(tx)) return false;

      switch (VIEW) {
        case "buyers":    return tx.kind === "purchase";
        case "sellers":   return tx.kind === "sale";
        case "contract":  return !isClosed(tx) && Number(tx.progress_step) <= 2;
        case "soon": {
          var d = fmt.daysUntil(tx.expected_close);
          return !isClosed(tx) && d != null && d >= 0 && d <= 30;
        }
        case "attention": return AG.rules.count(tx) > 0;
        case "closed":    return isClosed(tx);
        default:          return true;
      }
    }

    function searched(tx) {
      if (!Q) return true;
      var hay = [clientName(tx), tx.address, tx.file_number, agentName(tx)]
        .join(" ").toLowerCase();
      return hay.indexOf(Q) !== -1;
    }

    function sorted(rows) {
      var copy = rows.slice();
      copy.sort(function (a, b) {
        switch (SORT) {
          case "closing": {
            var ax = fmt.daysUntil(a.expected_close), bx = fmt.daysUntil(b.expected_close);
            if (ax == null && bx == null) return 0;
            if (ax == null) return 1;      /* undated sinks, never floats */
            if (bx == null) return -1;
            return ax - bx;
          }
          case "updated":
            return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
          case "attention":
            return AG.rules.count(b) - AG.rules.count(a);
          case "client":
            return clientName(a).localeCompare(clientName(b));
          default: {
            var an = nextDeadline(a), bn = nextDeadline(b);
            if (!an && !bn) return 0;
            if (!an) return 1;
            if (!bn) return -1;
            return an.days - bn.days;
          }
        }
      });
      return copy;
    }

    function visible() {
      return sorted(ROWS.filter(function (t) { return matches(t) && searched(t); }));
    }

    /* ---- KPI cards --------------------------------------------------- */
    function paintKpis() {
      var live = ROWS.filter(function (t) { return !isArchived(t) && !isClosed(t); });

      var thisMonth = live.filter(function (t) {
        var d = fmt.parse(t.expected_close);
        if (!d) return false;
        var n = new Date();
        return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
      });

      var flagged = live.filter(function (t) { return AG.rules.count(t) > 0; });

      var overdue = live.filter(function (t) {
        return AG.rules.evaluate(t).some(function (i) { return i.tone === "bad"; });
      });

      set("[data-kpi='active']",    live.length,      null);
      set("[data-kpi='month']",     thisMonth.length, null);
      set("[data-kpi='attention']", flagged.length,   flagged.length ? "warn" : null);
      set("[data-kpi='overdue']",   overdue.length,   overdue.length ? "bad"  : null);

      function set(sel, n, tone) {
        var card = dom.q(sel);
        if (!card) return;
        var v = card.querySelector(".kpi__n");
        if (v) v.textContent = String(n);
        card.classList.remove("kpi--warn", "kpi--bad");
        if (tone) card.classList.add("kpi--" + tone);
      }
    }

    /* ---- the table ---------------------------------------------------- */
    var COLS = ["Client", "Property", "Type", "Stage", "Closing", "Next deadline",
                "Attention", "Agent", "Updated"];

    function paintTable() {
      var host = dom.q("[data-ag-rows]");
      if (!host) return;
      var rows = visible();

      var countEl = dom.q("[data-ag-count]");
      if (countEl) {
        countEl.textContent = rows.length + (rows.length === 1 ? " transaction" : " transactions") +
          (Q ? " matching “" + Q + "”" : "");
      }

      dom.clear(host);

      if (!rows.length) {
        var td = dom.el("td", "ag-empty");
        td.colSpan = COLS.length;
        td.textContent = !ROWS.length
          ? "No transactions yet. Create the first one with New Transaction."
          : Q ? "Nothing matches “" + Q + "”."
              : "No transactions in this view.";
        var tr = dom.el("tr");
        tr.appendChild(td);
        host.appendChild(tr);
        return;
      }

      rows.forEach(function (tx) { host.appendChild(rowFor(tx)); });
    }

    function rowFor(tx) {
      var items = AG.rules.evaluate(tx);
      var worst = AG.rules.worstTone(items);
      var tr = dom.el("tr", "tx" + (worst === "bad" ? " tx--bad" : worst === "warn" ? " tx--warn" : ""));
      tr.tabIndex = 0;
      tr.setAttribute("role", "link");

      var href = "/portal/agent/transaction.html?id=" + encodeURIComponent(tx.id);
      function go() { location.assign(href); }
      dom.on(tr, "click", go);
      dom.on(tr, "keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      });

      /* client */
      var c = dom.el("td", "tx__client");
      c.appendChild(dom.el("span", "tx__name", clientName(tx)));
      if (tx.file_number) c.appendChild(dom.el("span", "tx__file", "File " + tx.file_number));
      tr.appendChild(c);

      /* property */
      var p = dom.el("td", "tx__addr", tx.address || "—");
      p.title = tx.address || "";
      tr.appendChild(p);

      /* type */
      tr.appendChild(dom.el("td", null, AG.model.kindLabel[tx.kind] || tx.kind || "—"));

      /* stage */
      var stage = dom.el("td");
      var step = Number(tx.progress_step) || 1;
      stage.appendChild(pill(AG.model.stages[step - 1] || "—", step === 4 ? "good" : "info"));
      tr.appendChild(stage);

      /* closing */
      var close = dom.el("td", "ag-nowrap");
      if (tx.expected_close) {
        close.appendChild(dom.el("span", null, fmt.date(tx.expected_close)));
      } else {
        close.appendChild(dom.el("span", "ag-muted", "—"));
      }
      tr.appendChild(close);

      /* next deadline */
      var nd = nextDeadline(tx);
      var deadline = dom.el("td", "tx__deadline");
      if (nd) {
        deadline.appendChild(dom.el("span", "tx__dl-label", nd.label));
        var tone = nd.days < 0 ? "bad" : nd.days <= AG.rules.thresholds.dueSoonDays ? "warn" : "idle";
        deadline.appendChild(dom.el("span", "tx__dl-when tx__dl-when--" + tone,
          fmt.date(nd.date) + " · " + fmt.countdown(nd.days)));
      } else {
        deadline.appendChild(dom.el("span", "ag-muted", "—"));
      }
      tr.appendChild(deadline);

      /* attention */
      var att = dom.el("td");
      if (items.length) {
        att.appendChild(pill(items.length + (items.length === 1 ? " item" : " items"), worst));
      } else {
        att.appendChild(dom.el("span", "ag-muted", "—"));
      }
      tr.appendChild(att);

      /* agent */
      tr.appendChild(dom.el("td", "ag-nowrap", agentName(tx)));

      /* updated */
      tr.appendChild(dom.el("td", "ag-nowrap ag-muted", fmt.ago(tx.updated_at)));

      return tr;
    }

    function pill(text, tone) {
      return dom.el("span", "ag-pill ag-pill--" + (tone || "idle"), text);
    }

    /* ---- controls ------------------------------------------------------ */
    function buildControls() {
      var fhost = dom.q("[data-ag-filters]");
      if (fhost && !fhost.childNodes.length) {
        FILTERS.forEach(function (f) {
          var b = dom.el("button", "chip" + (f.v === VIEW ? " chip--on" : ""), f.label);
          b.type = "button";
          b.dataset.filter = f.v;
          dom.on(b, "click", function () {
            VIEW = f.v;
            dom.qa("[data-ag-filters] .chip").forEach(function (o) {
              o.classList.toggle("chip--on", o.dataset.filter === VIEW);
            });
            paintTable();
          });
          fhost.appendChild(b);
        });
      }

      var shost = dom.q("[data-ag-sort]");
      if (shost && !shost.options.length) {
        SORTS.forEach(function (s) {
          var o = dom.el("option", null, s.label);
          o.value = s.v;
          shost.appendChild(o);
        });
        shost.value = SORT;
        dom.on(shost, "change", function () { SORT = shost.value; paintTable(); });
      }

      var q = dom.q("[data-ag-search]");
      if (q) {
        dom.on(q, "input", function () {
          Q = q.value.trim().toLowerCase();
          paintTable();
        });
      }
    }

    /* ---- load ----------------------------------------------------------- */
    function load() {
      var host = dom.q("[data-ag-error]");
      if (host) host.hidden = true;

      /* Agent names come from agent_options() rather than a join, because
         transactions.agent_id has no foreign key into profiles that
         PostgREST can follow. Failing here is not fatal — the column just
         shows a dash — so the transactions query does not wait on it. */
      sb.rpc("agent_options").then(function (res) {
        if (!res.error && res.data) {
          res.data.forEach(function (a) { AGENTS[a.id] = a.full_name || a.email; });
          paintTable();
        }
      });

      /* The client's name comes from an embedded profile. That join is the
         most fragile part of this query — it depends on a foreign key AND
         on the profiles policy letting the caller read the row — so a
         failure falls back to the same query without it. Losing the name
         column is a bad day; losing the whole transaction list because a
         name would not join is a broken tool. */
      function fetchRows() {
        return sb.from("transactions")
          .select("*, client:profiles!transactions_client_profile_fkey(full_name)")
          .then(function (res) {
            if (!res.error) return res;
            if (window.console) {
              console.warn("[agent] client name join failed, retrying without it", res.error);
            }
            return sb.from("transactions").select("*").then(function (bare) {
              if (!bare.error) bare.degraded = true;
              return bare;
            });
          });
      }

      return fetchRows()
        .then(function (res) {
          var body = dom.q("[data-ag-body]");
          if (res.error) {
            AG.err.show(host, res.error, "Transactions couldn’t load.", load);
            if (body) body.hidden = true;
            return;
          }
          ROWS = res.data || [];
          if (body) body.hidden = false;
          paintKpis();
          paintTable();
          if (res.degraded) {
            var note = dom.q("[data-ag-degraded]");
            if (note) note.hidden = false;
          }
        })
        /* Without this, anything thrown while painting becomes an
           unhandled rejection: the table keeps saying "Loading…" and no
           error is ever shown. Silence is the worst possible failure mode
           for a page an agent is trying to work from. */
        .catch(function (e) {
          AG.err.show(host, e, "Transactions couldn’t load.", load);
          var body = dom.q("[data-ag-body]");
          if (body) body.hidden = true;
        });
    }

    /* ---- entry ------------------------------------------------------------ */
    return {
      init: function (client, session, role) {
        sb = client;
        if (!dom.q("[data-ag-dash]")) return;

        /* Anything thrown here used to take the whole page with it,
           including the New Transaction toggle wired below, which is
           exactly the pair of symptoms a silent throw produces: a table
           stuck on "Loading…" and a button that does nothing. */
        try {
          buildControls();
          load();
        } catch (e) {
          AG.err.show(dom.q("[data-ag-error]"), e,
                      "The dashboard failed to start.", function () { location.reload(); });
        }

        /* The old create form is still the only way to make a transaction
           until the wizard lands. Kept working rather than removed. */
        var toggle = dom.q("[data-ag-newtoggle]");
        var panel  = dom.q("[data-ag-newpanel]");
        if (toggle && panel) {
          dom.on(toggle, "click", function () {
            panel.hidden = !panel.hidden;
            toggle.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
            if (!panel.hidden) {
              var f = panel.querySelector("input, select");
              if (f) f.focus();
            }
          });
        }
      },
      reload: load
    };
  })();

  /* ------------------------------------------------------------------ */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", AG.shell.init);
  } else {
    AG.shell.init();
  }

  return AG;
})();
