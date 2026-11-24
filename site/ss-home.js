// SecondSky home: everything here is read live from the contracts and from Telegraph's records.
import { createPublicClient, http, fallback, parseAbi, formatUnits, decodeEventLog } from "https://esm.sh/viem@2.21.0";
import { sepolia } from "https://esm.sh/viem@2.21.0/chains";

const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const ES = "https://sepolia.etherscan.io";
const REC = "https://devnode.telegraphprotocol.com/engine/v1/job";
const OUR_TEST = "0xae11b21cc16223e359acfcde5ad86a9a03286e61"; // our own test holder wallet
const CONTRACTS = [
  { v: 2, addr: "0x0136e904ef5df658588c84d95f520a338b3bbcff", from: 12183620n, status: ["None","Active","Settling","Paid","PaidHalf","NotPaid","Refunded"] },
  { v: 1, addr: "0x75e0129d3c30045d72a90676f24a63e2a1e6752f", from: 12181578n, status: ["None","Active","Settling","Paid","NotPaid","Disputed","Refunded"] },
];
const STAMP = { Active: "Open", Settling: "Asking", Paid: "Paid 100%", PaidHalf: "Paid 50%", NotPaid: "Not paid", Disputed: "Disputed", Refunded: "Refunded" };
const STAMP_NOTE = { Active: "waiting for its day", Settling: "Telegraph answering", PaidHalf: "sources split", NotPaid: "stayed under the limit", Disputed: "old v1 rule", Paid: "both over the limit" };
// Places we know by name. Anything else is shown as its coordinates.
const PLACES = [
  ["Lagos", 6.4541, 3.3947], ["Nairobi", -1.2833, 36.8167], ["London", 51.5085, -0.1257], ["Obuasi", 6.2023, -1.668],
  ["Kalgoorlie", -30.7461, 121.4742], ["Mumbai", 19.076, 72.8777],
];
const abi = parseAbi([
  "function policyCount() view returns (uint256)",
  "function lockedPayouts() view returns (uint256)",
  "function sourceA() view returns (uint256)",
  "function sourceB() view returns (uint256)",
  "function answers(uint256) view returns (uint256)",
  "function getPolicy(uint256) view returns ((address holder,uint96 payout,uint96 premium,uint96 jobReserve,uint64 settleAfter,uint64 thresholdE6,uint8 status,uint64 jobA,uint64 jobB,string location,string date))",
  "function balanceOf(address) view returns (uint256)",
  "event CoverBought(uint256 indexed policyId, address indexed holder, string location, string date, uint256 thresholdE6, uint256 payout, uint256 premium)",
  "event SettleRequested(uint256 indexed policyId, uint256 jobA, uint256 jobB)",
  "event Finalized(uint256 indexed policyId, uint8 status, uint256 rainA, uint256 rainB)",
  "event Finalized(uint256 indexed policyId, uint8 status, uint256 rainA, uint256 rainB, uint256 paid)",
  "event Retry(uint256 indexed policyId, bool okA, bool okB)",
  "event WrongMiner(uint256 indexed policyId, uint256 jobId)",
]);
const c = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
// publicnode prunes old logs, so event history comes from endpoints that keep it, in order.
const history = createPublicClient({ chain: sepolia, transport: fallback([
  http("https://sepolia.gateway.tenderly.co"), http("https://eth-sepolia.api.onfinality.io/public"), http("https://ethereum-sepolia-rpc.publicnode.com"),
]) });
const $ = (id) => document.getElementById(id);
const usd = (v) => Number(formatUnits(v, 6)).toLocaleString("en-GB", { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
const fmtDate = (d) => { const t = Date.parse(d + "T00:00:00Z"); return isNaN(t) ? esc(d) : new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };

function where(loc) {
  const m = String(loc).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const lat = +m[1], lon = +m[2];
    const near = PLACES.find(([, a, b]) => Math.abs(a - lat) < 0.05 && Math.abs(b - lon) < 0.05);
    return { name: near ? near[0] : `${lat.toFixed(2)}, ${lon.toFixed(2)}`, lat, lon, coords: `${lat}, ${lon}` };
  }
  const named = PLACES.find(([n]) => n.toLowerCase() === String(loc).trim().toLowerCase());
  return named ? { name: named[0], lat: named[1], lon: named[2], coords: `${named[1]}, ${named[2]}` } : { name: String(loc), lat: null, lon: null, coords: "" };
}
function unpack(v) {
  if (!(v >> 255n)) return { state: "waiting" };
  if (!((v >> 254n) & 1n)) return { state: "failed" };
  return { state: "ok", mm: Number(v & ((1n << 64n) - 1n)) / 1e6 };
}

async function loadContract(k) {
  const read = (functionName, args = [], address = k.addr) => c.readContract({ address, abi, functionName, args });
  const [count, locked, bal, sA, sB] = await Promise.all([read("policyCount"), read("lockedPayouts"), read("balanceOf", [k.addr], USDC), read("sourceA"), read("sourceB")]);
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const pols = await Promise.all(ids.map((id) => read("getPolicy", [id])));
  const ans = await Promise.all(pols.map((p) => Promise.all([p.jobA ? read("answers", [p.jobA]) : 0n, p.jobB ? read("answers", [p.jobB]) : 0n])));
  // Event history only adds transaction links and the job count; the ledger still shows if it cannot be read.
  const logs = await history.getLogs({ address: k.addr, fromBlock: k.from, toBlock: "latest" }).catch((e) => { console.warn("event history unavailable", e); return []; });
  const ev = {};
  for (const l of logs) {
    let d; try { d = decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { continue; }
    if (d.args.policyId === undefined) continue;
    const id = String(d.args.policyId); (ev[id] ??= {});
    if (d.eventName === "CoverBought") ev[id].buy = l.transactionHash;
    if (d.eventName === "SettleRequested") (ev[id].settle ??= []).push(l.transactionHash);
    if (d.eventName === "Finalized") { ev[id].final = l.transactionHash; if (d.args.paid !== undefined) ev[id].paid = d.args.paid; }
    if (d.eventName === "Retry") (ev[id].retry ??= []).push(l.transactionHash);
    if (d.eventName === "WrongMiner") (ev[id].wrong ??= []).push(l.transactionHash);
  }
  const rows = pols.map((p, i) => ({ k, id: String(ids[i]), p, st: k.status[p.status], a: unpack(ans[i][0]), b: unpack(ans[i][1]), lim: Number(p.thresholdE6) / 1e6, e: ev[String(ids[i])] || {}, w: where(p.location) }));
  return { k, count, locked, bal, sA, sB, rows };
}

async function load() {
  const all = await Promise.all(CONTRACTS.map(loadContract));
  $("srcA").textContent = all[0].sA; $("srcB").textContent = all[0].sB;
  const rows = all.flatMap((x) => x.rows.slice().reverse());
  let premiums = 0n, paidOut = 0n, jobs = 0, decided = 0, agreed = 0, outside = 0;
  const n = { full: 0, half: 0, none: 0, dispute: 0, open: 0 };
  for (const r of rows) {
    premiums += r.p.premium;
    if (r.p.holder.toLowerCase() !== OUR_TEST) outside++;
    if (r.st === "Paid") { n.full++; paidOut += r.p.payout; }
    else if (r.st === "PaidHalf") { n.half++; paidOut += r.p.payout / 2n; }
    else if (r.st === "NotPaid") n.none++;
    else if (r.st === "Disputed") n.dispute++;
    else if (r.st !== "Refunded") n.open++;
    jobs += r.e.settle ? r.e.settle.length * 2 : (r.p.jobA ? 2 : 0);
    if (r.a.state === "ok" && r.b.state === "ok") { decided++; if ((r.a.mm >= r.lim) === (r.b.mm >= r.lim)) agreed++; }
  }
  const v2 = all[0];
  const num = (v, k, note = "") => `<div class="num"><b>${v}</b><span>${k}</span>${note ? `<em>${note}</em>` : ""}</div>`;
  $("stats").innerHTML = [
    num(rows.length, "Policies", `${n.open} open now`),
    num(n.full, "Paid 100%", "both records over the limit"),
    num(n.half, "Paid 50%", "the records split"),
    num(n.none, "Not paid", "both under the limit"),
    num(usd(paidOut), "USDC paid out", "to policy holders"),
    num(decided ? Math.round(100 * agreed / decided) + "%" : "–", "Sources agreed", `${agreed} of ${decided} answered policies`),
    num(jobs, "Telegraph jobs", "bought by the contracts themselves"),
    num("2", "USDC of evidence", "per settlement: two 1 USDC jobs"),
    num(usd(v2.bal), "USDC in the v2 pool", `${usd(v2.locked)} promised to open policies`),
    num(usd(premiums), "USDC of premiums", "both versions"),
    num(outside, "Outside buyers", "wallets that are not ours"),
    num(n.dispute, "Disputed", "only under the old v1 rule"),
  ].join("");

  const max = Math.max(1, ...rows.flatMap((r) => [r.a.mm || 0, r.b.mm || 0, r.lim])) * 1.08;
  const bar = (name, cls, s, lim) => {
    const w = s.state === "ok" ? Math.max(0.6, 100 * s.mm / max) : 0;
    const txt = s.state === "ok" ? `${s.mm} mm` : s.state === "failed" ? "no answer" : "—";
    return `<div class="gbar"><span>${name}</span><div class="t"><div class="f ${cls}" style="width:${w}%"></div><div class="lim" style="left:${100 * lim / max}%" title="limit ${lim} mm"></div></div><span class="v">${txt}</span></div>`;
  };
  const why = (r) => {
    const paid = r.e.paid !== undefined ? usd(r.e.paid) : null;
    if (r.st === "Paid") return `Both records reached ${r.lim} mm, so the holder was paid ${paid ?? usd(r.p.payout)} USDC.`;
    if (r.st === "PaidHalf") return `One record reached ${r.lim} mm and the other did not. By the v2 rule the holder was paid half: ${paid ?? usd(r.p.payout / 2n)} USDC.`;
    if (r.st === "NotPaid") return `Both records stayed under ${r.lim} mm. The payout went back to the pool.`;
    if (r.st === "Disputed") return `One record says over ${r.lim} mm, the other under. The v1 rule would not pick a side. This is why v2 exists.`;
    if (r.st === "Settling") return "The contract has bought both answers and is waiting for Telegraph to deliver them.";
    if (r.e.wrong) return "Telegraph's record showed a miner other than the one named answered, so the keeper sent it back to be bought again.";
    if (r.e.retry) return "A source could not answer yet, so it went back to be bought again.";
    const due = Number(r.p.settleAfter) * 1000;
    return due > Date.now() ? `Bought. Settles after ${new Date(due).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC, once the day is over and NASA has published it.` : "Due. The keeper settles it once NASA has published the day.";
  };
  const link = (label, h) => h ? `<a href="${ES}/tx/${h}" target="_blank" rel="noopener">${label}</a>` : "";
  const rec = (j, s) => `<a href="${REC}/${j}/result" target="_blank" rel="noopener">${s} · job ${j}</a>`;
  $("policies").innerHTML = rows.map((r) => {
    const ours = r.p.holder.toLowerCase() === OUR_TEST;
    return `<article class="row">
      <div class="r-id">v${r.k.v}<b>${String(r.id).padStart(2, "0")}</b></div>
      <div class="r-place"><b>${esc(r.w.name)}</b><span>${fmtDate(r.p.date)} · ${r.w.coords ? `<a href="https://www.openstreetmap.org/?mlat=${r.w.lat}&mlon=${r.w.lon}#map=9/${r.w.lat}/${r.w.lon}" target="_blank" rel="noopener">${esc(r.w.coords)}</a>` : ""}<br>pays ${usd(r.p.payout)} USDC at ≥ ${r.lim} mm · premium ${usd(r.p.premium)}</span><span class="who ${ours ? "" : "out"}">${ours ? "our test" : `buyer ${r.p.holder.slice(0, 6)}…${r.p.holder.slice(-4)}`}</span></div>
      <div class="r-gauge">${bar("Open-Meteo", "f-a", r.a, r.lim)}${bar("NASA POWER", "f-b", r.b, r.lim)}</div>
      <div class="r-stamp"><span class="stamp st-${r.st}">${STAMP[r.st] || r.st}<small>${STAMP_NOTE[r.st] || ""}</small></span></div>
      <p class="r-why">${why(r)}</p>
      <div class="r-links">${link("bought", r.e.buy)}${(r.e.settle || []).map((h, i) => link(i ? "settled again" : "settled", h)).join("")}${(r.e.retry || []).map((h) => link("source failed → retry", h)).join("")}${(r.e.wrong || []).map((h) => link("wrong miner → bought again", h)).join("")}${r.p.jobA ? rec(r.p.jobA, "Open-Meteo record") + rec(r.p.jobB, "NASA record") : ""}${link("finalized", r.e.final)}</div>
    </article>`;
  }).join("") || `<p class="honest">No policies yet.</p>`;
  $("updated").textContent = `Read at ${new Date().toLocaleTimeString("en-GB")}.`;

  // places list beside the globe
  const groups = {};
  for (const r of rows) { if (r.w.lat === null) continue; (groups[r.w.name] ??= { ...r.w, rows: [] }).rows.push(r); }
  $("places").innerHTML = Object.values(groups).map((g) => {
    const paid = g.rows.filter((r) => r.st === "Paid" || r.st === "PaidHalf").length, open = g.rows.filter((r) => r.st === "Active" || r.st === "Settling").length;
    return `<li><b>${esc(g.name)}</b><span>${g.rows.length} polic${g.rows.length === 1 ? "y" : "ies"} · ${paid} paid · ${open} open</span></li>`;
  }).join("");
  globe(rows.filter((r) => r.w.lat !== null));
}

// ---------------------------------------------------------------- forecasts
async function forecasts() {
  const job = (n) => `<a href="${REC}/${n}/result" target="_blank" rel="noopener">job ${n}</a>`;
  try {
    const d = await (await fetch("/api/forecasts")).json();
    const s = d.summary || {};
    const num = (v, k, note) => `<div class="num"><b>${v}</b><span>${k}</span><em>${note}</em></div>`;
    $("fcStats").innerHTML =
      num(s.forecasts ?? 0, "Forecasts bought", "from Telegraph, 1 test USDC each") +
      num(s.scored ?? 0, "Scored", "the covered day has settled") +
      num(s.rain_calls ? `${s.rain_calls_right}/${s.rain_calls}` : "–", "Rain calls right", "said rain vs was wet") +
      num(s.mean_brier ?? "–", "Brier score", "0 is perfect, 0.25 a coin flip");
    $("fcRows").innerHTML = (d.rows || []).map((r) => {
      const f = r.forecast, rc = r.recorded, sc = r.score;
      const fc = !r.answered ? "waiting for Telegraph" : !f ? "answered, record not published yet" :
        `${f.chance_pct ?? "?"}% rain${f.rain_mm != null ? ", " + f.rain_mm + " mm" : ""} · ${f.high_c ?? "?"} / ${f.low_c ?? "?"} °C<span class="sub">${esc(r.answered_by)} · ${job(r.job)}</span>`;
      const rcs = rc ? `${rc.rain_a ?? "?"} / ${rc.rain_b ?? "?"} mm · ${rc.high_c ?? "?"} / ${rc.low_c ?? "?"} °C<span class="sub">${job(rc.jobA)} · ${job(rc.jobB)}</span>` : `<span class="sub">${esc(r.note || "")}</span>`;
      const scr = sc ? `<span class="${sc.rain_call_right ? "ok" : "bad"}">${sc.rain_call_right ? "Right" : "Wrong"}</span> (${sc.wet ? "wet" : "dry"}) · Brier ${sc.brier}<span class="sub">high ${sc.high_error_c > 0 ? "+" : ""}${sc.high_error_c} °C · low ${sc.low_error_c > 0 ? "+" : ""}${sc.low_error_c} °C</span>` : "–";
      const w = where(r.location);
      return `<tr><td>${r.policy ? "#" + r.policy : "test"}</td><td>${esc(w.name)}${r.date ? `<span class="sub">${fmtDate(r.date)}</span>` : ""}</td><td>${r.warning_hours != null ? r.warning_hours + " h" : "–"}</td><td>${fc}</td><td>${rcs}</td><td>${scr}</td></tr>`;
    }).join("") || `<tr><td colspan="6">No forecasts yet.</td></tr>`;
  } catch { $("fcStats").innerHTML = `<div class="num"><b>–</b><span>Could not load forecasts</span></div>`; }
}

// ---------------------------------------------------------------- the globe
async function globe(rows) {
  const canvas = $("globe"); if (!canvas) return;
  let THREE;
  try { THREE = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"); }
  catch { canvas.hidden = true; document.querySelector(".globe-fallback").hidden = false; return; }
  const wrap = canvas.parentElement;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
  catch { canvas.hidden = true; document.querySelector(".globe-fallback").hidden = false; return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 4.2);
  const world = new THREE.Group(); scene.add(world);

  const tl = new THREE.TextureLoader();
  const map = tl.load("/media/earth.jpg"); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const bump = tl.load("/media/earth-bump.jpg");
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), new THREE.MeshPhongMaterial({ map, bumpMap: bump, bumpScale: 0.035, specular: new THREE.Color(0x223344), shininess: 9 }));
  world.add(earth);
  // a thin atmosphere, brighter at the rim
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.09, 96, 96), new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec3 n; varying vec3 v; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); n = normalize(normalMatrix * normal); v = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "varying vec3 n; varying vec3 v; void main(){ float i = pow(clamp(0.62 + dot(n, v), 0.0, 1.0), 3.2); gl_FragColor = vec4(0.50,0.69,0.92,1.0) * i * 1.15; }",
  }));
  scene.add(atmo);
  // haze over the limb of the globe itself, so the edge glows instead of going dark
  const limb = new THREE.Mesh(new THREE.SphereGeometry(1.003, 96, 96), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec3 n; varying vec3 v; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); n = normalize(normalMatrix * normal); v = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "varying vec3 n; varying vec3 v; void main(){ float f = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0); gl_FragColor = vec4(0.52,0.70,0.92,1.0) * f * 0.85; }",
  }));
  scene.add(limb);

  // the sun where it really is now: subsolar point from the date and UTC time
  const now = new Date();
  const doy = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 0)) / 864e5;
  const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (doy + 10));
  const sunLon = -15 * (now.getUTCHours() + now.getUTCMinutes() / 60 - 12);
  const toVec = (lat, lon, r = 1) => {
    const phi = (90 - lat) * Math.PI / 180, th = (lon + 180) * Math.PI / 180;
    return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th));
  };
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
  world.add(sun); sun.position.copy(toVec(decl, sunLon, 10)); sun.target = earth;
  scene.add(new THREE.AmbientLight(0x31404f, 0.42));

  // a mark for every policy
  const COL = { Paid: 0xd4a84b, PaidHalf: 0x7fa3bd, NotPaid: 0x8e8a80, Disputed: 0xc2412b, Active: 0xff5a1f, Settling: 0xff5a1f, Refunded: 0x8e8a80 };
  const labels = [];
  const seen = {};
  for (const r of rows) {
    const key = r.w.name; const nth = (seen[key] = (seen[key] || 0) + 1) - 1;
    const h = 0.12 + Math.min(0.22, Number(r.p.payout) / 1e6 / 120) + nth * 0.0;
    const dir = toVec(r.w.lat + nth * 0.9, r.w.lon + nth * 0.9).normalize();
    const col = COL[r.st] ?? 0xffffff;
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, h, 8), new THREE.MeshBasicMaterial({ color: col }));
    stick.position.copy(dir.clone().multiplyScalar(1 + h / 2));
    stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 16), new THREE.MeshBasicMaterial({ color: col }));
    head.position.copy(dir.clone().multiplyScalar(1 + h));
    world.add(stick, head);
    if (nth === 0) {
      const el = document.createElement("div");
      el.className = "pin-label"; el.style.setProperty("--c", "#" + col.toString(16).padStart(6, "0"));
      el.textContent = r.w.name;
      wrap.appendChild(el);
      labels.push({ el, head, dir });
    }
  }

  // start facing Africa and Europe, where most policies are
  world.rotation.y = -(15 + 90) * Math.PI / 180; world.rotation.x = 0.18;
  let drag = null, vy = 0.0012, vx = 0, visible = true;
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    vy = (e.clientX - drag.x) * 0.005; vx = (e.clientY - drag.y) * 0.003;
    world.rotation.y += vy; world.rotation.x = Math.max(-0.8, Math.min(0.8, world.rotation.x + vx));
    drag = { x: e.clientX, y: e.clientY };
  });
  const end = () => { drag = null; };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);

  function size() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  addEventListener("resize", size); size();
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(wrap);

  const v = new THREE.Vector3(), camDir = new THREE.Vector3();
  (function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    if (!drag) { vy += (0.0012 - vy) * 0.03; world.rotation.y += vy; }
    renderer.render(scene, camera);
    const w = wrap.clientWidth, h = wrap.clientHeight;
    for (const L of labels) {
      L.head.getWorldPosition(v);
      camDir.copy(camera.position).sub(v).normalize();
      const facing = v.clone().normalize().dot(camDir) > 0.15;
      v.project(camera);
      L.el.style.left = ((v.x + 1) / 2 * w) + "px"; L.el.style.top = ((1 - v.y) / 2 * h) + "px";
      L.el.style.opacity = facing ? "1" : "0";
    }
  })();
}

load().catch((e) => { $("err").textContent = "Could not read the chain right now: " + (e.shortMessage || e.message); });
forecasts();
