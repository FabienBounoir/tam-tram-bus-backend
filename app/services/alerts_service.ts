import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { GtfsDb } from '#services/gtfs_service'

export type AlertFeedSource = 'urbain' | 'suburbain'
export type AlertFeedSourceSelection = AlertFeedSource | 'all'

const ALERT_FEEDS: Record<AlertFeedSource, string> = {
  urbain: 'https://data.montpellier3m.fr/GTFS/Urbain/Alert.pb',
  suburbain: 'https://data.montpellier3m.fr/GTFS/Suburbain/Alert.pb',
}

const CACHE_TTL_MS = 10_000
const FETCH_TIMEOUT_MS = 10_000

const ALERT_CAUSE_ENUM = (GtfsRealtimeBindings as any).transit_realtime?.Alert?.Cause ?? {}
const ALERT_EFFECT_ENUM = (GtfsRealtimeBindings as any).transit_realtime?.Alert?.Effect ?? {}
const ALERT_SEVERITY_ENUM =
  (GtfsRealtimeBindings as any).transit_realtime?.Alert?.SeverityLevel ?? {}

const feedCache = new Map<AlertFeedSource, { fetchedAtMs: number; snapshot: FeedSnapshot }>()

export interface AlertActivePeriod {
  start: number | null
  end: number | null
  start_iso: string | null
  end_iso: string | null
}

export interface AlertRouteRef {
  route_id: string | null
  route_short_name: string | null
  route_long_name: string | null
  direction_id: number | null
}

export interface AlertStopRef {
  stop_id: string | null
  stop_name: string | null
}

export interface TransitAlertItem {
  source: AlertFeedSource
  entity_id: string | null
  alert_id: string
  cause: string | null
  effect: string | null
  severity: string | null
  header: string | null
  description: string | null
  url: string | null
  is_active: boolean
  active_from: number | null
  active_until: number | null
  active_from_iso: string | null
  active_until_iso: string | null
  active_periods: AlertActivePeriod[]
  informed_entities_count: number
  routes: AlertRouteRef[]
  stops: AlertStopRef[]
}

interface FeedSnapshot {
  source: AlertFeedSource
  fetched_at: number
  feed_timestamp: number | null
  alerts: TransitAlertItem[]
  error: string | null
}

export interface AlertsOptions {
  source?: AlertFeedSourceSelection
  line?: string | null
  routeId?: string | null
  routeShortName?: string | null
  stopId?: string | null
  search?: string | null
  effect?: string | null
  severity?: string | null
  activeOnly?: boolean
  forceRefresh?: boolean
}

export interface AlertsResult {
  filters: {
    source: AlertFeedSourceSelection
    line: string | null
    route_id: string | null
    route_short_name: string | null
    stop_id: string | null
    search: string | null
    effect: string | null
    severity: string | null
    active_only: boolean
  }
  source_stats: Array<{
    source: AlertFeedSource
    alert_count: number
    fetched_at: number
    fetched_at_iso: string | null
    feed_timestamp: number | null
    feed_timestamp_iso: string | null
    error: string | null
  }>
  errors: Array<{ source: AlertFeedSource; message: string }>
  alert_count: number
  alerts: TransitAlertItem[]
}

export interface AlertLinesResult {
  filters: {
    source: AlertFeedSourceSelection
    search: string | null
    active_only: boolean
  }
  source_stats: AlertsResult['source_stats']
  errors: AlertsResult['errors']
  line_count: number
  lines: Array<{
    route_id: string | null
    route_short_name: string | null
    route_long_name: string | null
    alert_count: number
    active_alert_count: number
    effects: string[]
    severities: string[]
    sources: AlertFeedSource[]
  }>
}

export interface AlertStopsResult {
  filters: {
    source: AlertFeedSourceSelection
    search: string | null
    active_only: boolean
  }
  source_stats: AlertsResult['source_stats']
  errors: AlertsResult['errors']
  stop_count: number
  stops: Array<{
    stop_id: string
    stop_name: string | null
    alert_count: number
    active_alert_count: number
    effects: string[]
    severities: string[]
    sources: AlertFeedSource[]
  }>
}

export function isAlertFeedSourceSelection(
  source: string | null | undefined
): source is AlertFeedSourceSelection {
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

function enumToLabel(enumObject: Record<string, string | number>, value: unknown): string | null {
  const num = toNumber(value)
  if (num === null) return null
  const key = String(Math.trunc(num))
  const label = enumObject[key]
  return typeof label === 'string' ? label : key
}

function translatedToText(value: any): string | null {
  const translations = Array.isArray(value?.translation) ? value.translation : []

  const candidates = translations
    .map((translation: any) => ({
      text: normalizeText(translation?.text),
      language: normalizeText(translation?.language)?.toLowerCase() ?? null,
    }))
    .filter((translation: { text: string | null }) => !!translation.text)

  if (!candidates.length) return normalizeText(value?.text)

  const preferredFr = candidates.find((translation: { language: string | null }) =>
    translation.language?.startsWith('fr')
  )
  if (preferredFr?.text) return preferredFr.text

  const preferredEn = candidates.find((translation: { language: string | null }) =>
    translation.language?.startsWith('en')
  )
  if (preferredEn?.text) return preferredEn.text

  return candidates[0].text
}

function selectSources(source: AlertFeedSourceSelection): AlertFeedSource[] {
  if (source === 'urbain') return ['urbain']
  if (source === 'suburbain') return ['suburbain']
  return ['urbain', 'suburbain']
}

function parseActivePeriods(alert: any): AlertActivePeriod[] {
  const activePeriods = Array.isArray(alert?.activePeriod) ? alert.activePeriod : []

  return activePeriods.map((period: any) => {
    const startRaw = toNumber(period?.start)
    const endRaw = toNumber(period?.end)
    const start = startRaw === null ? null : Math.trunc(startRaw)
    const end = endRaw === null ? null : Math.trunc(endRaw)

    return {
      start,
      end,
      start_iso: unixToIso(start),
      end_iso: unixToIso(end),
    }
  })
}

function isActiveNow(activePeriods: AlertActivePeriod[], nowUnix: number): boolean {
  if (!activePeriods.length) return true

  return activePeriods.some((period) => {
    const start = period.start === null ? Number.NEGATIVE_INFINITY : period.start
    const end = period.end === null ? Number.POSITIVE_INFINITY : period.end
    return nowUnix >= start && nowUnix <= end
  })
}

function getBounds(periods: AlertActivePeriod[]): { from: number | null; until: number | null } {
  const starts = periods
    .map((period) => period.start)
    .filter((value): value is number => value !== null)
  const ends = periods
    .map((period) => period.end)
    .filter((value): value is number => value !== null)

  return {
    from: starts.length ? Math.min(...starts) : null,
    until: ends.length ? Math.max(...ends) : null,
  }
}

function parseInformedEntities(alert: any): {
  routes: AlertRouteRef[]
  stops: AlertStopRef[]
  informedEntitiesCount: number
} {
  const informedEntities = Array.isArray(alert?.informedEntity) ? alert.informedEntity : []
  const routes = new Map<string, AlertRouteRef>()
  const stops = new Map<string, AlertStopRef>()

  for (const selector of informedEntities) {
    const routeId = normalizeText(selector?.routeId ?? selector?.trip?.routeId)
    const directionIdRaw = toNumber(selector?.directionId ?? selector?.trip?.directionId)
    const directionId = directionIdRaw === null ? null : Math.trunc(directionIdRaw)

    if (routeId) {
      const routeKey = `${routeId}__${directionId === null ? 'null' : directionId}`
      if (!routes.has(routeKey)) {
        routes.set(routeKey, {
          route_id: routeId,
          route_short_name: null,
          route_long_name: null,
          direction_id: directionId,
        })
      }
    }

    const stopId = normalizeText(selector?.stopId)
    if (stopId && !stops.has(stopId)) {
      stops.set(stopId, {
        stop_id: stopId,
        stop_name: null,
      })
    }
  }

  return {
    routes: Array.from(routes.values()),
    stops: Array.from(stops.values()),
    informedEntitiesCount: informedEntities.length,
  }
}

function toAlertItem(
  source: AlertFeedSource,
  entity: any,
  index: number,
  nowUnix: number
): TransitAlertItem | null {
  const alert = entity?.alert
  if (!alert) return null

  const activePeriods = parseActivePeriods(alert)
  const bounds = getBounds(activePeriods)
  const informed = parseInformedEntities(alert)

  const entityId = normalizeText(entity?.id)
  const fallbackId = `${source}:${index}`
  const alertId = entityId ?? fallbackId

  return {
    source,
    entity_id: entityId,
    alert_id: alertId,
    cause: enumToLabel(ALERT_CAUSE_ENUM, alert?.cause),
    effect: enumToLabel(ALERT_EFFECT_ENUM, alert?.effect),
    severity: enumToLabel(ALERT_SEVERITY_ENUM, alert?.severityLevel),
    header: translatedToText(alert?.headerText),
    description: translatedToText(alert?.descriptionText),
    url: translatedToText(alert?.url),
    is_active: isActiveNow(activePeriods, nowUnix),
    active_from: bounds.from,
    active_until: bounds.until,
    active_from_iso: unixToIso(bounds.from),
    active_until_iso: unixToIso(bounds.until),
    active_periods: activePeriods,
    informed_entities_count: informed.informedEntitiesCount,
    routes: informed.routes,
    stops: informed.stops,
  }
}

async function enrichAlertsWithGtfsData(alerts: TransitAlertItem[]): Promise<void> {
  if (!alerts.length) return

  const routeIds = Array.from(
    new Set(
      alerts
        .flatMap((alert) => alert.routes)
        .map((routeRef) => routeRef.route_id)
        .filter((routeId): routeId is string => !!routeId)
    )
  )

  if (routeIds.length) {
    const placeholders = routeIds.map(() => '?').join(',')
    const rows = await GtfsDb.dbAll(
      `SELECT route_id, route_short_name, route_long_name FROM routes WHERE route_id IN (${placeholders})`,
      routeIds
    )

    const routesById = new Map(
      rows.map((row) => [
        String(row.route_id),
        {
          route_short_name: normalizeText(row.route_short_name),
          route_long_name: normalizeText(row.route_long_name),
        },
      ])
    )

    for (const alert of alerts) {
      for (const routeRef of alert.routes) {
        if (!routeRef.route_id) continue
        const route = routesById.get(routeRef.route_id)
        if (!route) continue
        routeRef.route_short_name = route.route_short_name
        routeRef.route_long_name = route.route_long_name
      }
    }
  }

  const stopIds = Array.from(
    new Set(
      alerts
        .flatMap((alert) => alert.stops)
        .map((stopRef) => stopRef.stop_id)
        .filter((stopId): stopId is string => !!stopId)
    )
  )

  if (!stopIds.length) return

  const stopPlaceholders = stopIds.map(() => '?').join(',')
  const stopRows = await GtfsDb.dbAll(
    `SELECT stop_id, stop_name FROM stops WHERE stop_id IN (${stopPlaceholders})`,
    stopIds
  )

  const stopsById = new Map(
    stopRows.map((row) => [String(row.stop_id), normalizeText(row.stop_name)])
  )

  for (const alert of alerts) {
    for (const stopRef of alert.stops) {
      if (!stopRef.stop_id) continue
      const stopName = stopsById.get(stopRef.stop_id)
      if (!stopName) continue
      stopRef.stop_name = stopName
    }
  }
}

function filterAlerts(
  alerts: TransitAlertItem[],
  options: {
    line: string | null
    routeId: string | null
    routeShortName: string | null
    stopId: string | null
    search: string | null
    effect: string | null
    severity: string | null
    activeOnly: boolean
  }
) {
  const normalizedLine = normalizeForSearch(options.line)
  const routeIdFilter = normalizeText(options.routeId)
  const normalizedRouteShortName = normalizeForSearch(options.routeShortName)
  const stopIdFilter = normalizeText(options.stopId)
  const normalizedSearch = normalizeForSearch(options.search)
  const normalizedEffect = normalizeForSearch(options.effect)
  const normalizedSeverity = normalizeForSearch(options.severity)

  return alerts.filter((alert) => {
    if (options.activeOnly && !alert.is_active) return false

    if (routeIdFilter) {
      const hasRouteId = alert.routes.some((routeRef) => routeRef.route_id === routeIdFilter)
      if (!hasRouteId) return false
    }

    if (normalizedRouteShortName) {
      const hasRouteShortName = alert.routes.some((routeRef) => {
        const routeShortName = normalizeForSearch(routeRef.route_short_name)
        return routeShortName === normalizedRouteShortName
      })
      if (!hasRouteShortName) return false
    }

    if (normalizedLine) {
      const hasLine = alert.routes.some((routeRef) => {
        const candidates = [
          normalizeForSearch(routeRef.route_id),
          normalizeForSearch(routeRef.route_short_name),
        ].filter((candidate): candidate is string => !!candidate)

        return candidates.some(
          (candidate) => candidate === normalizedLine || candidate.includes(normalizedLine)
        )
      })

      if (!hasLine) return false
    }

    if (stopIdFilter) {
      const hasStopId = alert.stops.some((stopRef) => stopRef.stop_id === stopIdFilter)
      if (!hasStopId) return false
    }

    if (normalizedEffect) {
      const effect = normalizeForSearch(alert.effect)
      if (!effect || (!effect.includes(normalizedEffect) && effect !== normalizedEffect)) {
        return false
      }
    }

    if (normalizedSeverity) {
      const severity = normalizeForSearch(alert.severity)
      if (
        !severity ||
        (!severity.includes(normalizedSeverity) && severity !== normalizedSeverity)
      ) {
        return false
      }
    }

    if (!normalizedSearch) return true

    const searchableTexts = [
      normalizeForSearch(alert.header),
      normalizeForSearch(alert.description),
      normalizeForSearch(alert.cause),
      normalizeForSearch(alert.effect),
      normalizeForSearch(alert.severity),
      ...alert.routes.flatMap((routeRef) => [
        normalizeForSearch(routeRef.route_id),
        normalizeForSearch(routeRef.route_short_name),
        normalizeForSearch(routeRef.route_long_name),
      ]),
      ...alert.stops.flatMap((stopRef) => [
        normalizeForSearch(stopRef.stop_id),
        normalizeForSearch(stopRef.stop_name),
      ]),
    ].filter((value): value is string => !!value)

    return searchableTexts.some((text) => text.includes(normalizedSearch))
  })
}

function severityRank(severity: string | null): number {
  if (severity === 'SEVERE') return 3
  if (severity === 'WARNING') return 2
  if (severity === 'INFO') return 1
  return 0
}

function sortAlerts(alerts: TransitAlertItem[]) {
  alerts.sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1

    const severityDiff = severityRank(b.severity) - severityRank(a.severity)
    if (severityDiff !== 0) return severityDiff

    const fromA = a.active_from ?? Number.MAX_SAFE_INTEGER
    const fromB = b.active_from ?? Number.MAX_SAFE_INTEGER
    if (fromA !== fromB) return fromA - fromB

    const lineA = a.routes[0]?.route_short_name || a.routes[0]?.route_id || ''
    const lineB = b.routes[0]?.route_short_name || b.routes[0]?.route_id || ''
    const lineCmp = lineA.localeCompare(lineB)
    if (lineCmp !== 0) return lineCmp

    const titleA = a.header || a.description || a.alert_id
    const titleB = b.header || b.description || b.alert_id
    return titleA.localeCompare(titleB)
  })
}

async function fetchSourceFeed(
  source: AlertFeedSource,
  forceRefresh: boolean
): Promise<FeedSnapshot> {
  const nowMs = Date.now()
  const cached = feedCache.get(source)

  if (!forceRefresh && cached && nowMs - cached.fetchedAtMs <= CACHE_TTL_MS) {
    return cached.snapshot
  }

  const url = ALERT_FEEDS[source]
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

    const buffer = await res.arrayBuffer()
    const message = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    ) as any

    const entities = Array.isArray(message?.entity) ? message.entity : []
    const nowUnix = Math.floor(nowMs / 1000)

    const alerts = entities
      .map((entity: any, index: number) => toAlertItem(source, entity, index, nowUnix))
      .filter((alert: TransitAlertItem | null): alert is TransitAlertItem => alert !== null)

    const feedTimestampRaw = toNumber(message?.header?.timestamp)
    const feedTimestamp = feedTimestampRaw === null ? null : Math.trunc(feedTimestampRaw)

    snapshot = {
      source,
      fetched_at: nowUnix,
      feed_timestamp: feedTimestamp,
      alerts,
      error: null,
    }
  } catch (error: any) {
    snapshot = {
      source,
      fetched_at: Math.floor(nowMs / 1000),
      feed_timestamp: null,
      alerts: [],
      error: normalizeText(error?.message) ?? 'unknown upstream error',
    }
  }

  feedCache.set(source, { fetchedAtMs: nowMs, snapshot })
  return snapshot
}

export async function getAlerts(options: AlertsOptions = {}): Promise<AlertsResult> {
  const source = options.source ?? 'all'
  const line = normalizeText(options.line)
  const routeId = normalizeText(options.routeId)
  const routeShortName = normalizeText(options.routeShortName)
  const stopId = normalizeText(options.stopId)
  const search = normalizeText(options.search)
  const effect = normalizeText(options.effect)
  const severity = normalizeText(options.severity)
  const activeOnly = options.activeOnly ?? true
  const forceRefresh = options.forceRefresh ?? false

  const sources = selectSources(source)
  const snapshots = await Promise.all(
    sources.map((feedSource) => fetchSourceFeed(feedSource, forceRefresh))
  )

  const mergedAlerts = snapshots.flatMap((snapshot) => snapshot.alerts)

  try {
    await enrichAlertsWithGtfsData(mergedAlerts)
  } catch {
    // GTFS enrichment is best effort only.
  }

  const filteredAlerts = filterAlerts(mergedAlerts, {
    line,
    routeId,
    routeShortName,
    stopId,
    search,
    effect,
    severity,
    activeOnly,
  })
  sortAlerts(filteredAlerts)

  const sourceStats = snapshots.map((snapshot) => ({
    source: snapshot.source,
    alert_count: snapshot.alerts.length,
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
      stop_id: stopId,
      search,
      effect,
      severity,
      active_only: activeOnly,
    },
    source_stats: sourceStats,
    errors,
    alert_count: filteredAlerts.length,
    alerts: filteredAlerts,
  }
}

function aggregateLines(alerts: TransitAlertItem[]) {
  const grouped = new Map<
    string,
    {
      route_id: string | null
      route_short_name: string | null
      route_long_name: string | null
      alert_count: number
      active_alert_count: number
      effects: Set<string>
      severities: Set<string>
      sources: Set<AlertFeedSource>
      alertIds: Set<string>
    }
  >()

  for (const alert of alerts) {
    for (const routeRef of alert.routes) {
      if (!routeRef.route_id && !routeRef.route_short_name) continue

      const key = `${routeRef.route_id ?? 'null'}__${routeRef.route_short_name ?? 'null'}`
      const current = grouped.get(key) ?? {
        route_id: routeRef.route_id,
        route_short_name: routeRef.route_short_name,
        route_long_name: routeRef.route_long_name,
        alert_count: 0,
        active_alert_count: 0,
        effects: new Set<string>(),
        severities: new Set<string>(),
        sources: new Set<AlertFeedSource>(),
        alertIds: new Set<string>(),
      }

      if (!current.route_long_name && routeRef.route_long_name) {
        current.route_long_name = routeRef.route_long_name
      }

      if (!current.alertIds.has(alert.alert_id)) {
        current.alertIds.add(alert.alert_id)
        current.alert_count += 1
        if (alert.is_active) current.active_alert_count += 1
      }

      if (alert.effect) current.effects.add(alert.effect)
      if (alert.severity) current.severities.add(alert.severity)
      current.sources.add(alert.source)

      grouped.set(key, current)
    }
  }

  const lines = Array.from(grouped.values()).map((line) => ({
    route_id: line.route_id,
    route_short_name: line.route_short_name,
    route_long_name: line.route_long_name,
    alert_count: line.alert_count,
    active_alert_count: line.active_alert_count,
    effects: Array.from(line.effects.values()).sort(),
    severities: Array.from(line.severities.values()).sort(),
    sources: Array.from(line.sources.values()).sort() as AlertFeedSource[],
  }))

  lines.sort((a, b) => {
    const valueA = a.route_short_name || a.route_id || ''
    const valueB = b.route_short_name || b.route_id || ''
    return valueA.localeCompare(valueB)
  })

  return lines
}

function aggregateStops(alerts: TransitAlertItem[]) {
  const grouped = new Map<
    string,
    {
      stop_id: string
      stop_name: string | null
      alert_count: number
      active_alert_count: number
      effects: Set<string>
      severities: Set<string>
      sources: Set<AlertFeedSource>
      alertIds: Set<string>
    }
  >()

  for (const alert of alerts) {
    for (const stopRef of alert.stops) {
      if (!stopRef.stop_id) continue

      const current = grouped.get(stopRef.stop_id) ?? {
        stop_id: stopRef.stop_id,
        stop_name: stopRef.stop_name,
        alert_count: 0,
        active_alert_count: 0,
        effects: new Set<string>(),
        severities: new Set<string>(),
        sources: new Set<AlertFeedSource>(),
        alertIds: new Set<string>(),
      }

      if (!current.stop_name && stopRef.stop_name) current.stop_name = stopRef.stop_name

      if (!current.alertIds.has(alert.alert_id)) {
        current.alertIds.add(alert.alert_id)
        current.alert_count += 1
        if (alert.is_active) current.active_alert_count += 1
      }

      if (alert.effect) current.effects.add(alert.effect)
      if (alert.severity) current.severities.add(alert.severity)
      current.sources.add(alert.source)

      grouped.set(stopRef.stop_id, current)
    }
  }

  const stops = Array.from(grouped.values()).map((stop) => ({
    stop_id: stop.stop_id,
    stop_name: stop.stop_name,
    alert_count: stop.alert_count,
    active_alert_count: stop.active_alert_count,
    effects: Array.from(stop.effects.values()).sort(),
    severities: Array.from(stop.severities.values()).sort(),
    sources: Array.from(stop.sources.values()).sort() as AlertFeedSource[],
  }))

  stops.sort((a, b) => {
    const nameA = a.stop_name || a.stop_id
    const nameB = b.stop_name || b.stop_id
    return nameA.localeCompare(nameB)
  })

  return stops
}

export async function getAlertLines(
  source: AlertFeedSourceSelection,
  search: string | null,
  activeOnly: boolean,
  forceRefresh: boolean
): Promise<AlertLinesResult> {
  const data = await getAlerts({
    source,
    activeOnly,
    forceRefresh,
  })

  const normalizedSearch = normalizeForSearch(search)
  let lines = aggregateLines(data.alerts)

  if (normalizedSearch) {
    lines = lines.filter((line) => {
      const candidates = [
        normalizeForSearch(line.route_id),
        normalizeForSearch(line.route_short_name),
        normalizeForSearch(line.route_long_name),
      ].filter((candidate): candidate is string => !!candidate)

      return candidates.some(
        (candidate) => candidate === normalizedSearch || candidate.includes(normalizedSearch)
      )
    })
  }

  return {
    filters: {
      source,
      search: normalizeText(search),
      active_only: activeOnly,
    },
    source_stats: data.source_stats,
    errors: data.errors,
    line_count: lines.length,
    lines,
  }
}

export async function getAlertStops(
  source: AlertFeedSourceSelection,
  search: string | null,
  activeOnly: boolean,
  forceRefresh: boolean
): Promise<AlertStopsResult> {
  const data = await getAlerts({
    source,
    activeOnly,
    forceRefresh,
  })

  const normalizedSearch = normalizeForSearch(search)
  let stops = aggregateStops(data.alerts)

  if (normalizedSearch) {
    stops = stops.filter((stop) => {
      const candidates = [
        normalizeForSearch(stop.stop_id),
        normalizeForSearch(stop.stop_name),
      ].filter((candidate): candidate is string => !!candidate)

      return candidates.some(
        (candidate) => candidate === normalizedSearch || candidate.includes(normalizedSearch)
      )
    })
  }

  return {
    filters: {
      source,
      search: normalizeText(search),
      active_only: activeOnly,
    },
    source_stats: data.source_stats,
    errors: data.errors,
    stop_count: stops.length,
    stops,
  }
}
