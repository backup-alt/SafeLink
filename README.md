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

SafeLink includes a production `Dockerfile` and `railway.json`. The same Railway service hosts both the API and the built web interface.

1. Create a Railway project from this GitHub repository.
2. Add a persistent volume and mount it at `/data`. Without this volume, downloaded Copernicus files disappear whenever the container is replaced.
3. Add these service variables in Railway:

   ```text
   COPERNICUSMARINE_SERVICE_USERNAME=your-copernicus-username
   COPERNICUSMARINE_SERVICE_PASSWORD=your-copernicus-password
   SAFELINK_AUTO_REFRESH=true
   SAFELINK_DATA_DIR=/data
   ```

4. Deploy the `main` branch and generate a public Railway domain for the service.
5. Open `/api/health` on that domain and confirm it returns `{"status":"ok"}`.

Do not add Copernicus credentials to GitHub or commit them to a file. Railway injects the variables only at runtime. The first deployment can remain healthy while the initial dataset downloads in the background; map layers appear as each product finishes.

Because the five Indian Ocean products use substantial storage, network transfer, memory, and CPU, select a Railway plan and volume large enough for the workload. Keep at least several gigabytes free to accommodate temporary downloads alongside retained data.

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
