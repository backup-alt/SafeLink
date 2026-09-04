# ORCA Marine Intelligence Map

ORCA (formerly SafeLink) is a browser-based ocean-conditions and decision-support map powered by Copernicus Marine and official INCOIS PFZ advisories. The MVP covers the Indian Ocean, Arabian Sea, and Bay of Bengal (`20°E–120°E`, `60°S–30°N`) and now includes an optional, tool-using conversational assistant.

## Features

- Significant wave height, wave direction animation, and wave period
- Surface-current speed and animated current direction
- Surface sea temperature
- Total sea level
- Surface chlorophyll concentration with a logarithmic scale
- Map inspection with values at the selected coordinate
- Decimal-coordinate and degrees/minutes/seconds coordinate search
- Forecast timeline with play and pause controls
- Automatic checks for fresh Copernicus products every six hours
- Seven-day local-file retention and automatic cleanup
- Detailed land, coastline, lake, lagoon, and river separation
- Public local interface with no SafeLink account required
- Streaming ORCA assistant with authoritative marine tools, optional OpenAI web search, citations, and allowlisted MapLibre actions

SafeLink is intended for visualization and situational awareness. It is not certified navigational or safety guidance.

## Requirements

Install the following before setting up SafeLink:

- [Git](https://git-scm.com/downloads)
- [Python](https://www.python.org/downloads/) 3.11 or newer (Python 3.12 recommended)
- [Node.js](https://nodejs.org/) 20 or newer
- `pnpm`, enabled with `corepack enable`
- A free [Copernicus Marine account](https://marine.copernicus.eu/)
- Enough storage for the downloaded NetCDF products. The initial five-layer dataset can require several gigabytes during download and approximately 1–2 GB after compression.
- An internet connection for Copernicus products and map tiles

## Install on Windows

Open PowerShell and run:

```powershell
git clone https://github.com/backup-alt/SafeLink.git
cd SafeLink
corepack enable
.\setup.ps1
```

If PowerShell blocks local scripts, allow them for only the current terminal and retry:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

Authenticate this computer with Copernicus Marine:

```powershell
.\.venv\Scripts\copernicusmarine.exe login
```

Enter your Copernicus Marine username and password when prompted. Credentials are stored by the Copernicus Marine client and are never committed to this repository.

Start SafeLink:

```powershell
.\start.ps1
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in a browser. On the first run, the server begins downloading the five datasets in the background. Layers become available as their downloads finish; the initial download may take a while.

Stop the server with `Ctrl+C`.

## Install on macOS or Linux

```bash
git clone https://github.com/backup-alt/SafeLink.git
cd SafeLink
corepack enable
chmod +x setup.sh start.sh
./setup.sh
.venv/bin/copernicusmarine login
./start.sh
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000). Stop the server with `Ctrl+C`.

## Using the map

1. Select **Waves**, **Currents**, **Sea temperature**, **Sea level**, or **Chlorophyll** from the layer panel.
2. Click the ocean to inspect the value at that exact coordinate.
3. Drag or zoom the map to explore the Indian Ocean basin.
4. Enter coordinates in the search field, for example `13.08, 80.27`, `13.08 N 80.27 E`, or DMS coordinates.
5. Drag the timeline or press Play to view the available forecast or observation frames.
6. Expand **Data info** to see the observation or forecast age.

## Data refresh and storage

### Official Potential Fishing Zone overlay

Potential Fishing Zones (PFZ) are official **INCOIS advisories**, separate from
Copernicus Marine chlorophyll and other oceanographic observations/forecasts.
Use the independent **Overlays → Potential Fishing Zones** checkbox with any
ocean layer. PFZ defaults on when available. Click a gold line for its advisory
date and PFZ number. PFZ is not calculated from chlorophyll and does not change
with the Copernicus timeline. Chlorophyll remains CHL in mg/m³ on a logarithmic
scale; see Data info for its observation age.

`GET /api/pfz` proxies the official INCOIS WFS through the backend (no API key).
The JSON response is `{ "data": <GeoJSON FeatureCollection>, "metadata": {...} }`.
`data` remains usable GeoJSON with unchanged MultiLineString coordinates, unique
render IDs, original properties, and a derived per-feature `advisory_date`.
Metadata includes `source`, `fetched_at`, `feature_count`, `stale`, and
`advisory_dates`; `advisory_date` is the latest valid Year + day-of-year date,
not the server date. Mixed dates are indicated in the UI. Length is shown in
unspecified source units rather than assuming kilometres.

Each backend process caches validated successes in memory for 20 minutes.
Refreshes are serialized; failures are logged and retried no sooner than one
minute later. On failure the last successful response is served as stale with
its original fetch timestamp. With no cached success, the API returns 503.
Malformed snapshots (including invalid geometries or a non-geographic CRS)
are rejected as a whole rather than displaying a silently incomplete advisory.
An empty successful collection means no lines, not an outage. Browser requests
poll independently every five minutes and never contact INCOIS directly.
Cache data does not survive restarts and is not shared between replicas; cached
advisories can be old, so always check the displayed date and stale indicator.

SafeLink remains situational-awareness software and is **not certified navigation
or safety guidance**. PFZ advisories do not guarantee a catch or safe conditions.

### Nearest PFZ

Choose **Find nearest PFZ** in Overlays first. The location panel asks for your
**starting/current position, not your destination**. Choose **Use my current
location** to request browser location permission, or **Choose on map** and click
your starting point (coordinate search also works). Check the labelled marker,
then click **Find PFZ from this location**. Device-reported accuracy is shown;
coarse desktop estimates require particular care. Cancel or press Escape to
leave selection without calculating a PFZ. No lookup runs before confirmation.

Device location requires HTTPS (localhost also works), browser permission, and
available operating-system location services. If permission is denied, services
are off, or the request times out, the panel explains how to retry or select a
point manually. SafeLink cannot bypass disabled location access and does not
substitute IP-based guesses for an actual position. Location is requested once
on user action, not continuously tracked. Confirmed coordinates are sent to the
SafeLink API to calculate the nearest PFZ and sample its conditions.

The result shows the nearest advisory feature, nearest point on its
geometry, direct distance in kilometres, and initial bearing clockwise from true
north. White highlights the selected feature; a white dot marks the origin and a
gold dot the nearest point. **Show nearest point** centres the map there. Clicking
another map point closes the result; use **Find nearest PFZ** to start again.

`GET /api/pfz/nearest?latitude=12.6&longitude=80.4` searches every segment of every
MultiLineString in the cached INCOIS snapshot, not just vertices or centroids.
It returns `feature`, `origin`, `point`, `distance_km`, `bearing_degrees`, segment
indices, and snapshot `metadata`. Empty advisories return 404; cold upstream
failure returns 503; invalid coordinates return 422. A coincident point has no
meaningful bearing (`null`). Calculations use minor great-circle arcs on a
6371.0088 km mean-radius sphere, not an ellipsoidal navigation solution. The
nearest feature may be stale or have a different advisory date; check its date.
This is the geometrically nearest feature, not a recommended destination or a
water-only route; a direct path can cross land.

Copernicus conditions are requested independently through `/api/value/{layer}`
at that point, using native nearest-grid sampling and the closest available
timestamp to the selected timeline time. The response includes the actual
`time` and `unit`; each sample's time is displayed separately. Missing data and
points outside coverage display **Unavailable**, without hiding the PFZ result.
Timeline changes refresh conditions but do not repeat the geometry lookup.
There is no spatial/temporal extrapolation, catch prediction, or new ORCA chat
integration. These endpoints provide the data needed for a future assistant.

With the standard start scripts, SafeLink checks for newer Copernicus data shortly after startup and then every six hours. Downloaded products are stored in `copernicus_data/`, which is intentionally excluded from Git. Files older than seven days are removed automatically.

Forecast layers request the current Copernicus analysis/forecast run and up to ten days of available forecast data. Chlorophyll is an observation product and therefore follows its separate publication schedule. Available times can vary by product and Copernicus publication status.

To run without automatic downloads, start the backend with `SAFELINK_AUTO_REFRESH=false` in the environment. Existing local data will still be served.

## Development

Run the API with live reload:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --reload
```

In another terminal, run the Vite development server:

```powershell
pnpm dev
```

Vite serves the development UI and proxies `/api` requests to port 8000.

Build and test before submitting changes:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s backend\tests
pnpm run build
```

On macOS or Linux, replace `.\.venv\Scripts\python.exe` with `.venv/bin/python` and use `/` in paths.

## ORCA conversational assistant

The assistant uses the official OpenAI Python SDK and the Responses API with
`gpt-5.5`. OpenAI's built-in web search is available to the model for fresh
external notices and reports; ORCA's own functions remain the source for PFZ and
Copernicus values. Chat is optional: if it is not configured or has an error,
the map and every data API continue to work.

```text
User
  |
React chat + MapLibre
  |
FastAPI -- OpenAI Responses API (GPT-5.5)
  |               |
  |               +-- Web search + cited public sources
  |
  +-- ORCA marine tools
  |      +-- INCOIS PFZ cache and nearest-line calculation
  |      +-- Copernicus native-grid point sampling
  |      +-- data availability and map-label place lookup
  |
  +-- validated map actions --> existing MapLibre map
```

### How the assistant works

`POST /api/chat` returns an SSE stream. The frontend incrementally renders answer
text while showing safe events such as **Finding nearest PFZ**, **Reading marine
conditions**, **Searching current public information**, and **Updating map**.
These are tool/activity summaries—not private model reasoning. Reasoning events,
tool arguments, raw marine payloads, prompts, exceptions, and credentials are
never streamed. Web citations are allowlisted to HTTP(S), shown inline when
possible, and collected in expandable source cards. Internal source badges such
as INCOIS and Copernicus Marine are kept distinct from web citations.

One backend orchestrator decides among six functions:

- `get_marine_conditions` — selected native-grid layers, actual sample times,
  units, and time offsets from the request;
- `get_nearest_pfz` and `get_pfz_details` — compact, verified INCOIS advisories;
- `get_data_availability` — layer coverage and first/last times;
- `resolve_location` — bounded matches from the existing Natural Earth map-label
  gazetteer (not a live geocoder or vessel-position source);
- `update_map` — schema-validated `fly_to`, `place_marker`, `highlight_pfz`,
  `select_layer`, `set_time`, or `clear_map_highlights` actions only.

The frontend validates every map command again; the model cannot execute
JavaScript or arbitrary DOM commands. An assistant PFZ highlight must refer to a
currently verified advisory. A requested time selects the closest source frame
and displays its actual timestamp rather than pretending it is exact.

Multi-turn context uses `previous_response_id`. A random HttpOnly, SameSite
browser cookie owns each server-side conversation ID so one browser cannot read
another browser's conversation. The MVP store is in memory, expires inactive
sessions after two hours, permits one active reply per conversation, and has
bounded conversation, concurrency, per-minute, daily, tool-round, and turn
limits. State is lost when the backend restarts and is not shared between
multiple Railway replicas. New conversation clears the current server context;
Stop cancels the browser request and upstream stream. In accordance with the
Responses API behavior, stored response state is subject to the OpenAI project's
retention and data-control settings. Do not send secrets in chat.

Every message includes only compact current map context: center, zoom, last
clicked/confirmed point, selected layer, time, and PFZ identifier. It never sends
raster arrays, full PFZ geometry, the browser geolocation accuracy value, or an
API key. A clicked map point is context—not automatically the user's actual
location. The system prompt requires sourced values, clear observed/forecast/
advisory/web/inference distinctions, honest missing-data handling, and the
navigation/safety disclaimer.

### Local OpenAI configuration

Copy the placeholder file and edit the ignored local file:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

Set these values in `.env`:

```text
OPENAI_API_KEY=<your OpenAI API key>
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=medium
```

Then run the normal setup/start command. `.env` is only for local development;
it is ignored by Git and excluded from Docker builds. `.env.example` contains
placeholders only. The existing local `.env.test` key was migrated atomically to
`.env` and `.env.test` was removed only after verifying the new ignored file.
The reusable migration utility is `scripts/migrate_local_env.py`; it refuses
tracked/unknown/conflicting input and never prints credential values.

Optional cost controls are documented in `.env.example`. Defaults are 2,500
maximum output tokens per model round, five tool rounds, six browser-owner
requests per minute, 100 total requests per process/day, 20 turns per
conversation, and three concurrent requests. Web search is capped within the
agent loop and is omitted after its small per-turn allowance is consumed. These
are safeguards, not a billing guarantee: check your OpenAI project limits.

Health/configuration check (this never makes a paid model request):

```text
http://127.0.0.1:8000/api/chat/health
```

It reports whether a server key and valid settings are present, plus the selected
model/effort. It does not verify the key, model access, quota, or billing.

## Deploy on Railway

SafeLink supports a Railway and Hugging Face deployment that keeps all credentials in Railway:

```text
Copernicus Marine -> Railway publisher -> Hugging Face dataset
                              ^                    |
                              |                    v
Browser --------------------> Railway API <--------+
```

Railway downloads one Copernicus product at a time, converts it into compressed web frames, uploads each small batch to Hugging Face, and immediately removes its temporary files. The publisher checks every six hours while the service is active and publishes at most one normal run per UTC day. Seven daily runs remain in the dataset repository and its commit history is squashed after successful publication so storage does not grow indefinitely.

### 1. Create the Hugging Face dataset

1. Create a public Hugging Face dataset repository, such as `your-name/safelink-data`.
2. Create a fine-grained Hugging Face access token with write permission for that dataset.
3. Keep the token private. SafeLink data may be public, but the write token must never be committed.

### 2. Configure Railway

Add these variables to the Railway SafeLink service:

```text
COPERNICUSMARINE_SERVICE_USERNAME=<copernicus-username>
COPERNICUSMARINE_SERVICE_PASSWORD=<copernicus-password>
HF_DATASET_REPO=<hugging-face-user>/safelink-data
HF_TOKEN=<hugging-face-write-token>
SAFELINK_AUTO_REFRESH=true
```

### Configure OpenAI on Railway

1. Open the Railway project and select the ORCA/SafeLink service.
2. Open **Variables**.
3. Add `OPENAI_API_KEY` with your OpenAI API key.
4. Add `OPENAI_MODEL=gpt-5.5`.
5. Add `OPENAI_REASONING_EFFORT=medium`.
6. Optionally add the cost-control variables from `.env.example`.
7. Save/apply the variables. Railway normally redeploys automatically; otherwise
   open Deployments and choose **Redeploy**.
8. Open `https://<railway-domain>/api/chat/health`. Expect `configured: true`,
   `model: "gpt-5.5"`, and `status: "ready"`. This is configuration-only; send a
   small chat message to manually confirm key access and quota when you choose.

Do not upload `.env` or add the key to GitHub/Vite variables. Railway production
uses service Variables. Existing deployments still require the Copernicus,
Hugging Face, and refresh variables listed above. `PORT` is supplied by Railway;
`HF_DATASET_REVISION`, `SAFELINK_HF_PREFIX`,
`SAFELINK_HF_SQUASH_HISTORY`, and `SAFELINK_REFRESH_TOKEN` remain optional.

OpenAI model and web-search use can incur API charges. The application does not
make a paid request during startup, health checks, builds, or automated tests.

Optional variables:

```text
HF_DATASET_REVISION=main
SAFELINK_HF_PREFIX=safelink
SAFELINK_HF_SQUASH_HISTORY=true
SAFELINK_REFRESH_TOKEN=<long-random-token>
```

When `SAFELINK_REFRESH_TOKEN` is configured, an external scheduler can start a refresh with an authenticated request:

```bash
curl -X POST https://<railway-domain>/api/admin/refresh \
  -H "Authorization: Bearer <long-random-token>"
```

This is useful when Railway Serverless is enabled and the service may be asleep at the scheduled refresh time. A normal browser visit also wakes the service; the in-process publisher checks shortly after application startup and then every six hours while it remains active.

After adding or changing variables, redeploy the Railway service. The first publication is large and can take a significant amount of time. Progress and any error are available from `/api/refresh/status`.

Verify the deployment:

```text
https://<railway-domain>/api/health
https://<railway-domain>/api/catalog
```

The health endpoint should return `{"status":"ok"}`. In the catalog response, all five layers should have `"available": true` after the first Hugging Face publication finishes.

### Cloud-data security

- Never commit Copernicus credentials or the Hugging Face write token.
- Store credentials only as Railway service variables.
- The backend can read a public dataset without a token, but the publisher requires write permission.
- Rotate the Hugging Face token if it is accidentally displayed or committed.

## Troubleshooting

- **No layer data appears:** Check the terminal for Copernicus authentication or download errors. Run the login command again and leave the server running until the first refresh completes.
- **Port 8000 is already in use:** Stop the other process using the port, then run the start script again.
- **Map tiles do not appear:** Confirm that the computer can access OpenStreetMap and OpenFreeMap tile services.
- **An old interface remains after updating:** Rebuild with `pnpm run build`, restart SafeLink, and hard-refresh the browser with `Ctrl+Shift+R`.
- **Installation fails while building Python packages:** Use the recommended Python 3.12 release and rerun the setup script.

## Project structure

```text
backend/          FastAPI service, Copernicus refresh, and data sampling
src/              React and MapLibre frontend
public/           Static geographic assets
scripts/          Supporting geographic-data utilities
setup.ps1/.sh     Dependency installation and frontend build
start.ps1/.sh     Local production server
```

## Data attribution

Ocean data is supplied by the [Copernicus Marine Service](https://marine.copernicus.eu/). Basemap and geographic context use OpenStreetMap/OpenFreeMap services and their applicable attribution terms.

Potential Fishing Zone advisories are supplied by [INCOIS](https://incois.gov.in/)
via its public `PFZ_Automation:pfzlines` GeoServer WFS. The self-contained land
reference layers use Natural Earth. PFZ is an independent advisory overlay,
not a Copernicus chlorophyll-derived prediction.
