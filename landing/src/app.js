/* squadchat — interações da landing page (estado local, sem rede) */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function nowHHMM() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function icon(id, size) {
    return '<svg class="od-icon"' + (size ? ' style="--od-icon-size:' + size + 'px"' : "") + ' aria-hidden="true"><use href="#' + id + '"/></svg>';
  }
  function replay(el, cls) {
    if (!el || reduceMotion) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function safe(fn) { try { fn(); } catch (e) { if (window.console) console.error(e); } }

  /* ---------- cabeçalho ---------- */
  safe(function () {
    var header = $(".site-header");
    var onScroll = function () { header.classList.toggle("is-scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // seção atual marcada na navegação
    var navLinks = Array.prototype.slice.call(document.querySelectorAll(".main-nav a"));
    var sections = navLinks.map(function (l) { return document.querySelector(l.getAttribute("href")); }).filter(Boolean);
    if ("IntersectionObserver" in window && sections.length) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          navLinks.forEach(function (l) { l.setAttribute("aria-current", String(l.getAttribute("href") === "#" + en.target.id)); });
        });
      }, { rootMargin: "-40% 0px -55% 0px" });
      sections.forEach(function (s) { io.observe(s); });
    }

    var btn = $(".menu-btn");
    var nav = $("#mobile-nav");
    var setOpen = function (open) {
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
      nav.hidden = !open;
    };
    btn.addEventListener("click", function () { setOpen(nav.hidden); });
    nav.addEventListener("click", function (e) { if (e.target.closest("a")) setOpen(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !nav.hidden) { setOpen(false); btn.focus(); }
    });
  });

  /* ---------- baralho de recursos ---------- */
  safe(function () {
    var rail = document.getElementById("deck");
    if (!rail) return;
    var cards = Array.prototype.slice.call(rail.querySelectorAll(".card"));
    var chips = Array.prototype.slice.call(document.querySelectorAll(".chip2[data-filter]"));
    var prev = document.getElementById("deck-prev");
    var next = document.getElementById("deck-next");
    var status = document.getElementById("deck-status");
    var counts = {
      todos: cards.length,
      estavel: cards.filter(function (c) { return c.dataset.status === "estavel"; }).length,
      beta: cards.filter(function (c) { return c.dataset.status === "beta"; }).length
    };
    Array.prototype.forEach.call(document.querySelectorAll("[data-count]"), function (el) { el.textContent = counts[el.dataset.count]; });

    function visible() { return cards.filter(function (c) { return !c.hidden; }); }
    function centerIndex(list) {
      var r = rail.getBoundingClientRect();
      var mid = r.left + r.width / 2;
      var best = 0, dist = Infinity;
      list.forEach(function (c, i) {
        var cr = c.getBoundingClientRect();
        var d = Math.abs(cr.left + cr.width / 2 - mid);
        if (d < dist) { dist = d; best = i; }
      });
      return best;
    }
    var statusTimer = null;
    function update() {
      var list = visible();
      var i = centerIndex(list);
      cards.forEach(function (c) { c.classList.remove("is-center"); });
      if (list[i]) list[i].classList.add("is-center");
      var atStart = rail.scrollLeft <= 4;
      var atEnd = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4;
      prev.disabled = atStart;
      next.disabled = atEnd;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(function () {
        if (list[i]) status.textContent = "Carta " + (i + 1) + " de " + list.length + ": " + list[i].querySelector("h3").textContent;
      }, 250);
    }
    function go(dir) {
      var list = visible();
      var i = centerIndex(list) + dir;
      i = Math.max(0, Math.min(list.length - 1, i));
      var c = list[i];
      if (!c) return;
      var r = rail.getBoundingClientRect();
      var cr = c.getBoundingClientRect();
      rail.scrollBy({ left: cr.left + cr.width / 2 - (r.left + r.width / 2), behavior: reduce ? "auto" : "smooth" });
    }
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    prev.addEventListener("click", function () { go(-1); });
    next.addEventListener("click", function () { go(1); });
    rail.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    });
    var ticking = false;
    rail.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; update(); });
    }, { passive: true });
    window.addEventListener("resize", update);

    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var f = chip.dataset.filter;
        chips.forEach(function (c) { c.setAttribute("aria-pressed", String(c === chip)); });
        cards.forEach(function (c) { c.hidden = !(f === "todos" || c.dataset.status === f); });
        rail.scrollLeft = 0;
        update();
      });
    });
    update();
  });

  /* ---------- copiar comandos ---------- */
  safe(function () {
    var btn = $("#copy-btn");
    var label = $("#copy-label");
    var pre = $("#install-cmd");
    var feedback = $("#copy-feedback");
    var text = "curl -fsSL https://squad-chat-6wd.pages.dev/install | sh";
    var timer;

    var done = function (ok) {
      window.clearTimeout(timer);
      if (ok) {
        btn.classList.add("is-done");
        label.textContent = "Copiado";
        feedback.hidden = true;
        timer = window.setTimeout(function () { btn.classList.remove("is-done"); label.textContent = "Copiar"; }, 2000);
      } else {
        // sem acesso à área de transferência: seleciona o texto para Ctrl+C
        var range = document.createRange();
        range.selectNodeContents(pre);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        feedback.hidden = false;
        feedback.textContent = "Não deu para copiar automaticamente. O texto está selecionado: use Ctrl+C ou ⌘C.";
      }
    };

    btn.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  });
})();
