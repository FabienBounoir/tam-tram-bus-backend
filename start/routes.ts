/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import app from '@adonisjs/core/services/app'
import router from '@adonisjs/core/services/router'

router.get('/', async () => {
  return {
    status: 'ok',
    service: 'tam-tram-bus-montpellier-api',
    version: '1.0.0',
    author: 'Fabien Bounoir',
  }
})

router.get('/debug.html', async ({ response }) => {
  return response.download(app.publicPath('debug.html'))
})

router
  .group(() => {
    router.get('/station-names', '#controllers/gtfs_controller.stationNames')
    router.get('/stops-by-name', '#controllers/gtfs_controller.stopsByName')
    router.get(
      '/stop-ids-for-name-and-route',
      '#controllers/gtfs_controller.stopIdsForNameAndRoute'
    )
    router.get('/routes-by-stop', '#controllers/gtfs_controller.routesByStop')
    router.get('/next-departures', '#controllers/gtfs_controller.nextDepartures')
    router.get('/trip-stop-times', '#controllers/gtfs_controller.tripStopTimes')
    router.get('/vehicle-positions', '#controllers/gtfs_controller.vehiclePositions')
    router.get('/vehicle-lines', '#controllers/gtfs_controller.vehicleLines')
    router.get('/alerts', '#controllers/gtfs_controller.alerts')
    router.get('/alerts/lines', '#controllers/gtfs_controller.alertLines')
    router.get('/alerts/line/:line', '#controllers/gtfs_controller.alertsForLine')
    router.get('/alerts/stops', '#controllers/gtfs_controller.alertStops')
    router.get('/display-lines', '#controllers/gtfs_controller.displayLines')
    router.get('/display-lines/lines', '#controllers/gtfs_controller.displayLineGroups')
    router.get('/display-lines/geojson', '#controllers/gtfs_controller.displayLinesGeoJson')
    router.get('/display-lines/line/:line', '#controllers/gtfs_controller.displayLinesForLine')
    router.get('/stops-near', '#controllers/gtfs_controller.stopsNear')
    router.get('/shapes', '#controllers/gtfs_controller.shapes')
    router.get('/shape', '#controllers/gtfs_controller.shape')
    router.get('/shape-by-route', '#controllers/gtfs_controller.shapeByRoute')
    router.get('/shape-from-trip', '#controllers/gtfs_controller.shapeFromTrip')
  })
  .prefix('/api')

router.post('/admin/generate-shapes', '#controllers/gtfs_controller.generateShapes')
