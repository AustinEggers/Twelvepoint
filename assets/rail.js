/* =====================================================================
   rail.js — sidebar behaviour, shared by both portals.

   Loaded by every page under /portal/, agent and client alike, BEFORE
   portal.js and agent.js. Depends on nothing and exports window.TPRail.

   WHY IT IS SHARED
   This used to live inside agent.js as AG.shell, which meant the client
   portal got a plainer sidebar with no icons and a different active
   state — a visible seam between two halves of the same product for no
   reason anyone could have explained.

   FOUR JOBS, and nothing else:
     1. mark the current page from the URL
     2. put an icon in front of each label
     3. a collapse toggle on desktop, remembered per browser
     4. a drawer under 60rem

   Everything degrades. If this file fails to load, portal-rail.css still
   draws a usable static sidebar: the drawer rules are gated on the
   has-railbar class set here, so the rail never hides with no way to
   open it.
   ===================================================================== */

window.TPRail = (function () {
  "use strict";

  var STORE = "tp-rail-collapsed";
  var NS = "http://www.w3.org/2000/svg";

  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(t, c, x) {
    var n = document.createElement(t);
    if (c) n.className = c;
    if (x != null) n.textContent = x;
    return n;
  }

  /* Inline SVG rather than an icon font: no extra request, no flash of
     missing glyph, and stroke follows currentColor so one definition
     works for idle, hover and active. Every path is a literal in this
     file — none of it comes from the database. */
  var ICONS = {
    transactions: "M3 5h13M3 10h9M3 15h13M16 13l3 3-3 3",
    contracts:    "M5 2h7l4 4v12H5zM12 2v4h4",
    marketing:    "M4 8v4h3l5 3V5L7 8zM15 8a3 3 0 0 1 0 4",
    vendors:      "M3 17V8l7-5 7 5v9M8 17v-5h4v5",
    team:         "M7 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 16c0-2.5 2.2-4 5-4s5 1.5 5 4M14 7.5a2 2 0 1 0 0-4M18 16c0-2-1.5-3.2-3.5-3.6",
    leads:        "M3 5h14v10H3zM3 6l7 5 7-5",
    contact:      "M3 5h14v10H3zM3 6l7 5 7-5",
    home:         "M3 9l7-6 7 6v8H3z",
    menu:         "M3 6h14M3 10h14M3 14h14",
    collapse:     "M12 5l-4 5 4 5M4 4v12"
  };

  function icon(name) {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var d = ICONS[name];
    if (!d) return svg;
    var p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
    return svg;
  }

  /* ------------------------------------------------------------------ */
  /* aria-current is hand-written in the markup and rots the moment a
     file is renamed. Recomputing it from the URL keeps it honest.

     The section root is skipped in the first pass because it prefixes
     every page beneath it and would always win; it is the fallback, so
     that a detail page like transaction.html highlights the section it
     belongs to rather than nothing at all. */
  function markCurrent(sectionRoot) {
    var here = location.pathname.replace(/index\.html$/, "");
    var links = qa(".rail__nav a");
    var hit = null;

    links.forEach(function (a) {
      a.removeAttribute("aria-current");
      var path = (a.getAttribute("href") || "").split("#")[0].replace(/index\.html$/, "");
      if (!path || path === sectionRoot) return;
      if (path === here) hit = a;
    });

    if (!hit && sectionRoot) {
      hit = links.filter(function (a) {
        return (a.getAttribute("href") || "").replace(/index\.html$/, "") === sectionRoot;
      })[0] || null;
    }
    if (hit) hit.setAttribute("aria-current", "page");
  }

  /* Wrap each label in a span and prepend its icon. Done in script so the
     markup stays readable and the icon set lives in one place. */
  function decorateNav() {
    qa(".rail__nav a").forEach(function (a) {
      if (a.querySelector("svg")) return;
      var name = a.getAttribute("data-icon");
      var label = el("span", "rail__label", a.textContent.trim());
      while (a.firstChild) a.removeChild(a.firstChild);
      if (name) a.appendChild(icon(name));
      a.appendChild(label);
    });
  }

  function buildToggle() {
    var nav = q(".rail__nav");
    if (!nav || q(".rail__toggle")) return;
    var t = el("button", "rail__toggle");
    t.type = "button";
    t.appendChild(icon("collapse"));
    t.appendChild(el("span", "rail__label", "Collapse"));
    t.setAttribute("aria-label", "Collapse sidebar");
    t.addEventListener("click", function () {
      var tight = document.body.classList.toggle("is-railtight");
      t.setAttribute("aria-label", tight ? "Expand sidebar" : "Collapse sidebar");
      try { localStorage.setItem(STORE, tight ? "1" : "0"); } catch (e) {}
    });
    nav.parentNode.insertBefore(t, nav.nextSibling);
  }

  function buildDrawer() {
    var app = q(".app");
    if (!app || q(".railbar")) return;

    var bar = el("div", "railbar");
    var menu = el("button", "railbar__menu");
    menu.type = "button";
    menu.setAttribute("aria-label", "Open menu");
    menu.setAttribute("aria-expanded", "false");
    menu.appendChild(icon("menu"));
    bar.appendChild(menu);

    var mark = document.createElement("img");
    mark.src = "/assets/mark-cream.png";
    mark.alt = "TwelvePoint Realty Group";
    bar.appendChild(mark);

    app.insertBefore(bar, app.firstChild);
    /* Only now are the drawer rules allowed to apply. */
    document.body.classList.add("has-railbar");

    function close() {
      document.body.classList.remove("is-railopen");
      menu.setAttribute("aria-expanded", "false");
      var s = q(".railscrim");
      if (s && s.parentNode) s.parentNode.removeChild(s);
    }

    menu.addEventListener("click", function () {
      var open = document.body.classList.toggle("is-railopen");
      menu.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) { close(); return; }
      var scrim = el("button", "railscrim");
      scrim.type = "button";
      scrim.setAttribute("aria-label", "Close menu");
      scrim.addEventListener("click", close);
      document.body.appendChild(scrim);
    });

    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    qa(".rail__nav a").forEach(function (a) { a.addEventListener("click", close); });
  }

  function restore() {
    var v = null;
    try { v = localStorage.getItem(STORE); } catch (e) {}
    if (v !== "1") return;
    document.body.classList.add("is-railtight");
    var t = q(".rail__toggle");
    if (t) t.setAttribute("aria-label", "Expand sidebar");
  }

  /* ------------------------------------------------------------------ */
  var API = {
    icon: icon,
    markCurrent: markCurrent,
    init: function () {
      if (!q(".rail")) return;
      /* Which link is the section root depends on which portal this is. */
      var root = location.pathname.indexOf("/portal/agent/") === 0
        ? "/portal/agent/" : "/portal/client/";
      markCurrent(root);
      decorateNav();
      buildToggle();
      buildDrawer();
      restore();
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", API.init);
  } else {
    API.init();
  }

  return API;
})();
