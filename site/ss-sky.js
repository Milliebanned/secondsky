// SecondSky home: the weather you scroll through, the depth layers, the scene switcher and the 3D panels.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const params = new URLSearchParams(location.search);
  
  // Each scene: the photo layers, where the subject sits in its image (fractions), and the day's story in four beats.
  const SCENES = [
    { word: "Harvest", alt: "A combine harvester in a wheat field", bg: "", fg: "/media/harvest-fg.webp", iw: 2400, ih: 1600, posY: 0.62, wordY: 0.37, wordYNarrow: 0.2, sky: true,
      beats: [
        ["06:00 · Tuesday", "Forty hectares are ready to cut. The forecast says rain is likely."],
        ["12:40", "The rain comes in hard. The combine stands in the yard, and the crew is paid to wait."],
        ["The next morning", "The contract asks two skies what fell: a weather archive and a NASA satellite record."],
        ["Settled", "Both say more than 10 mm. The farm is paid by rule. Nobody files a claim."],
      ] },
    { word: "Pour", alt: "A crew pouring concrete", bg: "/media/pour.jpg", fg: "/media/pour-cut.webp", iw: 2200, ih: 1468, posY: 0.42, wordY: 0.36, wordYNarrow: 0.16, sky: false,
      beats: [
        ["05:30 · Pour day", "The pump, six mixer trucks and the crew are booked for one slab."],
        ["09:15", "Rain starts before the first truck empties. The pour is called off. The pump still bills for the day."],
        ["After the day", "The contract asks two skies what fell: a weather archive and a NASA satellite record."],
        ["Settled", "Both say more than 10 mm. The contractor is paid by rule, before the slab is rebooked."],
      ] },
    { word: "Haul", alt: "A loaded haul truck on a mine road", bg: "/media/haul.jpg", fg: "/media/haul-cut.webp", iw: 2200, ih: 1467, posY: 0.62, wordY: 0.46, wordYNarrow: 0.4, sky: false,
      beats: [
        ["Day shift", "Twelve trucks on one haul road out of the pit."],
        ["Mid-shift", "Heavy rain turns the ramp to mud. The fleet parks. Fuel, crew and leases keep running."],
        ["After the shift", "The contract asks two skies what fell: a weather archive and a NASA satellite record."],
        ["Settled", "Both say more than 10 mm. The operator is paid by rule. No adjuster, no argument."],
      ] },
  ];

  // ================================================================ the scenes, built once
  const sky = $("#sky");
  if (!sky) return;
  const N = SCENES.length;
  const glass = $("#glass"), hud = $("#hud");
  const gFill = $("#gFill"), gRead = $("#gRead");
  const tickMarks = '<span class="b-step" aria-hidden="true"><i class="on"></i><i></i><i></i><i></i></span>';
  const scenes = SCENES.map((S, i) => {
    const sec = document.createElement("section");
    sec.className = "scene"; sec.dataset.i = i;
    sec.setAttribute("aria-label", `Example ${i + 1} of ${N}: ${S.word}`);
    sec.innerHTML = `
      <div class="stage">
        <div class="tiltbox">
          ${S.sky ? `<div class="layer l-sky"><img class="sky-img s0" src="/media/sky-storm.jpg" alt=""><img class="sky-img s1" src="/media/sky-break.jpg" alt=""><img class="sky-img s2" src="/media/sky-clear.jpg" alt=""></div>` : ""}
          ${S.bg ? `<div class="layer l-bg"><img src="${S.bg}" alt="" style="object-position:50% ${S.posY * 100}%"></div>` : ""}
          <div class="layer l-word" aria-hidden="true"><div class="word">${S.word}</div></div>
          <div class="layer l-fg"><img src="${S.fg}" alt="${S.alt}" style="object-position:50% ${S.posY * 100}%"></div>
          <div class="layer l-haze"></div>
          <div class="layer l-scrim"></div>
          <div class="scene-ui">
            ${i === 0 ? `<p class="eyebrow">Rain cover for the one day that has to stay dry</p>` : `<p class="scene-no"><b>${String(i + 1).padStart(2, "0")}</b> / ${String(N).padStart(2, "0")}</p>`}
            <div class="beat">
              <div class="b-top"><span class="b-time"></span>${tickMarks}</div>
              <p class="b-text"></p>
              <span class="b-note">An example day. Real policies are in the ledger below.</span>
            </div>
            <div class="readout" aria-hidden="true">
              <div><span>Open-Meteo archive</span><b>14.2 mm</b></div>
              <div><span>NASA POWER satellite</span><b>11.8 mm</b></div>
              <div class="r-limit"><span>Limit</span><b>10 mm</b></div>
            </div>
            <div class="stamp-hero" aria-hidden="true">Paid 100%</div>
          </div>
          <div class="fold-shade"></div>
        </div>
      </div>`;
    sky.appendChild(sec);
    const q = (s) => sec.querySelector(s);
    return { S, sec, stage: q(".stage"), box: q(".tiltbox"), word: q(".word"),
      L: { sky: q(".l-sky"), bg: q(".l-bg"), word: q(".l-word"), fg: q(".l-fg") },
      skies: [...sec.querySelectorAll(".sky-img")], beat: q(".beat"), bTime: q(".b-time"), bText: q(".b-text"),
      ticks: [...sec.querySelectorAll(".b-step i")], readout: q(".readout"), stamp: q(".stamp-hero"), shade: q(".fold-shade"),
      curBeat: -1, visible: true };
  });

  // ---------- place each giant word exactly behind its subject ----------
  function layout(sc) {
    const S = sc.S, W = sc.stage.clientWidth, H = sc.stage.clientHeight;
    const LW = W * 1.06, LH = H * 1.06, top0 = -0.03 * H;
    const s = Math.max(LW / S.iw, LH / S.ih), rh = S.ih * s;
    const imgTop = top0 + (LH - rh) * S.posY;
    sc.word.style.fontSize = "200px";
    const fs = Math.min(200 * W * (W < 700 ? 0.94 : 0.9) / (sc.word.scrollWidth || 1), (H * 0.36) / 0.8);
    sc.word.style.fontSize = fs + "px";
    const narrow = W / H < 0.9;
    const cy = imgTop + (narrow ? S.wordYNarrow : S.wordY) * rh;
    sc.word.style.top = Math.round(Math.max(H * (narrow ? 0.22 : 0.19), Math.min(cy - fs * 0.42 + 0.03 * H, H * 0.6 - fs * 0.8))) + "px";
  }
  const layoutAll = () => scenes.forEach(layout);
  addEventListener("resize", layoutAll);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutAll);
  layoutAll();

  // only the scenes near the screen do any work
  const io = new IntersectionObserver((es) => es.forEach((e) => { scenes[e.target.dataset.i].visible = e.isIntersecting; }), { rootMargin: "60% 0px" });
  scenes.forEach((sc) => io.observe(sc.sec));

  // the switcher scrolls to the moment each scene settles in
  function goTo(i) {
    i = (i + N) % N;
    const sc = scenes[i];
    scrollTo({ top: sc.sec.offsetTop + (reduce ? 0 : sc.stage.clientHeight * 0.05), behavior: reduce ? "auto" : "smooth" });
  }
  let active = 0;
  $$(".sc").forEach((b) => b.addEventListener("click", () => goTo(Number(b.dataset.scene))));
  $("#scPrev").addEventListener("click", () => goTo(active - 1));
  $("#scNext").addEventListener("click", () => goTo(active + 1));

  // ================================================================ every frame
  let mx = 0, my = 0, tx = 0, ty = 0;
  const f2 = (v) => v.toFixed(2);
  function tick() {
    // the screen height as the scenes see it (window.innerHeight can disagree on phones)
    const vh = scenes[0].stage.clientHeight || innerHeight;
    let act = null;
    for (const sc of scenes) {
      if (!sc.visible) continue;
      const r = sc.sec.getBoundingClientRect(), Hs = sc.sec.offsetHeight;
      // q runs 0 -> 1 from the moment the scene's top enters the screen to the moment its bottom leaves
      const q = clamp((vh - r.top) / (Hs + vh), 0, 1);
      const en = reduce ? 0 : clamp(r.top / vh, 0, 1);              // still rising into view
      const lv = reduce ? 0 : clamp((vh - r.bottom) / vh, 0, 1);    // already scrolling away
      if (r.top <= vh * 0.5 && r.bottom >= vh * 0.5) act = sc;
      // the weather plays while the scene is held on screen: rain as it arrives, sun by the time it leaves
      const pp = clamp(-r.top / Math.max(1, Hs - vh), 0, 1);
      const p = clamp((pp - 0.04) / 0.88, 0, 1);
      const sun = smooth(0.4, 0.85, p);
      const rain = 1 - smooth(0.45, 0.8, p);
      sc.rain = rain; sc.p = p;
      if (sc.skies.length) { sc.skies[1].style.opacity = smooth(0.35, 0.6, p); sc.skies[2].style.opacity = smooth(0.6, 0.85, p); }
      sc.box.style.setProperty("--haze", lerp(1, 0.45, sun).toFixed(3));
      sc.box.style.setProperty("--grade-fg", `brightness(${lerp(0.66, 1.04, sun).toFixed(3)}) saturate(${lerp(0.62, 1.12, sun).toFixed(3)}) contrast(${lerp(1.08, 1.02, sun).toFixed(3)}) sepia(${lerp(0, 0.08, sun).toFixed(3)})`);
      sc.box.style.setProperty("--grade-sky", `brightness(${lerp(0.82, 1.02, sun).toFixed(3)}) blur(${(rain * 1.2).toFixed(2)}px)`);
      sc.readout.classList.toggle("show", p > 0.5 && lv < 0.25);
      sc.stamp.classList.toggle("show", p > 0.82 && lv < 0.35);
      const b = p < 0.22 ? 0 : p < 0.48 ? 1 : p < 0.74 ? 2 : 3;
      if (b !== sc.curBeat) {
        sc.curBeat = b;
        const [tm, txt] = sc.S.beats[b];
        sc.bTime.textContent = tm; sc.bText.textContent = txt;
        sc.ticks.forEach((x, j) => x.classList.toggle("on", j <= b));
        sc.beat.classList.remove("swap"); void sc.beat.offsetWidth; sc.beat.classList.add("swap");
      }
      // the fold: the leaving scene tips back into depth, the arriving one rises and flattens
      sc.box.style.transformOrigin = lv > 0 ? "50% 0%" : "50% 100%";
      sc.box.style.transform = `rotateX(${f2(lv * 18 - en * 14)}deg) scale(${(1 - lv * 0.12 - en * 0.05).toFixed(4)}) translateZ(${f2(-lv * 120)}px)`;
      sc.shade.style.opacity = (lv * 0.75 + en * 0.55).toFixed(3);
      // the layers travel at different speeds: the further away, the slower
      const k = reduce ? 0 : 1, drift = (en - lv) * vh;
      if (sc.L.sky) sc.L.sky.style.transform = `translate3d(${f2(-tx * 10 * k)}px, ${f2(-ty * 6 * k + drift * 0.04 - p * 24)}px, 0) scale(1.04)`;
      sc.L.word.style.transform = `translate3d(${f2(-tx * 22 * k)}px, ${f2(-ty * 12 * k + drift * 0.2 - p * (sc.stage.clientWidth < sc.stage.clientHeight ? 18 : 70))}px, ${f2(-lv * 380)}px) rotateX(${f2(ty * 2 * k + lv * 10)}deg) rotateY(${f2(tx * -3 * k)}deg)`;
      const fgT = `translate3d(${f2(-tx * 36 * k)}px, ${f2(-ty * 18 * k + drift * 0.38)}px, ${f2(lv * 160)}px) scale(${(1 + p * 0.1).toFixed(4)})`;
      sc.L.fg.style.transform = fgT;
      // where the photo behind holds the same subject, photo and cut-out move as one, so it never doubles
      if (sc.L.bg) sc.L.bg.style.transform = fgT;
    }
    if (act) {
      active = Number(act.sec.dataset.i);
      $$(".sc").forEach((x) => { const on = Number(x.dataset.scene) === active; x.classList.toggle("on", on); x.setAttribute("aria-selected", on); });
      const mm = 14.2 * smooth(0.05, 0.5, act.p);
      gFill.style.height = Math.min(100, (mm / 20) * 100) + "%";
      gRead.textContent = act.p > 0.82 ? "Paid" : mm.toFixed(1) + " mm";
    }
    // the window and the controls belong to the hero only
    const hr = sky.getBoundingClientRect();
    const inHero = clamp((hr.bottom - vh * 0.35) / (vh * 0.4), 0, 1);
    hud.style.opacity = inHero.toFixed(3);
    hud.style.visibility = inHero > 0.02 ? "visible" : "hidden";
    const wet = act ? act.rain : 0;
    glass.style.opacity = (0.86 * wet * inHero).toFixed(3);
  }
  function loop() {
    tx += (mx - tx) * 0.07; ty += (my - ty) * 0.07;
    tick();
    requestAnimationFrame(loop);
  }
  addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { mx = e.clientX / innerWidth * 2 - 1; my = e.clientY / innerHeight * 2 - 1; } }, { passive: true });
  if (glass) new IntersectionObserver(([e]) => { e.isIntersecting ? glass.play().catch(() => {}) : glass.pause(); }).observe(sky);
  // ?y= jumps to a scroll position (used to check the page)
  if (params.has("y")) addEventListener("load", () => scrollTo(0, Number(params.get("y")) * innerHeight));
  requestAnimationFrame(loop);

  // ---------- panels: tilt in 3D, the subject steps out of the frame ----------
  if (!reduce) $$("[data-tilt]").forEach((el) => {
    const pop = $(".p-pop", el);
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `rotateY(${x * 10}deg) rotateX(${-y * 8}deg)`;
      if (pop) pop.style.transform = `translateZ(60px) translate(${x * -10}px, ${y * -8}px)`;
    });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; if (pop) pop.style.transform = ""; });
  });

  // ---------- nav: clear over the sky, solid after it, paper-coloured over paper ----------
  const nav = $("#nav");
  const papers = $$(".paper");
  function navState() {
    const past = sky.getBoundingClientRect().bottom < 80;
    nav.classList.toggle("solid", past);
    nav.classList.toggle("on-paper", past && papers.some((s) => { const r = s.getBoundingClientRect(); return r.top < 40 && r.bottom > 40; }));
  }
  addEventListener("scroll", navState, { passive: true }); navState();

  // satellite footage plays only while you can see it
  const sv = $(".settle-vid");
  if (sv && !reduce) new IntersectionObserver(([e]) => { if (e.isIntersecting) { sv.preload = "auto"; sv.play().catch(() => {}); } else sv.pause(); }, { rootMargin: "200px" }).observe(sv);
})();
