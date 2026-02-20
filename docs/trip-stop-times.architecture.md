# Architecture endpoint `GET /api/trip-stop-times`

## 1) Objectif produit

Cet endpoint sert à exposer la **timeline complète des arrêts d’un trajet (`trip_id`)** et à calculer, si demandé, le **temps de parcours entre un arrêt de montée et un arrêt de descente**, en prenant en compte le **realtime GTFS-RT**.

Cas d’usage principal frontend:
- "Je monte à l’arrêt A et je descends à l’arrêt B"
- "Combien de temps il reste avant d’arriver ?"
- "Quelle est l’heure réelle d’arrivée à mon arrêt de descente ?"

---

## 2) Contrat API

### Route
- Méthode: `GET`
- URL: `/api/trip-stop-times`

### Query params
- Obligatoire:
  - `trip_id: string`
- Optionnels (pour calcul `journey`):
  - `from_stop_id: string`
  - `to_stop_id: string`
  - `from_stop_sequence: number`
  - `to_stop_sequence: number`

### Règles de résolution `from` / `to`
- Si `from_stop_sequence` est fourni, il est prioritaire sur `from_stop_id`.
- Si `to_stop_sequence` est fourni, il est prioritaire sur `to_stop_id`.
- `to` est recherché **après** `from` (ordre du trajet).

---

## 3) Réponse JSON

### 3.1 Succès (200)

```json
{
  "trip": {
    "trip_id": "...",
    "route_id": "...",
    "route_short_name": "...",
    "route_long_name": "...",
    "service_id": "...",
    "direction_id": 0,
    "trip_headsign": "..."
  },
  "journey": {
    "from_stop_id": "...",
    "from_stop_name": "...",
    "from_stop_sequence": 12,
    "to_stop_id": "...",
    "to_stop_name": "...",
    "to_stop_sequence": 21,
    "scheduled_travel_seconds": 780,
    "scheduled_travel_minutes": 13,
    "realtime_travel_seconds": 900,
    "realtime_travel_minutes": 15,
    "delta_seconds": 120
  },
  "stops": [
    {
      "stop_id": "...",
      "stop_name": "...",
      "stop_sequence": 1,
      "arrival_time": "08:10:00",
      "departure_time": "08:10:30",
      "arrival_seconds": 29400,
      "departure_seconds": 29430,
      "realtime_arrival_time": "08:11:00",
      "realtime_departure_time": "08:11:30",
      "realtime_arrival_seconds": 29460,
      "realtime_departure_seconds": 29490,
      "arrival_delay_seconds": 60,
      "departure_delay_seconds": 60,
      "delay_seconds": 60,
      "delay_minutes": 1,
      "realtime_available": true,
      "realtime_updated": true,
      "realtime_updated_at": 1769253000
    }
  ]
}
```

### 3.2 Notes importantes
- `journey` peut être `null` si `from`/`to` non fournis.
- `realtime_*` peut être `null` si pas de donnée GTFS-RT valide pour l’arrêt.
- `delay_seconds > 0` = retard, `< 0` = avance.

---

## 4) Erreurs API

### 400 Bad Request
- `trip_id` absent
- `from_stop_sequence` non numérique
- `to_stop_sequence` non numérique

Exemple:
```json
{ "error": "trip_id query param required" }
```

### 404 Not Found
- `trip_id` introuvable
- `from` introuvable dans le trip
- `to` introuvable après `from`

Exemple:
```json
{ "error": "trip_id not found" }
```

---

## 5) Logique métier (backend)

1. Charge tous les `stop_times` du `trip_id` (ordonnés par `stop_sequence`).
2. Jointure sur `stops`, `trips`, `routes` pour enrichir les métadonnées.
3. Jointure realtime sur `stop_time_updates` en ne gardant que la mise à jour la plus récente **non expirée** par `(trip_id, stop_id)`.
4. Calcule pour chaque arrêt:
   - horaire théorique (`arrival_time`, `departure_time`)
   - horaire realtime (`realtime_arrival_time`, `realtime_departure_time`)
   - retard/avance (`delay_seconds`, `delay_minutes`)
5. Si `from` et `to` sont fournis:
   - calcule durée théorique = `to.arrival - from.departure`
   - calcule durée realtime = `to.realtime_arrival - from.realtime_departure`
   - calcule delta = `realtime - théorique`

---

## 6) Guide d’intégration frontend

## 6.1 Données minimales à stocker côté UI
- `trip.trip_id`
- `journey.realtime_travel_minutes`
- `journey.scheduled_travel_minutes`
- `journey.delta_seconds`
- `stops[]` pour timeline visuelle

## 6.2 Algorithme recommandé côté frontend
1. Identifier le `trip_id` actif (depuis endpoint des prochains passages / sélection utilisateur).
2. Appeler `/api/trip-stop-times?trip_id=...&from_stop_id=...&to_stop_id=...`.
3. Afficher:
   - "Temps estimé" = `journey.realtime_travel_minutes` (fallback `scheduled_travel_minutes`)
   - "Arrivée prévue" = `realtime_arrival_time` du stop de descente (fallback théorique)
4. Rafraîchir périodiquement (ex: toutes les 15–30 secondes).

## 6.3 Fallback UX
- Si `journey == null`: afficher seulement la timeline des arrêts.
- Si realtime absent: afficher un badge "théorique".
- Si erreur 404: proposer un nouveau `trip_id` (le trip a potentiellement expiré/changé).

---

## 7) Prompt prêt pour ton autre IA (Frontend)

Copier/coller ce bloc:

```text
Contexte: backend AdonisJS avec endpoint GET /api/trip-stop-times.
Objectif: créer un module frontend “ETA Trip” qui:
1) prend trip_id + from_stop_id + to_stop_id,
2) appelle /api/trip-stop-times,
3) affiche temps de trajet realtime (fallback théorique),
4) affiche heure d’arrivée realtime à l’arrêt de descente,
5) affiche timeline des arrêts avec retard/avance,
6) refresh auto toutes les 20s,
7) gère erreurs 400/404 avec messages UX propres.

Contrat important:
- journey.realtime_travel_minutes prioritaire
- fallback journey.scheduled_travel_minutes
- si journey null => vue timeline seule
- stop delay: positif = retard, négatif = avance
```

---

## 8) Exemples d’appels

### Timeline seule
`/api/trip-stop-times?trip_id=TRIP_123`

### ETA montée/descente par stop_id
`/api/trip-stop-times?trip_id=TRIP_123&from_stop_id=STOP_A&to_stop_id=STOP_B`

### ETA par séquences
`/api/trip-stop-times?trip_id=TRIP_123&from_stop_sequence=12&to_stop_sequence=21`

---

## 9) Fichiers backend concernés

- Contrôleur: `app/controllers/gtfs_controller.ts` (méthode `tripStopTimes`)
- Routing: `start/routes.ts` (route `GET /api/trip-stop-times`)
- UI debug: `public/debug.html` (section de test)

---

## 10) Limites connues

- L’endpoint nécessite un `trip_id` déjà identifié.
- Pas de sélection automatique du "meilleur trip" dans cet endpoint.
- Les données realtime dépendent de la fraîcheur GTFS-RT importée (TTL / expiration).
