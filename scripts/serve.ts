// Local demo server for the Conviction Book. Serves web/ and a small JSON API computed by
// src/book.ts from the files in web/data/. It makes no RPC calls, holds no keys, and
// cannot sign or send transactions. Binds to 127.0.0.1 only.
//
//   npm run app            # http://127.0.0.1:5173  (PORT to override)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildBook, previewOrder, type PoolSnapshot, type Side } from "../src/book.js";

const ROOT = path.resolve("web");
const DATA = path.join(ROOT, "data");
const PORT = Number(process.env.PORT ?? 5173);
const SOURCES = { "mainnet-snapshot": "mainnet-snapshot.json", demo: "demo.json" } as const;
type SourceKey = keyof typeof SOURCES;

interface Dataset {
  source: SourceKey;
  label: string;
  takenAt: string;
  referencePriceAt: string;
  caveats: string[];
  evidence: Record<string, string | null>;
  pools: PoolSnapshot[];
}

// Re-read on each request so `npm run data` takes effect without a restart. Files are small.
function load(source: SourceKey): Dataset | null {
  const f = path.join(DATA, SOURCES[source]);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function api(url: URL, res: http.ServerResponse) {
  const sourceParam = url.searchParams.get("source") ?? "mainnet-snapshot";
  if (url.pathname === "/api/evidence") {
    const f = path.join(DATA, "evidence.json");
    return send(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {});
  }
  if (!(sourceParam in SOURCES)) return send(res, 400, { error: `unknown source ${sourceParam}` });
  const ds = load(sourceParam as SourceKey);
  if (!ds) return send(res, 404, { error: `no data for ${sourceParam}; run \`npm run data\`` });

  if (url.pathname === "/api/pools") {
    return send(res, 200, {
      source: ds.source,
      label: ds.label,
      takenAt: ds.takenAt,
      referencePriceAt: ds.referencePriceAt,
      caveats: ds.caveats,
      evidence: ds.evidence,
      pools: ds.pools.map((p) => {
        const b = buildBook(p);
        return {
          id: p.id,
          name: p.name,
          tokenX: p.tokenX,
          tokenY: p.tokenY,
          dbcOrigin: p.dbcOrigin,
          refPrice: p.refPrice,
          refFeeBps: p.refFeeBps,
          dlmmBaseFeeBps: p.dlmmBaseFeeBps,
          binStep: p.binStep,
          lbPair: p.lbPair ?? null,
          dlmmActivePrice: p.dlmmActivePrice,
          orders: b.totals.orders,
          bidUsd: b.totals.bidUsd,
          askUsd: b.totals.askUsd,
          openBids: b.totals.openBids,
          openAsks: b.totals.openAsks,
          unpricedBids: b.totals.unpricedBids,
          unpricedAsks: b.totals.unpricedAsks,
          medianDaysOpen: b.totals.medianDaysOpen,
          hasFills: Object.keys(p.activity?.orderFillsByClass ?? {}).length > 0,
        };
      }),
    });
  }
  const pool = ds.pools.find((p) => p.id === url.searchParams.get("id"));
  if (url.pathname === "/api/book") {
    return pool ? send(res, 200, buildBook(pool)) : send(res, 404, { error: "pool not found" });
  }
  if (url.pathname === "/api/preview") {
    if (!pool) return send(res, 404, { error: "pool not found" });
    const side = url.searchParams.get("side") as Side;
    if (side !== "bid" && side !== "ask") return send(res, 400, { error: "side must be bid or ask" });
    try {
      return send(res, 200, previewOrder(pool, side, Number(url.searchParams.get("price")), Number(url.searchParams.get("sizeUsd") ?? 0), Number(url.searchParams.get("days") ?? 30)));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }
  return send(res, 404, { error: "unknown endpoint" });
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "read-only server: GET only" });
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith("/api/")) return api(url, res);
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => console.log(`Conviction Book: http://127.0.0.1:${PORT}  (local only; no RPC, no keys, no transactions)`));
