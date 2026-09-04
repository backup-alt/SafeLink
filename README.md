# SafeLink Ocean Map

SafeLink is a local, browser-based ocean-conditions map powered by fresh Copernicus Marine data. The MVP covers the Indian Ocean, Arabian Sea, and Bay of Bengal (`20°E–120°E`, `60°S–30°N`) and presents five layers through a Windy-inspired interface.

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
