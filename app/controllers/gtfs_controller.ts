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

    const includeRoutesRaw = request.input('include_routes') ?? request.input('includeRoutes')
    const includeRoutes =
      includeRoutesRaw === true ||
      includeRoutesRaw === 'true' ||
      includeRoutesRaw === '1' ||
      includeRoutesRaw === 1

    if (!includeRoutes) {
      const sql = `SELECT stop_id, stop_name, parent_station, stop_lat, stop_lon
        FROM stops
        WHERE stop_name LIKE ? COLLATE NOCASE
        ORDER BY stop_id`

      const rows = await GtfsDb.dbAll(sql, [`%${name}%`])
      return response.ok({ stops: rows })
    }

    const stopsSql = `SELECT stop_id, stop_name, parent_station, stop_lat, stop_lon
      FROM stops
      WHERE stop_name LIKE ? COLLATE NOCASE
      ORDER BY stop_id`

    const stopsRows = await GtfsDb.dbAll(stopsSql, [`%${name}%`])

    const routesSql = `WITH base AS (
        SELECT s.stop_id, r.route_id, r.route_short_name, r.route_long_name, t.direction_id,
               GROUP_CONCAT(DISTINCT t.trip_headsign) AS headsigns,
               MIN(t.trip_id) AS rep_trip_id
        FROM stops s
        JOIN stop_times st USING(stop_id)
        JOIN trips t USING(trip_id)
        JOIN routes r USING(route_id)
        WHERE s.stop_name LIKE ? COLLATE NOCASE
        GROUP BY s.stop_id, r.route_id, r.route_short_name, r.route_long_name, t.direction_id
      )
      SELECT base.*, 
        (SELECT stop_name FROM stop_times st2 JOIN stops s2 ON st2.stop_id = s2.stop_id
         WHERE st2.trip_id = base.rep_trip_id ORDER BY st2.stop_sequence LIMIT 1) AS start_stop_name,
        (SELECT stop_name FROM stop_times st3 JOIN stops s3 ON st3.stop_id = s3.stop_id
         WHERE st3.trip_id = base.rep_trip_id ORDER BY st3.stop_sequence DESC LIMIT 1) AS end_stop_name
      FROM base
      ORDER BY stop_id`

    const routesRows = await GtfsDb.dbAll(routesSql, [`%${name}%`])
    const routesByStop = new Map<string, any[]>()

    routesRows.forEach((row) => {
      const list = routesByStop.get(row.stop_id) ?? []
      list.push({
        route_id: row.route_id,
        route_short_name: row.route_short_name,
        route_long_name: row.route_long_name || null,
        direction_id: row.direction_id === null ? null : Number(row.direction_id),
        headsigns: row.headsigns ? String(row.headsigns).split(',') : [],
        start_stop_name: row.start_stop_name || null,
        end_stop_name: row.end_stop_name || null,
      })
      routesByStop.set(row.stop_id, list)
    })

    const result = stopsRows.map((stop) => ({
      ...stop,
      routes: routesByStop.get(stop.stop_id) ?? [],
    }))

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
    const nowUnix = Math.floor(now.getTime() / 1000)
    const formatYmd = (date: Date) => {
      const y = date.getFullYear()
      const m = String(date.getMonth() + 1).padStart(2, '0')
      const d = String(date.getDate()).padStart(2, '0')
      return `${y}${m}${d}`
    }
    const ymdToday = formatYmd(now)
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const ymdTomorrow = formatYmd(tomorrow)

    const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
    const todayServiceIds = await getActiveServiceIds(ymdToday)
    const tomorrowServiceIds = await getActiveServiceIds(ymdTomorrow)
    const allServiceIds = Array.from(new Set([...todayServiceIds, ...tomorrowServiceIds]))

    if (!allServiceIds.length) {
      return response.ok({ departures: [] })
    }

    const placeholders = allServiceIds.map(() => '?').join(',')
    const sql = `SELECT st.trip_id, st.stop_id, st.stop_sequence, st.arrival_time, st.departure_time,
        t.service_id, t.route_id, t.trip_headsign, r.route_short_name, r.route_long_name,
        rt.arrival_delay, rt.departure_delay, rt.created_timestamp AS realtime_updated_at
      FROM stop_times st
      JOIN trips t USING(trip_id)
      LEFT JOIN routes r USING(route_id)
      LEFT JOIN (
        SELECT u.* FROM stop_time_updates u
        JOIN (
          SELECT trip_id, stop_id, MAX(created_timestamp) AS max_ts
          FROM stop_time_updates
          WHERE stop_id = ? AND (expiration_timestamp IS NULL OR expiration_timestamp > ?)
          GROUP BY trip_id, stop_id
        ) latest
        ON u.trip_id = latest.trip_id AND u.stop_id = latest.stop_id AND u.created_timestamp = latest.max_ts
      ) rt ON rt.trip_id = st.trip_id AND rt.stop_id = st.stop_id
      WHERE st.stop_id = ? AND t.service_id IN (${placeholders})`

    const rows = await GtfsDb.dbAll(sql, [stopId, nowUnix, stopId, ...allServiceIds])

    const toNumber = (value: unknown): number | null => {
      if (value === null || value === undefined) return null
      const num = Number(value)
      return Number.isNaN(num) ? null : num
    }

    const formatSeconds = (totalSeconds: number | null): string | null => {
      if (totalSeconds === null) return null
      const sign = totalSeconds < 0 ? -1 : 1
      const abs = Math.abs(totalSeconds)
      const h = Math.floor(abs / 3600)
      const m = Math.floor((abs % 3600) / 60)
      const s = Math.floor(abs % 60)
      const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      return sign < 0 ? `-${base}` : base
    }

    const todayServiceSet = new Set(todayServiceIds)
    const tomorrowServiceSet = new Set(tomorrowServiceIds)

    const upcoming = rows
      .map((r) => ({
        ...r,
        departure_seconds: timeToSeconds(r.departure_time),
        arrival_seconds: timeToSeconds(r.arrival_time),
      }))
      .flatMap((r) => {
        const delaySeconds = toNumber(r.departure_delay) ?? toNumber(r.arrival_delay)
        const baseRealtimeDepartureSeconds =
          delaySeconds !== null && r.departure_seconds !== null
            ? (r.departure_seconds as number) + delaySeconds
            : r.departure_seconds
        const baseRealtimeArrivalSeconds =
          delaySeconds !== null && r.arrival_seconds !== null
            ? (r.arrival_seconds as number) + delaySeconds
            : r.arrival_seconds

        const candidates: any[] = []
        if (todayServiceSet.has(r.service_id)) {
          candidates.push({ day_offset: 0 })
        }

        if (
          tomorrowServiceSet.has(r.service_id) &&
          r.departure_seconds !== null &&
          (r.departure_seconds as number) < 24 * 3600
        ) {
          candidates.push({ day_offset: 24 * 3600 })
        }

        return candidates.map((candidate) => {
          const realtimeDepartureSeconds =
            baseRealtimeDepartureSeconds === null
              ? null
              : baseRealtimeDepartureSeconds + candidate.day_offset
          const realtimeArrivalSeconds =
            baseRealtimeArrivalSeconds === null ? null : baseRealtimeArrivalSeconds + candidate.day_offset

          return {
            ...r,
            delay_seconds: delaySeconds,
            realtime_departure_seconds: realtimeDepartureSeconds,
            realtime_arrival_seconds: realtimeArrivalSeconds,
            realtime_departure_time: formatSeconds(realtimeDepartureSeconds),
            realtime_arrival_time: formatSeconds(realtimeArrivalSeconds),
            realtime_updated: delaySeconds !== null && delaySeconds !== 0,
          }
        })
      })
      .filter((r) => r.realtime_departure_seconds !== null)
      .filter((r) => (r.realtime_departure_seconds as number) >= currentSeconds - 60)
      .sort(
        (a, b) =>
          (a.realtime_departure_seconds as number) - (b.realtime_departure_seconds as number)
      )
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
        realtime_departure_time: r.realtime_departure_time,
        realtime_arrival_time: r.realtime_arrival_time,
        delay_seconds: r.delay_seconds,
        delay_minutes: r.delay_seconds === null ? null : Number((r.delay_seconds / 60).toFixed(1)),
        realtime_updated: r.realtime_updated,
        realtime_updated_at: r.realtime_updated_at ?? null,
      }))

    return response.ok({ departures: upcoming })
  }

  async tripStopTimes({ request, response }: HttpContext) {
    const tripId = request.input('trip_id') || request.input('tripId')
    if (!tripId) return response.badRequest({ error: 'trip_id query param required' })

    const fromStopId = request.input('from_stop_id') || request.input('fromStopId')
    const toStopId = request.input('to_stop_id') || request.input('toStopId')
    const fromSequenceRaw = request.input('from_stop_sequence') || request.input('fromStopSequence')
    const toSequenceRaw = request.input('to_stop_sequence') || request.input('toStopSequence')

    const fromSequence =
      fromSequenceRaw === undefined || fromSequenceRaw === null
        ? null
        : Number.parseInt(String(fromSequenceRaw), 10)
    const toSequence =
      toSequenceRaw === undefined || toSequenceRaw === null
        ? null
        : Number.parseInt(String(toSequenceRaw), 10)

    if (fromSequenceRaw !== undefined && Number.isNaN(fromSequence as number)) {
      return response.badRequest({ error: 'from_stop_sequence must be a valid number' })
    }

    if (toSequenceRaw !== undefined && Number.isNaN(toSequence as number)) {
      return response.badRequest({ error: 'to_stop_sequence must be a valid number' })
    }

    const nowUnix = Math.floor(Date.now() / 1000)

    const sql = `SELECT st.trip_id, st.stop_id, st.stop_sequence, st.arrival_time, st.departure_time,
        s.stop_name,
        t.route_id, t.service_id, t.direction_id, t.trip_headsign,
        r.route_short_name, r.route_long_name,
        rt.arrival_delay, rt.departure_delay, rt.created_timestamp AS realtime_updated_at
      FROM stop_times st
      JOIN stops s USING(stop_id)
      JOIN trips t USING(trip_id)
      LEFT JOIN routes r USING(route_id)
      LEFT JOIN (
        SELECT u.* FROM stop_time_updates u
        JOIN (
          SELECT trip_id, stop_id, MAX(created_timestamp) AS max_ts
          FROM stop_time_updates
          WHERE trip_id = ? AND (expiration_timestamp IS NULL OR expiration_timestamp > ?)
          GROUP BY trip_id, stop_id
        ) latest
        ON u.trip_id = latest.trip_id AND u.stop_id = latest.stop_id AND u.created_timestamp = latest.max_ts
      ) rt ON rt.trip_id = st.trip_id AND rt.stop_id = st.stop_id
      WHERE st.trip_id = ?
      ORDER BY st.stop_sequence`

    const rows = await GtfsDb.dbAll(sql, [tripId, nowUnix, tripId])

    if (!rows.length) {
      return response.notFound({ error: 'trip_id not found' })
    }

    const toNumber = (value: unknown): number | null => {
      if (value === null || value === undefined) return null
      const num = Number(value)
      return Number.isNaN(num) ? null : num
    }

    const formatSeconds = (totalSeconds: number | null): string | null => {
      if (totalSeconds === null) return null
      const sign = totalSeconds < 0 ? -1 : 1
      const abs = Math.abs(totalSeconds)
      const h = Math.floor(abs / 3600)
      const m = Math.floor((abs % 3600) / 60)
      const s = Math.floor(abs % 60)
      const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      return sign < 0 ? `-${base}` : base
    }

    const stops = rows.map((row) => {
      const arrivalSeconds = timeToSeconds(row.arrival_time)
      const departureSeconds = timeToSeconds(row.departure_time)
      const arrivalDelay = toNumber(row.arrival_delay)
      const departureDelay = toNumber(row.departure_delay)
      const fallbackDelay = arrivalDelay ?? departureDelay
      const effectiveArrivalDelay = arrivalDelay ?? departureDelay ?? 0
      const effectiveDepartureDelay = departureDelay ?? arrivalDelay ?? 0

      const realtimeArrivalSeconds =
        arrivalSeconds === null ? null : (arrivalSeconds as number) + effectiveArrivalDelay
      const realtimeDepartureSeconds =
        departureSeconds === null ? null : (departureSeconds as number) + effectiveDepartureDelay

      return {
        stop_id: row.stop_id,
        stop_name: row.stop_name,
        stop_sequence: Number(row.stop_sequence),
        arrival_time: row.arrival_time,
        departure_time: row.departure_time,
        arrival_seconds: arrivalSeconds,
        departure_seconds: departureSeconds,
        realtime_arrival_time: formatSeconds(realtimeArrivalSeconds),
        realtime_departure_time: formatSeconds(realtimeDepartureSeconds),
        realtime_arrival_seconds: realtimeArrivalSeconds,
        realtime_departure_seconds: realtimeDepartureSeconds,
        arrival_delay_seconds: arrivalDelay,
        departure_delay_seconds: departureDelay,
        delay_seconds: fallbackDelay,
        delay_minutes: fallbackDelay === null ? null : Number((fallbackDelay / 60).toFixed(1)),
        realtime_available: arrivalDelay !== null || departureDelay !== null,
        realtime_updated: (arrivalDelay ?? 0) !== 0 || (departureDelay ?? 0) !== 0,
        realtime_updated_at: row.realtime_updated_at ?? null,
      }
    })

    const findIndex = (stopId: string | null, sequence: number | null, minIndex = 0): number => {
      if (sequence !== null) {
        return stops.findIndex((s, index) => index >= minIndex && s.stop_sequence === sequence)
      }

      if (stopId) {
        return stops.findIndex((s, index) => index >= minIndex && s.stop_id === stopId)
      }

      return -1
    }

    const fromIndex = findIndex(fromStopId ?? null, fromSequence)
    const toIndex = findIndex(toStopId ?? null, toSequence, fromIndex === -1 ? 0 : fromIndex + 1)

    if ((fromStopId || fromSequence !== null) && fromIndex === -1) {
      return response.notFound({
        error: 'from stop not found in this trip',
        from_stop_id: fromStopId ?? null,
        from_stop_sequence: fromSequence,
      })
    }

    if ((toStopId || toSequence !== null) && toIndex === -1) {
      return response.notFound({
        error: 'to stop not found after from stop in this trip',
        to_stop_id: toStopId ?? null,
        to_stop_sequence: toSequence,
      })
    }

    const fromStop = fromIndex === -1 ? null : stops[fromIndex]
    const toStop = toIndex === -1 ? null : stops[toIndex]

    const scheduledTravelSeconds =
      fromStop && toStop && fromStop.departure_seconds !== null && toStop.arrival_seconds !== null
        ? (toStop.arrival_seconds as number) - (fromStop.departure_seconds as number)
        : null

    const realtimeTravelSeconds =
      fromStop &&
      toStop &&
      fromStop.realtime_departure_seconds !== null &&
      toStop.realtime_arrival_seconds !== null
        ? (toStop.realtime_arrival_seconds as number) -
          (fromStop.realtime_departure_seconds as number)
        : null

    const first = rows[0]

    return response.ok({
      trip: {
        trip_id: first.trip_id,
        route_id: first.route_id,
        route_short_name: first.route_short_name,
        route_long_name: first.route_long_name,
        service_id: first.service_id,
        direction_id: first.direction_id === null ? null : Number(first.direction_id),
        trip_headsign: first.trip_headsign,
      },
      journey:
        fromStop && toStop
          ? {
              from_stop_id: fromStop.stop_id,
              from_stop_name: fromStop.stop_name,
              from_stop_sequence: fromStop.stop_sequence,
              to_stop_id: toStop.stop_id,
              to_stop_name: toStop.stop_name,
              to_stop_sequence: toStop.stop_sequence,
              scheduled_travel_seconds: scheduledTravelSeconds,
              scheduled_travel_minutes:
                scheduledTravelSeconds === null
                  ? null
                  : Number((scheduledTravelSeconds / 60).toFixed(1)),
              realtime_travel_seconds: realtimeTravelSeconds,
              realtime_travel_minutes:
                realtimeTravelSeconds === null ? null : Number((realtimeTravelSeconds / 60).toFixed(1)),
              delta_seconds:
                scheduledTravelSeconds === null || realtimeTravelSeconds === null
                  ? null
                  : realtimeTravelSeconds - scheduledTravelSeconds,
            }
          : null,
      stops,
    })
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

    const hasShapes = await GtfsDb.dbGet(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='shapes'"
    )

    if (hasShapes) {
      const rows = await GtfsDb.dbAll(
        'SELECT shape_pt_lat AS lat, shape_pt_lon AS lon, shape_pt_sequence AS seq FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence',
        [shapeId]
      )

      if (rows.length) {
        return response.ok({ shape_id: shapeId, points: rows, source: 'shapes_table' })
      }
    }

    const hasGeneratedShapes = await GtfsDb.dbGet(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='generated_shapes'"
    )

    if (hasGeneratedShapes) {
      const generated = await GtfsDb.dbGet(
        'SELECT points_json FROM generated_shapes WHERE shape_id = ?',
        [shapeId]
      )

      if (generated?.points_json) {
        const points = JSON.parse(generated.points_json)
        return response.ok({ shape_id: shapeId, points, source: 'generated_shapes' })
      }
    }

    return response.notFound({ error: 'shape not found' })
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
