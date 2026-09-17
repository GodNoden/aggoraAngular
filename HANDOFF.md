# Handoff: where the Aggora dashboard stands and what is not working

Written for whoever picks this up next, including a future me. It is deliberately blunt about
what is verified and what is not, because a lot of time was lost here to confident claims that
turned out to be about the wrong thing.

## The one-line version

**The dashboard works, and the bug that made it hang is found, explained, fixed and verified in a
real browser.** It was a single line: an `effect()` in `SeriesHistoryService` that read its own
signal and wrote to it, so it re-scheduled itself for ever and never gave the main thread back. The
network, the gateway, the WebSocket, the proxy and CORS were never the problem.

## The bug, with the evidence

### What was happening

The page painted its header and every panel stayed on `loading` for ever. The traces showed the
first request going out and coming back `200`, and then the page stopped. On this machine that
happened on a fresh load *and* on reload, in headless **and** in a real windowed browser.

### How it was found (and how to do it again)

The old handoff said the missing measurement was: *when the page is stuck, is
`/api/metrics?panel=pulso` `pending` or `200`?* With the tooling below the answer came out as:
**`200`, and the page never asks for the next panel** — the bridge logs the request, answers it, and
the app does nothing with it. That already rules the network out.

The decisive measurement was different: **the renderer was blocked, not waiting**. A second tab in
the same browser answered `Runtime.evaluate` in 2 ms while the dashboard's tab never answered, even
30 s later. A blocked renderer means a synchronous loop in the page, so the search moved into the
app. Bisecting by service (`?solo=`) and then by component showed:

| what was on | what happened |
|---|---|
| `?solo=live` (sockets only) | responds |
| `?solo=analytics` | responds |
| `?solo=metrics` (catalog only) | **blocks the thread** |
| `?solo=metrics&ver=pulso` / `lag` / `transacciones` | responds |
| `?solo=metrics&ver=particiones` / `descartes` / `salud` | **blocks** |

The three panels that blocked were exactly the ones that inject `SeriesHistoryService`. Reducing its
`effect()` to variants settled it:

| effect body | result |
|---|---|
| `void this.metrics.panels()` (read the trigger only) | responds |
| read `panels()`, write `historial` | responds |
| **read `historial()`, write `historial`** | **blocks** |

### The fix

`src/app/core/series-history.service.ts` keeps the last value per series in a plain (non-signal)
map, `ultimos`, which is what the effect consults. The effect's only reactive dependency is
`panels()`, the thing that should trigger it. No `untracked()` needed, no extra machinery, and the
service also exposes `vueltasDelEfecto` so a runaway effect is visible.

The regression spec (`series-history.service.spec.ts`) pins it down: it asserts the effect runs
**exactly once** per metrics change. It was verified the honest way — reintroducing the bug makes it
fail (`Expected 2 to be 1`), restoring the fix makes it pass.

There was a **second, smaller bug** found on the way: `?diag=1` wrote its report by hand into the
DOM from `ngAfterViewChecked`, and in this Angular version **that hook can stop firing while the
view keeps refreshing** (measured: the page clock advanced every second, `ngDoCheck` stayed at 2).
The report froze at the boot state, which is *exactly* what made the first bug look like "the app
never asks for anything". It is now a signal rendered by the template, so it cannot desynchronise.

### The traces that were misleading, and why

- `curl` returning 200 from WSL says nothing about the browser: it never was a network question.
- **"The cycle always stops after exactly five requests" was this bug, not a connection cap.** The
  old notes treated it as a limit being hit. Reading the bridge log by cycles, every cycle was
  `pulso` (Spring), `pulso` (Quarkus), `/analytics`, `pulso` again and `lag`, and then silence. The
  sequence is the app working normally and then dying at a fixed point: the response for `pulso`
  arrives, the effect fires for the first time and loops for ever, and `lag` is simply the last
  request that had already gone out when the thread was taken away. Nothing was ever "capped"; the
  page was gone.
- A single `--dump-dom` run samples the page at an arbitrary moment; it showed the app "stuck" when
  it had simply not been given time. Use `npm run diag:browser`, which waits and reloads.
- `?diag=1` froze at boot for its own reason (bug 2 above), so it reported "12 panels loading" while
  the panels were actually fine. A broken diagnostic is worse than no diagnostic.

## What this front end consumes from the backend, exactly

This is the part a newcomer needs before writing any code. All of it is **read-only**: GET and
WebSocket only, there is no write endpoint anywhere in the contract.

### 1. The live channel: one WebSocket per stack

`ws://<host>:8089/ws` (Spring) and `ws://<host>:8189/ws` (Quarkus). One JSON per frame, no STOMP,
no subprotocol. Every message carries the same envelope: `v` (contract version, currently 1),
`kind`, `stack` (`spring` / `quarkus`) and `ts` (ISO-8601 UTC).

Three kinds of message:

```json
{"v":1,"kind":"snapshot","stack":"spring","ts":"...","ticksIn":35,"ticksOut":7,
 "symbols":{"EUR/USD":{"price":"1.1509","currency":"USD","size":166,
                       "source":"SYNTHETIC","at":"..."}}}
```

- `snapshot`: **once per second**. `ticksIn` is how many ticks were consumed from Kafka during
  that second; `symbols` is only the **last value per symbol**, never a list. A symbol that stops
  ticking keeps its last price. The difference between `ticksIn` and the number of symbols is what
  the per-second summary saves the page.
- `position`: immediately, per account and symbol. `quantity` is a number; `averageCost`,
  `realizedPnl` and `exposure` are **strings**, because they are Avro decimals and money is not a
  float. `marginBreach` is the margin warning.
- `alert`: immediately. `severity` is `CRITICAL`, `WARNING` or `INFO`; `type`, `subject`, `detail`
  and `value` describe it.

Two rules that shape the design: it is a **fan-out with no replay**, so a slow client misses
messages and recovers with the next snapshot (do not treat it as a log), and it is the only
per-second channel, so any moving window has to be built by the page from the snapshots it
receives.

### 2. The metrics catalog: closed, one panel per request

`GET /api/metrics?panel=<name>` on each gateway. The panel name is the only input: **there is no
free PromQL**, so the page cannot ask Prometheus anything else. Seven panels:

| Panel | `label` per series | What it means |
|---|---|---|
| `pulso` | `entrada`, `salida-spring`, `salida-quarkus` | ticks/s into `market.ticks.raw` and out of the canonical topics |
| `lag` | consumer group name | how far behind each group is (`ingestion-normalizer`, `-q`, `analytics-streams`, `-q`) |
| `particiones` | `topic/partition` | current offset of every partition: the log advancing |
| `descartes` | `topic/partition` | offsets of the DLT and retry topics: what could not be processed |
| `salud` | target, `stack/service`, `under-replicated/<topic>` | Prometheus `up`, the Kafka Streams engine per stack, under-replicated partitions |
| `transacciones` | — | **always empty plus a `nota`**: that counter does not exist in this Prometheus |
| `comparativa` | `spring/...`, `quarkus/...` | needs `&de=<panel>`; returns both stacks' series side by side |

Response shape:

```json
{"panel":"lag","ts":"...","stack":"spring",
 "series":[{"label":"ingestion-normalizer","points":[[1789659200,-3.0]]}]}
```

- `points` is `[epoch seconds, value]`. Today each series carries **one point** (instant query);
  the shape already allows several. To draw a line the page has to keep its own short history of
  those points as it polls.
- `nota` appears **only** when `series` is empty, explaining why. Never invent a series.
- The value can be **negative** (`lag` did return `-3`), and that is not an error.
- A panel name that is not in the catalog returns 400 with `{"error":"panel desconocido: X",
  "detalle":[...]}`; Prometheus being down returns 502.

### 3. The interactive query: the state store

`GET /analytics?symbol=EUR/USD&minutes=3` on the analytics service (`:8085` Spring, `:8185`
Quarkus). This is the only thing the user asks for explicitly, and it returns a **bare JSON
array** of computed windows (the contract documents the URL but not this shape):

```json
[{"symbol":"EUR/USD","currency":"USD","windowKind":"TUMBLING",
  "windowStart":"...","windowEnd":"...","ticks":150,"volume":38689,
  "vwap":1.1551,"movingAverage":1.1550,"volatility":0.0038,"lastPrice":1.1590}]
```

One entry per time window, newest last. This is the *state store* view: VWAP and volatility are
computed by the stream, not by the page.

### 4. Health

`/actuator/health` (Spring, on `:8080` for the simulator) and `/q/health` (Quarkus). Useful to
distinguish "the process is up" from "the engine inside it is working": in lesson 5 the process
stays up while the stream engine is dead, and the probe is what says so.

### 5. What the backend does NOT provide

- No committed/aborted transaction counts. `transacciones` is empty on purpose and says why.
- No history in the WebSocket and no replay: only the last value per symbol, once per second.
- No per-partition ISR detail beyond an under-replicated count.
- No write endpoint of any kind.

## "It is already in Grafana" — why this dashboard still exists, and what to do about it

The backend agent is right that Prometheus and Grafana already hold all of this. That is not the
same as it being **understandable**, and that is the whole point of this front end. Grafana answers
"what is the value of this series over time" for somebody who already knows what the series means.
This dashboard has to answer a different question: **"what is the pipeline doing right now, and
what would it look like if it were broken?"**

That difference has practical consequences, and they are the reason Grafana does not replace it:

- **Grafana gives you series; this gives you a story.** The valuable content is not the chart, it
  is the sentence next to it: *"two lines that rise and fall together mean the normalizer keeps up;
  if the input rises and the output does not, it fell behind"*. That text is the product.
- **Grafana does not know about the lessons.** Turning a broker off, sending a poison pill, forcing
  a rebalance: the dashboard should say which panel to watch and what should change, and what
  should *not* change (in lesson 1 the lag does not move, and that is the lesson).
- **The catalog is deliberately small.** The backend exposes seven panels precisely so the page
  cannot wander off into arbitrary queries. The front end should honour that instead of trying to
  become a Grafana clone.
- **Empty is information.** `transacciones` returning `series: []` with a `nota` is a hole in the
  environment being admitted. A Grafana panel shows "No data"; this dashboard should say why, and
  refuse to fill it in.

If the goal is a visual explanation of the backend, the work is **90% editorial and 10% charts**.
The charts here are hand-written SVG polylines for that reason: they are the smallest part.

## Environment notes that still apply

- The repository lives in **WSL**; the browser can run on **Windows**. `localhost` is not the same
  host on both sides, which is why the app talks to **its own origin** and the server proxies:
  `proxy.conf.json` in development, `tools/serve-verify.mjs` for the compiled build.
- There is **no Chrome in WSL and none on Windows** any more. Edge is used, and everything (Karma,
  the live check, the browser diagnostics) finds it through `tools/`.
- **The browser's debug port on Windows is not reachable from WSL.** WSL2 forwards `localhost` one
  way only (Windows → WSL). `tools/tcp-relay.mjs` bridges it with a PowerShell pipe, which is what
  makes `npm run diag:browser` work from this side.
- **Do not conclude anything from a single headless run.** `--dump-dom` in particular returns
  before the page has done its work.

## How to look at it now

```bash
npm run build
npm run serve:built        # serves the build and proxies /api, /q, /analytics, /actuator and the WebSockets on :4300
```

Open `http://localhost:4300/?diag=1`. The page prints its own report at the bottom (panel states,
socket states, and the raw network probe that runs before Angular). Useful switches:

| switch | what it does |
|---|---|
| `?diag=1` | shows the diagnostics block |
| `?nodiag=1` | turns the diagnostics repaint off |
| `?solo=live\|metrics\|analytics` | starts a single service (this is how the bug above was isolated) |
| `?verify=1` | in-page PASS/FAIL verification report against the live backend |

And the full browser diagnosis, console and Network tab included, from WSL:

```bash
npm run diag:browser                     # serves, launches Edge, relays CDP, navigates, reloads, reports
node tools/browser-diag.mjs --fase=15000 --url=http://localhost:4300/?diag=1
```

It prints the app's own report after 3/6/9 s, the `[aggora]` console lines, every HTTP response and
every network failure, then reloads the same tab and does it again. That is the evidence this
repository was missing for hours.

## What is verified

- `ng build` green. `npm test` green: **76 specs**. (Karma may report a bigger number because it
  adds up connections from more than one browser; `tools/run-tests.mjs` reports the real size.)
- In a real browser against the live backend, measured with `npm run diag:browser`:
  - fresh session: **12 panels `ok`, 2 `empty`** (`transacciones` on purpose), both sockets `open`,
    the page clock ticking once per second, ~133 WebSocket messages parsed in 9 s;
  - **reload behaves exactly like a fresh session** (the same 12/2 within 3 s);
  - the panels converge and stay converged, and the catalog answers 200 for both stacks.
- The regression spec fails if the bug is reintroduced (`Expected 2 to be 1`), so it is a real
  guard and not decoration.

## What is still open (not bugs, choices)

1. **`ngDoCheck` / `ngAfterViewChecked` on the root component did not run** in this Angular version
   while the view kept refreshing. The app no longer depends on them for anything (the diagnostics
   use the page clock), but if you plan to add lifecycle logic to `App`, measure it first: a
   `console.info` in the hook plus `npm run diag:browser` settles it in a minute. A minimal
   reproduction would be worth filing.
2. **The dev server** (`ng serve`, `proxy.conf.json`) was not re-verified after the fix. The demo
   path is the compiled build behind `serve:built`. If you use `ng serve`, check that the panels
   fill before trusting it.
3. **The Quarkus analytics URL in production** is hardcoded to `http://localhost:8185`
   (`environment.production.ts`), which is cross-origin and will not work behind a tunnel. Leave it
   empty or point it at the published origin before publishing.
4. **No authentication.** CORS is not authentication: `curl` reads every endpoint. See the README.

## What was changed, and which bugs were real

Real bugs found and fixed, each with a spec where it made sense:

1. **`SeriesHistoryService`'s effect read and wrote its own signal**, blocking the main thread for
   ever. This is the bug in the one-line version at the top. Fixed with a non-signal map
   (`ultimos`), plus a spec that fails if it comes back.
2. **`?diag=1` depended on `ngAfterViewChecked`**, which stopped firing while the view kept
   refreshing, so the report froze at the boot state and hid bug 1. The report is now a signal
   rendered by the template.
3. `provideHttpClient()` was missing in `app.config.ts`: the app never bootstrapped and showed a
   black page.
4. `metricsUrl` appended `/api` on top of the gateway path and produced `/api/api/metrics`.
5. `analyticsUrl` produced `/analytics/analytics` (seen in the browser console as a 404).
6. No timeouts anywhere. Now: 10 s per request, 8 s WebSocket handshake watchdog, hung poll cycles
   discarded, every error message carries the endpoint.
7. The diagnostics never painted: the probe script runs in `<head>`, before `<body>` exists, so
   `document.body.appendChild` threw and its own `try/catch` swallowed it.
8. The test runner lied twice: Karma exits 1 here with everything green, and it adds up the counts
   of several browser connections. `tools/run-tests.mjs` decides from the test summary instead.
9. Three bugs in `tools/serve-verify.mjs`: it did not rewrite the path before forwarding, it
   forwarded the upstream's `Connection` and `Transfer-Encoding` headers, and it did not send
   `Content-Length`.

### What not to repeat

- Do not debug a blocked page through `--dump-dom` or a single headless run; use
  `npm run diag:browser`, which waits and reads the app's own report.
- Do not write the DOM by hand from a lifecycle hook. Use a signal and a template binding.
- **Never read a signal inside the effect that writes it.** If the effect needs its own state, keep
  it in a plain field.
- Do not let a diagnostic swallow its own error (the probe did, for hours).
- Do not add panels the catalog does not have, and do not fill in a panel that came back empty.

## What is genuinely good in here, if you start over

- `core/contract.ts` and `core/contract.parser.ts`: the whole contract typed, and a parser that
  never throws, says which field failed, and normalises unknown severities. The specs around it
  are the most valuable thing in the repo.
- `core/live.service.ts`: one socket per stack, increasing backoff, 60-point moving window,
  handshake watchdog, signals.
- `core/metrics.service.ts`: the closed catalog, the `nota` preserved verbatim, empty versus
  error, per-request timeout, hung-cycle discard.
- `core/series-history.service.ts`: the moving window, with the trap documented in the header so
  nobody repeats it.
- `core/panel-docs.ts` and `core/lessons.ts`: the plain-language explanation of every panel and
  the five lessons. That content is the point of the dashboard and is not tied to any framework.
- `core/urls.ts`: the `https → wss` rule and relative-versus-absolute bases, with specs.
- `tools/`: `serve-verify.mjs` (one-origin bridge), `browser-diag.mjs` + `cdp.mjs` + `tcp-relay.mjs`
  (real browser, real console, real Network tab, from WSL), `dump-dom.mjs` (quick DOM dump),
  `run-tests.mjs` (an honest exit code).
