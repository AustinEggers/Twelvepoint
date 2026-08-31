/* TwelvePoint Realty Group — shared behaviour
   Kept deliberately small: a sticky header, one reveal observer, one
   orchestrated antler draw, and a mobile nav. No dependencies. */
(function () {
  "use strict";

  /* Mark the document as scripted FIRST. Every hidden-then-revealed element
     is gated on this class, so if this file fails to load or throws, the
     content simply renders visible instead of disappearing. */
  document.documentElement.classList.add("js");

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --- sticky masthead ------------------------------------------------- */
  var head = document.querySelector(".masthead");
  if (head) {
    var solid = document.body.hasAttribute("data-solid-header");
    var onScroll = function () {
      head.classList.toggle("is-stuck", solid || window.scrollY > 40);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* --- hero headline parallax ------------------------------------------ */
  /* Writes scroll progress (0 to 1) into --sp on the headline. The CSS turns
     that into an upward translate plus a fade, so the movement is tied to
     scroll position rather than to a duration — it tracks the finger exactly
     and reverses on the way back up for free.

     Divisor is 0.72 of the hero height so the headline is fully gone a little
     BEFORE the hero leaves the viewport, rather than exactly as it does. */
  var heroEl = document.querySelector(".hero");
  /* --sp goes on .hero__inner so BOTH the headline and the boxes ride the
     scroll exit together, and so the exit transform never collides with the
     entrance animations, which live on the lines and the box row. */
  var headline = document.querySelector(".hero__inner");
  if (heroEl && headline && !reduced) {
    var last = -1, queued = false;

    var apply = function () {
      queued = false;
      var span = heroEl.offsetHeight * 0.72;
      if (span <= 0) return;
      var p = window.scrollY / span;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      p = Math.round(p * 1000) / 1000;
      if (p === last) return;          /* skip no-op style writes */
      last = p;
      headline.style.setProperty("--sp", p);
    };
    var queue = function () {
      if (!queued) { queued = true; requestAnimationFrame(apply); }
    };
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    apply();
  }

  /* --- photography plate: scroll-linked scale -------------------------- */
  /* Writes 0..1 into --pp as the plate crosses the viewport. CSS turns that
     into a 1.035 -> 1.00 scale, which is small enough to register as the
     image settling rather than as an effect. Skipped entirely under reduced
     motion, and it shares the rAF pattern used by the hero. */
  var plate = document.querySelector(".plate");
  var plateImg = plate && plate.querySelector("img");
  if (plate && plateImg && !reduced) {
    var lastP = -1, queuedP = false;

    var applyPlate = function () {
      queuedP = false;
      var r = plate.getBoundingClientRect();
      var span = window.innerHeight + r.height;
      if (span <= 0) return;
      var p = (window.innerHeight - r.top) / span;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      p = Math.round(p * 100) / 100;
      if (p === lastP) return;
      lastP = p;
      plateImg.style.setProperty("--pp", p);
    };
    var queueP = function () {
      if (!queuedP) { queuedP = true; requestAnimationFrame(applyPlate); }
    };
    window.addEventListener("scroll", queueP, { passive: true });
    window.addEventListener("resize", queueP);
    applyPlate();
  }

  /* --- home value: multi-step form ------------------------------------- */
  /* The markup ships with every field present and all steps visible. This
     turns it into a wizard only once scripting is confirmed working, so a
     failed script leaves a long but perfectly usable form rather than two
     thirds of the fields hidden with no way to reach them. */
  var wizard = document.querySelector("[data-wizard]");
  if (wizard) {
    var steps = [].slice.call(wizard.querySelectorAll(".wizard__step"));
    var bar = wizard.querySelector("[data-wizard-bar]");
    var fill = wizard.querySelector("[data-wizard-fill]");
    var current = wizard.querySelector("[data-wizard-current]");
    var backBtn = wizard.querySelector("[data-wizard-back]");
    var nextBtn = wizard.querySelector("[data-wizard-next]");
    var submitBtn = wizard.querySelector("[data-wizard-submit]");

    if (steps.length > 1 && bar && nextBtn && submitBtn) {
      var at = 0;

      var clearError = function (el) {
        el.removeAttribute("aria-invalid");
        var msg = el.parentNode.querySelector(".field__error");
        if (msg) msg.remove();
      };

      /* Validate only the step being left, so someone is never blocked by a
         field they have not reached yet. */
      var validate = function (i) {
        var ok = true, first = null;
        steps[i].querySelectorAll("input, select, textarea").forEach(function (el) {
          clearError(el);
          if (el.hasAttribute("required") && !el.value.trim()) {
            el.setAttribute("aria-invalid", "true");
            var msg = document.createElement("span");
            msg.className = "field__error";
            msg.textContent = "Please fill this in";
            el.parentNode.appendChild(msg);
            if (!first) first = el;
            ok = false;
          } else if (el.type === "email" && el.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value)) {
            el.setAttribute("aria-invalid", "true");
            var m2 = document.createElement("span");
            m2.className = "field__error";
            m2.textContent = "Check this email address";
            el.parentNode.appendChild(m2);
            if (!first) first = el;
            ok = false;
          }
        });
        if (first) first.focus();
        return ok;
      };

      var render = function (moveFocus) {
        steps.forEach(function (s, i) { s.hidden = i !== at; });
        var last = at === steps.length - 1;
        backBtn.hidden = at === 0;
        nextBtn.hidden = last;
        submitBtn.hidden = !last;
        current.textContent = String(at + 1);
        fill.style.width = ((at + 1) / steps.length * 100) + "%";
        if (moveFocus) {
          var legend = steps[at].querySelector(".wizard__legend");
          if (legend) {
            legend.setAttribute("tabindex", "-1");
            legend.focus({ preventScroll: true });
          }
        }
      };

      bar.hidden = false;
      render(false);

      nextBtn.addEventListener("click", function () {
        if (!validate(at)) return;
        if (at < steps.length - 1) { at++; render(true); }
      });
      backBtn.addEventListener("click", function () {
        if (at > 0) { at--; render(true); }
      });
      /* Enter should advance rather than submit a half-filled form. */
      wizard.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.target.tagName === "INPUT" && at < steps.length - 1) {
          e.preventDefault();
          nextBtn.click();
        }
      });
      wizard.addEventListener("submit", function (e) {
        /* stopImmediatePropagation matters: the lead handler further down
           this file also listens for submit on this form, and without it a
           failed validation would still be posted. */
        if (!validate(at)) { e.preventDefault(); e.stopImmediatePropagation(); }
      });

      /* --- lift the wizard into its dialog ---------------------------- */
      /* Same approach as the buyers page: the form is written once, in the
         page, and MOVED here rather than duplicated. One set of ids, one
         future handler, and with JS off the wizard stays where it is and
         works as an ordinary form. */
      var hvDlg = document.getElementById("homevalue");
      var hvInDialog = false;
      if (hvDlg && typeof hvDlg.showModal === "function") {
        var hvSlot = hvDlg.querySelector("[data-hv-slot]");
        var hvHost = document.querySelector("[data-hv-formhost]");
        var hvCta  = document.querySelector("[data-hv-cta]");
        if (hvSlot) {
          hvSlot.appendChild(wizard);
          hvInDialog = true;
          if (hvHost) hvHost.hidden = true;
          if (hvCta) hvCta.hidden = false;
        }
      }

      /* Carry the hero address into step one so it is never typed twice. */
      var starter = document.querySelector("[data-hv-start]");
      if (starter) {
        starter.addEventListener("submit", function (e) {
          e.preventDefault();
          var from = starter.querySelector('input[name="address"]');
          var to = wizard.querySelector("#hv-address");
          if (from && to && from.value.trim()) to.value = from.value.trim();

          /* Focus the first field the visitor still has to fill: if they
             already typed an address, skip past it rather than landing on
             a box they just completed. */
          var focusOn = (to && !to.value) ? to : wizard.querySelector("#hv-city");

          if (hvInDialog) {
            hvDlg.showModal();
            if (focusOn) focusOn.focus();
            return;
          }

          /* No dialog support — fall back to the original scroll. */
          var target = document.getElementById("valuation");
          if (target) target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
          window.setTimeout(function () {
            if (focusOn) focusOn.focus({ preventScroll: true });
          }, reduced ? 0 : 650);
        });
      }
    }
  }

  /* --- notes: category filter + load more ------------------------------ */
  /* Both are enhancements layered onto a page that is complete without
     them: every note is in the HTML and visible, so nothing is ever locked
     behind a control that failed to initialise. */
  var noteGrid = document.querySelector("[data-notegrid]");
  if (noteGrid) {
    var notes = [].slice.call(noteGrid.querySelectorAll(".post"));
    var filters = [].slice.call(document.querySelectorAll(".notefilter__btn"));
    var emptyMsg = document.querySelector("[data-filter-empty]");
    var moreWrap = document.querySelector("[data-notemore]");
    var moreBtn = document.querySelector("[data-notemore-btn]");
    var PAGE = 6;                       /* notes revealed per batch */
    var active = "all";
    var limit = PAGE;

    var matching = function () {
      return notes.filter(function (n) {
        return active === "all" || n.getAttribute("data-cat") === active;
      });
    };

    var render = function () {
      var hits = matching();
      notes.forEach(function (n) { n.hidden = true; });
      hits.slice(0, limit).forEach(function (n) { n.hidden = false; });

      if (emptyMsg) emptyMsg.hidden = hits.length !== 0;
      if (moreWrap) moreWrap.hidden = hits.length <= limit;
    };

    filters.forEach(function (btn) {
      btn.addEventListener("click", function () {
        active = btn.getAttribute("data-filter");
        limit = PAGE;
        filters.forEach(function (b) {
          var on = b === btn;
          b.classList.toggle("is-on", on);
          b.setAttribute("aria-pressed", String(on));
        });
        render();
      });
    });

    if (moreBtn) {
      moreBtn.addEventListener("click", function () {
        limit += PAGE;
        render();
        /* Move focus to the first newly revealed note so keyboard and screen
           reader users land on the new content rather than staying on a
           button that may have just disappeared. */
        var revealed = matching()[limit - PAGE];
        if (revealed) {
          revealed.setAttribute("tabindex", "-1");
          revealed.focus({ preventScroll: true });
        }
      });
    }

    render();
  }

  /* --- buyers: relocate the search form into its dialog ---------------- */
  /* The form ships in the page so it works without scripting. Once we know
     <dialog> is supported we MOVE that same node into the dialog and swap
     the page column for a button — one form, one handler, nothing cloned
     and no duplicate ids. */
  var buyerDlg = document.getElementById("buyersearch");
  if (buyerDlg && typeof buyerDlg.showModal === "function") {
    var buyerSlot = buyerDlg.querySelector("[data-buyer-slot]");
    var buyerForm = document.querySelector('[data-form="buyer"]');
    var buyerHost = document.querySelector("[data-buyer-formhost]");
    var buyerCta  = document.querySelector("[data-buyer-cta]");
    if (buyerSlot && buyerForm) {
      buyerSlot.appendChild(buyerForm);
      if (buyerHost) buyerHost.hidden = true;
      if (buyerCta) buyerCta.hidden = false;
    }
  }

  /* --- conversation dialog --------------------------------------------- */
  /* Upgrades the mailto link into a native modal. Only runs when <dialog>
     is actually supported, so on anything older the link keeps working as
     a mailto rather than becoming a dead button. */
  document.querySelectorAll("[data-dialog-open]").forEach(function (trigger) {
    var dlg = document.getElementById(trigger.getAttribute("data-dialog-open"));
    if (!dlg || typeof dlg.showModal !== "function") return;

    trigger.addEventListener("click", function (e) {
      e.preventDefault();
      dlg.showModal();
      /* First field that is actually on screen. Skipping type=hidden is not
         enough: the valuation wizard keeps steps 2 and 3 in the DOM behind
         a hidden fieldset, and focusing something inside one of those
         silently does nothing, leaving focus on <body>. offsetParent is
         null for anything inside a hidden ancestor. */
      var fields = dlg.querySelectorAll("input:not([type=hidden]), select, textarea");
      for (var i = 0; i < fields.length; i++) {
        if (fields[i].offsetParent !== null) { fields[i].focus(); break; }
      }
    });

    /* Clicking the backdrop closes. The dialog element fills the viewport as
       far as the event target is concerned, so a click landing on the dialog
       itself — rather than on the panel inside it — is a backdrop click. */
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) dlg.close();
    });

    dlg.querySelectorAll("[data-dialog-close]").forEach(function (btn) {
      btn.addEventListener("click", function () { dlg.close(); });
    });
  });

  /* --- sticky CTA ------------------------------------------------------ */
  /* Shows after the hero, hides again while the form is on screen — a bar
     urging you toward the thing you are already looking at is just clutter. */
  var sticky = document.querySelector("[data-stickycta]");
  if (sticky && "IntersectionObserver" in window) {
    var heroEl2 = document.querySelector(".lhero, .hero");
    var formEl = document.getElementById("valuation");
    var pastHero = false, onForm = false;

    var sync = function () {
      var show = pastHero && !onForm;
      sticky.hidden = false;
      sticky.classList.toggle("is-on", show);
    };
    if (heroEl2) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { pastHero = !e.isIntersecting; sync(); });
      }, { threshold: 0 }).observe(heroEl2);
    }
    if (formEl) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { onForm = e.isIntersecting; sync(); });
      }, { threshold: 0 }).observe(formEl);
    }
  }

  /* --- testimonials: three at a time, staggered ------------------------ */
  /* All ten recommendations stay in the HTML so they are crawlable and so a
     failed script leaves every one of them readable. This reduces the page
     to three at a time and swaps each slot on its OWN timer, so the section
     is never changing all at once.

     The row height is locked to the tallest card. Quotes vary from 20 to 90
     words, and without that lock the row would jog on every swap — with
     staggered swaps that is roughly every three seconds. */
  var qgrid = document.querySelector("[data-quotecycle]");
  if (qgrid) {
    var qcards = [].slice.call(qgrid.querySelectorAll(".quotecard"));
    var SLOTS = 3;

    if (qcards.length > SLOTS) {
      var period = parseInt(qgrid.getAttribute("data-quotecycle"), 10) || 8000;
      var shown = [];                       /* card index living in each slot */
      var timers = [];

      var measure = function () {
        qgrid.classList.add("is-measuring");
        var tallest = 0;
        qcards.forEach(function (c) {
          var h = c.offsetHeight;
          if (h > tallest) tallest = h;
        });
        qgrid.classList.remove("is-measuring");
        if (tallest) qgrid.style.setProperty("--qmin", tallest + "px");
      };

      var paint = function () {
        qcards.forEach(function (c) {
          c.classList.remove("is-shown", "is-first");
          c.style.order = "";
        });
        shown.forEach(function (idx, slot) {
          var c = qcards[idx];
          c.classList.add("is-shown");
          c.style.order = String(slot);     /* order keeps slots in place even
                                               though DOM order never changes */
          if (slot === 0) c.classList.add("is-first");
        });
      };

      /* Pick a card that is not currently on screen. */
      var pick = function () {
        var pool = [];
        for (var i = 0; i < qcards.length; i++) {
          if (shown.indexOf(i) === -1) pool.push(i);
        }
        return pool[Math.floor(Math.random() * pool.length)];
      };

      var swap = function (slot) {
        var outCard = qcards[shown[slot]];
        outCard.classList.add("is-out");
        window.setTimeout(function () {
          outCard.classList.remove("is-out");
          shown[slot] = pick();
          paint();
          var inCard = qcards[shown[slot]];
          inCard.classList.add("is-out");     /* start transparent */
          /* force a frame so the browser sees the change before we fade in */
          void inCard.offsetWidth;
          inCard.classList.remove("is-out");
        }, 560);
      };

      var start = function () {
        if (timers.length) return;
        for (var s = 0; s < SLOTS; s++) {
          (function (slot) {
            /* stagger the first swap, then each slot runs on its own cycle */
            timers.push(window.setTimeout(function () {
              swap(slot);
              timers.push(window.setInterval(function () { swap(slot); }, period));
            }, Math.round(period / SLOTS) * (slot + 1)));
          })(s);
        }
      };
      var stop = function () {
        timers.forEach(function (t) { window.clearTimeout(t); window.clearInterval(t); });
        timers = [];
      };

      /* Seed the first three, then reveal cycling mode. */
      measure();
      shown = [0, 1, 2];
      qgrid.setAttribute("data-cycling", "");
      paint();

      var reMeasure;
      window.addEventListener("resize", function () {
        window.clearTimeout(reMeasure);
        reMeasure = window.setTimeout(measure, 250);
      });

      if (!reduced) {
        /* Only run while the section is on screen. document.hidden is not a
           reliable signal — embedded and preview viewports report hidden
           permanently, which would freeze this on the first three. */
        if ("IntersectionObserver" in window) {
          new IntersectionObserver(function (entries) {
            entries.forEach(function (e) { e.isIntersecting ? start() : stop(); });
          }, { threshold: 0 }).observe(qgrid);
        } else {
          start();
        }
        qgrid.addEventListener("mouseenter", stop);
        qgrid.addEventListener("mouseleave", start);
      }
    }
  }

  /* --- featured listings: hover preview -------------------------------- */
  /* Only activates for rows that actually carry a data-preview path. With no
     photography supplied the panel never renders, so the section degrades to
     the plain typographic index rather than showing empty frames. */
  var plist = document.querySelector(".plist");
  if (plist) {
    var panel = plist.querySelector(".plist__preview");
    var panelImg = panel && panel.querySelector("img");
    var withImg = [].slice.call(plist.querySelectorAll(".plist__row"))
                    .filter(function (r) { return r.getAttribute("data-preview"); });

    if (panel && panelImg && withImg.length) {
      plist.classList.add("has-preview");

      /* Decode up front so the first hover does not flash an empty frame. */
      withImg.forEach(function (row) {
        var pre = new Image();
        pre.src = row.getAttribute("data-preview");
      });

      var show = function (row) {
        var src = row.getAttribute("data-preview");
        if (!src) return;
        if (panelImg.getAttribute("src") !== src) panelImg.setAttribute("src", src);
        /* Track the hovered row so the panel rides alongside it. */
        var top = row.offsetTop + (row.offsetHeight - panel.offsetHeight) / 2;
        var maxTop = plist.offsetHeight - panel.offsetHeight;
        panel.style.top = Math.max(0, Math.min(top, maxTop)) + "px";
        panel.classList.add("is-on");
      };
      var hide = function () { panel.classList.remove("is-on"); };

      withImg.forEach(function (row) {
        row.addEventListener("mouseenter", function () { show(row); });
        row.addEventListener("focus", function () { show(row); });
      });
      plist.addEventListener("mouseleave", hide);
      plist.addEventListener("focusout", function (e) {
        if (!plist.contains(e.relatedTarget)) hide();
      });
    }
  }

  /* --- mobile nav ------------------------------------------------------ */
  /* The mark sits between two separate <nav> elements now, so the open state
     lives on the header rather than on one nav — otherwise only half the
     menu would slide in. */
  var burger = document.querySelector(".burger");
  if (burger && head) {
    var setNav = function (open) {
      head.classList.toggle("is-nav-open", open);
      burger.setAttribute("aria-expanded", String(open));
      burger.textContent = open ? "Close" : "Menu";
    };
    burger.addEventListener("click", function () {
      setNav(!head.classList.contains("is-nav-open"));
    });
    head.addEventListener("click", function (e) {
      if (e.target.tagName === "A" && head.classList.contains("is-nav-open")) setNav(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && head.classList.contains("is-nav-open")) {
        setNav(false);
        burger.focus();
      }
    });
  }

  /* --- finder tabs ------------------------------------------------------ */
  /* Roving tabindex + arrow keys, per the ARIA tabs pattern. Generic enough
     that it drives any [role="tablist"] on the page. */
  document.querySelectorAll('[role="tablist"]').forEach(function (list) {
    var tabs = [].slice.call(list.querySelectorAll('[role="tab"]'));
    if (tabs.length < 2) return;

    var select = function (tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    };

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab); });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });
  });

  /* --- scroll reveals --------------------------------------------------- */
  /* Wrapped in a function ON PURPOSE. This block returns early in two
     cases — no .reveal elements, and prefers-reduced-motion — and at the
     top level of the IIFE those returns killed EVERYTHING declared after
     it, including lead capture. A visitor with reduced motion switched on
     could not submit a single form on the site. Keep new code out of the
     way of early returns, or give the early returns a function to leave. */
  (function setupReveals() {
  var targets = document.querySelectorAll(".reveal");
  if (!targets.length) return;

  if (reduced || !("IntersectionObserver" in window)) {
    targets.forEach(function (el) { el.classList.add("is-in"); });
    return;
  }

  /* threshold 0 , not a percentage. A percentage threshold means a block
     taller than the viewport can never satisfy it on the way in, so tall
     sections — the twelve-point grid especially — stayed invisible. The
     negative bottom margin is what delays the trigger instead. */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-in");
      io.unobserve(entry.target);
    });
  }, { threshold: 0, rootMargin: "0px 0px -12% 0px" });

  targets.forEach(function (el) { io.observe(el); });

  /* Belt and braces: anything still unrevealed shortly after load gets shown
     regardless. A decorative animation must never be able to eat content. */
  window.setTimeout(function () {
    document.querySelectorAll(".reveal:not(.is-in)").forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight) { el.classList.add("is-in"); io.unobserve(el); }
    });
  }, 1200);
  })();

  /* --- lead capture ----------------------------------------------------- */
  /* Every public form on the site posts to /api/lead, which validates,
     saves to Supabase, then notifies. One handler, so a new form only has
     to declare a data-form value and its fields.

     Nothing secret is here. The browser posts plain JSON; the API key, the
     database credentials and the notification providers all live server
     side. */

  var LEAD_TYPES = {
    "conversation":   "contact",
    "buyer":          "buyer_inquiry",
    "home-value":     "home_valuation",
    "join":           "join_team",
    "agent-contact":  "agent_contact",
    "property":       "property_inquiry"
  };

  var leadForms = document.querySelectorAll("[data-form]");
  Array.prototype.forEach.call(leadForms, function (form) {
    var key = form.getAttribute("data-form");
    var formType = LEAD_TYPES[key];
    if (!formType) return;                    /* not a lead form */

    /* Honeypot. Hidden from people, irresistible to bots. Positioned off
       screen rather than display:none, because some bots skip anything
       that is not rendered. aria-hidden and tabindex keep it away from
       screen readers and keyboard users. */
    var hp = document.createElement("div");
    hp.setAttribute("aria-hidden", "true");
    hp.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden";
    hp.innerHTML = '<label>Website<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label>';
    form.appendChild(hp);

    /* When the form was first shown. A submission faster than a couple of
       seconds was not typed by a person. */
    var opened = document.createElement("input");
    opened.type = "hidden";
    opened.name = "_t";
    opened.value = String(Date.now());
    form.appendChild(opened);

    var note = form.querySelector(".formnote");
    var submitBtn = form.querySelector('button[type="submit"], [data-wizard-submit]');
    var originalLabel = submitBtn ? submitBtn.innerHTML : "";
    var sending = false;

    function say(msg, kind) {
      if (!note) {
        note = document.createElement("p");
        note.className = "formnote form__full";
        form.appendChild(note);
      }
      note.textContent = msg;
      note.className = "formnote form__full" + (kind ? " formnote--" + kind : "");
      note.hidden = false;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      /* Double-click, slow connection, impatient second press — all land
         here and are ignored while the first is still in flight. */
      if (sending) return;

      var data = {};
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.disabled) return;
        if (el.type === "checkbox" && !el.checked) return;
        if (el.type === "radio" && !el.checked) return;
        data[el.name] = el.value;
      });

      data.form_type = formType;
      data.page_url  = location.href;
      data.page_name = document.title;
      data.referrer  = document.referrer || null;
      data.lead_source = data.source || "website";

      /* Campaign attribution, if this visit carried any. */
      var q = new URLSearchParams(location.search);
      ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (k) {
        var v = q.get(k);
        if (v) data[k] = v;
      });

      sending = true;
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Sending…"; }
      say("");

      fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
      }).then(function (res) {
        sending = false;
        if (!res.ok || !res.body.ok) {
          /* The visitor is never told it worked unless the lead is stored.
             A false success loses the enquiry silently, which is the worst
             outcome available. */
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalLabel; }
          say((res.body && res.body.error) || "That did not send. Please try again, or call 713-828-4185.", "err");
          return;
        }

        /* Replace the form with the confirmation rather than leaving a
           filled-in form sitting under a success message, which invites a
           second submission. */
        var done = document.createElement("div");
        done.className = "formdone";
        done.setAttribute("role", "status");
        var h = document.createElement("p");
        h.className = "formdone__title";
        h.textContent = "Thank you.";
        var p = document.createElement("p");
        p.textContent = "Your request has been received and a member of our team will be in touch shortly.";
        done.appendChild(h);
        done.appendChild(p);
        form.parentNode.replaceChild(done, form);

          /* Announce it AFTER the server confirmed the lead was stored,
             not on submit. Anything listening — conversion tracking,
             mostly — then counts leads that actually exist rather than
             attempts that may have failed. */
          document.dispatchEvent(new CustomEvent("tp:lead", {
            detail: { formType: formType, form: key }
          }));
      }).catch(function () {
        sending = false;
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalLabel; }
        say("We could not reach the server. Please check your connection, or call 713-828-4185.", "err");
      });
    });
  });

  /* ==================================================================== */
  /* HOME VALUE LANDING PAGE                                              */
  /* ==================================================================== */
  /* Runs only where the markers exist, so every other page skips it
     entirely. Four small jobs; none of them touch the existing wizard,
     the dialog, or the lead posting, all of which already worked.

     1. a sticky call to action on phones
     2. contextual buttons that open the same form rather than a new one
     3. a place for an address autocomplete provider to be added later
     4. conversion-tracking hooks with no vendor and no IDs invented   */
  (function homeValueLanding() {
    var card = document.querySelector("[data-hvx-card]");
    if (!card) return;                       /* not this page */

    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* The sticky call to action is NOT built here. site.css already has
       .stickycta and site.js already drives it on this page — it works on
       desktop as well as phones and carries a line of text, which is more
       than the one I started to add. Reused rather than duplicated. */

    /* ---- contextual buttons ------------------------------------- */
    /* Every couple of sections there is a way back to the form. They all
       lead to the SAME form — one conversion goal, not competing ones.
       If the dialog is in play, data-dialog-open in site.js already opens
       it; these only need to handle the no-dialog case and the focus. */
    Array.prototype.forEach.call(document.querySelectorAll("[data-hvx-jump]"), function (btn) {
      btn.addEventListener("click", function () {
        /* Give the dialog a moment if one is opening, then put the cursor
           in the first empty field rather than at the top of a form. */
        window.setTimeout(function () {
          var open = document.querySelector("dialog[open] #hv-address");
          var field = open || document.getElementById("hv-address");
          if (!field) return;
          if (!open) {
            var target = document.getElementById("valuation");
            if (target) target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
          }
          if (!field.value) field.focus();
        }, 60);
      });
    });

    /* ---- 3. address autocomplete slot ------------------------------- */
    /* Deliberately inert. No provider is configured and no key is
       invented, so the field stays an ordinary text input that works.
       When a provider is chosen, define window.TP_ADDRESS_AUTOCOMPLETE
       before site.js and it will be handed the input. */
    var addr = document.querySelector("[data-hvx-autocomplete]");
    if (addr && typeof window.TP_ADDRESS_AUTOCOMPLETE === "function") {
      try { window.TP_ADDRESS_AUTOCOMPLETE(addr); }
      catch (e) { if (window.console) console.error("[hv] autocomplete provider failed", e); }
    }

    /* ---- 4. conversion tracking ------------------------------------- */
    /* A shim, not an integration. It fires whatever is already on the
       page and does nothing at all if nothing is. No Pixel ID, no
       measurement ID, and no vendor script is added by this file — those
       are Austin's to paste in when he has them.

       Add gtag or fbq to the page and these events start reporting with
       no further change here. */
    function track(event, detail) {
      try {
        if (typeof window.fbq === "function") window.fbq("track", event, detail || {});
        if (typeof window.gtag === "function") window.gtag("event", event, detail || {});
        if (window.dataLayer && typeof window.dataLayer.push === "function") {
          window.dataLayer.push(Object.assign({ event: event }, detail || {}));
        }
      } catch (e) { /* tracking must never break the form */ }
      /* Always dispatch, so anything can listen without patching this. */
      document.dispatchEvent(new CustomEvent("tp:track", { detail: { event: event, data: detail || {} } }));
    }
    window.TPtrack = track;

    track("ViewContent", { content_name: "home_valuation_landing" });

    /* Starting the form is the first real signal of intent. */
    var starter = document.querySelector("[data-hv-start]");
    if (starter) {
      starter.addEventListener("submit", function () {
        track("InitiateCheckout", { content_name: "home_valuation_started" });
      });
    }

    /* Reaching the last step means they are about to hand over contact
       details — worth knowing separately from those who finish. */
    var wiz = document.querySelector("[data-wizard]");
    if (wiz) {
      var seen = {};
      wiz.addEventListener("click", function (e) {
        if (!e.target.closest("[data-wizard-next]")) return;
        window.setTimeout(function () {
          var cur = wiz.querySelector("[data-wizard-current]");
          var n = cur ? cur.textContent.trim() : null;
          if (n && !seen[n]) { seen[n] = true; track("ValuationStep", { step: n }); }
        }, 30);
      });
    }

    /* The conversion itself. site.js dispatches this once /api/lead has
       confirmed the lead was STORED — not merely submitted — so what is
       counted here is a lead that actually exists. */
    document.addEventListener("tp:lead", function (e) {
      var d = (e && e.detail) || {};
      if (d.formType !== "home_valuation") return;
      track("Lead", { content_name: "home_valuation", value: 0, currency: "USD" });
    });
  })();
})();
