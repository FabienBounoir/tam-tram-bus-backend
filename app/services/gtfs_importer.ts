import app from '@adonisjs/core/services/app'
import { importGtfs, updateGtfsRealtime } from 'gtfs'
import type { Config } from 'gtfs'
import { readFile } from 'node:fs/promises'

let cachedConfig: Config | null = null
let syncStarted = false
let importRunning = false
let realtimeRunning = false
const GLOBAL_SYNC_KEY = '__tam_tram_bus_gtfs_sync_started__'

async function loadConfig(): Promise<Config> {
  if (cachedConfig) return cachedConfig

  const configPath = app.makePath('config.json')
  const raw = await readFile(configPath, 'utf8')
  cachedConfig = JSON.parse(raw) as Config
  return cachedConfig
}

export async function runImport(): Promise<void> {
  if (importRunning) return
  importRunning = true
  const config = await loadConfig()
  try {
    await importGtfs(config)
  } finally {
    importRunning = false
  }
}

export async function runRealtimeUpdate(): Promise<void> {
  if (realtimeRunning) return
  realtimeRunning = true
  const config = await loadConfig()
  try {
    await updateGtfsRealtime(config)
  } finally {
    realtimeRunning = false
  }
}

export function markSyncStarted(): boolean {
  const globalState = globalThis as Record<string, unknown>
  if (globalState[GLOBAL_SYNC_KEY]) return false
  globalState[GLOBAL_SYNC_KEY] = true

  if (syncStarted) return false
  syncStarted = true
  return true
}
