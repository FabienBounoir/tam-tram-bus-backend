import type { HttpContext } from '@adonisjs/core/http'
import {
  GtfsDb,
  generateShapesFromTrips,
  getActiveServiceIds,
  timeToSeconds,
} from '#services/gtfs_service'

export default class GtfsController {
  async stationNames({ response }: HttpContext) {
    const sql = `
      SELECT MIN(stop_name) AS name,
             COUNT(*) AS variants,
             MIN(stop_id) AS sample_stop_id,
             AVG(stop_lat) AS avg_lat,
             AVG(stop_lon) AS avg_lon
      FROM stops
      GROUP BY LOWER(stop_name)
      ORDER BY LOWER(name)
    `

    const rows = await GtfsDb.dbAll(sql, [])
    const names = rows.map((r) => ({
      name: r.name,
      variants: r.variants,
      sample_stop_id: r.sample_stop_id,
      avg_lat: r.avg_lat,
      avg_lon: r.avg_lon,
    }))

    return response.ok({ ok: true, count: names.length, names })
  }

  async stopsByName({ request, response }: HttpContext) {
    const name = request.input('name')
    if (!name) return response.badRequest({ error: 'name query param required' })

    const sql = `SELECT s.stop_id, s.stop_name, s.parent_station, s.stop_lat, s.stop_lon,
        GROUP_CONCAT(DISTINCT r.route_id || '|' || r.route_short_name || '|' || COALESCE(t.direction_id, '')) AS routes_concat
      FROM stops s
      JOIN stop_times st USING(stop_id)
      JOIN trips t USING(trip_id)
      JOIN routes r USING(route_id)
      WHERE s.stop_name LIKE ? COLLATE NOCASE
      GROUP BY s.stop_id, s.stop_name, s.parent_station, s.stop_lat, s.stop_lon
      ORDER BY s.stop_id`

    const rows = await GtfsDb.dbAll(sql, [`%${name}%`])
    const result = rows.map((r) => {
      const routes = r.routes_concat
        ? r.routes_concat.split(',').map((item: string) => {
            const parts = item.split('|')
            return {
              route_id: parts[0],
              route_short_name: parts[1],
              direction_id: parts[2] === '' ? null : Number(parts[2]),
            }
          })
        : []
      return {
        stop_id: r.stop_id,
        stop_name: r.stop_name,
        parent_station: r.parent_station,
        stop_lat: r.stop_lat,
        stop_lon: r.stop_lon,
        routes,
      }
    })

    return response.ok({ stops: result })
  }

  async stopIdsForNameAndRoute({ request, response }: HttpContext) {
    const name = request.input('name')
    const routeId = request.input('route_id')
    const routeShort = request.input('route_short_name') || request.input('route_short')
    if (!name || (!routeId && !routeShort)) {
      return response.badRequest({ error: 'name and route_id or route_short_name required' })
    }

    let sql = `SELECT DISTINCT st.stop_id, s.stop_name, s.parent_station, s.stop_lat, s.stop_lon, r.route_id, r.route_short_name
      FROM stops s
      JOIN stop_times st USING(stop_id)
      JOIN trips t USING(trip_id)
      JOIN routes r USING(route_id)
      WHERE s.stop_name LIKE ? COLLATE NOCASE`

    const params = [`%${name}%`]
    if (routeId) {
      sql += ' AND r.route_id = ?'
      params.push(routeId)
    } else if (routeShort) {
      sql += ' AND r.route_short_name = ?'
      params.push(routeShort)
    }
    sql += ' ORDER BY st.stop_id'

    const rows = await GtfsDb.dbAll(sql, params)
    return response.ok({ stops: rows })
  }

  async routesByStop({ request, response }: HttpContext) {
    const stopId = request.input('stop_id') || request.input('stopId')
    if (!stopId) return response.badRequest({ error: 'stop_id query param required' })

    const sql = `SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name, t.direction_id,
        GROUP_CONCAT(DISTINCT t.trip_headsign) AS headsigns,
        (SELECT stop_name FROM stop_times st2 JOIN stops s2 ON st2.stop_id = s2.stop_id
         WHERE st2.trip_id = t.trip_id ORDER BY st2.stop_sequence LIMIT 1) AS start_stop_name,
        (SELECT stop_name FROM stop_times st3 JOIN stops s3 ON st3.stop_id = s3.stop_id
         WHERE st3.trip_id = t.trip_id ORDER BY st3.stop_sequence DESC LIMIT 1) AS end_stop_name
      FROM stop_times st
      JOIN trips t USING(trip_id)
      JOIN routes r USING(route_id)
      WHERE st.stop_id = ?
      GROUP BY r.route_id, r.route_short_name, r.route_long_name, t.direction_id
      ORDER BY r.route_short_name`

    const rows = await GtfsDb.dbAll(sql, [stopId])
    const result = rows.map((r) => ({
      route_id: r.route_id,
      route_short_name: r.route_short_name,
      route_long_name: r.route_long_name,
      direction_id: r.direction_id === null ? null : Number(r.direction_id),
      trip_headsigns: r.headsigns ? r.headsigns.split(',') : [],
      start_stop_name: r.start_stop_name,
      end_stop_name: r.end_stop_name,
    }))

    return response.ok({ routes: result })
  }

  async nextDepartures({ request, response }: HttpContext) {
    const stopId = request.input('stop_id') || request.input('stopId')
    const limit = Number.parseInt(request.input('limit') || '10', 10)
    if (!stopId) return response.badRequest({ error: 'stop_id query param required' })

    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const ymd = `${y}${m}${d}`

    const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
    const serviceIds = await getActiveServiceIds(ymd)

    if (!serviceIds.length) {
      return response.ok({ departures: [] })
    }

    const placeholders = serviceIds.map(() => '?').join(',')
    const sql = `SELECT st.trip_id, st.stop_id, st.stop_sequence, st.arrival_time, st.departure_time,
        t.service_id, t.route_id, t.trip_headsign, r.route_short_name, r.route_long_name
      FROM stop_times st
      JOIN trips t USING(trip_id)
      LEFT JOIN routes r USING(route_id)
      WHERE st.stop_id = ? AND t.service_id IN (${placeholders})`

    const rows = await GtfsDb.dbAll(sql, [stopId, ...serviceIds])

    const upcoming = rows
      .map((r) => ({
        ...r,
        departure_seconds: timeToSeconds(r.departure_time),
        arrival_seconds: timeToSeconds(r.arrival_time),
      }))
      .filter((r) => r.departure_seconds !== null)
      .filter((r) => r.departure_seconds >= currentSeconds - 60)
      .sort((a, b) => (a.departure_seconds as number) - (b.departure_seconds as number))
      .slice(0, limit)
      .map((r) => ({
        trip_id: r.trip_id,
        service_id: r.service_id,
        route_id: r.route_id,
        route_short_name: r.route_short_name,
        route_long_name: r.route_long_name,
        trip_headsign: r.trip_headsign,
        departure_time: r.departure_time,
        arrival_time: r.arrival_time,
      }))

    return response.ok({ departures: upcoming })
  }

  async stopsNear({ request, response }: HttpContext) {
    const lat = Number.parseFloat(request.input('lat'))
    const lon = Number.parseFloat(request.input('lon'))
    const radiusKm = Number.parseFloat(request.input('radius') || '0.5')
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return response.badRequest({ error: 'lat and lon query params required' })
    }

    const delta = radiusKm / 111
    const sql = `SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops
      WHERE stop_lat BETWEEN ? AND ? AND stop_lon BETWEEN ? AND ?`

    const rows = await GtfsDb.dbAll(sql, [lat - delta, lat + delta, lon - delta, lon + delta])

    const toRad = (v: number) => (v * Math.PI) / 180
    const haversine = (aLat: number, aLon: number, bLat: number, bLon: number) => {
      const R = 6371e3
      const phi1 = toRad(aLat)
      const phi2 = toRad(bLat)
      const dPhi = toRad(bLat - aLat)
      const dLambda = toRad(bLon - aLon)
      const A =
        Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2)
      const C = 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1 - A))
      return R * C
    }

    const annotated = rows
      .map((r) => ({ ...r, distance_m: haversine(lat, lon, r.stop_lat, r.stop_lon) }))
      .sort((a, b) => a.distance_m - b.distance_m)

    return response.ok({ stops: annotated.slice(0, 100) })
  }

  async shape({ request, response }: HttpContext) {
    const shapeId = request.input('shape_id') || request.input('shapeId')
    if (!shapeId) return response.badRequest({ error: 'shape_id required' })

    const rows = await GtfsDb.dbAll(
      'SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence AS seq FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence',
      [shapeId]
    )

    return response.ok({ shape_id: shapeId, points: rows })
  }

  async shapeByRoute({ request, response }: HttpContext) {
    const routeId = request.input('route_id')
    const dirParam = request.input('direction_id')
    if (!routeId) return response.badRequest({ error: 'route_id required' })

    let direction: number | null = null
    if (dirParam !== undefined && dirParam !== 'null') {
      direction = Number(dirParam)
    }

    const hasShapes = await GtfsDb.dbGet(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='shapes'"
    )

    if (hasShapes) {
      let shapeRow: any
      if (direction === null) {
        shapeRow = await GtfsDb.dbGet(
          `SELECT shape_id, COUNT(*) AS cnt FROM trips WHERE route_id = ? AND shape_id IS NOT NULL
           GROUP BY shape_id ORDER BY cnt DESC LIMIT 1`,
          [routeId]
        )
      } else {
        shapeRow = await GtfsDb.dbGet(
          `SELECT shape_id, COUNT(*) AS cnt FROM trips WHERE route_id = ? AND direction_id = ? AND shape_id IS NOT NULL
           GROUP BY shape_id ORDER BY cnt DESC LIMIT 1`,
          [routeId, direction]
        )
      }

      if (shapeRow?.shape_id) {
        const rows = await GtfsDb.dbAll(
          'SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence AS seq FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence',
          [shapeRow.shape_id]
        )
        return response.ok({
          route_id: routeId,
          direction_id: direction,
          shape_id: shapeRow.shape_id,
          points: rows,
        })
      }
    }

    let row: any
    if (direction === null) {
      row = await GtfsDb.dbGet(
        'SELECT points_json FROM generated_shapes WHERE route_id = ? AND direction_id IS NULL',
        [routeId]
      )
    } else {
      row = await GtfsDb.dbGet(
        'SELECT points_json FROM generated_shapes WHERE route_id = ? AND direction_id = ?',
        [routeId, direction]
      )
    }

    if (!row) return response.notFound({ error: 'shape not found for route/direction' })

    const points = JSON.parse(row.points_json)
    return response.ok({ route_id: routeId, direction_id: direction, points })
  }

  async shapes({ response }: HttpContext) {
    const hasShapes = await GtfsDb.dbGet(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='shapes'"
    )
    if (hasShapes) {
      const countRow = await GtfsDb.dbGet('SELECT COUNT(*) AS c FROM shapes')
      const total = countRow?.c ?? 0
      if (total > 0) {
        const rows = await GtfsDb.dbAll(
          'SELECT shape_id, COUNT(*) AS pts_count FROM shapes GROUP BY shape_id ORDER BY shape_id'
        )
        return response.ok({ source: 'shapes_table', shapes: rows })
      }
    }

    const genExists = await GtfsDb.dbGet(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='generated_shapes'"
    )
    if (genExists) {
      const rows = await GtfsDb.dbAll(
        'SELECT shape_id, route_id, direction_id, created_at FROM generated_shapes ORDER BY route_id'
      )
      return response.ok({ source: 'generated_shapes', shapes: rows })
    }

    return response.ok({ source: 'none', shapes: [] })
  }

  async shapeFromTrip({ request, response }: HttpContext) {
    const tripId = request.input('trip_id')
    if (!tripId) return response.badRequest({ error: 'trip_id required' })

    const hasShapes = await GtfsDb.dbGet(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='shapes'"
    )
    if (hasShapes) {
      const tripRow = await GtfsDb.dbGet('SELECT shape_id FROM trips WHERE trip_id = ?', [tripId])
      if (tripRow?.shape_id) {
        const rows = await GtfsDb.dbAll(
          'SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence AS seq FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence',
          [tripRow.shape_id]
        )
        return response.ok({ trip_id: tripId, shape_id: tripRow.shape_id, points: rows })
      }
    }

    const pts = await GtfsDb.dbAll(
      `SELECT s.stop_lat AS lat, s.stop_lon AS lon, st.stop_sequence AS seq
       FROM stop_times st JOIN stops s USING(stop_id)
       WHERE st.trip_id = ?
       ORDER BY st.stop_sequence`,
      [tripId]
    )

    return response.ok({ trip_id: tripId, points: pts })
  }

  async generateShapes({ response }: HttpContext) {
    await generateShapesFromTrips()
    return response.ok({ ok: true, message: 'Shape generation triggered' })
  }
}
