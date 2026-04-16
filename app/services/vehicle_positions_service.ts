import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { GtfsDb } from '#services/gtfs_service'

export type VehicleFeedSource = 'urbain' | 'suburbain'
export type VehicleFeedSourceSelection = VehicleFeedSource | 'all'

const VEHICLE_FEEDS: Record<VehicleFeedSource, string> = {
  urbain: 'https://data.montpellier3m.fr/GTFS/Urbain/VehiclePosition.pb',
  suburbain: 'https://data.montpellier3m.fr/GTFS/Suburbain/VehiclePosition.pb',
}

const CACHE_TTL_MS = 10_000
const FETCH_TIMEOUT_MS = 10_000

const VEHICLE_STOP_STATUS: Record<number, string> = {
  0: 'INCOMING_AT',
  1: 'STOPPED_AT',
  2: 'IN_TRANSIT_TO',
}

const CONGESTION_LEVEL: Record<number, string> = {
  0: 'UNKNOWN_CONGESTION_LEVEL',
  1: 'RUNNING_SMOOTHLY',
  2: 'STOP_AND_GO',
  3: 'CONGESTION',
  4: 'SEVERE_CONGESTION',
}

const OCCUPANCY_STATUS: Record<number, string> = {
  0: 'EMPTY',
  1: 'MANY_SEATS_AVAILABLE',
  2: 'FEW_SEATS_AVAILABLE',
  3: 'STANDING_ROOM_ONLY',
  4: 'CRUSHED_STANDING_ROOM_ONLY',
  5: 'FULL',
  6: 'NOT_ACCEPTING_PASSENGERS',
  7: 'NO_DATA_AVAILABLE',
  8: 'NOT_BOARDABLE',
}

const feedCache = new Map<VehicleFeedSource, { fetchedAtMs: number; snapshot: FeedSnapshot }>()

export interface VehiclePositionItem {
  source: VehicleFeedSource
  entity_id: string | null
  trip_id: string | null
  route_id: string | null
  route_short_name: string | null
  route_long_name: string | null
  direction_id: number | null
  start_date: string | null
  start_time: string | null
  vehicle_id: string | null
  vehicle_label: string | null
  vehicle_license_plate: string | null
  latitude: number
  longitude: number
  bearing: number | null
  speed: number | null
  current_stop_sequence: number | null
  vehicle_stop_status: string | null
  congestion_level: string | null
  occupancy_status: string | null
  timestamp: number | null
  timestamp_iso: string | null
}

interface FeedSnapshot {
  source: VehicleFeedSource
  fetched_at: number
  feed_timestamp: number | null
  vehicles: VehiclePositionItem[]
  error: string | null
}

export interface VehiclePositionsOptions {
  source?: VehicleFeedSourceSelection
  line?: string | null
  routeId?: string | null
  routeShortName?: string | null
  forceRefresh?: boolean
}

export interface VehiclePositionsResult {
  filters: {
    source: VehicleFeedSourceSelection
    line: string | null
    route_id: string | null
    route_short_name: string | null
  }
  source_stats: Array<{
    source: VehicleFeedSource
    vehicle_count: number
    fetched_at: number
    fetched_at_iso: string | null
    feed_timestamp: number | null
    feed_timestamp_iso: string | null
    error: string | null
  }>
  errors: Array<{ source: VehicleFeedSource; message: string }>
  vehicle_count: number
  vehicles: VehiclePositionItem[]
}

export interface VehicleLinesResult {
  filters: {
    source: VehicleFeedSourceSelection
    search: string | null
  }
  source_stats: VehiclePositionsResult['source_stats']
  errors: VehiclePositionsResult['errors']
  line_count: number
  lines: Array<{
    route_id: string | null
    route_short_name: string | null
    route_long_name: string | null
    vehicle_count: number
    sources: VehicleFeedSource[]
  }>
}

export function isVehicleFeedSourceSelection(
  source: string | null | undefined
): source is VehicleFeedSourceSelection {
  return source === 'all' || source === 'urbain' || source === 'suburbain'
}

function normalizeText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length ? text : null
}

function normalizeForSearch(value: string | null): string | null {
  if (!value) return null
  return value.toLowerCase().replace(/\s+/g, '')
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }

  if (typeof value === 'object') {
    const obj = value as { toNumber?: () => number; toString?: () => string }
    if (typeof obj.toNumber === 'function') {
      const num = obj.toNumber()
      return Number.isFinite(num) ? num : null
    }
    if (typeof obj.toString === 'function') {
      const num = Number(obj.toString())
      return Number.isFinite(num) ? num : null
    }
  }

  return null
}

function unixToIso(ts: number | null): string | null {
  if (ts === null) return null
  const date = new Date(ts * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function enumToLabel(dictionary: Record<number, string>, value: unknown): string | null {
  const num = toNumber(value)
  if (num === null) return null
  const key = Math.trunc(num)
  return dictionary[key] ?? String(key)
}

function selectSources(source: VehicleFeedSourceSelection): VehicleFeedSource[] {
  if (source === 'urbain') return ['urbain']
  if (source === 'suburbain') return ['suburbain']
  return ['urbain', 'suburbain']
}

function toVehiclePosition(source: VehicleFeedSource, entity: any): VehiclePositionItem | null {
  const vehicle = entity?.vehicle
  const position = vehicle?.position

  const latitude = toNumber(position?.latitude)
  const longitude = toNumber(position?.longitude)
  if (latitude === null || longitude === null) return null

  const trip = vehicle?.trip ?? {}
  const vehicleDescriptor = vehicle?.vehicle ?? {}
  const directionId = toNumber(trip.directionId)
  const timestamp = toNumber(vehicle?.timestamp)

  return {
    source,
    entity_id: normalizeText(entity?.id),
    trip_id: normalizeText(trip.tripId),
    route_id: normalizeText(trip.routeId),
    route_short_name: null,
    route_long_name: null,
    direction_id: directionId === null ? null : Math.trunc(directionId),
    start_date: normalizeText(trip.startDate),
    start_time: normalizeText(trip.startTime),
    vehicle_id: normalizeText(vehicleDescriptor.id),
    vehicle_label: normalizeText(vehicleDescriptor.label),
    vehicle_license_plate: normalizeText(vehicleDescriptor.licensePlate),
    latitude,
    longitude,
    bearing: toNumber(position?.bearing),
    speed: toNumber(position?.speed),
    current_stop_sequence: toNumber(vehicle?.currentStopSequence),
    vehicle_stop_status: enumToLabel(VEHICLE_STOP_STATUS, vehicle?.currentStatus),
    congestion_level: enumToLabel(CONGESTION_LEVEL, vehicle?.congestionLevel),
    occupancy_status: enumToLabel(OCCUPANCY_STATUS, vehicle?.occupancyStatus),
    timestamp,
    timestamp_iso: unixToIso(timestamp),
  }
}

function filterVehicles(
  vehicles: VehiclePositionItem[],
  line: string | null,
  routeId: string | null,
  routeShortName: string | null
): VehiclePositionItem[] {
  const normalizedLine = normalizeForSearch(line)
  const normalizedRouteShort = normalizeForSearch(routeShortName)
  const routeIdFilter = normalizeText(routeId)

  return vehicles.filter((vehicle) => {
    if (routeIdFilter && vehicle.route_id !== routeIdFilter) return false

    if (normalizedRouteShort) {
      const shortName = normalizeForSearch(vehicle.route_short_name)
      if (!shortName || shortName !== normalizedRouteShort) return false
    }

    if (normalizedLine) {
      const candidates = [
        normalizeForSearch(vehicle.route_short_name),
        normalizeForSearch(vehicle.route_id),
      ].filter((value): value is string => Boolean(value))

      const match = candidates.some(
        (candidate) => candidate === normalizedLine || candidate.includes(normalizedLine)
      )

      if (!match) return false
    }

    return true
  })
}

async function enrichWithGtfsData(vehicles: VehiclePositionItem[]): Promise<void> {
  if (!vehicles.length) return

  const tripIdsWithoutRoute = Array.from(
    new Set(
      vehicles
        .filter((vehicle) => !vehicle.route_id && vehicle.trip_id)
        .map((vehicle) => vehicle.trip_id as string)
    )
  )

  if (tripIdsWithoutRoute.length) {
    const placeholders = tripIdsWithoutRoute.map(() => '?').join(',')
    const rows = await GtfsDb.dbAll(
      `SELECT trip_id, route_id, direction_id FROM trips WHERE trip_id IN (${placeholders})`,
      tripIdsWithoutRoute
    )
    const byTripId = new Map(
      rows.map((row) => [
        String(row.trip_id),
        { route_id: row.route_id, direction_id: row.direction_id },
      ])
    )

    for (const vehicle of vehicles) {
      if (vehicle.route_id || !vehicle.trip_id) continue
      const tripInfo = byTripId.get(vehicle.trip_id)
      if (!tripInfo) continue

      vehicle.route_id = normalizeText(tripInfo.route_id)
      if (vehicle.direction_id === null) {
        const directionId = toNumber(tripInfo.direction_id)
        vehicle.direction_id = directionId === null ? null : Math.trunc(directionId)
      }
    }
  }

  const routeIds = Array.from(
    new Set(
      vehicles.map((vehicle) => vehicle.route_id).filter((routeId): routeId is string => !!routeId)
    )
  )

  if (!routeIds.length) return

  const routePlaceholders = routeIds.map(() => '?').join(',')
  const routeRows = await GtfsDb.dbAll(
    `SELECT route_id, route_short_name, route_long_name FROM routes WHERE route_id IN (${routePlaceholders})`,
    routeIds
  )
  const routesById = new Map(
    routeRows.map((row) => [
      String(row.route_id),
      {
        route_short_name: normalizeText(row.route_short_name),
        route_long_name: normalizeText(row.route_long_name),
      },
    ])
  )

  for (const vehicle of vehicles) {
    if (!vehicle.route_id) continue
    const route = routesById.get(vehicle.route_id)
    if (!route) continue

    vehicle.route_short_name = route.route_short_name
    vehicle.route_long_name = route.route_long_name
  }
}

async function fetchSourceFeed(
  source: VehicleFeedSource,
  forceRefresh: boolean
): Promise<FeedSnapshot> {
  const nowMs = Date.now()
  const cached = feedCache.get(source)

  if (!forceRefresh && cached && nowMs - cached.fetchedAtMs <= CACHE_TTL_MS) {
    return cached.snapshot
  }

  const url = VEHICLE_FEEDS[source]
  let snapshot: FeedSnapshot

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: 'application/octet-stream',
      },
    })

    if (!res.ok) {
      throw new Error(`upstream ${res.status} ${res.statusText}`)
    }

    const arrayBuffer = await res.arrayBuffer()
    const message = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(arrayBuffer)
    ) as any
    const entities = Array.isArray(message?.entity) ? message.entity : []
    const vehicles = entities
      .map((entity: any) => toVehiclePosition(source, entity))
      .filter(
        (vehicle: VehiclePositionItem | null): vehicle is VehiclePositionItem => vehicle !== null
      )

    const feedTimestamp = toNumber(message?.header?.timestamp)
    snapshot = {
      source,
      fetched_at: Math.floor(nowMs / 1000),
      feed_timestamp: feedTimestamp,
      vehicles,
      error: null,
    }
  } catch (error: any) {
    snapshot = {
      source,
      fetched_at: Math.floor(nowMs / 1000),
      feed_timestamp: null,
      vehicles: [],
      error: normalizeText(error?.message) ?? 'unknown upstream error',
    }
  }

  feedCache.set(source, { fetchedAtMs: nowMs, snapshot })
  return snapshot
}

function sortVehicles(vehicles: VehiclePositionItem[]) {
  vehicles.sort((a, b) => {
    const routeA = a.route_short_name || a.route_id || ''
    const routeB = b.route_short_name || b.route_id || ''
    const routeCmp = routeA.localeCompare(routeB)
    if (routeCmp !== 0) return routeCmp

    const vehicleA = a.vehicle_label || a.vehicle_id || ''
    const vehicleB = b.vehicle_label || b.vehicle_id || ''
    return vehicleA.localeCompare(vehicleB)
  })
}

export async function getVehiclePositions(
  options: VehiclePositionsOptions = {}
): Promise<VehiclePositionsResult> {
  const source = options.source ?? 'all'
  const line = normalizeText(options.line)
  const routeId = normalizeText(options.routeId)
  const routeShortName = normalizeText(options.routeShortName)
  const forceRefresh = options.forceRefresh ?? false

  const sources = selectSources(source)
  const snapshots = await Promise.all(
    sources.map((feedSource) => fetchSourceFeed(feedSource, forceRefresh))
  )

  const mergedVehicles = snapshots.flatMap((snapshot) => snapshot.vehicles)

  try {
    await enrichWithGtfsData(mergedVehicles)
  } catch {
    // Route enrichment is best effort only.
  }

  const filteredVehicles = filterVehicles(mergedVehicles, line, routeId, routeShortName)
  sortVehicles(filteredVehicles)

  const sourceStats = snapshots.map((snapshot) => ({
    source: snapshot.source,
    vehicle_count: snapshot.vehicles.length,
    fetched_at: snapshot.fetched_at,
    fetched_at_iso: unixToIso(snapshot.fetched_at),
    feed_timestamp: snapshot.feed_timestamp,
    feed_timestamp_iso: unixToIso(snapshot.feed_timestamp),
    error: snapshot.error,
  }))

  const errors = sourceStats
    .filter((stat) => stat.error)
    .map((stat) => ({ source: stat.source, message: stat.error as string }))

  return {
    filters: {
      source,
      line,
      route_id: routeId,
      route_short_name: routeShortName,
    },
    source_stats: sourceStats,
    errors,
    vehicle_count: filteredVehicles.length,
    vehicles: filteredVehicles,
  }
}

export async function getVehicleLines(
  source: VehicleFeedSourceSelection,
  search: string | null,
  forceRefresh: boolean
): Promise<VehicleLinesResult> {
  const data = await getVehiclePositions({ source, forceRefresh })
  const normalizedSearch = normalizeForSearch(search)

  const grouped = new Map<
    string,
    {
      route_id: string | null
      route_short_name: string | null
      route_long_name: string | null
      vehicle_count: number
      sources: Set<VehicleFeedSource>
    }
  >()

  for (const vehicle of data.vehicles) {
    const key = vehicle.route_id || vehicle.route_short_name || 'unknown'
    const current = grouped.get(key) ?? {
      route_id: vehicle.route_id,
      route_short_name: vehicle.route_short_name,
      route_long_name: vehicle.route_long_name,
      vehicle_count: 0,
      sources: new Set<VehicleFeedSource>(),
    }

    current.vehicle_count += 1
    current.sources.add(vehicle.source)

    if (!current.route_id && vehicle.route_id) current.route_id = vehicle.route_id
    if (!current.route_short_name && vehicle.route_short_name) {
      current.route_short_name = vehicle.route_short_name
    }
    if (!current.route_long_name && vehicle.route_long_name) {
      current.route_long_name = vehicle.route_long_name
    }

    grouped.set(key, current)
  }

  let lines = Array.from(grouped.values()).map((lineItem) => ({
    route_id: lineItem.route_id,
    route_short_name: lineItem.route_short_name,
    route_long_name: lineItem.route_long_name,
    vehicle_count: lineItem.vehicle_count,
    sources: Array.from(lineItem.sources.values()).sort() as VehicleFeedSource[],
  }))

  if (normalizedSearch) {
    lines = lines.filter((lineItem) => {
      const candidates = [
        normalizeForSearch(lineItem.route_short_name),
        normalizeForSearch(lineItem.route_id),
        normalizeForSearch(lineItem.route_long_name),
      ].filter((value): value is string => !!value)

      return candidates.some(
        (candidate) => candidate === normalizedSearch || candidate.includes(normalizedSearch)
      )
    })
  }

  lines.sort((a, b) => {
    const valueA = a.route_short_name || a.route_id || ''
    const valueB = b.route_short_name || b.route_id || ''
    return valueA.localeCompare(valueB)
  })

  return {
    filters: {
      source,
      search: normalizeText(search),
    },
    source_stats: data.source_stats,
    errors: data.errors,
    line_count: lines.length,
    lines,
  }
}
