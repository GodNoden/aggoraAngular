# Handoff: where the Aggora dashboard stands and what is not working

Written for whoever picks this up next, including a future me. It is deliberately blunt about
what is verified and what is not, because a lot of time was lost here to confident claims that
turned out to be about the wrong thing.

## The one-line version

The dashboard is complete and tested, but in **this machine's environment** the page hangs on
reload while fetching its panels, and that is not solved. A fresh browser session against the
production build fills the panels correctly (traces show `respuesta OK pulso spring` and the
next request going out); a **reload** stops getting answers.

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

## What I would try next, in order

1. **Reproduce it in a real browser and read the Network tab.** Specifically: is
   `/api/metrics?panel=pulso` `pending` or `200`? That single answer splits the problem in two
   and it was never obtained. Everything else was guessing around it.
2. **Reload with the probe disabled.** The probe in `index.html` opens fetches and a WebSocket
   of its own at page load. It is the only thing that runs in the fresh session which does not
   run again on reload in the same way. Remove it and see whether the reload symptom changes.
3. **Serve the app from the backend's origin.** The deployment plan is "one origin, gateway in
   front" anyway. If the page and the API are literally the same server, this whole class of
   problem disappears, and it is what has to happen in production regardless.
4. **Drop the proxy from the picture** by configuring absolute backend URLs and adding
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
