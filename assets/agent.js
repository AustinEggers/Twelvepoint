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

  /* ------------------------------------------------------------------ */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", AG.shell.init);
  } else {
    AG.shell.init();
  }

  return AG;
})();
