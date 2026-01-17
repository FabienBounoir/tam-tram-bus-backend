import app from '@adonisjs/core/services/app'
import scheduler from 'adonisjs-scheduler/services/main'
import { runImport, runRealtimeUpdate } from '#services/gtfs_importer'
import { generateShapesFromTrips } from '#services/gtfs_service'

if (!app.inTest) {
  scheduler
    .call(() => runRealtimeUpdate())
    .cron('*/15 * * * * *')
    .withoutOverlapping()

  scheduler
    .call(() => runImport())
    .monthly()
    .withoutOverlapping()

  scheduler
    .call(() => generateShapesFromTrips())
    .dailyAt('03:00')
    .withoutOverlapping()
}
