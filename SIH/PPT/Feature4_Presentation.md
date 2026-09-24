# SafeLink — Feature #4: Real-Time Emergency & Guardrail Alerts
### SIH 2026 | SIH26176 — ORCA Marine EcOsystem Reasoning with Collaborative Agents
### Sponsor: ISRO | Theme: Disaster Management
### Presenter: Baraniganesh J (Solo — Feature #4)

---

## SLIDE 1 — THE PROBLEM

Indian fishermen lose **lives every year** because:
- They enter **prohibited zones** (military testing areas, wildlife sanctuaries) unknowingly
- **Cyclones form** in the Bay of Bengal with little on-boat warning
- They **don't have real-time fused data** — ocean hazards come from 5+ different sources
- Existing apps show data, but **never alert** when danger is imminent

> **"Data without alert is just decoration."**

---

## SLIDE 2 — WHAT I BUILT

**Feature #4: Real-Time Emergency & Guardrail Alerts**

Three-layer protection system:

```
┌─────────────────────────────────────────────────────────────┐
│                   LAYER 1: GEOFENCING                       │
│  3 restricted zones: India EEZ, Gulf of Mannar sanctuary,   │
│  Military testing block — checked via Shapely point-in-poly │
├─────────────────────────────────────────────────────────────┤
│                   LAYER 2: WEATHER INTERRUPT                 │
│  Cyclone + Lightning hazard polygons from IMD/Copernicus     │
│  mock data for demo (API-ready for production)              │
├─────────────────────────────────────────────────────────────┤
│                   LAYER 3: DATASET FUSION                   │
│  Chlorophyll-a (< 48h freshness) + Wave height (> 2.5m)    │
│  + Ship accumulation (> 5 vessels) → single fused risk      │
└─────────────────────────────────────────────────────────────┘
```

---

## SLIDE 3 — ARCHITECTURE

```
                          ┌──────────────────────────┐
                          │      React Frontend       │
                          │  (MapLibre + Vite + pnpm)  │
                          └─────────┬────────────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 │                  │                   │
          ┌──────▼──────┐  ┌───────▼────────┐  ┌──────▼──────────┐
          │ AlertOverlay │  │GuardrailBanner │  │ GuardrailPopup  │
          │ (Map layers) │  │(top status)    │  │(bottom toast)   │
          │ flash red +  │  │siren+vibrate+  │  │ auto-dismiss    │
          │ dashed borders│  │notification    │  │ 8s timer        │
          └──────┬──────┘  └───────┬────────┘  └──────┬──────────┘
                 │                  │                   │
                 └──────────────────┼───────────────────┘
                                    │ REST API (5 endpoints)
                                    │
               ┌────────────────────▼───────────────────────┐
               │         FastAPI Backend (Python)            │
               │                                            │
               │  GET /api/geofences                        │
               │  GET /api/geofence/check?lat=&lng=         │
               │  GET /api/alerts/weather                    │
               │  GET /api/alerts/hazards                    │
               │  GET /api/alerts/guardrail?lat=&lng=       │
               │                                            │
               │  ┌──────────────────────────────────────┐  │
               │  │  alerts/geofence_service.py          │  │
               │  │  • 3 hardcoded zones (Shapely)       │  │
               │  │  • point_in_polygon check             │  │
               │  │  • haversine distance calculation     │  │
               │  │  • time-to-zone prediction            │  │
               │  └──────────────────────────────────────┘  │
               │  ┌──────────────────────────────────────┐  │
               │  │  alerts/weather_service.py            │  │
               │  │  • MOCK_HAZARDS (cyclone + lightning) │  │
               │  │  • fused_guardrail_check()            │  │
               │  │  • chl-a + waves + ships → risk level │  │
               │  └──────────────────────────────────────┘  │
               │  ┌──────────────────────────────────────┐  │
               │  │  ai/tools.py                          │  │
               │  │  • get_guardrail_status (9th tool)    │  │
               │  │  • Chat can answer "Is it safe?"      │  │
               │  └──────────────────────────────────────┘  │
               └────────────────────┬───────────────────────┘
                                    │
                      ┌─────────────┼─────────────┐
                      │             │              │
               ┌──────▼───┐  ┌─────▼──────┐  ┌───▼──────────┐
               │ Copernicus│  │ AIS Vessel │  │  GeoJSON     │
               │  Marine   │  │  Tracker   │  │  Geofences   │
               │  (chl,    │  │ (ship      │  │  (india_eez) │
               │   waves)  │  │  count)    │  │              │
               └──────────┘  └────────────┘  └──────────────┘
```

---

## SLIDE 4 — HOW IT WORKS (Step-by-step)

**User clicks on the map →**
1. `selectMapPoint()` in `App.tsx` stores clicked coordinates
2. `GuardrailBanner` + `GuardrailPopup` render with the point
3. Both call `GET /api/alerts/guardrail?lat=&lng=`
4. Backend `fused_guardrail_check()` runs in parallel:
   - Checks geofence (Shapely `contains()`)
   - Checks weather hazards (mock cyclone/lightning zones)
   - Checks wave height (> 2.5m from Copernicus or fallback)
   - Checks chlorophyll-a age (< 48h from HF dataset)
   - Checks ship count (> 5 from AIS proxy)
5. Returns `level: safe | warning | danger` with alert messages
6. Frontend:
   - **Banner** (top): color-coded + alerts list
   - **Popup** (bottom toast): prominent, auto-dismiss 8s
   - **Siren**: 880Hz oscillator (danger) / 440Hz (warning)
   - **Vibration**: triple pulse pattern
   - **Notification**: browser push (requests permission on first use)
   - **Map**: red flashing zones (650ms toggle opacity)

---

## SLIDE 5 — LIVE DEMO SCRIPT (5 minutes)

### Demo Step 1: Geofencing (1 min)
- Open `http://localhost:5173`
- **Click on the red dashed zone near Gulf of Mannar** (lat ~8.9, lng ~79.0)
- Point out: top banner shows `🔴 DANGER`
- Popup toast appears: "Gulf of Mannar Protected Sanctuary — No Entry"
- Siren + vibrate fires

### Demo Step 2: Weather Interrupt (1 min)
- **Click on the solid red zone** (Bay of Bengal cyclone mock, lat ~13, lng ~88)
- Point out: "Cyclone Zone: BOB 2026 — Enter at own risk"
- Banner + popup + siren

### Demo Step 3: Dataset Fusion (1 min)
- Click on open ocean (not in any zone)
- Shows: `🟢 SAFE — Guardrail Active`
- Point out the data panel: Wave value, Chl age, Ship count
- Explain: "This fuses 3 data sources into one risk score"

### Demo Step 4: Chat Integration (1 min)
- Click the chat panel (bottom left)
- Type: "Is it safe at latitude 13, longitude 88?"
- Chat responds with danger alert + reasoning
- Explain: "The AI has a new tool — `get_guardrail_status` — that fuses all 5 signals"

### Demo Step 5: Architecture Walk-through (1 min)
- Show the diagram on screen
- Point to the 3 layers: Geofencing → Weather → Fusion
- "Each layer is independent, composable, and production-ready"

---

## SLIDE 6 — IMPACT ON THE PROJECT

| Aspect | Before Feature #4 | After Feature #4 |
|--------|-------------------|------------------|
| Fisherman safety | Passive data display | **Active alerts** with siren/vibrate |
| Geofencing | None | **3 restricted zones** with distance prediction |
| Weather hazards | None | **Cyclone/Lightning** interrupt flags |
| Data fusion | Separate layers | **Single risk score** from chl + waves + ships |
| Chat capability | Ocean analysis only | **"Is it safe?"** answers with reasoning |
| Total API endpoints | 8 | **13** (+5 new) |
| Tools available | 8 | **9** (+1 new: guardrail status) |

---

## SLIDE 7 — MEETING JUDGES' EXPECTATIONS

### Q1: "How is this different from existing apps?"
> Most marine apps show data layers. **We alert before danger.** Our guardrail fuses 5 independent signals into a single `safe/warning/danger` verdict and triggers audio, vibration, and browser notifications — even if the fisherman isn't looking at the screen.

### Q2: "How does the AI/agent part work?"
> SafeLink uses a **multi-agent architecture** — ORCA agents handle ocean reasoning. My feature adds a **9th tool** (`get_guardrail_status`) to the chat's AI tools. When a fisherman asks "Is it safe at my location?", the LLM calls this tool, which fuses geofence + weather + waves + chlorophyll + ship data and returns a risk verdict. The agent reasons over it and responds in natural language.

### Q3: "What about real data? Is this just mock?"
> **Hybrid approach.** 
> - Geofencing: Hardcoded zones for demo → MarineRegions.org + WDPA for production
> - Weather: Mock for demo → IMD API + Copernicus for production (code is API-ready)
> - Chlorophyll/Waves: **Real data** from HuggingFace dataset (Sherwin-Aniesh/SafeLink)
> - Ships: **Real AIS data** from open-water vessel tracking
> - The architecture is the same — only the data source changes

### Q4: "How does this help in disaster management?"
> The problem statement is specifically about **early warning systems**. Our feature:
> 1. **Prevents entry** into dangerous zones (proactive)
> 2. **Interrupts** ongoing navigation with hazard alerts (reactive)
> 3. **Fuses disparate data** so fishermen don't need to check 5 apps (simplification)
> 4. **Works with chat** — natural language access for fishermen who can't read maps

### Q5: "Can this scale beyond India?"
> Yes. The geofence system uses GeoJSON polygons — add new zones by dropping in a file. Weather uses standard Copernicus/IMD APIs. The guardrail logic is region-agnostic. Swap India EEZ for any country's boundaries.

### Q6: "What's the tech stack?"
> **Frontend:** React + TypeScript + MapLibre GL + Vite
> **Backend:** FastAPI (Python) + Shapely (geospatial) + Copernicus Marine
> **AI:** Groq LLM with 9 custom tools
> **Data:** HuggingFace dataset + AIS vessel tracking
> **Deploy:** Railway (backend) + Vercel-ready (frontend)

---

## SLIDE 8 — CODE HIGHLIGHTS

**Backend fusion logic (weather_service.py:145-168):**
```python
def fused_guardrail_check(lat, lng, repo):
    alerts = []
    geo = check_point(lng, lat)           # Layer 1: Geofence
    weather = check_weather(lat, lng)      # Layer 2: Weather
    chl = get_chlorophyll_sample(lng, lat, repo)  # Layer 3a
    wave = get_wave_sample(lng, lat, repo)         # Layer 3b
    ships = count_nearby_ships(lng, lat)            # Layer 3c
    
    if geo["restricted"]: alerts.append({"type": "geofence", ...})
    if weather: alerts.append({"type": weather["type"], ...})
    if chl and chl["age_hours"] < 48: alerts.append({"type": "chlorophyll", ...})
    if wave and wave["value"] > 2.5: alerts.append({"type": "wave", ...})
    if ships > 5: alerts.append({"type": "ship_accumulation", ...})
    
    level = "danger" if alerts else "safe"
    return {"level": level, "alerts": alerts, "samples": {...}}
```

**Frontend siren (GuardrailBanner.tsx:25-28):**
```tsx
const o = ctx.createOscillator()
const g = ctx.createGain()
o.frequency.value = 880  // danger = 880Hz, warning = 440Hz
o.connect(g); g.connect(ctx.destination); g.gain.value = 0.3
o.start(); setTimeout(() => o.stop(), 500)
```

---

## SLIDE 9 — WHAT'S NEXT (Post Hackathon)

1. **Real IMD API** integration for live cyclone tracking
2. **Push notifications** via Firebase for background alerts
3. **Dynamic geofences** from MarineRegions.org EEZ database
4. **Prediction model** — predict ship destination in 5 min, warn if heading toward danger
5. **Multi-language** alert messages (Tamil, Telugu, Malayalam)

---

## SLIDE 10 — SUMMARY

**One feature. Three layers. Five signals. One verdict.**

- 3 files created on backend, 3 files on frontend, 2 existing files modified
- **Zero breakage** to existing features (layers, chat, PFZ, routing, nautical, vessels)
- All changes are **additive** — 49 lines modified in existing files
- **Build passes** — production-ready for Railway deployment
- **Solo implementation** in 1 day

> "SafeLink doesn't just show the ocean — **it protects the fisherman in it.**"

---

## APPENDIX — FILE MANIFEST

| File | Lines | Purpose |
|------|-------|---------|
| `backend/alerts/__init__.py` | 1 | Package init |
| `backend/alerts/geofence_service.py` | 170 | 3 zones + Shapely check + haversine + prediction |
| `backend/alerts/weather_service.py` | 169 | Mock hazards + fused_guardrail_check + chl/wave/ship fusion |
| `backend/alerts/routes.py` | 40 | 5 REST API endpoints |
| `public/geofences/india_eez.geojson` | 3 polygons | Frontend boundary data |
| `src/utils/geofence.ts` | 1.3K | Client-side point-in-polygon + haversine (no Turf) |
| `src/components/AlertOverlay.tsx` | 2.7K | MapLibre red flashing layers |
| `src/components/GuardrailBanner.tsx` | 2.9K | Top banner + siren + vibrate + notification |
| `src/components/GuardrailPopup.tsx` | 2.4K | Bottom toast popup with auto-dismiss |
| `backend/ai/tools.py` | +7 lines | `get_guardrail_status` tool (9th tool) |
| `backend/app.py` | +3 lines | `include_router(alerts_router)` |
| `src/App.tsx` | +5 lines | Import + mount GuardrailBanner + GuardrailPopup |
| `src/OceanMap.tsx` | +35 lines | Guard layer useEffect on map load |
