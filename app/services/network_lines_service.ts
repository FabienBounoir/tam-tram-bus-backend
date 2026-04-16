export type NetworkLineSource = 'tram' | 'bus' | 'bustram'
export type NetworkLineSourceSelection = NetworkLineSource | 'all'

const NETWORK_LINE_FEEDS: Record<NetworkLineSource, string> = {
  tram: 'https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json',
  bus: 'https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_BusLigne.json',
  bustram: 'https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_Bustram.json',
}

const CACHE_TTL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 15_000

interface LineStringGeometry {
  type: 'LineString'
  coordinates: Array<[number, number]>
}

interface MultiLineStringGeometry {
  type: 'MultiLineString'
  coordinates: Array<Array<[number, number]>>
}

type NetworkLineGeometry = LineStringGeometry | MultiLineStringGeometry

export interface NetworkLineSegment {
  source: NetworkLineSource
  feature_id: string
  external_line_id: string | null
  line_key: string
  line_code: string | null
  line_label: string
  line_name: string | null
  network: string | null
  mode: string | null
  direction: string | null
  operation: string | null
  color: string | null
  coordinate_count: number
  geometry: NetworkLineGeometry | null
}

interface FeedSnapshot {
  source: NetworkLineSource
  source_name: string | null
  fetched_at: number
  segments: NetworkLineSegment[]
  error: string | null
}

export interface NetworkLinesOptions {
  source?: NetworkLineSourceSelection
  line?: string | null
  search?: string | null
  mode?: string | null
  network?: string | null
  includeGeometry?: boolean
  forceRefresh?: boolean
}

export interface NetworkLinesResult {
  filters: {
    source: NetworkLineSourceSelection
    line: string | null
    search: string | null
    mode: string | null
    network: string | null
    include_geometry: boolean
  }
  source_stats: Array<{
    source: NetworkLineSource
    source_name: string | null
    segment_count: number
    fetched_at: number
    fetched_at_iso: string | null
    error: string | null
  }>
  errors: Array<{ source: NetworkLineSource; message: string }>
  segment_count: number
  segments: NetworkLineSegment[]
}

export interface NetworkLineGroupsResult {
  filters: {
    source: NetworkLineSourceSelection
    line: string | null
    search: string | null
    mode: string | null
    network: string | null
  }
  source_stats: NetworkLinesResult['source_stats']
  errors: NetworkLinesResult['errors']
  line_count: number
  lines: Array<{
    source: NetworkLineSource
    line_key: string
    line_code: string | null
    line_label: string
    line_name: string | null
    network: string | null
    mode: string | null
    color: string | null
    segment_count: number
    directions: string[]
    operations: string[]
  }>
}

export interface NetworkLinesGeoJsonResult {
  type: 'FeatureCollection'
  name: string
  filters: NetworkLinesResult['filters']
  source_stats: NetworkLinesResult['source_stats']
  errors: NetworkLinesResult['errors']
  feature_count: number
  features: Array<{
    type: 'Feature'
    geometry: NetworkLineGeometry | null
    properties: Omit<NetworkLineSegment, 'geometry'>
  }>
}

const feedCache = new Map<NetworkLineSource, { fetchedAtMs: number; snapshot: FeedSnapshot }>()

export function isNetworkLineSourceSelection(
  source: string | null | undefined
): source is NetworkLineSourceSelection {
  return source === 'all' || source === 'tram' || source === 'bus' || source === 'bustram'
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

function normalizeColor(value: unknown): string | null {
  const text = normalizeText(value)
  if (!text) return null

  if (/^#[0-9a-f]{3,8}$/i.test(text)) return text.toUpperCase()
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toUpperCase()}`

  return text
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function unixToIso(ts: number | null): string | null {
  if (ts === null) return null
  const date = new Date(ts * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function sanitizeLineStringCoordinates(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return []

  return value
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) return null
      const lon = toNumber(point[0])
      const lat = toNumber(point[1])
      if (lon === null || lat === null) return null
      return [lon, lat] as [number, number]
    })
    .filter((point): point is [number, number] => point !== null)
}

function sanitizeGeometry(value: any): NetworkLineGeometry | null {
  const type = normalizeText(value?.type)

  if (type === 'LineString') {
    const coordinates = sanitizeLineStringCoordinates(value?.coordinates)
    if (!coordinates.length) return null
    return { type: 'LineString', coordinates }
  }

  if (type === 'MultiLineString') {
    const lines = Array.isArray(value?.coordinates) ? (value.coordinates as unknown[]) : []
    const coordinates = lines
      .map((line: unknown) => sanitizeLineStringCoordinates(line))
      .filter((line: Array<[number, number]>) => line.length > 0)

    if (!coordinates.length) return null
    return { type: 'MultiLineString', coordinates }
  }

  return null
}

function countCoordinates(geometry: NetworkLineGeometry | null): number {
  if (!geometry) return 0
  if (geometry.type === 'LineString') return geometry.coordinates.length

  return geometry.coordinates.reduce((acc, line) => acc + line.length, 0)
}

function extractLineCode(properties: Record<string, unknown>): string | null {
  const commercial = normalizeText(properties.num_commercial)
  if (commercial) return commercial.toUpperCase()

  const exploitation = normalizeText(properties.num_exploitation)
  if (exploitation) return exploitation.toUpperCase()

  const lineName = normalizeText(properties.nom_ligne)
  if (!lineName) return null

  const tramOrLine = lineName.match(/^L\s*([A-Za-z0-9]+)/i)
  if (tramOrLine?.[1]) return tramOrLine[1].toUpperCase()

  const bustram = lineName.match(/^Bustram\s*([A-Za-z0-9]+)/i)
  if (bustram?.[1]) return bustram[1].toUpperCase()

  return null
}

function buildLineLabel(
  source: NetworkLineSource,
  lineCode: string | null,
  lineName: string | null
): string {
  if (lineCode) {
    if (source === 'tram') {
      return lineCode.toUpperCase().startsWith('L') ? lineCode.toUpperCase() : `L${lineCode}`
    }

    if (source === 'bustram') {
      return `Bustram ${lineCode}`
    }

    return lineCode
  }

  const normalizedName = normalizeText(lineName)
  if (!normalizedName) return 'Unknown'

  const firstToken = normalizedName.split(' ')[0]
  return firstToken || normalizedName
}

function getFeatureId(
  source: NetworkLineSource,
  properties: Record<string, unknown>,
  index: number
): string {
  const explicitId = normalizeText(properties.id_lignes_sens ?? properties.f_id)
  return explicitId ?? `${source}:${index}`
}

function toSegment(
  source: NetworkLineSource,
  feature: any,
  index: number
): NetworkLineSegment | null {
  const properties = (feature?.properties ?? {}) as Record<string, unknown>
  const geometry = sanitizeGeometry(feature?.geometry)

  const lineName = normalizeText(properties.nom_ligne)
  const lineCode = extractLineCode(properties)
  const lineLabel = buildLineLabel(source, lineCode, lineName)
  const featureId = getFeatureId(source, properties, index)

  const lineKey =
    normalizeForSearch(
      `${source}:${lineCode ?? normalizeText(lineName?.split('>')[0]) ?? featureId}`
    ) ?? `${source}:${featureId}`

  return {
    source,
    feature_id: featureId,
    external_line_id: normalizeText(properties.id_lignes_sens ?? properties.f_id),
    line_key: lineKey,
    line_code: lineCode,
    line_label: lineLabel,
    line_name: lineName,
    network: normalizeText(properties.reseau),
    mode: normalizeText(properties.mode),
    direction: normalizeText(properties.sens),
    operation: normalizeText(properties.fonctionnement),
    color: normalizeColor(properties.code_couleur),
    coordinate_count: countCoordinates(geometry),
    geometry,
  }
}

function selectSources(source: NetworkLineSourceSelection): NetworkLineSource[] {
  if (source === 'tram') return ['tram']
  if (source === 'bus') return ['bus']
  if (source === 'bustram') return ['bustram']
  return ['tram', 'bus', 'bustram']
}

function isLineMatch(segment: NetworkLineSegment, line: string | null): boolean {
  const normalizedLine = normalizeForSearch(line)
  if (!normalizedLine) return true

  const candidates = [
    normalizeForSearch(segment.line_code),
    normalizeForSearch(segment.line_label),
    normalizeForSearch(segment.line_name),
  ].filter((candidate): candidate is string => !!candidate)

  return candidates.some((candidate) => {
    if (candidate === normalizedLine || candidate.includes(normalizedLine)) return true

    const candidateWithoutL = candidate.startsWith('l') ? candidate.slice(1) : candidate
    const lineWithoutL = normalizedLine.startsWith('l') ? normalizedLine.slice(1) : normalizedLine

    return candidateWithoutL === lineWithoutL
  })
}

function isSearchMatch(segment: NetworkLineSegment, search: string | null): boolean {
  const normalizedSearch = normalizeForSearch(search)
  if (!normalizedSearch) return true

  const searchable = [
    normalizeForSearch(segment.line_code),
    normalizeForSearch(segment.line_label),
    normalizeForSearch(segment.line_name),
    normalizeForSearch(segment.mode),
    normalizeForSearch(segment.network),
    normalizeForSearch(segment.direction),
    normalizeForSearch(segment.operation),
    normalizeForSearch(segment.external_line_id),
  ].filter((candidate): candidate is string => !!candidate)

  return searchable.some((candidate) => candidate.includes(normalizedSearch))
}

function isModeMatch(segment: NetworkLineSegment, mode: string | null): boolean {
  const normalizedMode = normalizeForSearch(mode)
  if (!normalizedMode) return true

  const segmentMode = normalizeForSearch(segment.mode)
  if (!segmentMode) return false

  return segmentMode === normalizedMode || segmentMode.includes(normalizedMode)
}

function isNetworkMatch(segment: NetworkLineSegment, network: string | null): boolean {
  const normalizedNetwork = normalizeForSearch(network)
  if (!normalizedNetwork) return true

  const segmentNetwork = normalizeForSearch(segment.network)
  if (!segmentNetwork) return false

  return segmentNetwork === normalizedNetwork || segmentNetwork.includes(normalizedNetwork)
}

function sortSegments(segments: NetworkLineSegment[]) {
  segments.sort((a, b) => {
    const sourceCmp = a.source.localeCompare(b.source)
    if (sourceCmp !== 0) return sourceCmp

    const lineCmp = a.line_label.localeCompare(b.line_label)
    if (lineCmp !== 0) return lineCmp

    const directionA = a.direction || ''
    const directionB = b.direction || ''
    return directionA.localeCompare(directionB)
  })
}

async function fetchSourceFeed(
  source: NetworkLineSource,
  forceRefresh: boolean
): Promise<FeedSnapshot> {
  const nowMs = Date.now()
  const cached = feedCache.get(source)

  if (!forceRefresh && cached && nowMs - cached.fetchedAtMs <= CACHE_TTL_MS) {
    return cached.snapshot
  }

  const url = NETWORK_LINE_FEEDS[source]
  let snapshot: FeedSnapshot

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
      },
    })

    if (!res.ok) {
      throw new Error(`upstream ${res.status} ${res.statusText}`)
    }

    const body = (await res.json()) as any
    const sourceName = normalizeText(body?.name)
    const features = Array.isArray(body?.features) ? body.features : []
    const segments = features
      .map((feature: any, index: number) => toSegment(source, feature, index))
      .filter((segment: NetworkLineSegment | null): segment is NetworkLineSegment => !!segment)

    snapshot = {
      source,
      source_name: sourceName,
      fetched_at: Math.floor(nowMs / 1000),
      segments,
      error: null,
    }
  } catch (error: any) {
    snapshot = {
      source,
      source_name: null,
      fetched_at: Math.floor(nowMs / 1000),
      segments: [],
      error: normalizeText(error?.message) ?? 'unknown upstream error',
    }
  }

  feedCache.set(source, { fetchedAtMs: nowMs, snapshot })
  return snapshot
}

function applyFilters(
  segments: NetworkLineSegment[],
  options: NetworkLinesOptions
): NetworkLineSegment[] {
  return segments.filter((segment) => {
    if (!isLineMatch(segment, options.line ?? null)) return false
    if (!isSearchMatch(segment, options.search ?? null)) return false
    if (!isModeMatch(segment, options.mode ?? null)) return false
    if (!isNetworkMatch(segment, options.network ?? null)) return false
    return true
  })
}

function stripGeometry(segments: NetworkLineSegment[]): NetworkLineSegment[] {
  return segments.map((segment) => ({
    ...segment,
    geometry: null,
  }))
}

export async function getNetworkLines(
  options: NetworkLinesOptions = {}
): Promise<NetworkLinesResult> {
  const source = options.source ?? 'all'
  const line = normalizeText(options.line)
  const search = normalizeText(options.search)
  const mode = normalizeText(options.mode)
  const network = normalizeText(options.network)
  const includeGeometry = options.includeGeometry ?? false
  const forceRefresh = options.forceRefresh ?? false

  const sources = selectSources(source)
  const snapshots = await Promise.all(
    sources.map((feedSource) => fetchSourceFeed(feedSource, forceRefresh))
  )

  const mergedSegments = snapshots.flatMap((snapshot) => snapshot.segments)
  const filteredSegments = applyFilters(mergedSegments, {
    source,
    line,
    search,
    mode,
    network,
    includeGeometry,
    forceRefresh,
  })

  sortSegments(filteredSegments)
  const segments = includeGeometry ? filteredSegments : stripGeometry(filteredSegments)

  const sourceStats = snapshots.map((snapshot) => ({
    source: snapshot.source,
    source_name: snapshot.source_name,
    segment_count: snapshot.segments.length,
    fetched_at: snapshot.fetched_at,
    fetched_at_iso: unixToIso(snapshot.fetched_at),
    error: snapshot.error,
  }))

  const errors = sourceStats
    .filter((stat) => stat.error)
    .map((stat) => ({ source: stat.source, message: stat.error as string }))

  return {
    filters: {
      source,
      line,
      search,
      mode,
      network,
      include_geometry: includeGeometry,
    },
    source_stats: sourceStats,
    errors,
    segment_count: segments.length,
    segments,
  }
}

export async function getNetworkLineGroups(
  source: NetworkLineSourceSelection,
  line: string | null,
  search: string | null,
  mode: string | null,
  network: string | null,
  forceRefresh: boolean
): Promise<NetworkLineGroupsResult> {
  const data = await getNetworkLines({
    source,
    line,
    search,
    mode,
    network,
    includeGeometry: false,
    forceRefresh,
  })

  const grouped = new Map<
    string,
    {
      source: NetworkLineSource
      line_key: string
      line_code: string | null
      line_label: string
      line_name: string | null
      network: string | null
      mode: string | null
      color: string | null
      segment_count: number
      directions: Set<string>
      operations: Set<string>
    }
  >()

  for (const segment of data.segments) {
    const current = grouped.get(segment.line_key) ?? {
      source: segment.source,
      line_key: segment.line_key,
      line_code: segment.line_code,
      line_label: segment.line_label,
      line_name: segment.line_name,
      network: segment.network,
      mode: segment.mode,
      color: segment.color,
      segment_count: 0,
      directions: new Set<string>(),
      operations: new Set<string>(),
    }

    if (!current.line_name && segment.line_name) current.line_name = segment.line_name
    if (!current.mode && segment.mode) current.mode = segment.mode
    if (!current.network && segment.network) current.network = segment.network
    if (!current.color && segment.color) current.color = segment.color

    current.segment_count += 1
    if (segment.direction) current.directions.add(segment.direction)
    if (segment.operation) current.operations.add(segment.operation)

    grouped.set(segment.line_key, current)
  }

  const lines = Array.from(grouped.values())
    .map((lineItem) => ({
      source: lineItem.source,
      line_key: lineItem.line_key,
      line_code: lineItem.line_code,
      line_label: lineItem.line_label,
      line_name: lineItem.line_name,
      network: lineItem.network,
      mode: lineItem.mode,
      color: lineItem.color,
      segment_count: lineItem.segment_count,
      directions: Array.from(lineItem.directions.values()).sort(),
      operations: Array.from(lineItem.operations.values()).sort(),
    }))
    .sort((a, b) => {
      const sourceCmp = a.source.localeCompare(b.source)
      if (sourceCmp !== 0) return sourceCmp
      return a.line_label.localeCompare(b.line_label)
    })

  return {
    filters: {
      source,
      line: normalizeText(line),
      search: normalizeText(search),
      mode: normalizeText(mode),
      network: normalizeText(network),
    },
    source_stats: data.source_stats,
    errors: data.errors,
    line_count: lines.length,
    lines,
  }
}

export async function getNetworkLinesGeoJson(
  options: NetworkLinesOptions = {}
): Promise<NetworkLinesGeoJsonResult> {
  const data = await getNetworkLines({
    ...options,
    includeGeometry: true,
  })

  return {
    type: 'FeatureCollection',
    name: 'tam_tram_bus_display_lines',
    filters: data.filters,
    source_stats: data.source_stats,
    errors: data.errors,
    feature_count: data.segment_count,
    features: data.segments.map((segment) => ({
      type: 'Feature',
      geometry: segment.geometry,
      properties: {
        source: segment.source,
        feature_id: segment.feature_id,
        external_line_id: segment.external_line_id,
        line_key: segment.line_key,
        line_code: segment.line_code,
        line_label: segment.line_label,
        line_name: segment.line_name,
        network: segment.network,
        mode: segment.mode,
        direction: segment.direction,
        operation: segment.operation,
        color: segment.color,
        coordinate_count: segment.coordinate_count,
      },
    })),
  }
}
