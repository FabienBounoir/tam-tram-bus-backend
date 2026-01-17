import type { ApplicationService } from '@adonisjs/core/types'
import { Worker } from 'adonisjs-scheduler'
import { markSyncStarted, runImport } from '#services/gtfs_importer'
import { generateShapesFromTrips } from '#services/gtfs_service'

const GLOBAL_WORKER_KEY = '__tam_tram_bus_scheduler_worker__'

export default class GtfsProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    if (this.app.inTest) return
    if (!markSyncStarted()) return

    try {
      await runImport()
      await generateShapesFromTrips()
    } catch (error) {
      console.error('GTFS import on boot failed:', error)
    }

    const globalState = globalThis as Record<string, unknown>
    if (globalState[GLOBAL_WORKER_KEY]) return
    globalState[GLOBAL_WORKER_KEY] = true

    const worker = new Worker(this.app)
    this.app.terminating(async () => {
      await worker.stop()
    })

    await worker.start()
  }
}
