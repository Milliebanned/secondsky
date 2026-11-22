// SecondSky home: the weather you scroll through, the depth layers, the scene switcher and the 3D panels.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const params = new URLSearchParams(location.search);
  const fixedP = params.has("p") ? clamp(Number(params.get("p")), 0, 1) : null;

  // Each scene: the photo layers, where the subject sits in its image (fractions), and the day's story in four beats.
  const SCENES = [
    { word: "Harvest", bg: "", fg: "/media/harvest-fg.webp", iw: 2400, ih: 1600, posY: 0.62, wordY: 0.37, wordYNarrow: 0.2, sky: true,
      beats: [
        ["06:00 · Tuesday", "Forty hectares are ready to cut. The forecast says rain is likely."],
        ["12:40", "The rain comes in hard. The combine stands in the yard, and the crew is paid to wait."],
        ["The next morning", "The contract asks two skies what fell: a weather archive and a NASA satellite record."],
        ["Settled", "Both say more than 10 mm. The farm is paid by rule. Nobody files a claim."],
      ] },
    { word: "Pour", bg: "/media/pour.jpg", fg: "/media/pour-cut.webp", iw: 2200, ih: 1468, posY: 0.42, wordY: 0.36, wordYNarrow: 0.16, sky: false,
      beats: [
        ["05:30 · Pour day", "The pump, six mixer trucks and the crew are booked for one slab."],
        ["09:15", "Rain starts before the first truck empties. The pour is called off. The pump still bills for the day."],
        ["After the day", "The contract asks two skies what fell: a weather archive and a NASA satellite record."],
        ["Settled", "Both say more than 10 mm. The contractor is paid by rule, before the slab is rebooked."],
      ] },
    { word: "Haul", bg: "/media/haul.jpg", fg: "/media/haul-cut.webp", iw: 2200, ih: 1467, posY: 0.62, wordY: 0.46, wordYNarrow: 0.4, sky: false,
      beats: [
        ["Day shift", "Twelve trucks on one haul road out of the pit."],
        ["Mid-shift", "Heavy rain turns the ramp to mud. The fleet parks. Fuel, crew and leases keep running."],
        ["After the shift", "The contract asks two skies what fell: a weather archive and a NASA satellite record."],
        ["Settled", "Both say more than 10 mm. The operator is paid by rule. No adjuster, no argument."],
      ] },
  ];

  const stage = $("#stage"), sky = $("#sky");
  if (!stage) return;
  const word = $("#word"), bgImg = $("#sceneBg"), fgImg = $("#sceneFg");
  const L = { sky: $(".l-sky"), bg: $(".l-bg"), word: $(".l-word"), fg: $(".l-fg") };
  const skies = $$(".sky-img");
  const glass = $("#glass");
  const beat = $("#beat"), bTime = $("#bTime"), bText = $("#bText");
  const gFill = $("#gFill"), gRead = $("#gRead"), readout = $("#readout"), stampHero = $("#stampHero");
  let scene = clamp(Number(params.get("scene") || 0), 0, SCENES.length - 1);
  let curBeat = -1;

  // ---------- place the giant word exactly behind the subject ----------
  function layout() {
    const S = SCENES[scene];
    const W = stage.clientWidth, H = stage.clientHeight;
    const LW = W * 1.06, LH = H * 1.06, top0 = -0.03 * H;
    const s = Math.max(LW / S.iw, LH / S.ih), rh = S.ih * s;
    const imgTop = top0 + (LH - rh) * S.posY;
    word.style.fontSize = "200px";
    const w200 = word.scrollWidth || 1;
    const maxW = W * (W < 700 ? 0.94 : 0.9);
    const fs = Math.min(200 * maxW / w200, (H * 0.36) / 0.8);
    word.style.fontSize = fs + "px";
    // on a tall, narrow screen the subject fills the width, so lift the word mostly above it
    const narrow = W / H < 0.9;
    const cy = imgTop + (narrow ? S.wordYNarrow : S.wordY) * rh;
    // keep it clear of the line above and above the captions
    const top = Math.max(H * 0.17, Math.min(cy - fs * 0.42 + 0.03 * H, H * 0.62 - fs * 0.8));
    word.style.top = Math.round(top) + "px";
  }

  function setScene(i, instant) {
    scene = (i + SCENES.length) % SCENES.length;
    const S = SCENES[scene];
    const apply = () => {
      word.textContent = S.word;
      bgImg.src = S.bg; bgImg.alt = "";
      fgImg.src = S.fg; fgImg.alt = S.word === "Harvest" ? "A combine harvester in a wheat field" : S.word === "Pour" ? "A crew pouring concrete" : "A loaded haul truck";
      bgImg.style.objectPosition = fgImg.style.objectPosition = `50% ${S.posY * 100}%`;
      L.sky.style.visibility = S.sky ? "visible" : "hidden";
      $$(".sc").forEach((b) => { const on = Number(b.dataset.scene) === scene; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
      curBeat = -1;
      layout(); tick(true);
      stage.classList.remove("fade-scene");
    };
    if (instant) return apply();
    stage.classList.add("fade-scene");
    const pre = [S.fg, S.bg].filter(Boolean).map((src) => new Promise((r) => { const im = new Image(); im.onload = im.onerror = r; im.src = src; }));
    Promise.all([...pre, new Promise((r) => setTimeout(r, 380))]).then(apply);
  }
  $$(".sc").forEach((b) => b.addEventListener("click", () => setScene(Number(b.dataset.scene))));
  $("#scPrev").addEventListener("click", () => setScene(scene - 1));
  $("#scNext").addEventListener("click", () => setScene(scene + 1));

  // ---------- the weather, driven by scroll ----------
  let mx = 0, my = 0, tx = 0, ty = 0;
  function progress() {
    if (fixedP !== null) return fixedP;
    if (reduce) return 0;
    const r = sky.getBoundingClientRect();
    const span = sky.offsetHeight - innerHeight;
    return span > 0 ? clamp(-r.top / span, 0, 1) : 0;
  }
  function tick(force) {
    const p = progress();
    const sun = smooth(0.5, 0.9, p);
    // sky: storm -> light breaking -> clear
    skies[1].style.opacity = smooth(0.44, 0.62, p);
    skies[2].style.opacity = smooth(0.66, 0.86, p);
    // rain on the glass: heavy, heavier, then wiped away
    const rain = p < 0.3 ? lerp(0.7, 0.88, p / 0.3) : 0.88 * (1 - smooth(0.58, 0.8, p));
    stage.style.setProperty("--glass", rain.toFixed(3));
    stage.style.setProperty("--haze", lerp(1, 0.45, sun).toFixed(3));
    // grade: cold and dim under the storm, warm and bright in the sun; a touch of focus on the glass while wet
    const blur = (rain * 1.4).toFixed(2);
    stage.style.setProperty("--grade-fg", `brightness(${lerp(0.66, 1.04, sun).toFixed(3)}) saturate(${lerp(0.62, 1.12, sun).toFixed(3)}) contrast(${lerp(1.08, 1.02, sun).toFixed(3)}) sepia(${lerp(0.0, 0.08, sun).toFixed(3)}) blur(${(rain * 0.6).toFixed(2)}px)`);
    stage.style.setProperty("--grade-sky", `brightness(${lerp(0.82, 1.02, sun).toFixed(3)}) blur(${blur}px)`);
    // gauge
    const mm = 14.2 * smooth(0.06, 0.46, p);
    gFill.style.height = Math.min(100, (mm / 20) * 100) + "%";
    gRead.textContent = p > 0.82 ? "Paid" : mm.toFixed(1) + " mm";
    readout.classList.toggle("show", p > 0.55);
    stampHero.classList.toggle("show", p > 0.82);
    // beats
    const b = p < 0.2 ? 0 : p < 0.47 ? 1 : p < 0.74 ? 2 : 3;
    if (b !== curBeat || force) {
      curBeat = b;
      const [t, txt] = SCENES[scene].beats[b];
      bTime.textContent = t; bText.textContent = txt;
      beat.classList.remove("swap"); void beat.offsetWidth; beat.classList.add("swap");
    }
    // depth: each layer moves by its distance from you
    const k = reduce ? 0 : 1;
    L.sky.style.transform = `translate3d(${(-tx * 10 * k).toFixed(2)}px, ${(-ty * 6 * k + p * -30).toFixed(2)}px, 0) scale(${1 + p * 0.03})`;
    L.bg.style.transform = `translate3d(${(-tx * 14 * k).toFixed(2)}px, ${(-ty * 8 * k).toFixed(2)}px, 0) scale(${1 + p * 0.04})`;
    L.word.style.transform = `translate3d(${(-tx * 22 * k).toFixed(2)}px, ${(-ty * 12 * k + p * -40).toFixed(2)}px, 0) rotateX(${(ty * 2 * k).toFixed(2)}deg) rotateY(${(tx * -3 * k).toFixed(2)}deg)`;
    L.fg.style.transform = `translate3d(${(-tx * 36 * k).toFixed(2)}px, ${(-ty * 18 * k).toFixed(2)}px, 0) scale(${1 + p * 0.07})`;
    $("#cue") && ($("#cue").style.opacity = String(1 - smooth(0.0, 0.05, p)));
  }
  function loop() {
    tx += (mx - tx) * 0.07; ty += (my - ty) * 0.07;
    tick(false);
    requestAnimationFrame(loop);
  }
  addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { mx = e.clientX / innerWidth * 2 - 1; my = e.clientY / innerHeight * 2 - 1; } }, { passive: true });
  addEventListener("resize", layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

  // the glass only plays while the hero is on screen
  if (glass) {
    new IntersectionObserver(([e]) => { e.isIntersecting ? glass.play().catch(() => {}) : glass.pause(); }).observe(stage);
  }

  setScene(scene, true);
  requestAnimationFrame(loop);
  // warm the other scenes once the first one is up
  addEventListener("load", () => setTimeout(() => SCENES.forEach((S) => [S.bg, S.fg].filter(Boolean).forEach((src) => { const im = new Image(); im.src = src; })), 1200));

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
