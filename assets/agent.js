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

   The sidebar lives in assets/rail.js, loaded before this file and shared
   with the client portal, so both halves of the product navigate the same.

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

    /* The subtitle doubles as a progress readout. A page that hangs on a
       single unchanging "Loading…" tells nobody anything — not the agent
       looking at it and not whoever they describe it to. Each stage names
       itself, so a stall is reported as the stage it stalled in. */
    function say(msg) {
      var el = dom.q("[data-ag-count]");
      if (el) el.textContent = msg;
      if (window.console) console.log("[agent] " + msg);
    }

    function load() {
      var host = dom.q("[data-ag-error]");
      if (host) host.hidden = true;
      say("Requesting transactions…");

      /* A request that never settles is indistinguishable from a broken
         page. Give it a deadline and say so out loud when it passes. */
      var settled = false;
      setTimeout(function () {
        if (settled) return;
        say("Request timed out.");
        AG.err.show(host, { code: "TIMEOUT", message:
          "The database did not respond within 15 seconds. This is usually a " +
          "network problem or a Supabase project that is paused." },
          "Transactions couldn’t load.", load);
      }, 15000);

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
          settled = true;
          var body = dom.q("[data-ag-body]");
          if (res.error) {
            say("Request failed.");
            AG.err.show(host, res.error, "Transactions couldn’t load.", load);
            if (body) body.hidden = true;
            return;
          }
          say("Received " + ((res.data || []).length) + " rows, drawing…");
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
          settled = true;
          say("Failed while drawing the table.");
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
        say("Starting…");
        try {
          buildControls();
          say("Controls built.");
          load();
        } catch (e) {
          say("Failed to start.");
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

  /* ================================================================== */
  /* AG.detail — the individual transaction                              */
  /* ================================================================== */
  /* Replaces initStaffDetail() in portal.js for the agent side. The
     client's transaction page is a different document with a different
     renderer and shares nothing with this.

     SAVE MODEL, stated once because mixed models are what make people
     distrust a form: every field on this page — including the stage and
     the milestones — goes into a dirty buffer and is written by Save
     changes. The separate collections (action items, documents, notes)
     are their own records with their own add and remove buttons, and
     those write immediately. So: things with a Save button save on Save;
     things with an Add button save on Add. Nothing saves by surprise. */
  AG.detail = (function () {
    var sb = null, ID = null, SESSION = null, ROLE = "agent";
    var TX = null, DIRTY = {}, AGENTS = {};
    var ITEMS = [], DOCS = [], NOTES = [], AUDIT = [];
    var BUSY = false;

    /* ---- dirty state -------------------------------------------------- */
    function setDirty(field, value) {
      DIRTY[field] = value;
      paintSaveState();
    }
    function isDirty() { for (var k in DIRTY) { if (DIRTY.hasOwnProperty(k)) return true; } return false; }

    function paintSaveState(msg, tone) {
      var el = dom.q("[data-dtl-savestate]");
      var btn = dom.q("[data-dtl-save]");
      if (btn) btn.disabled = BUSY || !isDirty();
      if (!el) return;
      if (msg) { el.textContent = msg; el.className = "savestate" + (tone ? " savestate--" + tone : ""); return; }
      if (BUSY) { el.textContent = "Saving…"; el.className = "savestate savestate--busy"; return; }
      if (isDirty()) {
        var n = Object.keys(DIRTY).length;
        el.textContent = "Unsaved changes (" + n + " field" + (n === 1 ? "" : "s") + ")";
        el.className = "savestate savestate--dirty";
      } else {
        el.textContent = "All changes saved";
        el.className = "savestate";
      }
    }

    /* Leaving with unsaved work is the one thing a browser can warn about,
       so let it. Registered once, guarded on there being anything to lose. */
    window.addEventListener("beforeunload", function (e) {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    });

    /* ---- save --------------------------------------------------------- */
    function save() {
      if (!isDirty() || BUSY) return;
      BUSY = true;
      paintSaveState();

      var patch = {};
      for (var k in DIRTY) if (DIRTY.hasOwnProperty(k)) patch[k] = DIRTY[k];

      sb.from("transactions").update(patch).eq("id", ID).select().maybeSingle()
        .then(function (res) {
          BUSY = false;
          if (res.error) {
            paintSaveState("Not saved — " + (res.error.message || "the database refused the change"), "bad");
            AG.err.show(dom.q("[data-dtl-error]"), res.error,
                        "Those changes could not be saved.", save);
            return;
          }
          /* Take the row back from the database rather than trusting the
             local copy: a trigger may have changed something. Marking
             Closing complete moves the stage, and the agent should see
             that happen rather than discover it on the next load. */
          if (res.data) TX = merge(TX, res.data);
          DIRTY = {};
          paintAll();
          paintSaveState("Saved", "good");
          loadAudit();
          setTimeout(function () { if (!isDirty() && !BUSY) paintSaveState(); }, 2500);
        })
        .catch(function (e) {
          BUSY = false;
          paintSaveState("Not saved", "bad");
          AG.err.show(dom.q("[data-dtl-error]"), e, "Those changes could not be saved.", save);
        });
    }

    function merge(base, next) {
      var out = {};
      var k;
      for (k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
      for (k in next) if (next.hasOwnProperty(k)) out[k] = next[k];
      /* The embedded client object is not returned by update().select(). */
      if (base && base.client && !next.client) out.client = base.client;
      return out;
    }

    /* Current value of a field: the pending edit if there is one. */
    function val(field) {
      return DIRTY.hasOwnProperty(field) ? DIRTY[field] : (TX ? TX[field] : null);
    }

    /* A view of the row as it WOULD be after saving, so the attention
       panel and the date strip react to edits before they are committed.
       An agent who fixes a date should see the warning clear immediately. */
    function projected() {
      return merge(TX || {}, DIRTY);
    }

    /* ---- header ------------------------------------------------------- */
    function paintHeader() {
      var t = projected();
      document.title = (t.address || "Transaction") + " — TwelvePoint Agent Portal";
      dom.q("[data-dtl-addr]").textContent = t.address || "Transaction";

      var who = (TX && TX.client && TX.client.full_name) || "";
      dom.q("[data-dtl-client]").textContent = who;
      dom.q("[data-dtl-clientname]").textContent = who || "—";
      dom.q("[data-dtl-kind]").textContent = AG.model.kindLabel[t.kind] || "";
      dom.q("[data-dtl-agent]").textContent = AGENTS[t.agent_id] ? "Agent: " + AGENTS[t.agent_id] : "";
      dom.q("[data-dtl-close]").textContent = t.expected_close
        ? "Closing " + fmt.dateLong(t.expected_close) : "No closing date";
      dom.q("[data-dtl-file]").textContent = t.file_number ? "File " + t.file_number : "";
      dom.q("[data-dtl-agentname]").textContent = AGENTS[t.agent_id] || "—";

      var fs = t.closing_status || "active";
      var pill = dom.q("[data-dtl-filestatus]");
      pill.textContent = t.archived_at ? "Archived" : (AG.model.fileStatus[fs] || fs);
      pill.className = "ag-pill ag-pill--" +
        (t.archived_at ? "idle" : (AG.model.fileStatusTone[fs] || "idle"));
    }

    /* ---- stages -------------------------------------------------------- */
    function paintStages() {
      var host = dom.q("[data-dtl-stages]");
      if (!host) return;
      var step = Number(val("progress_step")) || 1;
      dom.clear(host);
      AG.model.stages.forEach(function (label, i) {
        var n = i + 1;
        var li = dom.el("li");
        var b = dom.el("button", "tstage" +
          (n < step ? " tstage--done" : n === step ? " tstage--now" : ""));
        b.type = "button";
        b.setAttribute("aria-current", n === step ? "step" : "false");
        b.appendChild(dom.el("span", "tstage__n", String(n)));
        b.appendChild(dom.el("span", "tstage__label", label));
        dom.on(b, "click", function () {
          if (n === Number(val("progress_step"))) return;
          setDirty("progress_step", n);
          paintStages();
          paintAttention();
        });
        li.appendChild(b);
        host.appendChild(li);
      });
    }

    /* ---- editable fields ------------------------------------------------ */
    function paintFields() {
      dom.qa("[data-fld]").forEach(function (input) {
        var k = input.dataset.fld;
        var v = val(k);
        if (k === "closing_status") {
          v = ({ in_process: "active", cancelled: "terminated" })[v] || v || "active";
        }
        var next = v == null ? "" : String(v);
        if (input.value !== next) input.value = next;
      });
    }

    /* DELEGATED, not bound per input. The date fields are built by
       paintDateInputs() after the row loads, so binding at init time would
       miss every one of them — they looked editable and silently discarded
       what you typed. Delegation cannot go stale as the DOM is rebuilt. */
    function wireFields() {
      var root = dom.q("[data-ag-detail]");
      if (!root) return;

      function handle(e) {
        var input = e.target;
        if (!input || !input.dataset || !input.dataset.fld) return;
        var k = input.dataset.fld;
        var raw = input.value;
        var v = raw === "" ? null
              : input.type === "number" ? Number(raw)
              : raw;
        setDirty(k, v);
        paintHeader();
        paintDateStrip();
        paintAttention();
      }

      /* input for typing, change for selects and date pickers — a native
         date picker fires change on pick and input on keyboard entry, and
         missing either makes the field feel broken. */
      dom.on(root, "input", handle);
      dom.on(root, "change", handle);
    }

    /* ---- dates ---------------------------------------------------------- */
    function paintDateInputs() {
      var host = dom.q("[data-dtl-dates]");
      if (!host || host.childNodes.length) return;   /* built once */
      AG.model.dates.forEach(function (d) {
        var label = dom.el("label", "f");
        label.appendChild(dom.el("span", "f__label", d.label));
        var input = dom.el("input", "f__in");
        input.type = "date";
        input.dataset.fld = d.key;
        label.appendChild(input);
        host.appendChild(label);
      });
    }

    /* The horizontal strip near the top. Deadlines only — a contract date
       is a fact, not something to count down to. */
    function paintDateStrip() {
      var host = dom.q("[data-dtl-datestrip]");
      if (!host) return;
      var t = projected();
      dom.clear(host);

      var shown = 0;
      AG.model.dates.forEach(function (d) {
        if (!d.deadline || !t[d.key]) return;
        shown++;
        var done = d.done && AG.model.isDone(t[d.done]);
        var days = fmt.daysUntil(t[d.key]);
        var tone = done ? "good"
                 : days < 0 ? "bad"
                 : days <= AG.rules.thresholds.dueSoonDays ? "warn" : "idle";

        var cell = dom.el("div", "dcell dcell--" + tone);
        cell.appendChild(dom.el("span", "dcell__l", d.label));
        cell.appendChild(dom.el("span", "dcell__d", fmt.date(t[d.key])));
        cell.appendChild(dom.el("span", "dcell__c",
          done ? "Complete" : fmt.countdown(days)));
        host.appendChild(cell);
      });

      if (!shown) {
        host.appendChild(dom.el("p", "ag-empty",
          "No deadlines set yet. Add them under Dates & deadlines."));
      }
    }

    /* ---- attention ------------------------------------------------------- */
    function paintAttention() {
      var host = dom.q("[data-dtl-attention]");
      var badge = dom.q("[data-dtl-attn-count]");
      if (!host) return;

      var items = AG.rules.evaluate(projected(), { actionItems: ITEMS, documents: DOCS });
      dom.clear(host);

      if (badge) {
        badge.textContent = String(items.length);
        badge.className = "ag-pill ag-pill--" + (AG.rules.worstTone(items) || "good");
      }

      var card = dom.q(".sect-attention");
      if (card) card.classList.toggle("sect-attention--clear", !items.length);

      if (!items.length) {
        var ok = dom.el("li", "attn__ok");
        ok.appendChild(AG.icon("check"));
        ok.appendChild(dom.el("span", null, "Everything is on track"));
        host.appendChild(ok);
        return;
      }

      items.forEach(function (it) {
        var li = dom.el("li", "attn__i attn__i--" + it.tone);
        var b = dom.el("button", "attn__btn");
        b.type = "button";
        b.appendChild(dom.el("span", "attn__dot"));
        b.appendChild(dom.el("span", "attn__text", it.text));
        dom.on(b, "click", function () {
          var target = dom.q("#sec-" + it.target);
          if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
            target.classList.add("ag-card--flash");
            setTimeout(function () { target.classList.remove("ag-card--flash"); }, 1200);
          }
        });
        li.appendChild(b);
        host.appendChild(li);
      });
    }

    /* ---- milestones -------------------------------------------------------- */
    /* One row per milestone, one select per row. The old version drew four
       buttons on every row — 48 controls for twelve facts. */
    function paintMilestones() {
      var host = dom.q("[data-dtl-miles]");
      if (!host) return;
      dom.clear(host);

      AG.model.milestones.forEach(function (m) {
        var cur = val(m.key) || "";
        var state = AG.model.msState(cur);

        var li = dom.el("li", "mile");
        var name = dom.el("span", "mile__name", m.label);
        if (m.required) name.appendChild(dom.el("span", "mile__req", "required"));
        li.appendChild(name);

        var sel = dom.el("select", "mile__sel mile__sel--" + state.tone);
        AG.model.msStates.forEach(function (s) {
          var o = dom.el("option", null, s.label);
          o.value = s.v;
          if (s.v === cur) o.selected = true;
          sel.appendChild(o);
        });
        sel.setAttribute("aria-label", m.label + " status");
        dom.on(sel, "change", function () {
          setDirty(m.key, sel.value || null);
          sel.className = "mile__sel mile__sel--" + AG.model.msState(sel.value).tone;
          /* Marking Closing complete moves the stage in the database via a
             trigger. Reflect that here so the page does not disagree with
             itself until the next load. */
          if (m.key === "ms_closing" && sel.value === "complete") {
            setDirty("progress_step", 4);
            paintStages();
          }
          paintAttention();
          paintDateStrip();
        });
        li.appendChild(sel);
        host.appendChild(li);
      });
    }

    /* ---- paint everything ---------------------------------------------------- */
    function paintAll() {
      paintHeader();
      paintStages();
      paintDateInputs();
      paintFields();
      paintDateStrip();
      paintMilestones();
      paintAttention();
      paintSaveState();
    }

    /* ================================================================ */
    /* client action items                                              */
    /* ================================================================ */
    var PRIORITY = { normal: "Normal", high: "High", urgent: "Urgent" };

    function loadItems() {
      var host = dom.q("[data-dtl-actions]");
      return sb.from("transaction_action_items")
        .select("id, title, note, due_date, status, priority, notify_client, sort_order")
        .eq("transaction_id", ID).order("sort_order")
        .then(function (res) {
          if (res.error) {
            AG.err.show(host, res.error, "Action items couldn’t load.", loadItems);
            return;
          }
          ITEMS = res.data || [];
          paintItems();
          paintAttention();
        })
        .catch(function (e) { AG.err.show(host, e, "Action items couldn’t load.", loadItems); });
    }

    function paintItems() {
      var host = dom.q("[data-dtl-actions]");
      if (!host) return;
      dom.clear(host);
      host.hidden = false;

      if (!ITEMS.length) {
        host.appendChild(dom.el("p", "ag-empty", "No tasks for the client yet."));
        return;
      }

      var ul = dom.el("ul", "tasks");
      ITEMS.forEach(function (a) {
        var done = a.status === "complete";
        var overdue = !done && a.due_date && fmt.daysUntil(a.due_date) < 0;
        var li = dom.el("li", "task" + (done ? " task--done" : "") + (overdue ? " task--bad" : ""));

        var box = dom.el("input", "task__box");
        box.type = "checkbox";
        box.checked = done;
        box.setAttribute("aria-label", "Mark “" + a.title + "” complete");
        dom.on(box, "change", function () {
          box.disabled = true;
          sb.from("transaction_action_items")
            .update({ status: box.checked ? "complete" : "pending" }).eq("id", a.id)
            .then(function (r) {
              box.disabled = false;
              if (r.error) { box.checked = done; AG.err.show(host, r.error, "That task could not be updated.", null); return; }
              a.status = box.checked ? "complete" : "pending";
              paintItems();
              paintAttention();
            });
        });
        li.appendChild(box);

        var body = dom.el("span", "task__body");
        body.appendChild(dom.el("span", "task__title", a.title));
        var meta = dom.el("span", "task__meta");
        if (a.due_date) {
          var d = fmt.daysUntil(a.due_date);
          meta.appendChild(dom.el("span", overdue ? "task__due task__due--bad" : "task__due",
            "Due " + fmt.date(a.due_date) + (done ? "" : " · " + fmt.countdown(d))));
        }
        if (a.priority && a.priority !== "normal") {
          meta.appendChild(dom.el("span", "ag-pill ag-pill--" + (a.priority === "urgent" ? "bad" : "warn"),
            PRIORITY[a.priority] || a.priority));
        }
        body.appendChild(meta);
        li.appendChild(body);

        var del = dom.el("button", "iconbtn", "Remove");
        del.type = "button";
        dom.on(del, "click", function () {
          if (!confirm("Remove “" + a.title + "” from the client's list?")) return;
          sb.from("transaction_action_items").delete().eq("id", a.id).then(function (r) {
            if (r.error) { AG.err.show(host, r.error, "That task could not be removed.", null); return; }
            loadItems();
          });
        });
        li.appendChild(del);
        ul.appendChild(li);
      });
      host.appendChild(ul);
    }

    function wireItemForm() {
      var form = dom.q("[data-dtl-actionform]");
      if (!form) return;
      dom.on(form, "submit", function (e) {
        e.preventDefault();
        var f = form.elements;
        var title = f.title.value.trim();
        if (!title) return;
        var btn = form.querySelector("button[type=submit]");
        if (btn) btn.disabled = true;
        sb.from("transaction_action_items").insert({
          transaction_id: ID,
          title: title,
          due_date: f.due_date.value || null,
          priority: f.priority.value || "normal",
          sort_order: (ITEMS.length + 1) * 10
        }).then(function (r) {
          if (btn) btn.disabled = false;
          if (r.error) {
            AG.err.show(dom.q("[data-dtl-actions]"), r.error, "That task could not be added.", null);
            return;
          }
          form.reset();
          loadItems();
        });
      });
    }

    /* ================================================================ */
    /* documents                                                        */
    /* ================================================================ */
    function loadDocs() {
      var host = dom.q("[data-dtl-docs]");
      return sb.from("transaction_documents")
        .select("id, name, category, storage_path, status, client_visible, created_at, uploaded_by")
        .eq("transaction_id", ID).order("created_at", { ascending: false })
        .then(function (res) {
          if (res.error) {
            AG.err.show(host, res.error, "Documents couldn’t load.", loadDocs);
            return;
          }
          DOCS = res.data || [];
          paintDocs();
        })
        .catch(function (e) { AG.err.show(host, e, "Documents couldn’t load.", loadDocs); });
    }

    function paintDocs() {
      var host = dom.q("[data-dtl-docs]");
      if (!host) return;
      dom.clear(host);
      host.hidden = false;

      if (!DOCS.length) {
        host.appendChild(dom.el("p", "ag-empty", "No documents on this file yet."));
        return;
      }

      var wrap = dom.el("div", "docwrap");
      var table = dom.el("table", "doctable");
      var thead = dom.el("thead"), hr = dom.el("tr");
      ["Document", "Category", "Visibility", "Added", ""].forEach(function (h) {
        hr.appendChild(dom.el("th", null, h));
      });
      thead.appendChild(hr);
      table.appendChild(thead);

      var tb = dom.el("tbody");
      DOCS.forEach(function (d) { tb.appendChild(docRow(d)); });
      table.appendChild(tb);
      wrap.appendChild(table);
      host.appendChild(wrap);
    }

    function docRow(d) {
      var tr = dom.el("tr");

      tr.appendChild(dom.el("td", "doc__name", d.name || "Document"));

      /* category */
      var cat = dom.el("td");
      var sel = dom.el("select", "f__in f__in--sm");
      AG.model.docCategories.forEach(function (c) {
        var o = dom.el("option", null, c.label);
        o.value = c.v;
        if ((d.category || "other") === c.v) o.selected = true;
        sel.appendChild(o);
      });
      sel.setAttribute("aria-label", "Category for " + (d.name || "document"));
      dom.on(sel, "change", function () {
        sb.from("transaction_documents").update({ category: sel.value }).eq("id", d.id)
          .then(function (r) {
            if (r.error) { AG.err.show(dom.q("[data-dtl-docs]"), r.error, "The category could not be changed.", null); return; }
            d.category = sel.value;
          });
      });
      cat.appendChild(sel);
      tr.appendChild(cat);

      /* visibility — the most important control on this page */
      var vis = dom.el("td");
      var btn = dom.el("button", "visbtn " + (d.client_visible ? "visbtn--client" : "visbtn--internal"));
      btn.type = "button";
      function paintVis() {
        dom.clear(btn);
        btn.className = "visbtn " + (d.client_visible ? "visbtn--client" : "visbtn--internal");
        btn.appendChild(AG.icon(d.client_visible ? "eye" : "lock"));
        btn.appendChild(dom.el("span", null, d.client_visible ? "Shared with client" : "Internal"));
        btn.title = d.client_visible
          ? "The client can open this. Click to make it internal."
          : "Only staff can open this. Click to share it with the client.";
      }
      paintVis();
      dom.on(btn, "click", function () {
        var next = !d.client_visible;
        /* Sharing is the direction that can do harm, so it is the one that
           asks. Un-sharing just goes. */
        if (next && !confirm("Share “" + (d.name || "this document") + "” with the client?\n\n" +
                             "They will be able to open it from their portal immediately.")) return;
        btn.disabled = true;
        sb.from("transaction_documents").update({ client_visible: next }).eq("id", d.id)
          .then(function (r) {
            btn.disabled = false;
            if (r.error) { AG.err.show(dom.q("[data-dtl-docs]"), r.error, "Visibility could not be changed.", null); return; }
            d.client_visible = next;
            paintVis();
          });
      });
      vis.appendChild(btn);
      tr.appendChild(vis);

      tr.appendChild(dom.el("td", "ag-muted ag-nowrap", fmt.date(d.created_at)));

      /* actions */
      var act = dom.el("td", "doc__act");
      var open = dom.el("button", "iconbtn", "Open");
      open.type = "button";
      dom.on(open, "click", function () {
        open.disabled = true;
        sb.storage.from("transaction-docs").createSignedUrl(d.storage_path, 60)
          .then(function (r) {
            open.disabled = false;
            if (r.error || !r.data) { AG.err.show(dom.q("[data-dtl-docs]"), r.error, "That file could not be opened.", null); return; }
            window.open(r.data.signedUrl, "_blank", "noopener");
          });
      });
      act.appendChild(open);

      var ren = dom.el("button", "iconbtn", "Rename");
      ren.type = "button";
      dom.on(ren, "click", function () {
        var name = prompt("Rename this document", d.name || "");
        if (name == null) return;
        name = name.trim();
        if (!name) return;
        sb.from("transaction_documents").update({ name: name }).eq("id", d.id).then(function (r) {
          if (r.error) { AG.err.show(dom.q("[data-dtl-docs]"), r.error, "It could not be renamed.", null); return; }
          loadDocs();
        });
      });
      act.appendChild(ren);

      var del = dom.el("button", "iconbtn iconbtn--bad", "Delete");
      del.type = "button";
      dom.on(del, "click", function () {
        if (!confirm("Delete “" + (d.name || "this document") + "”?\n\nThis removes the file as well and cannot be undone.")) return;
        sb.storage.from("transaction-docs").remove([d.storage_path]).then(function () {
          return sb.from("transaction_documents").delete().eq("id", d.id);
        }).then(function (r) {
          if (r && r.error) { AG.err.show(dom.q("[data-dtl-docs]"), r.error, "It could not be deleted.", null); return; }
          loadDocs();
        });
      });
      act.appendChild(del);

      tr.appendChild(act);
      return tr;
    }

    function wireUpload() {
      var drop = dom.q("[data-dtl-drop]");
      var input = dom.q("[data-dtl-file]");
      var state = dom.q("[data-dtl-upstate]");
      if (!drop || !input) return;

      function say(msg, tone) {
        if (!state) return;
        state.hidden = !msg;
        state.textContent = msg || "";
        state.className = "uploadstate" + (tone ? " uploadstate--" + tone : "");
      }

      ["dragenter", "dragover"].forEach(function (e) {
        dom.on(drop, e, function (ev) { ev.preventDefault(); drop.classList.add("drop--over"); });
      });
      ["dragleave", "drop"].forEach(function (e) {
        dom.on(drop, e, function (ev) { ev.preventDefault(); drop.classList.remove("drop--over"); });
      });
      dom.on(drop, "drop", function (ev) {
        if (ev.dataTransfer && ev.dataTransfer.files) upload(ev.dataTransfer.files);
      });
      dom.on(input, "change", function () { upload(input.files); input.value = ""; });

      function upload(files) {
        var list = Array.prototype.slice.call(files || []);
        if (!list.length) return;
        var done = 0, failed = 0;
        say("Uploading " + list.length + " file" + (list.length === 1 ? "" : "s") + "…");

        list.reduce(function (chain, file) {
          return chain.then(function () {
            /* Path is transactionId/timestamp-name. The leading folder is
               what the Storage policy checks, so it must stay first. */
            var safe = file.name.replace(/[^\w.\- ]+/g, "_");
            var path = ID + "/" + Date.now() + "-" + safe;
            return sb.storage.from("transaction-docs").upload(path, file)
              .then(function (up) {
                if (up.error) throw up.error;
                return sb.from("transaction_documents").insert({
                  transaction_id: ID,
                  name: file.name,
                  storage_path: path,
                  category: "other",
                  client_visible: false,      /* explicit, not merely defaulted */
                  uploaded_by: SESSION && SESSION.user && SESSION.user.id
                });
              })
              .then(function (ins) { if (ins.error) throw ins.error; done++; })
              .catch(function (e) {
                failed++;
                if (window.console) console.error("[agent] upload failed", file.name, e);
              });
          });
        }, Promise.resolve()).then(function () {
          say(failed
            ? done + " uploaded, " + failed + " failed. Check the file size and try again."
            : done + " file" + (done === 1 ? "" : "s") + " uploaded, internal until you share them.",
            failed ? "bad" : "good");
          loadDocs();
          setTimeout(function () { say(""); }, 6000);
        });
      }
    }

    /* ================================================================ */
    /* internal notes                                                   */
    /* ================================================================ */
    function loadNotes() {
      var host = dom.q("[data-dtl-notes]");
      return sb.from("transaction_notes")
        .select("id, body, author_email, author_id, created_at")
        .eq("transaction_id", ID).order("created_at", { ascending: false })
        .then(function (res) {
          if (res.error) { AG.err.show(host, res.error, "Notes couldn’t load.", loadNotes); return; }
          NOTES = res.data || [];
          paintNotes();
        })
        .catch(function (e) { AG.err.show(host, e, "Notes couldn’t load.", loadNotes); });
    }

    function paintNotes() {
      var host = dom.q("[data-dtl-notes]");
      if (!host) return;
      dom.clear(host);
      host.hidden = false;
      if (!NOTES.length) {
        host.appendChild(dom.el("p", "ag-empty", "No internal notes yet."));
        return;
      }
      var ul = dom.el("ul", "notes");
      NOTES.forEach(function (n) {
        var li = dom.el("li", "note-i");
        var head = dom.el("div", "note-i__head");
        head.appendChild(dom.el("span", "note-i__who",
          (n.author_email || "Someone").split("@")[0]));
        head.appendChild(dom.el("span", "note-i__when", fmt.dateTime(n.created_at)));

        var mine = SESSION && SESSION.user && n.author_id === SESSION.user.id;
        if (mine || ROLE === "admin") {
          var del = dom.el("button", "iconbtn iconbtn--bad", "Delete");
          del.type = "button";
          dom.on(del, "click", function () {
            if (!confirm("Delete this note? Notes cannot be edited, only removed.")) return;
            sb.from("transaction_notes").delete().eq("id", n.id).then(function (r) {
              if (r.error) { AG.err.show(host, r.error, "That note could not be removed.", null); return; }
              loadNotes();
            });
          });
          head.appendChild(del);
        }
        li.appendChild(head);
        li.appendChild(dom.el("p", "note-i__body", n.body));
        ul.appendChild(li);
      });
      host.appendChild(ul);
    }

    function wireNoteForm() {
      var form = dom.q("[data-dtl-noteform]");
      if (!form) return;
      dom.on(form, "submit", function (e) {
        e.preventDefault();
        var body = form.elements.body.value.trim();
        if (!body) return;
        var btn = form.querySelector("button[type=submit]");
        if (btn) btn.disabled = true;
        sb.from("transaction_notes").insert({
          transaction_id: ID,
          body: body,
          author_id: SESSION && SESSION.user && SESSION.user.id,
          author_email: SESSION && SESSION.user && SESSION.user.email
        }).then(function (r) {
          if (btn) btn.disabled = false;
          if (r.error) { AG.err.show(dom.q("[data-dtl-notes]"), r.error, "That note could not be saved.", null); return; }
          form.reset();
          loadNotes();
        });
      });
    }

    /* ================================================================ */
    /* activity                                                         */
    /* ================================================================ */
    function loadAudit() {
      var host = dom.q("[data-dtl-activity]");
      return sb.from("transaction_audit")
        .select("field, old_value, new_value, actor_email, created_at, source")
        .eq("transaction_id", ID).order("created_at", { ascending: false }).limit(60)
        .then(function (res) {
          if (res.error) { AG.err.show(host, res.error, "Activity couldn’t load.", loadAudit); return; }
          AUDIT = res.data || [];
          paintAudit();
        })
        .catch(function (e) { AG.err.show(host, e, "Activity couldn’t load.", loadAudit); });
    }

    /* Grouped by day, because "what changed today" is the question. */
    function paintAudit() {
      var host = dom.q("[data-dtl-activity]");
      if (!host) return;
      dom.clear(host);
      host.hidden = false;

      if (!AUDIT.length) {
        host.appendChild(dom.el("p", "ag-empty", "Nothing recorded yet."));
        return;
      }

      var lastDay = null, ul = null;
      AUDIT.forEach(function (a) {
        var d = new Date(a.created_at);
        var day = d.toDateString();
        if (day !== lastDay) {
          lastDay = day;
          var today = new Date().toDateString();
          var yday = new Date(Date.now() - 86400000).toDateString();
          host.appendChild(dom.el("h3", "feed__day",
            day === today ? "Today" : day === yday ? "Yesterday"
              : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })));
          ul = dom.el("ul", "feed");
          host.appendChild(ul);
        }

        var li = dom.el("li", "feed__i");
        li.appendChild(dom.el("span", "feed__t",
          d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })));

        var body = dom.el("span", "feed__b");
        var who = a.source === "system" ? "Automatically" :
                  (a.actor_email || "Someone").split("@")[0];
        body.appendChild(dom.el("span", "feed__who", who));
        body.appendChild(dom.el("span", null, " changed " + fmt.field(a.field)));

        var change = dom.el("span", "feed__c");
        change.appendChild(dom.el("span", "feed__from", pretty(a.field, a.old_value)));
        change.appendChild(dom.el("span", "feed__arrow", "→"));
        change.appendChild(dom.el("span", "feed__to", pretty(a.field, a.new_value)));
        body.appendChild(change);

        if (a.source === "system") {
          body.appendChild(dom.el("span", "ag-pill ag-pill--idle", "automatic"));
        }
        li.appendChild(body);
        ul.appendChild(li);
      });
    }

    function pretty(field, v) {
      if (v == null || v === "") return "empty";
      if (field === "progress_step") return AG.model.stages[Number(v) - 1] || v;
      if (field.indexOf("ms_") === 0) return AG.model.msState(v).label;
      if (field === "closing_status") return AG.model.fileStatus[v] || v;
      if (field === "sales_price") return fmt.money(v);
      if (/_date$|_due$|_ends$|_deadline$|expected_close/.test(field)) return fmt.date(v);
      return String(v);
    }

    /* ================================================================ */
    /* the ••• menu                                                     */
    /* ================================================================ */
    function buildMenu() {
      var wrap = dom.q("[data-dtl-menu]");
      var btn = dom.q("[data-dtl-menubtn]");
      var list = dom.q("[data-dtl-menulist]");
      if (!wrap || !btn || !list) return;

      dom.clear(list);

      function item(label, danger, fn) {
        var b = dom.el("button", "menu__i" + (danger ? " menu__i--bad" : ""), label);
        b.type = "button";
        b.setAttribute("role", "menuitem");
        dom.on(b, "click", function () { close(); fn(); });
        list.appendChild(b);
        return b;
      }

      if (TX && TX.archived_at) {
        if (ROLE === "admin") {
          item("Restore transaction", false, function () {
            sb.rpc("restore_transaction", { p_id: ID }).then(afterRpc("Restored."));
          });
        } else {
          var note = dom.el("p", "menu__note", "Archived. An administrator can restore it.");
          list.appendChild(note);
        }
      } else {
        item("Archive transaction", false, function () {
          if (!confirm("Archive this transaction?\n\nIt leaves the active list. Nothing is deleted.")) return;
          sb.rpc("archive_transaction", { p_id: ID }).then(afterRpc("Archived."));
        });
      }

      /* Hard delete is admin-only and asks for the address to be typed.
         It is in the menu because it has to live somewhere, not because
         it is a normal thing to do. */
      if (ROLE === "admin") {
        item("Delete permanently", true, function () {
          var typed = prompt(
            "This permanently deletes the transaction, its documents, notes and " +
            "its entire history. It cannot be undone.\n\n" +
            "Archive is almost always the right choice instead.\n\n" +
            "To confirm, type the property address exactly:\n" + (TX.address || ""));
          if (typed == null) return;
          sb.rpc("delete_transaction_hard", { p_id: ID, p_confirm_address: typed })
            .then(function (r) {
              if (r.error) { alert(r.error.message || "It was not deleted."); return; }
              location.assign("/portal/agent/");
            });
        });
      }

      function afterRpc(msg) {
        return function (r) {
          if (r.error) {
            AG.err.show(dom.q("[data-dtl-error]"), r.error, "That did not work.", null);
            return;
          }
          paintSaveState(msg, "good");
          reloadRow();
        };
      }

      function open() { list.hidden = false; btn.setAttribute("aria-expanded", "true"); }
      function close() { list.hidden = true; btn.setAttribute("aria-expanded", "false"); }

      dom.on(btn, "click", function (e) {
        e.stopPropagation();
        if (list.hidden) open(); else close();
      });
      dom.on(document, "click", function (e) { if (!wrap.contains(e.target)) close(); });
      dom.on(document, "keydown", function (e) { if (e.key === "Escape") close(); });
    }

    /* ================================================================ */
    /* load                                                             */
    /* ================================================================ */
    function reloadRow() {
      return sb.from("transactions")
        .select("*, client:profiles!transactions_client_profile_fkey(full_name)")
        .eq("id", ID).maybeSingle()
        .then(function (res) {
          if (res.error || !res.data) {
            return sb.from("transactions").select("*").eq("id", ID).maybeSingle();
          }
          return res;
        })
        .then(function (res) {
          if (res.error) throw res.error;
          if (!res.data) {
            var box = dom.q("[data-dtl-error]");
            if (box) {
              box.hidden = false;
              dom.clear(box);
              box.appendChild(dom.el("span", "ag-err__msg",
                "That transaction is not on your account."));
              box.className = "ag-err";
            }
            return;
          }
          TX = res.data;
          dom.q("[data-dtl-body]").hidden = false;
          paintAll();
          buildMenu();
        });
    }

    return {
      init: function (client, session, role) {
        sb = client;
        SESSION = session;
        ROLE = role || "agent";
        if (!dom.q("[data-ag-detail]")) return;

        ID = new URLSearchParams(location.search).get("id");
        var box = dom.q("[data-dtl-error]");
        if (!ID) {
          if (box) {
            box.hidden = false;
            box.className = "ag-err";
            box.textContent = "No transaction was specified.";
          }
          return;
        }

        wireFields();
        wireItemForm();
        wireNoteForm();
        wireUpload();
        dom.on(dom.q("[data-dtl-save]"), "click", save);

        /* Ctrl/Cmd+S is what anyone editing a form reaches for. */
        dom.on(document, "keydown", function (e) {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            save();
          }
        });

        sb.rpc("agent_options").then(function (r) {
          if (!r.error && r.data) {
            r.data.forEach(function (a) { AGENTS[a.id] = a.full_name || a.email; });
            if (TX) paintHeader();
          }
        });

        reloadRow()
          .then(function () {
            /* Sequential rather than parallel: each of these can fail on
               its own and report into its own section, and a failure in
               one must not stop the others rendering. */
            return loadItems();
          })
          .then(loadDocs)
          .then(loadNotes)
          .then(loadAudit)
          .catch(function (e) {
            AG.err.show(dom.q("[data-dtl-error]"), e,
                        "This transaction couldn’t load.", function () { location.reload(); });
          });
      }
    };
  })();

  /* The sidebar is not this file's job any more — assets/rail.js owns it
     and is shared with the client portal. */
  return AG;
})();
