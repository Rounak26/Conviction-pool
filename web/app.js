// Conviction Book frontend. Talks only to the local server (/api/*). No wallet, no RPC.
// All data strings are inserted with textContent (via el()), never as HTML.

const state = { source: "mainnet-snapshot", meta: null, pools: [], selected: null, book: null, side: "bid", filter: "", dbcOnly: false };

// ---------------------------------------------------------------- helpers
function el(tag, attrs = {}, ...children) {
  const n = document.createElementNS(tag === "svg" || attrs.svg ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "svg" || v == null || v === false) continue;
    if (k === "class") n.setAttribute("class", v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const s = (tag, attrs = {}, ...children) => el(tag, { ...attrs, svg: true }, ...children);
const $ = (sel, root = document) => root.querySelector(sel);

async function getJson(url) {
  const r = await fetch(url);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

function fmtPrice(p) {
  if (p == null || !isFinite(p)) return "–";
  if (p === 0) return "0";
  const a = Math.abs(p);
  if (a >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (a < 1e-7) return p.toExponential(3);
  return Number(p.toPrecision(4)).toString();
}
const fmtUsd = (v) => (v == null ? "–" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(v < 10 ? 2 : 0)}`);
const fmtPct = (f, digits = 1) => (f == null ? "–" : `${f > 0 ? "+" : ""}${(f * 100).toFixed(digits)}%`);
// Distances beyond +900% read better as a multiple of the reference.
const fmtDist = (f) => (f != null && f > 9 ? `${(1 + f).toFixed(1 + f >= 100 ? 0 : 1)}× ref` : fmtPct(f));
const fmtDays = (d) => (d == null ? "–" : d < 1 ? `${Math.round(d * 24)}h` : `${d.toFixed(d < 10 ? 1 : 0)}d`);
const fmtScore = (v) => (v == null ? "–" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0));
const fmtTime = (iso) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "–");
const STATUS_LABEL = { resting: "resting", "crossed-in-band": "crossed, in band", "arb-fillable": "arb-fillable", filled: "filled", "wrong-side": "wrong side of reference" };
const DBC_BADGE = {
  confirmed: ["Graduated (DBC) ✓", "ok", "The DAMM v2 pool's creation transaction invoked the DBC program."],
  "unverified-history-limit": ["DBC authority, unverified", "maybe", "The DAMM v2 pool was created by DBC's pool authority, but its creation transaction was beyond the history we scanned."],
  "dbc-authority-unchecked": ["DBC authority, unchecked", "maybe", "Created by DBC's pool authority; creation transaction not checked."],
  none: ["No DBC link found", "", "No DAMM v2 pool for this pair was created by DBC's pool authority."],
  demo: ["Demo", "demo", "Synthetic pool."],
};
const solscan = (kind, id) => `https://solscan.io/${kind}/${encodeURIComponent(id)}`;
const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a ?? "");
// Unfilled USD for one side. Orders the data source could not price are counted, never shown as $0.
function fmtSideUsd(usd, open, unpriced) {
  if (!open) return "none";
  if (unpriced === open) return `${open} unpriced`;
  return unpriced ? `${fmtUsd(usd)} + ${unpriced} unpriced` : fmtUsd(usd);
}
const FILL_CLASS = { jupiter: "via Jupiter", "damm-dlmm-arb": "DAMM v2 → DLMM arbitrage", "direct-or-other": "direct / other router", "order-owner": "by an order owner" };

// ---------------------------------------------------------------- data loading
async function loadPools() {
  const data = await getJson(`/api/pools?source=${state.source}`);
  state.meta = data;
  state.pools = data.pools;
  renderBanner();
  renderPoolList();
  const keep = state.pools.find((p) => p.id === state.selected);
  await selectPool(keep ? keep.id : state.pools[0]?.id);
}

let selectSeq = 0;
async function selectPool(id) {
  state.selected = id;
  renderPoolList();
  syncUrl();
  if (!id) {
    $("#detail").replaceChildren(el("p", { class: "empty" }, "No pools in this dataset."));
    return;
  }
  const seq = ++selectSeq;
  const book = await getJson(`/api/book?source=${state.source}&id=${encodeURIComponent(id)}`);
  if (seq !== selectSeq) return; // a later click won
  state.book = book;
  renderDetail();
}

function syncUrl() {
  const q = new URLSearchParams();
  if (state.source !== "mainnet-snapshot") q.set("source", state.source);
  if (state.selected) q.set("pool", state.selected);
  const tab = document.querySelector('.tabs button[aria-selected="true"]')?.dataset.tab;
  if (tab && tab !== "book") q.set("tab", tab);
  history.replaceState(null, "", q.size ? `?${q}` : location.pathname);
}

// ---------------------------------------------------------------- banner + list
function renderBanner() {
  const m = state.meta;
  const b = $("#banner");
  b.className = `banner${m.source === "demo" ? " demo" : ""}`;
  b.replaceChildren(
    el("span", { class: "badge banner-tag" }, m.source === "demo" ? "SYNTHETIC" : "SNAPSHOT · NOT LIVE"),
    " ",
    el("strong", {}, m.label),
    ` · orders as of ${fmtTime(m.takenAt)}`,
    m.referencePriceAt && m.referencePriceAt !== m.takenAt ? ` · reference prices as of ${fmtTime(m.referencePriceAt)}` : "",
    " · ",
    el("details", {}, el("summary", {}, "caveats"), el("ul", {}, m.caveats.map((c) => el("li", {}, c)))),
  );
}

function renderPoolList() {
  const q = state.filter.trim().toLowerCase();
  const list = state.pools.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!state.dbcOnly || p.dbcOrigin === "confirmed" || p.dbcOrigin === "unverified-history-limit" || p.dbcOrigin === "dbc-authority-unchecked"));
  $("#pool-list").replaceChildren(
    ...list.map((p) => {
      const [label, cls] = DBC_BADGE[p.dbcOrigin] ?? ["", ""];
      return el(
        "li",
        {},
        el(
          "button",
          { "aria-current": p.id === state.selected ? "true" : "false", onclick: () => selectPool(p.id) },
          el("span", { class: "pl-name" }, p.name, p.dbcOrigin !== "none" ? el("span", { class: `badge ${cls}` }, label) : null, p.hasFills ? el("span", { class: "badge ok", title: "Order fills observed in the sampled window" }, "fills seen") : null),
          el("span", { class: "pl-meta" }, `${p.orders} orders · bids ${fmtSideUsd(p.bidUsd, p.openBids, p.unpricedBids)} · asks ${fmtSideUsd(p.askUsd, p.openAsks, p.unpricedAsks)} · median open ${fmtDays(p.medianDaysOpen)}`),
          el("span", { class: "pl-meta pl-sub" }, `bin step ${p.binStep} · DAMM fee ${p.refFeeBps} bps${p.lbPair ? ` · ${shortAddr(p.lbPair)}` : ""}`),
        ),
      );
    }),
    ...(list.length ? [] : [el("li", { class: "pl-meta" }, "No pools match.")]),
  );
}

// ---------------------------------------------------------------- detail
function renderDetail() {
  const book = state.book;
  const p = book.pool;
  const root = $("#tpl-detail").content.cloneNode(true);

  $(".pool-name", root).textContent = p.name;
  const [label, cls, title] = DBC_BADGE[p.dbcOrigin] ?? ["", "", ""];
  $(".badges", root).append(
    el("span", { class: `badge ${cls}`, title }, label),
    el("span", { class: "badge" }, `DAMM v2 fee ${p.refFeeBps} bps`),
    el("span", { class: "badge" }, `DLMM base fee ${p.dlmmBaseFeeBps} bps`),
    el("span", { class: "badge" }, `bin step ${p.binStep}`),
  );
  if (p.source === "mainnet-snapshot") {
    $(".links", root).append(
      p.lbPair ? el("a", { href: solscan("account", p.lbPair), target: "_blank", rel: "noopener" }, "DLMM pool ↗") : "",
      p.dammPool ? el("a", { href: solscan("account", p.dammPool), target: "_blank", rel: "noopener" }, "DAMM v2 reference ↗") : "",
    );
  }

  if (p.dlmmActivePrice) {
    const ratio = p.dlmmActivePrice / p.refPrice;
    if (ratio > 1.2 || ratio < 1 / 1.2) {
      const d = $(".drift", root);
      d.hidden = false;
      d.textContent = `The DLMM active price (${fmtPrice(p.dlmmActivePrice)}) is ${ratio >= 1 ? ratio.toFixed(1) + "×" : (1 / ratio).toFixed(1) + "× below"} the DAMM v2 reference (${fmtPrice(p.refPrice)}). Only arbitrage links the two pools; a gap this large means either the DLMM pool has drifted or the reference pool is thin. Treat distances on this page with care.`;
    }
  }

  const t = book.totals;
  const stat = (k, v, sub) => el("div", { class: "stat" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), sub ? el("div", { class: "s" }, sub) : null);
  $(".stats", root).append(
    stat("DAMM v2 reference", fmtPrice(p.refPrice), `${p.tokenY} per ${p.tokenX}`),
    stat("No-fill band", `≥ ±${(book.bandWidth * 100).toFixed(2)}%`, "base fees; lower bound"),
    stat("Bids waiting", fmtSideUsd(t.bidUsd, t.openBids, t.unpricedBids), `${t.openBids} open bids, unfilled USD${t.unpricedBids ? `; ${t.unpricedBids} unpriced` : ""}`),
    stat("Asks waiting", fmtSideUsd(t.askUsd, t.openAsks, t.unpricedAsks), `${t.openAsks} open asks, unfilled USD${t.unpricedAsks ? `; ${t.unpricedAsks} unpriced` : ""}`),
    stat("Median time open", fmtDays(t.medianDaysOpen), "observed, not locked"),
    stat("Crossed / fillable", `${t.byStatus["crossed-in-band"]} / ${t.byStatus["arb-fillable"]}`, `${t.byStatus.filled} filled, ${t.byStatus.resting} resting`),
  );

  $(".chart", root).append(depthChart(book));
  const unpriced = t.unpricedBids + t.unpricedAsks;
  if (unpriced) $(".chart", root).append(el("p", { class: "hint" }, `${unpriced} open order${unpriced > 1 ? "s have" : " has"} no USD price and ${unpriced > 1 ? "are" : "is"} not in this chart.`));
  $(".coverage", root).textContent = p.coverage;
  $("table.orders", root).append(...orderTable(book));

  if (p.activity) {
    const a = $(".activity", root);
    a.hidden = false;
    $(".act-window", a).textContent = `${p.activity.swapTxs} swaps sampled, ${fmtTime(p.activity.windowStart)} → ${fmtTime(p.activity.windowEnd)}`;
    const fills = Object.entries(p.activity.orderFillsByClass);
    $(".act-body", a).append(
      ...(fills.length
        ? fills.map(([k, v]) => el("div", { class: "stat" }, el("div", { class: "k" }, FILL_CLASS[k] ?? k), el("div", { class: "v" }, v)))
        : [el("p", { class: "hint" }, "No swap in the sampled window consumed limit-order liquidity. A short window on a busy pool can miss fills.")]),
    );
    if (p.activity.fills?.length) {
      $(".act-txs", a).append(
        el("thead", {}, el("tr", {}, el("th", {}, "Time (UTC)"), el("th", {}, "Route"), el("th", {}, "Mainnet transaction"))),
        el(
          "tbody",
          {},
          p.activity.fills.map((f) =>
            el("tr", {}, el("td", {}, f.blockTime ? fmtTime(new Date(f.blockTime * 1000).toISOString()) : "–"), el("td", {}, FILL_CLASS[f.class] ?? f.class), el("td", {}, el("a", { href: solscan("tx", f.signature), target: "_blank", rel: "noopener" }, `${f.signature.slice(0, 10)}… ↗`))),
          ),
        ),
      );
    }
  }

  $("#detail").replaceChildren(root);
  wirePreview();
}

function depthChart(book) {
  const W = 760, H = 190, padL = 8, padR = 8, padT = 14, padB = 26;
  const LIM = 50; // ±50% window; tails are clamped into the edge buckets
  const buckets = new Map();
  for (const r of [...book.bids, ...book.asks]) {
    if (r.status === "filled" || !r.unfilledUsd) continue;
    const pct = Math.max(-LIM, Math.min(LIM - 1, Math.floor(r.distance * 100)));
    const key = `${r.side}:${pct}`;
    buckets.set(key, (buckets.get(key) ?? 0) + r.unfilledUsd);
  }
  const max = Math.max(1, ...buckets.values());
  const x = (pct) => padL + ((pct + LIM) / (2 * LIM)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const bw = x(1) - x(0) - 1;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Unfilled order size by distance from the reference price" });
  const band = book.bandWidth * 100;
  svg.append(s("rect", { class: "band", x: x(-band), y: padT, width: Math.max(1, x(band) - x(-band)), height: H - padT - padB }));
  for (const [key, v] of buckets) {
    const [side, pct] = key.split(":");
    svg.append(s("rect", { class: side, x: x(Number(pct)) + 0.5, y: y(v), width: bw, height: Math.max(1, H - padB - y(v)), rx: 1.5 }, s("title", {}, `${side} ${pct}% to ${Number(pct) + 1}%: ${fmtUsd(v)}`)));
  }
  svg.append(s("line", { class: "axis", x1: padL, x2: W - padR, y1: H - padB, y2: H - padB }));
  for (const t of [-50, -25, -10, 0, 10, 25, 50]) {
    svg.append(s("text", { class: "tick", x: Math.min(W - padR - 14, Math.max(padL + 10, x(t))), y: H - 8, "text-anchor": "middle" }, t === 0 ? "ref" : `${t > 0 ? "+" : ""}${t}%`));
  }
  svg.append(s("line", { class: "ref", x1: x(0), x2: x(0), y1: padT - 6, y2: H - padB }));
  svg.append(s("text", { class: "reflabel", x: x(0) + 4, y: padT }, `ref ${fmtPrice(book.pool.refPrice)}`));
  return svg;
}

function orderTable(book) {
  const maxUsd = Math.max(1, ...[...book.bids, ...book.asks].map((r) => r.unfilledUsd ?? 0));
  const head = el("thead", {}, el("tr", {}, ["Side", "Price", "Distance", "Unfilled", "Open for", "Filled", "Status", "Score", ""].map((h, i) => el("th", { class: [1, 2, 3, 4, 5, 7].includes(i) ? "num" : "" }, h))));
  const row = (r) =>
    el(
      "tr",
      {},
      el("td", { class: `side-${r.side}` }, r.side),
      el("td", { class: "num", title: `Order covers ${fmtPrice(r.priceLow)} – ${fmtPrice(r.priceHigh)}; shown: the price nearest the market` }, fmtPrice(r.edgePrice)),
      el("td", { class: "num" }, fmtDist(r.distance)),
      r.unfilledUsd == null
        ? el("td", { class: "num hint", title: `Size ${fmtPrice(r.sizeInput)} ${r.inputToken}; the data source has no USD price for it` }, "unpriced")
        : el("td", { class: "num" }, el("span", { class: "bar", style: `width:${Math.round((r.unfilledUsd / maxUsd) * 50)}px` }), fmtUsd(r.unfilledUsd)),
      el("td", { class: "num" }, fmtDays(r.daysOpen)),
      el("td", { class: "num" }, `${Math.round(r.filledPct)}%`),
      el("td", {}, el("span", { class: `pill ${r.status}` }, STATUS_LABEL[r.status])),
      el("td", { class: "num", title: "Observational: unfilled USD × days open (≤90) × proximity. Not a reward." }, fmtScore(r.score)),
      el(
        "td",
        {},
        book.pool.source !== "mainnet-snapshot"
          ? el("span", { class: "hint" }, r.owner)
          : r.openedSignature
            ? el("a", { href: solscan("tx", r.openedSignature), target: "_blank", rel: "noopener", title: `Transaction that opened this order (owner ${r.owner}). The order may have been cancelled or filled since the snapshot.` }, "open tx ↗")
            : el("a", { href: solscan("account", r.id), target: "_blank", rel: "noopener", title: `Order account (owner ${r.owner}). It closes when the order is cancelled.` }, "account ↗"),
      ),
    );
  const asks = [...book.asks].reverse().map(row); // furthest ask on top, nearest just above the reference
  const sep = el("tr", { class: "sep" }, el("td", { colspan: 9 }, `DAMM v2 reference ${fmtPrice(book.pool.refPrice)} ${book.pool.tokenY}/${book.pool.tokenX} · band ≥ ±${(book.bandWidth * 100).toFixed(2)}%`));
  const bids = book.bids.map(row);
  const empty = (txt) => el("tr", {}, el("td", { colspan: 9, class: "hint" }, txt));
  return [head, el("tbody", {}, asks.length ? asks : empty("No asks in this dataset."), sep, bids.length ? bids : empty("No bids in this dataset."))];
}

// ---------------------------------------------------------------- preview
let previewSeq = 0;
function wirePreview() {
  const form = $(".preview");
  const segs = form.querySelectorAll(".seg button");
  segs.forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.side === state.side));
    b.onclick = () => {
      state.side = b.dataset.side;
      segs.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      updatePreview();
    };
  });
  form.oninput = updatePreview;
  form.onsubmit = (e) => e.preventDefault();
  updatePreview();
}

async function updatePreview() {
  const form = $(".preview");
  if (!form) return;
  const p = state.book.pool;
  const dist = Number(form.dist.value) / 100;
  const price = state.side === "bid" ? p.refPrice * (1 - dist) : p.refPrice * (1 + dist);
  $(".dist-out", form).textContent = `${state.side === "bid" ? "−" : "+"}${(dist * 100).toFixed(1)}% → ${fmtPrice(price)}`;
  const seq = ++previewSeq;
  const out = $(".preview-out");
  try {
    const r = await getJson(`/api/preview?source=${state.source}&id=${encodeURIComponent(p.id)}&side=${state.side}&price=${price}&sizeUsd=${Number(form.size.value) || 0}&days=${Number(form.days.value) || 0}`);
    if (seq !== previewSeq) return;
    const row = (k, v) => el("div", { class: "row" }, el("span", {}, k), el("span", { class: "num" }, v));
    out.replaceChildren(
      row("Order price", `${fmtPrice(r.price)} ${p.tokenY}/${p.tokenX}`),
      row("Status now", STATUS_LABEL[r.status]),
      row(state.side === "bid" ? "Arb could fill once ref ≤" : "Arb could fill once ref ≥", fmtPrice(r.arbTriggerRefPrice)),
      row("Move needed from today", fmtPct(r.arbTriggerRefPrice / p.refPrice - 1)),
      row(`Score after ${r.horizonDays}d, unfilled`, fmtScore(r.scoreAtHorizon)),
      ...r.warnings.map((w) => el("div", { class: "warn" }, w)),
    );
  } catch (e) {
    if (seq === previewSeq) out.replaceChildren(el("div", { class: "warn" }, e.message));
  }
}

// ---------------------------------------------------------------- evidence tab
async function renderEvidence() {
  const ev = await getJson("/api/evidence");
  const page = $("#tab-evidence");
  const cards = [];
  if (ev.stageA) {
    const a = ev.stageA;
    cards.push(
      el(
        "section",
        { class: "card" },
        el("div", { class: "card-head" }, el("h3", {}, `Stage A on devnet: ${a.verdict} (${a.assertions} assertions)`), el("span", { class: "hint" }, `net cost ${a.solSpent ?? "–"} SOL`)),
        el("p", { class: "hint" }, "An atomic DAMM v2 → DLMM arbitrage filled a resting DLMM bid between wallets we controlled. Devnet only; not mainnet evidence."),
        el(
          "table",
          {},
          el(
            "tbody",
            {},
            a.steps.map((st) =>
              el(
                "tr",
                {},
                el("td", {}, st.name),
                el("td", {}, st.signature ? el("a", { href: `https://explorer.solana.com/tx/${encodeURIComponent(st.signature)}?cluster=devnet`, target: "_blank", rel: "noopener" }, `${st.signature.slice(0, 8)}… ↗`) : st.status),
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (ev.b0) {
    const c = ev.b0.census ?? {};
    const f = ev.b0.forensics ?? {};
    const kv = (k, v) => el("tr", {}, el("td", {}, k), el("td", {}, v));
    cards.push(
      el(
        "section",
        { class: "card" },
        el("div", { class: "card-head" }, el("h3", {}, "Stage B0: read-only mainnet observation"), el("span", { class: "hint" }, fmtTime(ev.b0.takenAt))),
        el("p", { class: "hint" }, "About other people's pools, observed without signing or sending anything. Full report: ", ev.b0.report),
        el(
          "table",
          {},
          el(
            "tbody",
            {},
            kv("Limit-order accounts on mainnet", c.limitOrderAccounts ?? "–"),
            kv("DLMM pools holding them", c.poolsWithOrders ?? "–"),
            kv("Pools with a DAMM v2 pair", c.pairsWithDammV2 ?? "–"),
            kv("Pairs with a DBC-authority DAMM v2 pool", c.pairsWithDbcAuthorityDammV2 ?? "–"),
            kv(`Order fills seen (${f.poolsExamined ?? "–"} pools sampled${f.complete === false ? ", partial run" : ""})`, f.orderFills ?? "–"),
            kv("…of which third-party DAMM v2 → DLMM arbitrage", f.thirdPartyArbOrderFills ?? "–"),
          ),
        ),
        f.arbFills?.length
          ? el(
              "div",
              {},
              el("h4", {}, "Third-party arbitrage fills (mainnet, other people's orders)"),
              el(
                "table",
                {},
                el(
                  "tbody",
                  {},
                  f.arbFills.map((x) =>
                    el(
                      "tr",
                      {},
                      el("td", {}, x.blockTime ? fmtTime(new Date(x.blockTime * 1000).toISOString()) : "–", el("span", { class: "hint" }, ` · DLMM ${shortAddr(x.lbPair)}`)),
                      el("td", {}, el("a", { href: solscan("tx", x.signature), target: "_blank", rel: "noopener" }, `${x.signature.slice(0, 8)}… ↗`)),
                    ),
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  }
  cards.push(
    el(
      "section",
      { class: "card" },
      el("div", { class: "card-head" }, el("h3", {}, "Not yet shown")),
      el(
        "ul",
        { class: "plain" },
        el("li", {}, el("strong", {}, "Stage B has not run. "), "No order of ours has been placed or filled on mainnet."),
        el("li", {}, "Third-party bots filling a new, small, thin pool like ours (B0 saw them only in existing pools)."),
        el("li", {}, "How long after the reference crosses an order a bot fills it."),
        el("li", {}, "Keeper economics at small order sizes."),
        el("li", {}, "Any funding or payout for the conviction score. It is observational only."),
      ),
    ),
  );
  page.replaceChildren(el("div", { class: "evgrid" }, ev.stageA || ev.b0 ? cards : el("p", { class: "empty" }, "No evidence file. Run `npm run data`.")));
}

// ---------------------------------------------------------------- wiring
document.querySelectorAll(".source button").forEach((b) =>
  b.addEventListener("click", () => {
    state.source = b.dataset.source;
    document.querySelectorAll(".source button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    state.selected = null;
    loadPools().catch(showError);
  }),
);
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    for (const t of ["book", "evidence", "about"]) $(`#tab-${t}`).hidden = t !== b.dataset.tab;
    if (b.dataset.tab === "evidence") renderEvidence().catch((e) => $("#tab-evidence").replaceChildren(el("div", { class: "warn" }, `Could not load evidence: ${e.message}`)));
    syncUrl();
  }),
);
$("#pool-search").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderPoolList();
});
$("#dbc-only").addEventListener("change", (e) => {
  state.dbcOnly = e.target.checked;
  renderPoolList();
});

function showError(e) {
  $("#detail").replaceChildren(el("div", { class: "warn" }, `Could not load data: ${e.message}. Is the server running (npm run app) and has \`npm run data\` been run?`));
}

// Deep links: ?source=demo&pool=<id>&tab=evidence|about
const params = new URLSearchParams(location.search);
if (params.get("source") === "demo") {
  state.source = "demo";
  document.querySelectorAll(".source button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.source === "demo")));
}
state.selected = params.get("pool");
loadPools().catch(showError);
const tab = params.get("tab");
if (tab) document.querySelector(`.tabs button[data-tab="${CSS.escape(tab)}"]`)?.click();
