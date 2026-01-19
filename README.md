# TAM Tram/Bus Backend (AdonisJS)

Backend API built with AdonisJS, using the existing `gtfs.sqlite` database in the project root.

## ✅ What’s included

- AdonisJS API-only starter kit
- SQLite configured to read `gtfs.sqlite`
- GTFS endpoints migrated from the POC (`/api/*`)
- Automatic generated-shapes bootstrap + admin endpoint
- Scheduled GTFS imports (startup + monthly) and realtime updates (every 15s)

## Requirements

- Node.js (LTS recommended)
- Existing GTFS database file at `./gtfs.sqlite`

## Setup

Install dependencies and run the API server:

```bash
npm install
npm run dev
```

The server starts on `http://localhost:34000` by default.

## Docker 🐳

### Build & run (image)

```bash
docker build -t tam-tram-bus-backend .
docker run --rm -p 34000:34000 \
	-v $(pwd)/gtfs.sqlite:/app/gtfs.sqlite \
	-v $(pwd)/config.json:/app/config.json \
	tam-tram-bus-backend
```

### Run with docker-compose

```bash
docker compose up --build
```

Make sure your `.env` file includes `APP_KEY` and `LOG_LEVEL` (required by AdonisJS). If you
don't have one, copy `.env.example` and fill in the values.

## Database

The SQLite connection is configured in `config/database.ts` to use:

```
./gtfs.sqlite
```

If you replace the GTFS database file, keep the same filename or update the config.

## API Endpoints

All endpoints are prefixed with `/api` unless noted.

- `GET /api/station-names` – list unique station names
- `GET /api/stops-by-name?name=...`
- `GET /api/stop-ids-for-name-and-route?name=...&route_id=...`
- `GET /api/routes-by-stop?stop_id=...`
- `GET /api/next-departures?stop_id=...&limit=10`
- `GET /api/stops-near?lat=...&lon=...&radius=0.5`
- `GET /api/shapes`
- `GET /api/shape?shape_id=...`
- `GET /api/shape-by-route?route_id=...&direction_id=...`
- `GET /api/shape-from-trip?trip_id=...`
- `POST /admin/generate-shapes`

## GTFS import & realtime updates

On boot, the backend runs `importGtfs` once, then schedules:

- Full GTFS import every 30 days
- Realtime updates every 15 seconds

These schedules are implemented in `app/services/gtfs_importer.ts`, registered in
`start/scheduler.ts`, and run by the scheduler worker started from `providers/gtfs_provider.ts`.

`GET /api/next-departures` now merges GTFS-RT stop time updates when available. Each departure
includes:

- `realtime_departure_time` / `realtime_arrival_time` (adjusted by delay)
- `delay_seconds` and `delay_minutes` (positive = late, negative = early)
- `realtime_updated` (true when delay is non-zero)
- `realtime_updated_at` (timestamp from GTFS-RT update, if present)

## Shapes generation

On server boot, the backend generates synthetic shapes from representative trips (stored in `generated_shapes`).
The scheduler also refreshes shapes daily at 03:00.
You can also trigger regeneration manually via:

```
POST /admin/generate-shapes
```

## Backup of the POC

The original Express proof-of-concept has been moved to:

```
./_backup_poc_2026-01-17
```
