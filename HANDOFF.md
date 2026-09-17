# Handoff: where the Aggora dashboard stands and what is not working

Written for whoever picks this up next, including a future me. It is deliberately blunt about
what is verified and what is not, because a lot of time was lost here to confident claims that
turned out to be about the wrong thing.

## The one-line version

The dashboard is complete and tested, but in **this machine's environment** the page hangs on
reload while fetching its panels, and that is not solved. A fresh browser session against the
production build fills the panels correctly (traces show `respuesta OK pulso spring` and the
next request going out); a **reload** stops getting answers.

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

## How to approach a rebuild

Do these in order. The first one is not optional, and it is where this attempt lost its way.

1. **Decide and pin down the origin before writing any code.** This is the mistake that cost the
   most time. This repo lives in WSL and the browser runs on Windows, so `localhost` is not the same
   host on both sides, and the front end must either be served by the same server as the API or
   have a proxy in front of both. Pick one and verify it with a plain `fetch` from the browser
   before building anything:
   - simplest and closest to production: **serve the static build from the gateway's own origin**
     (or a reverse proxy in front of both), so every request is same-origin and CORS never enters
     the picture;
   - acceptable: a dev proxy, but then confirm the proxy returns bodies the browser can read, and
     check it with the Network tab rather than with `curl`.
   Write that decision into the repo README before the first component.
2. **Build the data layer first, and prove it in a real browser.** One module that fetches the
   catalog, one that opens the sockets, both with timeouts. Before any styling, open a page that
   prints the raw values on screen. If the values do not arrive at this point, nothing else matters.
   Do not debug this through headless runs on this machine (see above): ask a human to read the
   console and the Network tab.
3. **Then the panels, one at a time, each with its sentence.** Pulse first, then lag, then dead
   letters, then health. For each one, write the "what you are seeing" and "why it matters" text
   *before* the component; that text is the deliverable.
4. **Lesson mode last**, and only as a reader: the page never runs anything on the backend. A card
   per lesson with the command to copy, the panel to watch and what should change.
5. **Keep the honest states from the start**: loading with a limit, empty with the backend's note,
   error with the endpoint that failed. A dashboard that waits for ever cannot tell "slow" from
   "gone", and that is half the job.

### What to keep from this attempt

Even if the UI is thrown away, these are worth reading first, because they encode the contract and
its traps and are not tied to any framework:

- `src/app/core/contract.ts` and `contract.parser.ts`: the whole contract typed, and a parser that
  never throws and names the field that failed.
- `src/app/core/panel-docs.ts` and `lessons.ts`: the plain-language content.
- `src/app/core/live.service.ts`: sockets with increasing backoff, a 60-point window and a handshake
  watchdog.
- `src/app/core/metrics.service.ts`: the closed catalog, `nota` preserved, empty versus error.
- `src/app/core/urls.ts`: the `https → wss` rule and relative-versus-absolute bases.

### What not to repeat

- Do not build the whole UI before proving one request arrives in the browser.
- Do not trust a single headless run on this machine.
- Do not let a diagnostic swallow its own error (the probe did, for hours).
- Do not add panels the catalog does not have, and do not fill in a panel that came back empty.

## What is verified

- `ng build` green. `npm test` green: **71 specs**.
- The app boots and renders: header, seven panels, lesson mode, stack selector. Verified in a
  real browser.
- The network is fine. Measured from inside the browser (the probe in `index.html` paints its
  own block):
  - same origin, `/api`, `/q/api`, `/analytics` through the proxy: **HTTP 200** in 100-400 ms.
  - WebSocket: **opens** in ~250 ms.
- The backend answers: Spring 8089/8085/8080 and Quarkus 8189/8185 all return 200 when asked
  with `curl`, from WSL and from Windows.
- The fetch traces in the app show, in a fresh session: request out, response 200, body read,
  next panel requested. Panels fill one after another.
- `tools/serve-verify.mjs` logs every request and every response with its size, which is what
  finally showed that the gateway answers all of them.

## What is NOT working

**Reloading the page leaves the panels in `loading`.** The requests go out and the bridge logs
them and answers 200, but the page does not get the responses. Not solved.

Things ruled out, with measurements rather than reasoning:

- **Not the backend.** Every endpoint returns 200 by `curl`, and the WebSocket handshake works.
- **Not CORS.** Everything is same-origin through the proxy; the only CORS failures are probes
  that call the backend directly, which is expected and is noise.
- **Not a change-detection loop.** The counter in `?diag=1` reads `total=0`, `loop=false`.
- **Not the proxy under load.** Fourteen concurrent requests through it return 200 in 0.4 s
  (tested repeatedly).
- **Not `HttpClient` alone.** It never settled (measured: `fetch` 200 in 154 ms, `HttpClient`
  no answer), which is why there is now a `fetch` client. But the app's own `fetch` shows the
  same symptom on reload, so this was a real bug but not the whole story.
- **Not zone.js.** Removed entirely (zoneless) and the symptom stayed.

## What was changed, and which bugs were real

Real bugs found and fixed, each with a spec where it made sense:

1. **`provideHttpClient()` was missing** in `app.config.ts`: the app never bootstrapped and
   showed a black page. The shell spec now builds with the real `appConfig`, so this class of
   bug fails the test.
2. **`metricsUrl` appended `/api` on top of the gateway path** and produced `/api/api/metrics`.
3. **`analyticsUrl` produced `/analytics/analytics`** (seen in the browser console as a 404).
4. **No timeouts anywhere.** A panel could wait for ever, which cannot tell "slow" from "gone".
   Now: 10 s per request, 8 s WebSocket handshake watchdog, hung poll cycles discarded, every
   error message carries the endpoint.
5. **The diagnostics never painted**: the probe script runs in `<head>`, before `<body>` exists,
   so `document.body.appendChild` threw and its own `try/catch` swallowed it.
6. **The test runner lied twice**: Karma exits 1 here with everything green (the Windows browser
   disconnects while the server shuts down) and it adds up the counts of several browser
   connections. `tools/run-tests.mjs` decides from the test summary instead.
7. **Three bugs in `tools/serve-verify.mjs`** which invalidated hours of measurements: it did
   not rewrite the path before forwarding, it forwarded the upstream's `Connection` and
   `Transfer-Encoding` headers (which leaves the browser waiting on a socket that is not its
   own), and it did not send `Content-Length`.

## The environment, which is the hard part

- The repository lives in **WSL**; the browser runs on **Windows**. `localhost` is not the same
  host on both sides, so the app must talk to **its own origin** and the server must proxy.
- The **Angular dev server swallows the responses**: with `ng serve` the panels never fill. That
  is why the demo is served from the production build instead.
- There is no Chrome in WSL and no Chrome on Windows any more (uninstalled on purpose). Edge is
  used, and `karma.conf.js` looks for it.
- **Headless is not trustworthy here.** With `--dump-dom` the same build answers in one run and
  not in the next, while `curl` always works. Do not draw conclusions from a single headless run;
  ask a human to look at the browser console instead. That mistake cost most of the time.

## How to look at it now

```bash
npm run build
npm run serve:built        # serves the build and proxies /api, /q, /analytics, /actuator and the WebSockets on :4300
```

Open `http://localhost:4300/?diag=1`. In the console, the traces tell the story:

- `[aggora] fetch lanzado <url>` — the request went out.
- `[aggora] fetch respondio <url> 200` — the response arrived.
- `[aggora] respuesta OK <panel> <stack> <ms>` — the panel was filled.
- `[aggora] fetch fallo <url> <error>` — it failed, with the URL.

`?diag=1` also prints a block in the page: change-detection cycles, panel states by status,
socket states, messages parsed, discarded cycles, and the raw network probe.

## What I would try next, in order (to fix this attempt)

If the plan is to **rebuild**, go to "How to approach a rebuild" above instead: pinning down the
origin first is the step that was skipped here, and it would have avoided most of this list.

1. **Reproduce it in a real browser and read the Network tab.** Specifically: is
   `/api/metrics?panel=pulso` `pending` or `200`? That single answer splits the problem in two
   and it was never obtained. Everything else was guessing around it.
2. **Explain why the cycle stops after exactly five requests.** From the bridge log, every cycle
   is the same five requests and then silence, never reaching `particiones`:

   ```
   /api/metrics?panel=pulso            -> 200
   /q/api/metrics?panel=pulso          -> 200
   /analytics?...                      -> 200
   /api/metrics?panel=pulso&_t=...     -> 200
   /api/metrics?panel=lag&_t=...       -> 200   <- and the cycle ends here
   ```

   It is deterministic, not random, so there is a concrete limit being hit at five: a browser
   connection cap, something in the bridge, or the page being reloaded mid-cycle. This is the
   sharpest lead available and it is worth starting here.
3. **Reload with the probe disabled.** The probe in `index.html` opens fetches and a WebSocket
   of its own at page load. It is the only thing that runs in the fresh session which does not
   run again on reload in the same way. Remove it and see whether the reload symptom changes.
4. **Serve the app from the backend's origin.** The deployment plan is "one origin, gateway in
   front" anyway. If the page and the API are literally the same server, this whole class of
   problem disappears, and it is what has to happen in production regardless.
5. **Drop the proxy from the picture** by configuring absolute backend URLs and adding
   `http://localhost:4300` to the backend's CORS allowlist (`aggora.ui.allowed-origins`), then
   compare.

## What is genuinely good in here, if you start over

- `core/contract.ts` and `core/contract.parser.ts`: the whole contract typed, and a parser that
  never throws, says which field failed, and normalises unknown severities. The specs around it
  are the most valuable thing in the repo.
- `core/live.service.ts`: one socket per stack, increasing backoff, 60-point moving window,
  handshake watchdog, signals.
- `core/metrics.service.ts`: the closed catalog, the `nota` preserved verbatim, empty versus
  error, per-request timeout, hung-cycle discard.
- `core/panel-docs.ts` and `core/lessons.ts`: the plain-language explanation of every panel and
  the five lessons. That content is the point of the dashboard and is not tied to any framework.
- `core/urls.ts`: the `https → wss` rule and relative-versus-absolute bases, with specs.
