# MYCELIUM

**Factories don't talk to each other. We gave them a nervous system.**

A multi-agent system that discovers closed-loop industrial symbiosis networks across
Indian industrial clusters — where facility A's waste feeds B, B's waste feeds C, and
C's waste feeds back to A — and negotiates each leg live using autonomous LLM agents
with real reservation prices, memory, and a regulatory compliance gate.

Built in a single 10-hour hackathon session.

---

## The idea

Industrial symbiosis (steel slag → cement, fly ash → bricks, spent grain → cattle feed)
is a solved *chemistry* problem. What's never been solved is the *coordination* problem:
which two facilities, out of thousands, should actually talk to each other, on what
terms, and is it even legal? Kalundborg, Denmark's famous industrial symbiosis park,
took **40 years** of human relationship-building to produce ~15 exchanges.

MYCELIUM automates discovery **and** negotiation:

1. **Graph engine** (pure Python, no LLM) scans 24 facilities across 6 real Indian
   industrial clusters and finds pairs, 3-node cascades, and — the hard part —
   **closed cycles**, where a deal only clears if every leg is simultaneously viable.
2. **Negotiation agents** (LLM-driven) — one per facility, with a private reservation
   price, a persona, and memory of past deals — negotiate each leg live, showing both
   their public offer *and* their private internal reasoning side by side.
3. **Compliance agent** enforces real Indian regulation in code (MoEFCC Fly Ash
   Notification's 300 km mandatory-use radius; CPCB Hazardous Waste Rules licensing) —
   deterministically, so a judge can watch a chemically perfect match get vetoed live.
4. **Shock console** lets a judge mutate the world (diesel +18%, a new landfill tax)
   and watch the whole network re-score and agents renegotiate in real time.

Humans stay the approval gate: agents propose, a person signs off on every deal.

---

## Architecture

```
 DETERMINISTIC CORE (fast, always correct, zero LLM)
   graph.py        compatibility graph -> pairs / cascades / closed cycles (networkx)
   econ.py         ₹ saved, CO2e avoided, transport cost -- 4 documented constants
   compliance.py   CPCB / MoEFCC rule checks -> verdict + citation

 AGENT LAYER (LLM judgment)
   agents.py       FacilityAgent (seller/buyer) + BrokerAgent, strict JSON schemas
   negotiate.py    hand-rolled negotiation state machine, package viability gate
   memory.py       per-facility JSONL -- agents remember past counterparties
   llm.py          provider fail-over shim: Groq -> Gemini -> Ollama -> xAI Grok

 WEB (no build step)
   MapLibre GL tilted 3D map -- glowing dual-layer routes, hover deal-preview tooltips,
   camera fly-to on selection, a traveling light "packet" animated along the route in
   sync with each real negotiation turn, and a radar-ping at whichever facility is
   currently mid-LLM-call. A live SSE-driven "Agent Theatre" (public vs private
   reasoning) plus a "System Monitor" console showing real backend telemetry --
   provider, model, per-call latency, schema-validation status, live-vs-replay cache hits.
```

**Design principle:** combinatorics (cycle detection, distance scoring, rule checks)
lives in plain Python — instant, deterministic, always demoable even if every LLM
provider is down. Judgment (price negotiation, strategic reasoning) lives in the LLM.
This split is also the honest answer to "what's actually AI here?"

---

## Running it

```bash
cd mycelium
pip install fastapi "uvicorn[standard]" openai networkx httpx pydantic jsonschema python-multipart

# Add at least one free LLM key to .env (Groq recommended -- fast + generous free tier):
#   GROQ_API_KEY=...
# Get one free at console.groq.com

cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Open **http://127.0.0.1:8000/**. Click **DISCOVER**.

### Offline-safe demo mode

Free-tier LLM providers rate-limit hard. Before presenting, pre-record fixtures once:

```bash
cd scripts
python record_demo.py
```

Then set `DEMO_MODE=replay` in `.env` and the entire demo — including the closed-loop
negotiation — runs identically with the network cable pulled. Set it back to `live`
to actually negotiate on stage (recommended: **live** for the wow factor, with the
recorded fixtures as an automatic fallback if a provider call fails mid-demo).

---

## The dataset

24 facilities across 6 real Indian industrial clusters: Peenya/Bengaluru, Hosur,
Tiruppur, Jamshedpur, Bellary-Hospet, Mundra. Every exchange type mirrors documented
real-world practice (steel slag → GGBS cement is standard Tata/JSW practice; fly ash
reuse is legally mandated; foundry sand → construction fill is common in the
Peenya/Hosur belt). See [`assumptions.md`](assumptions.md) for every constant, formula,
and regulatory citation on screen — this is the file that survives a hard Q&A.

Three seeded hero scenarios:
- **The closed loop**: Brewery → Dairy/Feed → Biogas → back to the Brewery's boiler.
  A real, documented symbiosis pattern, seeded deliberately (true 3-cycles are rare —
  that's exactly why automated discovery matters).
- **The high-value cascade**: Steel → GGBS Cement → Road Construction. Crore-scale ₹.
- **The ghost match**: a chemically perfect fly-ash pair at 368 km — 68 km over the
  MoEFCC mandatory-use radius. Vetoed live, with the exact rule cited.

---

## What's genuinely agentic here

- **Multiple agent roles** (Seller, Buyer, Broker, Compliance) with distinct goals,
  private state, and tools (route/emissions lookup, virgin-price index, regulation
  check) surfaced transparently in the UI.
- **Persistent memory** — a facility's negotiation history with a counterparty is
  injected into its next negotiation; a human rejection becomes a hard constraint on
  future attempts.
- **Multilateral package-viability gate** — a closed loop only closes if all three
  legs are independently viable; agents are told the stakes ("if any leg fails, you
  lose the other deal too"), which measurably softens their reservation price.
- **Live re-planning under a changed world** — the shock console mutates real
  economic parameters and the whole network re-scores and renegotiates.
- **Strict structured output** — every agent turn is schema-validated JSON with a
  repair-retry and enum-coercion layer, not regex-parsed prose.

---

## Known limitations (said out loud, not hidden)

- Distances are haversine × 1.3, not a live routing API — a deliberate choice to
  avoid a hung request killing a live demo; documented in `assumptions.md`.
- Facility economics (prices, quantities) are synthesized for the demo, calibrated
  against public price ranges, not sourced from real facility filings.
- Free-tier LLM providers cap tokens/minute; the negotiation orchestrator paces
  closed-loop legs 3 seconds apart specifically to stay under that ceiling live.
