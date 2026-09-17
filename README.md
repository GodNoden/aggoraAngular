# Aggora dashboard

A **read-only** visual dashboard for Aggora, a Kafka event pipeline for market data that is
implemented **twice**: once in Spring Boot and once in Quarkus. This app shows both, side by side.

It is an Angular 20 standalone application. It never writes anything: every endpoint it touches is a
`GET` or a WebSocket, and the backend contract has no write endpoint at all. It is not the source of
truth for any number it displays — Kafka and Prometheus are.

The contract lives in the backend repository: `docs/CONTRACT.md` (short, normative) and
`docs/dashboard.md` (long, with the reasoning).

---

## What it shows

### 1. The live view

| Panel | What you are looking at | Why it matters |
|---|---|---|
| **Pulse** | Ticks per second going into `market.ticks.raw` and coming out of the canonical topics, from the WebSocket **and** from Prometheus | Two lines that move together mean the normalizer keeps up. If the input rises and the output does not, it fell behind |
| **Consumer lag** | How far behind each consumer group is | Near zero and saw-toothing is healthy. Climbing without returning means somebody cannot keep up |
| **Partitions** | The current offset of every partition: the log moving forward | A flat line is a partition nobody writes to; a jump is a burst |
| **Dead letters** | Offsets of the DLT and retry topics | Flat at zero is green. Every step is a message that landed in the DLT |
| **Health** | Prometheus targets, the Kafka Streams engine per stack, under-replicated partitions | Who is alive and who only looks like it. An engine at 0 with the process still up is lesson 5 |
| **Transactions** | Committed vs aborted transactions | **Empty on purpose**, with the backend's note: that counter does not exist in this Prometheus |
| **Side by side** | Any of the above, with its Spring series and its Quarkus series together | The signature of the project. Same shape means the same behaviour |

Every panel carries a plain-language sentence of *what you are seeing* and *why it matters*: this is
meant to be teaching material, not another Grafana board.

The stack selector has **three** positions: Spring, Quarkus, and **Spring + Quarkus** (two columns,
the same data on both sides). The **Side by side panel** dropdown chooses which panel to compare
(`comparativa&de=<panel>`).

### 2. Lesson mode

The five lessons shipped with the backend, each with the **exact command to copy**, which panel to
watch, and what should change:

```bash
bash scripts/leccion-1-broker-caido.sh
bash scripts/leccion-2-veneno-dlt.sh
bash scripts/leccion-3-rebalanceo.sh
bash scripts/leccion-4-exactly-once.sh
bash scripts/leccion-5-streams-muerto.sh
```

They run **from a terminal inside the devcontainer**, never from this page. The page only observes
and narrates, and it says so on screen. Clicking a lesson highlights the panel it talks about.

### 3. Static and publishable

The app compiles to static files, so it can be served from GitHub Pages, Netlify or Vercel. See
[Publishing](#publishing).

---

## Running it

The backend must be up (it runs in a devcontainer with its ports forwarded to the host, so the
browser sees `localhost`). Nothing needs to be started from this repository for the backend to work.

```bash
npm install
npm start          # ng serve on http://localhost:4200
```

CORS on the backend already allows `http://localhost:4200`, so no proxy or extra configuration is
needed in development.

### Adresses

Everything lives in one place: [`src/environments/environment.ts`](src/environments/environment.ts).

| What | Spring | Quarkus |
|---|---|---|
| Live events (WebSocket) | `ws://localhost:8089/ws` | `ws://localhost:8189/ws` |
| Metrics catalog | `http://localhost:8089/api/metrics?panel=<name>` | `http://localhost:8189/api/metrics?panel=<name>` |
| Interactive query | `http://localhost:8085/analytics?symbol=&minutes=` | `http://localhost:8185/analytics?symbol=&minutes=` |
| Health probe | `http://localhost:8080/actuator/health` | `http://localhost:8189/q/health` |

Panels are polled every **5 s** in development and **10 s** in production (`metricsIntervalMs`), not
every second: the metrics catalog is a Prometheus proxy and there is no reason to hammer it. The
WebSocket is the per-second channel.

---

## How it is built

```
src/app/
  core/
    contract.ts              types for the whole contract (the 3 WebSocket messages, the panels)
    contract.parser.ts       defensive parsing: never throws, always says which field failed
    live.service.ts          one WebSocket per stack, reconnection with backoff, 60-point window
    metrics.service.ts       polls the 7 panels, keeps the backend's `nota` when a panel is empty
    analytics.service.ts     the interactive /analytics query (on demand, not in a loop)
    series-history.service.ts short history built from the instant points of the catalog
    urls.ts                  the only place where ws:// vs wss:// is decided
    panel-docs.ts            the "what you are seeing / why it matters" text
    lessons.ts               the five lessons: command, panel, expectation, twist
  charts/                    hand-written SVG line charts (no chart library, no CDN)
  live/                      one component per panel
  ui/                        panel card, metric list, event feed, lesson panel, analytics panel
  verify.ts                  optional in-page verification (?verify=1)
```

Angular's own tools only: **signals**, `HttpClient`, RxJS and forms. No state-management library, no
chart library, no CDN. The charts are `polyline`s and `path`s built by hand.

Three deliberate choices worth calling out:

- **A frame that does not match the contract cannot take the page down.** `parseLiveMessage` returns
  a described failure instead of throwing, and the page shows it. The WebSocket is a fan-out with no
  replay: the next snapshot fixes the gap.
- **Nothing is ever filled in.** If the catalog returns `series: []`, the panel says "no data" and
  repeats the backend's note. No empty charts, no invented numbers.
- **`wss://` is chosen, not written.** `wsBase()` reads the page protocol, because an `https://` page
  cannot open a `ws://` socket. With an empty base it also uses the page's own host, so publishing
  behind a tunnel needs no rebuild.

---

## Tests

```bash
npm test                      # ng test --watch=false (Karma + headless Chrome)
```

The suite covers the parts where a mistake would be invisible until production:

- contract parsing: valid messages, and the invalid ones (missing `ticksIn`, `price` as a number,
  unknown `kind`/`stack`/`severity`, non-JSON frames) which must **fail gracefully**;
- the metrics catalog: a panel with `series: []` plus a `nota` is *empty*, not an error; a 502 or a
  dead gateway is an *error* with the URL in the message; the app warns when the backend breaks its
  own promise (series and note at once, or empty with no note);
- the WebSocket service: the moving window is capped, invalid frames do not enter it, alerts and
  positions accumulate immediately, the socket is closed on `stop()`;
- the URL helpers: `http → ws`, `https → wss`, empty base = page host;
- the shell: it renders, and it boots with the **real** `appConfig` (so a missing provider fails the
  test instead of silently producing a black page).

### Nothing waits for ever

A dashboard that sits on a spinner cannot tell "the backend is slow" from "the backend is
gone", and that difference is half the job. So every waiting state has a limit:

- **Each metrics request has a timeout** (10 s). Past it, the panel switches to an error and
  says which endpoint it called, so the failure can be checked without guessing.
- **Each WebSocket has a handshake watchdog** (8 s). A socket that never opens is closed and
  retried with the same increasing backoff; `connecting` is never a permanent state.
- **A hung poll cycle is discarded**, not left holding the lock. Otherwise one stuck cycle
  would silence every later one and the page would go quiet for ever.
- **Every error message carries the URL.** "HTTP 502 in /api/metrics?panel=salud" is
  actionable; "something failed" is not.
- **A panel that is still waiting past the timeout says `still waiting`**, not `loading`.

The tests cover the timeout path, the stale-cycle path and the URL in the error text, because
these are the behaviours that turn a hang into a diagnosis.

### On this machine (WSL + the Windows Chrome)

There is no Chrome inside WSL. `karma.conf.js` finds the Windows Chrome through WSL interop and
launches it through [`tools/chrome-wsl.sh`](tools/chrome-wsl.sh), which translates the Linux
`--user-data-dir=/tmp/...` argument into a Windows path. Without that translation Chrome starts and
dies with exit code 21, and Karma can only report "Cannot start ChromeHeadless".

```bash
npm test                                  # uses the wrapper automatically
CHROME_BIN=/usr/bin/google-chrome npm test  # native Linux Chrome, if you have one
```

### Live check

With the backend and `npm start` running:

```bash
npm run verify:live                       # checks the app as rendered against the live backend
```

It opens the app in headless Chrome, reads the painted DOM and checks that the app booted, that the
WebSocket is delivering messages and snapshots, that the metrics catalog answered, that the three
stack positions are there, that the lesson commands are on screen and that the empty panel explains
itself. It exits non-zero if anything is off.

For a **full per-check report** there is an in-page verification mode, `?verify=1`, which runs the
same checks from inside the page and prints a PASS/FAIL list. `tools/live-check.ps1` drives it from
the Windows side (that is where Chrome's debug port is reachable); the report is also readable by
hand in the page.

---

## Publishing

`npm run build` writes static files to `dist/aggora-dashboard/browser`. Upload that folder to GitHub
Pages, Netlify, Vercel or any static host.

### The one thing that matters: `https://` forces `wss://`

A page served over HTTPS **cannot** open a `ws://` socket; the browser blocks it as mixed content.
This app already handles it: `wsBase()` picks the scheme from `location.protocol`, so the same build
works locally (`ws://`) and behind TLS (`wss://`). You do not need to write the scheme anywhere.

What you do need is **TLS in front of the gateway** — a tunnel (Cloudflare Tunnel) or a reverse proxy
(Caddy, nginx). Both gateways honour `X-Forwarded-*`, so they behave correctly behind one. The
backend documentation covers the two setups in `docs/dashboard.md`, section 6.

### Pointing the build at your backend

Edit [`src/environments/environment.production.ts`](src/environments/environment.production.ts):

- **Same domain for the app and the gateway** (the usual tunnel/reverse-proxy setup): leave the bases
  as empty strings. The app will use the page's own host for HTTP and WebSocket, so the bundle does
  not hardcode a domain. `/api/metrics` and `/ws` must reach the gateway from that host.
- **Different hosts**: put the full URLs in, e.g. `gateway: 'https://aggora.midominio.com'` and
  `analytics: 'https://aggora-analytics.midominio.com'`.

Two more things have to be true on the backend side, and neither is done from this repository:

1. **Add the public origin to the CORS allowlist.** Spring:
   `aggora.ui.allowed-origins` (comma-separated). Quarkus: `quarkus.http.cors.enabled=true` plus
   `quarkus.http.cors.origins`, or `QUARKUS_HTTP_CORS_ORIGINS`. No `*`: that would let anyone read
   the data. (In Quarkus 3.39.3 the old `quarkus.http.cors=true` is not recognised and CORS is
   silently not applied.)
2. **Publish only the thin edge.** What the dashboard needs is the two gateways (WebSocket + metrics
   catalog) and, at most, the analytics reader. Kafka, Prometheus, Grafana, Postgres and the workers
   stay inside.

### Two honest warnings

- **CORS is enforced by the browser, not by the server.** The allowlist is not authentication:
  `curl` still reads the endpoints. Before publishing for real you want authentication at the edge
  (Cloudflare Access, Caddy `basic_auth`, or whatever proxy you use). There is none today.
- **Serving both stacks is heavy.** If the host is small, publish **one** gateway and turn the other
  stack off. The dashboard's "Spring + Quarkus" column will show a network error for the stack that
  is not published — which is information, not a broken page.

---

## What this dashboard cannot say

- It is not the source of truth. The truth is in Kafka (the topics) and Prometheus (the series). If
  the gateway dies there is no dashboard, but the pipeline keeps running.
- It writes nothing. Every endpoint is read-only.
- It cannot reconstruct the past. The `snapshot` is the **last** value per symbol, not a history, and
  the WebSocket is a fan-out: a slow client misses messages and recovers with the next snapshot. For
  history you ask Prometheus, which already keeps it.
- It cannot promise exactly-once on screen. That belongs to the matching engine and Kafka. The
  `transacciones` panel is empty because the metric does not exist, and it says so.
- It has no authentication. See the warning above.

---

## Verified against the live backend

Checked with both stacks running (Spring on 8089/8085, Quarkus on 8189/8185) and the app on
`http://localhost:4200`:

- `ng build` green; `npm test` green (**64 specs**).
- The app renders with the real backend; the live panels request and receive the catalog for both
  stacks, and `GET /analytics` answers the interactive query.

Live backend answers that differ from the contract text, recorded rather than hidden:

- `GET /analytics` returns a **bare JSON array** of windows (`symbol`, `currency`, `windowKind`,
  `windowStart`, `windowEnd`, `ticks`, `volume`, `vwap`, `movingAverage`, `volatility`,
  `lastPrice`). The contract lists the URL but not this shape; the parser accepts the array (and an
  object with `windows`, by tolerance).
- `comparativa&de=particiones` labels are `spring/market.ticks.canonical` — **aggregated, with no
  partition number** — while the plain `particiones` panel is `topic/partition`. The side-by-side
  comparison is therefore not partition-aligned, and the UI says so.
- `comparativa&de=salud` currently returns only `spring/analytics-streams`; there is no
  `quarkus/...` counterpart, so that comparison has one side. The UI says so.
- `lag` can return a **negative** value (e.g. `analytics-streams` at `-3`). It is shown as-is and not
  treated as an error.
- `salud` returns ~85 series, most of them `under-replicated/prueba.*` leftovers at 0. Those are
  collapsed into a count and only the topics above 0 are listed, so the signal is not buried.

No automatic browser test could drive the Windows Chrome from WSL (the debug port is only reachable
from the Windows side), so the end-to-end check is `npm run verify:live` plus the in-page `?verify=1`
report; both are in this repository.
