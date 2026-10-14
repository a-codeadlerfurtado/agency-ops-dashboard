/* Navegação dos tutoriais: setas, G de visão geral, N de notas do apresentador,
   swipe no touch, contadores, escala do palco e reflow de celular.
   Os atos vêm de window.DECK_ATOS, definido por cada deck antes deste arquivo. */
(function(){
  "use strict";
  var doc = document.documentElement;
  var slides = Array.prototype.slice.call(document.querySelectorAll("#stage > .slide"));
  var N = slides.length;
  var ACTS = (window.DECK_ATOS && window.DECK_ATOS.length) ? window.DECK_ATOS
            : ["Ato I","Ato II","Ato III","Ato IV","Ato V"];
  var ROMAN = ["I","II","III","IV","V"];
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var cur = -1;

  if (!reduce) doc.classList.add("motion");

  slides.forEach(function(s,i){
    var n = String(i+1);
    while (n.length < 2) n = "0" + n;
    s.setAttribute("role","group");
    s.setAttribute("aria-roledescription","slide");
    s.setAttribute("aria-label",(i+1)+" de "+N+": "+(s.dataset.title||""));
    Array.prototype.forEach.call(s.querySelectorAll(".num"), function(el){ el.textContent = n+" / "+N; });
    Array.prototype.forEach.call(s.querySelectorAll(".ftitle"), function(el){ el.textContent = s.dataset.title || ""; });
    var act = parseInt(s.dataset.act,10) || 1;
    Array.prototype.forEach.call(s.querySelectorAll(".acts"), function(el){
      var h = "";
      for (var a=1; a<=ACTS.length; a++) h += '<i class="'+(a<=act?"on":"")+'"></i>';
      el.innerHTML = h + "<span>Ato "+ROMAN[act-1]+" · "+ACTS[act-1]+"</span>";
      el.setAttribute("aria-label","Ato "+act+" de "+ACTS.length+": "+ACTS[act-1]);
    });
    Array.prototype.forEach.call(s.querySelectorAll("[data-count]"), function(el){ el.dataset.final = el.textContent; });
  });

  function layout(){
    var w = window.innerWidth, h = window.innerHeight;
    var mobile = (w < 860 && h > w * 1.02) || w < 600;
    doc.classList.toggle("mobile", mobile);
    if (!mobile) doc.style.setProperty("--scale", String(Math.min(w/1920, h/1080)));
    else doc.style.removeProperty("--scale");
  }
  window.addEventListener("resize", layout);
  layout();

  function runCounters(s){
    if (reduce) return;
    Array.prototype.forEach.call(s.querySelectorAll("[data-count]"), function(el){
      var target = parseFloat(el.dataset.count) || 0;
      var suf = el.dataset.suffix || "";
      var t0 = null, dur = 1200, delay = 260;
      if (el._raf) cancelAnimationFrame(el._raf);
      el.textContent = "0" + suf;
      function step(ts){
        if (t0 === null) t0 = ts + delay;
        var p = Math.min(1, Math.max(0, (ts - t0) / dur));
        var e = 1 - Math.pow(1 - p, 3);
        if (p >= 1 || !s.classList.contains("is-active")) { el.textContent = el.dataset.final; return; }
        el.textContent = Math.round(target * e) + suf;
        el._raf = requestAnimationFrame(step);
      }
      el._raf = requestAnimationFrame(step);
    });
  }
  function fillBars(s){
    Array.prototype.forEach.call(s.querySelectorAll(".seg"), function(el){
      el.style.width = el.getAttribute("data-w") + "%";
    });
  }

  var bar = document.querySelector(".progress");
  var ctr = document.getElementById("ctr");
  function go(i){
    i = Math.max(0, Math.min(N-1, i));
    if (i === cur) return;
    var prev = cur;
    cur = i;
    slides.forEach(function(s,j){
      var on = j === i;
      s.classList.toggle("is-active", on);
      s.setAttribute("aria-hidden", on ? "false" : "true");
      if (on) s.removeAttribute("inert"); else s.setAttribute("inert","");
    });
    if (prev >= 0) Array.prototype.forEach.call(slides[prev].querySelectorAll("[data-count]"), function(el){
      if (el._raf) cancelAnimationFrame(el._raf);
      el.textContent = el.dataset.final;
    });
    runCounters(slides[i]);
    fillBars(slides[i]);
    bar.style.setProperty("--p", String((i+1)/N));
    ctr.textContent = (i+1) + " / " + N;
    try { history.replaceState(null, "", "#" + (i+1)); } catch(e){}
    updateNotes();
    slides[i].scrollTop = 0;
  }

  document.getElementById("btn-next").addEventListener("click", function(){ go(cur+1); });
  document.getElementById("btn-prev").addEventListener("click", function(){ go(cur-1); });

  /* notas */
  var panel = document.getElementById("notes-panel");
  var ntext = document.getElementById("notes-text");
  var notesOn = false;
  function updateNotes(){
    if (!notesOn || cur < 0) return;
    ntext.textContent = slides[cur].dataset.notes || "Sem nota para este slide.";
  }
  function toggleNotes(){
    notesOn = !notesOn;
    panel.hidden = !notesOn;
    updateNotes();
  }
  document.getElementById("btn-notes").addEventListener("click", toggleNotes);

  /* visão geral */
  var ov = document.getElementById("overview");
  var ogrid = document.getElementById("ogrid");
  slides.forEach(function(s,i){
    var b = document.createElement("button");
    b.type = "button";
    b.innerHTML = '<span class="on">'+(i+1)+' / '+N+'</span><span class="ot"></span>';
    b.querySelector(".ot").textContent = s.dataset.title || "";
    b.addEventListener("click", function(){ ov.hidden = true; go(i); });
    ogrid.appendChild(b);
  });
  function toggleGrid(){ ov.hidden = !ov.hidden; }
  document.getElementById("btn-grid").addEventListener("click", toggleGrid);

  document.addEventListener("keydown", function(e){
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || k === " ") { e.preventDefault(); go(cur+1); }
    else if (k === "ArrowLeft" || k === "PageUp") { e.preventDefault(); go(cur-1); }
    else if (k === "Home") { e.preventDefault(); go(0); }
    else if (k === "End") { e.preventDefault(); go(N-1); }
    else if (k === "g" || k === "G") { e.preventDefault(); toggleGrid(); }
    else if (k === "n" || k === "N") { e.preventDefault(); toggleNotes(); }
    else if (k === "Escape") { ov.hidden = true; }
  });

  /* toque */
  var tx = 0, ty = 0;
  document.addEventListener("touchstart", function(e){
    if (!e.touches[0]) return;
    tx = e.touches[0].clientX; ty = e.touches[0].clientY;
  }, {passive:true});
  document.addEventListener("touchend", function(e){
    if (doc.classList.contains("mobile") || !e.changedTouches[0]) return;
    var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) go(cur + (dx < 0 ? 1 : -1));
  }, {passive:true});

  /* esconde os controles quando ninguém mexe */
  var idleT = null;
  function wake(){
    document.body.classList.remove("idle");
    if (idleT) clearTimeout(idleT);
    idleT = setTimeout(function(){ document.body.classList.add("idle"); }, 2800);
  }
  ["mousemove","mousedown","keydown","touchstart","wheel"].forEach(function(ev){
    document.addEventListener(ev, wake, {passive:true});
  });
  wake();
  setTimeout(function(){ document.body.classList.add("hinted"); }, 7000);

  var start = parseInt((location.hash || "").replace("#",""), 10);
  go(isFinite(start) && start >= 1 ? start - 1 : 0);
  /* no celular tudo fica visível e empilhado */
  if (doc.classList.contains("mobile")) {
    slides.forEach(function(s){ s.classList.add("is-active"); s.removeAttribute("inert"); s.setAttribute("aria-hidden","false"); fillBars(s); });
  }
})();
