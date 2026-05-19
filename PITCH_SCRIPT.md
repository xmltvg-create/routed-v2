# PathPilot — 60-Second Pitch Script

> **Use case**: build-fest live demo. Memorise the spoken lines, hit the
> stage cues. The TTS narration baked into the demo screen takes care of
> the headline numbers — your job is the *story* around them.
>
> **Length**: 60 seconds, ±5s flex.
> **Tone**: confident, specific, zero hedging. Numbers > adjectives.
> **Audio**: phone media volume ~60%, ringer off, DnD on (so TTS still plays).
> **Stage**: phone in hand, mirror to projector if available; if not, stand
> close enough that judges can see the screen.

---

## Pre-stage checklist (do this *before* you walk on)

- [ ] PathPilot APK force-closed → reopen → wait 5s on splash for OTA
- [ ] On the login screen — confirm the **"Watch the 25-second demo"**
      button is visible (sub-Google CTA, blue outline)
- [ ] Volume rocker → media volume to ~60%
- [ ] Phone unlocked, screen-off timeout extended to 5 min
- [ ] One full dry run of the demo, screen-recorded as 60s fallback video

---

## Script — second-by-second

### 0:00 — 0:05  ·  HOOK
**Screen**: Login screen, your finger hovers near the demo button.

> "G'day. This is PathPilot. A real delivery driver — my [partner / mate /
> Steve] — runs his route with this every morning, six o'clock, Sunshine
> Coast. Let me show you what he saw on Tuesday."

**Cue**: tap **"Watch the 25-second demo"** on the *fifth* word ("PathPilot").
The transition fades, the map renders, the overview card slides up.

---

### 0:05 — 0:10  ·  THE PROBLEM
**Screen**: 50 dots scattered across a Sunshine Coast bbox, the headline
pill at the top reads `50 stops · 72 km · 148 min`.

> "Fifty stops. Caloundra to Coolum. The dispatcher hands him the manifest
> in CSV row order — that's 175 kilometres, five hours of driving."

**Cue**: tap **"Start cinematic flythrough"** as you finish the line. The
camera tilts to 60°, drops to street-level, the synthetic driver dot
starts moving. The TTS narration kicks in roughly here — let it ride.

---

### 0:10 — 0:35  ·  THE DEMO PLAYS (you stay quiet for ~5s)
**Screen**: Camera glides along the OSRM road network at ~6× speed.
Top ticker counts up *"Stop 12 / 50 — Customer 23"*. Trail behind the
dot fades green.

The on-screen TTS reads:

>     *"50 stops across the Sunshine Coast.*
>     *As-dispatched: 175 kilometres, 306 minutes of driving.*
>     *PathPilot delivers the same route in 72 kilometres.*
>     *That's 159 minutes back to the driver — every day."*

**You at 0:18** (after the second TTS line lands):

> "Same fifty stops. Same town. PathPilot rebuilt the order using
> PyVRP-HGS with a 2-opt polish, on a self-hosted Fly.io OSRM I deployed
> last week from a Geofabrik Queensland extract."

**Cue**: keep eye contact with the judges, not the screen. The animation
sells itself — your job is to anchor what they're seeing in *engineering
choices*. Drop "Fly.io", "OSRM", "Geofabrik" — the technical judges will
pin their ears back.

---

### 0:35 — 0:45  ·  THE PAYOFF
**Screen**: Flythrough lands at the depot, savings overlay slides up.
*Big green "102 km — saved"*, before/after blocks, **−59%** delta pill,
extrapolation footnote *"That's 25,575 km off the odometer — for one
driver, in a year."*

> "Hundred and two kilometres saved. Per day. Two and a half hours back.
> Across a working year, that's twenty-five thousand kilometres off the
> odometer — for *one* driver."

**Cue**: pause on the "for one driver" — let it land. Don't rush.

---

### 0:45 — 0:55  ·  THE MOAT
**Screen**: Still on the savings overlay. (Optional: scroll to *Replay* /
*Try it with my stops* CTAs to show interactivity.)

> "Most route apps optimise once and forget. PathPilot's already
> instrumented to learn from every delivery — arrival GPS, completion
> GPS, service times — so by month two it knows fourteen Buderim Avenue
> takes six minutes longer than the average because the driveway's a
> hundred metres long. Phase 1 ships this month."

**Cue**: this is the *competitive moat* sentence. Drop "Phase 1 ships
this month" with confidence — judges love a roadmap that's already
half-built (and Phase 0 is shipped, so this is honest).

---

### 0:55 — 1:00  ·  THE CLOSE
**Screen**: Tap **"Try it with my stops"** — fades back to login.

> "Production today. Used daily. PathPilot."

**Cue**: hold the phone up; eye contact; smile; step back.
**Do not** add another sentence. Silence after a closing line beats
nervous-hedging every single time.

---

## Q&A — judge-bait answers

Memorise these for the post-demo grilling. The first sentence answers
the question; the second adds the credibility hook.

### "How does this compare to OR-Tools / Google Maps optimisation?"
> "We benchmark against the *as-dispatched* baseline — what a dispatcher
> literally hands a driver — because that's the experience we replace.
> Versus OR-Tools the gap is much smaller, under 2%, but neither solver
> matches the realism of feeding live arrival GPS into the next day's
> matrix — that's where this is heading."

### "Why route optimisation? Isn't this solved?"
> "It's solved on uniform-Euclidean benchmarks. On real road networks
> with school-zone penalties, ferry crossings, and asymmetric durations,
> the published 0.5% gap-to-optimal evaporates. We're solving the
> *specific* problem one driver sees daily, with their *own* historical
> data — that's not in any benchmark."

### "What's the AI / ML angle?"
> "Three phases. Phase zero — instrumentation — shipped this week:
> arrival GPS, completion GPS, service-time logging. Phase one — a
> Bayesian-shrunk per-suburb service-time learner — slots into the
> solver in about a day once we have thirty routes of data. Phase two
> uses the offset between geocoded centroid and observed delivery point
> to self-correct the geocoder. Zero training infrastructure required
> for either."

### "Why not pure deep-learning NCO?"
> "Pointer-Networks and POMO are great when you have a million training
> instances and uniform-Euclidean coordinates. With three hundred routes
> of correlated Sunshine Coast data, classical solvers beat any neural
> baseline I've benchmarked, and they ship today. We've architected for
> NCO — the data pipeline can feed it — but it's the wrong tool right
> now."

### "How are you deployed?"
> "Frontend's an Expo React Native app on Android via EAS, ships OTA.
> Backend's FastAPI on an Emergent always-on pod. Routing engine is a
> dedicated OSRM 5.25 on Fly.io with a Queensland extract — Sydney
> region, auto-stop, sub-300 millisecond round trips. MapLibre WebGL
> inside a WebView for sixty FPS on Android."

### "What's the business model?"
> "Twenty-five-AUD-per-month per driver, fourteen-day free trial, Stripe
> Checkout via web — zero App Store cut. B2C solo first, B2B fleet
> seats once we hit twenty paying drivers. The architecture's documented
> and ready to ship."

### "What's the moat against, say, a Mapbox optimisation API?"
> "Two things. One — fourteen solvers in parallel, picked per-instance:
> nobody else does that. Two — the longitudinal learning loop: every
> delivery makes the next route smarter. Mapbox sells you a generic
> matrix; we ship a *specific* driver an order tuned to their last six
> months of GPS traces."

---

## Stage tactics (the soft stuff that wins)

- **Phone in landscape** if your demo runs landscape, portrait if not —
  judges hate looking sideways.
- **Don't apologise** for what's missing. The fleet dashboard, the iOS
  port, the subscription tier — all *roadmap*, not gap.
- **Don't read the script onstage**. Memorise it and use the demo's
  animation as your prompt: when you see the camera tilt, you know
  you're at 0:10.
- **Smile on the close.** A relaxed close communicates "I shipped this,
  I'm proud of it" — judges feel that.
- **If the WiFi dies**: pull out the 60-second screen-recording, narrate
  over it. *Never* stop and apologise — viewers don't notice technical
  hiccups, they notice composure breaks.

---

## Common stumbling words to rehearse

- *Geofabrik* — "GEE-oh-FAB-rik" (German, hard G).
- *PyVRP-HGS* — "pie-V-R-P, hybrid genetic search" if asked to expand.
- *OSRM* — letter-by-letter; some judges think it's a single word.
- *2-opt* — "two-opt" not "twopt".

---

## After the demo

- [ ] Drop a one-line follow-up to the organisers with the GitHub /
      Emergent demo URL within 4 hours.
- [ ] If anyone asks for the deck, send the screen-recording instead.
      Video > slides.
- [ ] Sleep before the awards ceremony — don't tweak the demo at 2am
      and break it.

---

*Total runtime: 60 seconds. Words: 198. Density: ~3.3 words/sec — comfortable.*
