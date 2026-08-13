export const MAP_STATUS_COLORS = {
  overdue: '#dc2626',
  'due-soon': '#f59e0b',
  ok: '#16a34a',
}

const STATUS_URGENCY = {
  overdue: 0,
  'due-soon': 1,
  ok: 2,
}

export const DEFAULT_MAP_STATUS_VISIBILITY = {
  overdue: true,
  'due-soon': true,
  ok: true,
}

export function mostUrgentStatus(points) {
  let mostUrgent = 'ok'
  for (const point of points) {
    const status = typeof point === 'string' ? point : point.status
    if (STATUS_URGENCY[status] < STATUS_URGENCY[mostUrgent]) mostUrgent = status
  }
  return mostUrgent
}

export function mostUrgentColor(points) {
  return MAP_STATUS_COLORS[mostUrgentStatus(points)]
}

export function visibleScalePoints(points, statusVisibility, directCustomerId = null) {
  return points.filter(
    (point) => point.id === directCustomerId || statusVisibility[point.status] === true
  )
}

/**
 * Bin projected world-pixel points onto a map-fixed grid. Callers supply the
 * projection so this stays independent of Leaflet and deterministic in tests.
 */
export function clusterGrid(points, project, cellSize = 72) {
  if (!(cellSize > 0)) throw new Error('cellSize must be greater than zero')

  const bins = new Map()
  for (const point of points) {
    const projected = project(point)
    const column = Math.floor(projected.x / cellSize)
    const row = Math.floor(projected.y / cellSize)
    const key = `${column}:${row}`
    let bin = bins.get(key)
    if (!bin) {
      bin = {
        key,
        column,
        row,
        sumX: 0,
        sumY: 0,
        members: [],
        bounds: {
          south: point.lat,
          west: point.lng,
          north: point.lat,
          east: point.lng,
        },
      }
      bins.set(key, bin)
    }
    bin.sumX += projected.x
    bin.sumY += projected.y
    bin.members.push(point)
    bin.bounds.south = Math.min(bin.bounds.south, point.lat)
    bin.bounds.west = Math.min(bin.bounds.west, point.lng)
    bin.bounds.north = Math.max(bin.bounds.north, point.lat)
    bin.bounds.east = Math.max(bin.bounds.east, point.lng)
  }

  return [...bins.values()]
    .sort((a, b) => a.row - b.row || a.column - b.column)
    .map((bin) => {
      const members = [...bin.members].sort((a, b) => {
        const aId = String(a.id)
        const bId = String(b.id)
        return aId < bId ? -1 : aId > bId ? 1 : 0
      })
      return {
        key: bin.key,
        point: { x: bin.sumX / members.length, y: bin.sumY / members.length },
        members,
        count: members.length,
        status: mostUrgentStatus(members),
        color: mostUrgentColor(members),
        bounds: bin.bounds,
      }
    })
}

export function paddedBounds(bounds, padding = 0.25) {
  const latPad = (bounds.north - bounds.south) * padding
  const lngPad = (bounds.east - bounds.west) * padding
  return {
    south: Math.max(-90, bounds.south - latPad),
    west: Math.max(-180, bounds.west - lngPad),
    north: Math.min(90, bounds.north + latPad),
    east: Math.min(180, bounds.east + lngPad),
  }
}

export function pointsInPaddedBounds(
  points,
  bounds,
  padding = 0.25,
  directCustomerId = null
) {
  const padded = paddedBounds(bounds, padding)
  return points.filter(
    (point) =>
      point.id === directCustomerId ||
      (point.lat >= padded.south &&
        point.lat <= padded.north &&
        point.lng >= padded.west &&
        point.lng <= padded.east)
  )
}
