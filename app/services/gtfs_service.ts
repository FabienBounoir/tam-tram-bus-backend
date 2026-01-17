import Database from '@adonisjs/lucid/services/db'

function unwrapRows(result: any): any[] {
  if (Array.isArray(result)) return result
  return result?.rows ?? []
}

async function dbAll(sql: string, params: any[] = []) {
  const result = await Database.rawQuery(sql, params)
  return unwrapRows(result)
}

async function dbGet(sql: string, params: any[] = []) {
  const rows = await dbAll(sql, params)
  return rows[0] ?? null
}

export function timeToSeconds(t?: string | null): number | null {
  if (!t) return null
  const parts = String(t).split(':')
  if (parts.length !== 3) return null
  const h = Number.parseInt(parts[0], 10) || 0
  const m = Number.parseInt(parts[1], 10) || 0
  const s = Number.parseInt(parts[2], 10) || 0
  return h * 3600 + m * 60 + s
}

export async function getActiveServiceIds(ymd: string): Promise<string[]> {
  const sql = `WITH params(ymd) AS (SELECT ?),
iso AS (SELECT substr(ymd,1,4)||'-'||substr(ymd,5,2)||'-'||substr(ymd,7,2) iso_date, ymd FROM params),
base AS (
  SELECT service_id FROM calendar, iso
  WHERE calendar.start_date <= iso.ymd AND calendar.end_date >= iso.ymd
  AND (
    (strftime('%w', iso.iso_date) = '0' AND sunday = 1) OR
    (strftime('%w', iso.iso_date) = '1' AND monday = 1) OR
    (strftime('%w', iso.iso_date) = '2' AND tuesday = 1) OR
    (strftime('%w', iso.iso_date) = '3' AND wednesday = 1) OR
    (strftime('%w', iso.iso_date) = '4' AND thursday = 1) OR
    (strftime('%w', iso.iso_date) = '5' AND friday = 1) OR
    (strftime('%w', iso.iso_date) = '6' AND saturday = 1)
  )
),
exceptions AS (
  SELECT service_id, exception_type FROM calendar_dates WHERE date = (SELECT ymd FROM params)
),
active AS (
  SELECT service_id FROM base WHERE service_id NOT IN (SELECT service_id FROM exceptions WHERE exception_type = 2)
  UNION
  SELECT service_id FROM exceptions WHERE exception_type = 1
)
SELECT DISTINCT service_id FROM active;`

  const rows = await dbAll(sql, [ymd])
  return rows.map((r) => r.service_id)
}

export async function generateShapesFromTrips(): Promise<void> {
  await dbAll(`CREATE TABLE IF NOT EXISTS generated_shapes (
    shape_id TEXT PRIMARY KEY,
    route_id TEXT,
    direction_id INTEGER,
    points_json TEXT,
    created_at TEXT
  )`)

  const pairs = await dbAll('SELECT DISTINCT route_id, direction_id FROM trips')

  for (const p of pairs) {
    const routeId = p.route_id
    const direction = p.direction_id

    let tripRow: any
    if (direction === null || direction === undefined) {
      tripRow = await dbGet(
        `SELECT st.trip_id, COUNT(*) AS cnt FROM stop_times st JOIN trips t USING(trip_id)
         WHERE t.route_id = ? AND t.direction_id IS NULL
         GROUP BY st.trip_id ORDER BY cnt DESC LIMIT 1`,
        [routeId]
      )
    } else {
      tripRow = await dbGet(
        `SELECT st.trip_id, COUNT(*) AS cnt FROM stop_times st JOIN trips t USING(trip_id)
         WHERE t.route_id = ? AND t.direction_id = ?
         GROUP BY st.trip_id ORDER BY cnt DESC LIMIT 1`,
        [routeId, direction]
      )
    }

    if (!tripRow?.trip_id) continue

    const pts = await dbAll(
      `SELECT s.stop_lat AS lat, s.stop_lon AS lon, st.stop_sequence AS seq
       FROM stop_times st JOIN stops s USING(stop_id)
       WHERE st.trip_id = ?
       ORDER BY st.stop_sequence`,
      [tripRow.trip_id]
    )

    if (!pts.length) continue

    const dirKey = direction ?? 'null'
    const shapeId = `${routeId}__${dirKey}`
    const now = new Date().toISOString()
    await dbAll(
      `REPLACE INTO generated_shapes(shape_id, route_id, direction_id, points_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [shapeId, routeId, direction ?? null, JSON.stringify(pts), now]
    )
  }
}

export const GtfsDb = { dbAll, dbGet }
