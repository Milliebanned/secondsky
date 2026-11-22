// Buy page: keep the giant place word fitted behind the combine, and keep the ticket in step with the form.
(() => {
  const $ = (id) => document.getElementById(id);
  const vis = $("visual"), word = $("vWord");
  const IW = 2400, IH = 1600, POSY = 0.62, WORDY = 0.36;
  const state = { place: "", coords: "", price: null, id: null, status: null };

  function fit() {
    const W = vis.clientWidth, H = vis.clientHeight;
    const wrap = word.parentElement;
    word.style.fontSize = "120px";
    const w120 = word.scrollWidth || 1;
    const fs = Math.min(120 * (W * 0.88) / w120, H * 0.3 / 0.8);
    word.style.fontSize = fs + "px";
    const s = Math.max(W / IW, H / IH), rh = IH * s, top = (H - rh) * POSY;
    const narrow = W / H < 0.9;
    wrap.style.top = Math.max(H * 0.12, top + (narrow ? 0.22 : WORDY) * rh - fs * 0.42) + "px";
  }
  function setWord(t) {
    const v = (t || "Anywhere").trim();
    if (word.textContent === v) return;
    word.textContent = v; word.classList.remove("swap"); void word.offsetWidth; word.classList.add("swap");
    fit();
  }
  const fmtDay = (d) => { const t = Date.parse(d + "T00:00:00Z"); return isNaN(t) ? "—" : new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
  const STAMP = { Paid: "Paid 100%", PaidHalf: "Paid 50%", NotPaid: "Not paid", Settling: "Asking Telegraph", Active: "Bought", Refunded: "Refunded" };

  function render() {
    $("tPlace").textContent = state.place || "Pick a place";
    $("tCoords").innerHTML = state.coords || "&nbsp;";
    $("tDay").textContent = fmtDay($("date").value);
    $("tMode").textContent = $("tReplay").classList.contains("on") ? "Replay of a past day" : "Cover for a future day";
    $("tLimit").textContent = `≥ ${Number($("limit").value) || "?"} mm`;
    $("tPayout").textContent = `${Number($("payout").value) || "?"} USDC`;
    $("tPrice").textContent = state.price != null ? `${state.price} USDC` : "Ask for a price";
    $("tId").textContent = state.id ? `Policy #${state.id} · Sepolia` : "Sepolia · test USDC";
    const st = state.status && STAMP[state.status];
    $("tStamp").hidden = !st; if (st) $("tStamp").textContent = st;
    setWord(state.place);
  }
  // the form's own code reports what changed
  window.ssTicket = (patch) => {
    if ("place" in patch) { state.price = null; }
    Object.assign(state, patch);
    render();
  };
  ["date", "limit", "payout"].forEach((id) => $(id).addEventListener("input", () => { state.price = null; render(); }));
  $("place").addEventListener("input", () => { if (!$("place").value.trim()) { state.place = ""; state.coords = ""; render(); } });

  addEventListener("resize", fit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  // after the form script sets the default dates
  addEventListener("load", render);
  render(); fit();
})();
