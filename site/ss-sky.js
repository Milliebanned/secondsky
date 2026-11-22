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
  const N = SCENES.length;
  const word = $("#word"), bgImg = $("#sceneBg"), fgImg = $("#sceneFg");
  const L = { sky: $(".l-sky"), bg: $(".l-bg"), word: $(".l-word"), fg: $(".l-fg") };
  const skies = $$(".sky-img");
  const glass = $("#glass"), curtain = $("#curtain"), card = $("#sceneCard");
  const beat = $("#beat"), bTime = $("#bTime"), bText = $("#bText"), bStep = $("#bStep");
  const gFill = $("#gFill"), gRead = $("#gRead"), readout = $("#readout"), stampHero = $("#stampHero");
  let scene = -1, curBeat = -1, forced = null;
  const startScene = clamp(Number(params.get("scene") || 0), 0, N - 1);

  // load every scene up front, so a scene change while scrolling never shows an empty frame
  SCENES.forEach((S) => [S.bg, S.fg].filter(Boolean).forEach((src) => { const im = new Image(); im.decoding = "async"; im.src = src; }));

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
    const top = Math.max(H * (narrow ? 0.22 : 0.19), Math.min(cy - fs * 0.42 + 0.03 * H, H * 0.6 - fs * 0.8));
    word.style.top = Math.round(top) + "px";
  }

  function showScene(i) {
    if (i === scene) return;
    scene = i;
    const S = SCENES[i];
    word.textContent = S.word;
    bgImg.src = S.bg || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    bgImg.style.visibility = S.bg ? "visible" : "hidden";
    fgImg.src = S.fg;
    fgImg.alt = S.word === "Harvest" ? "A combine harvester in a wheat field" : S.word === "Pour" ? "A crew pouring concrete" : "A loaded haul truck";
    bgImg.style.objectPosition = fgImg.style.objectPosition = `50% ${S.posY * 100}%`;
    L.sky.style.visibility = S.sky ? "visible" : "hidden";
    $$(".sc").forEach((b) => { const on = Number(b.dataset.scene) === i; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    card.querySelector("b").textContent = `${String(i + 1).padStart(2, "0")} / ${String(N).padStart(2, "0")}`;
    card.querySelector("span").textContent = S.word;
    curBeat = -1;
    layout();
  }

  // the switcher scrolls you to that scene, so scrolling and clicking always agree
  const span = () => sky.offsetHeight - innerHeight;
  function goTo(i) {
    i = (i + N) % N;
    if (fixedP !== null || reduce) { forced = i; showScene(i); return; }
    scrollTo({ top: sky.offsetTop + span() * ((i + 0.14) / N), behavior: "smooth" });
  }
  $$(".sc").forEach((b) => b.addEventListener("click", () => goTo(Number(b.dataset.scene))));
  $("#scPrev").addEventListener("click", () => goTo(scene - 1));
  $("#scNext").addEventListener("click", () => goTo(scene + 1));

  // ---------- the journey, driven by scroll ----------
  let mx = 0, my = 0, tx = 0, ty = 0;
  function progress() {
    if (fixedP !== null) return ((forced ?? startScene) + Math.min(fixedP, 0.99999)) / N;   // ?p= is progress within ?scene=
    if (reduce) return ((forced ?? startScene) + 0.3) / N;
    const r = sky.getBoundingClientRect();
    return span() > 0 ? clamp(-r.top / span(), 0, 0.99999) : 0;
  }
  const px = (v) => v.toFixed(2);
  function tick() {
    const P = progress();
    const i = Math.min(N - 1, Math.floor(P * N));
    const t = P * N - i;                                         // 0..1 within this scene
    showScene(i);
    // the weather plays out in the middle of each scene; the ends are for the 3D handover
    const p = clamp((t - 0.1) / 0.74, 0, 1);
    const out = i < N - 1 ? smooth(0.86, 1, t) : 0;              // leaving this scene
    const inn = i > 0 ? 1 - smooth(0, 0.12, t) : 0;              // arriving into it
    const sun = smooth(0.5, 0.9, p);
    skies[1].style.opacity = smooth(0.44, 0.62, p);
    skies[2].style.opacity = smooth(0.66, 0.86, p);
    const rain = p < 0.3 ? lerp(0.7, 0.88, p / 0.3) : 0.88 * (1 - smooth(0.58, 0.8, p));
    stage.style.setProperty("--glass", Math.max(rain, (out + inn) * 0.9).toFixed(3));
    stage.style.setProperty("--haze", lerp(1, 0.45, sun).toFixed(3));
    stage.style.setProperty("--grade-fg", `brightness(${lerp(0.66, 1.04, sun).toFixed(3)}) saturate(${lerp(0.62, 1.12, sun).toFixed(3)}) contrast(${lerp(1.08, 1.02, sun).toFixed(3)}) sepia(${lerp(0, 0.08, sun).toFixed(3)}) blur(${(rain * 0.6).toFixed(2)}px)`);
    stage.style.setProperty("--grade-sky", `brightness(${lerp(0.82, 1.02, sun).toFixed(3)}) blur(${(rain * 1.4).toFixed(2)}px)`);
    const mm = 14.2 * smooth(0.06, 0.46, p);
    gFill.style.height = Math.min(100, (mm / 20) * 100) + "%";
    gRead.textContent = p > 0.82 ? "Paid" : mm.toFixed(1) + " mm";
    readout.classList.toggle("show", p > 0.55 && out < 0.3 && inn < 0.3);
    stampHero.classList.toggle("show", p > 0.82 && out < 0.2);
    const b = p < 0.2 ? 0 : p < 0.47 ? 1 : p < 0.74 ? 2 : 3;
    if (b !== curBeat) {
      curBeat = b;
      const [tm, txt] = SCENES[i].beats[b];
      bTime.textContent = tm; bText.textContent = txt; bStep.textContent = `${b + 1} / 4`;
      beat.classList.remove("swap"); void beat.offsetWidth; beat.classList.add("swap");
    }
    beat.style.opacity = String(clamp(1 - Math.max(out, inn) * 1.6, 0, 1));
    // the handover: the machine rushes past you, the word falls back into depth, the next world pulls forward
    const k = reduce ? 0 : 1, H = innerHeight, m = Math.max(out, inn);
    curtain.style.opacity = (m * 0.9).toFixed(3);
    card.classList.toggle("show", m > 0.5);
    const tilt = `rotateX(${px(ty * 2 * k)}deg) rotateY(${px(tx * -3 * k)}deg)`;
    const world = `scale(${(1 + p * 0.03 + out * 0.28 + inn * 0.4).toFixed(4)}) rotate(${px((out - inn) * 3)}deg)`;
    L.sky.style.transform = `translate3d(${px(-tx * 10 * k)}px, ${px(-ty * 6 * k - p * 30)}px, 0) ${world}`;
    L.bg.style.transform = `translate3d(${px(-tx * 14 * k)}px, ${px(-ty * 8 * k)}px, 0) ${world}`;
    L.word.style.transform = `translate3d(${px(-tx * 22 * k)}px, ${px(-ty * 12 * k - p * 40 - inn * H * 0.4)}px, ${px(-out * 900)}px) ${tilt} rotateX(${px(out * 40 - inn * 75)}deg)`;
    L.word.style.opacity = String(clamp(1 - m * 1.15, 0, 1));
    L.fg.style.transform = `translate3d(${px(-tx * 36 * k)}px, ${px(-ty * 18 * k + out * H * 0.14 + inn * H * 0.5)}px, ${px(out * 560)}px) scale(${(1 + p * 0.07 - inn * 0.08).toFixed(4)})`;
    L.fg.style.opacity = String(clamp(1 - Math.max(out * 1.05, inn * 0.95), 0, 1));
    const cue = $("#cue"); if (cue) cue.style.opacity = String(1 - smooth(0, 0.02, P));
  }
  function loop() {
    tx += (mx - tx) * 0.07; ty += (my - ty) * 0.07;
    tick();
    requestAnimationFrame(loop);
  }
  addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { mx = e.clientX / innerWidth * 2 - 1; my = e.clientY / innerHeight * 2 - 1; } }, { passive: true });
  addEventListener("resize", layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
  if (glass) new IntersectionObserver(([e]) => { e.isIntersecting ? glass.play().catch(() => {}) : glass.pause(); }).observe(stage);

  showScene(startScene);
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
