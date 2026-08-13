import { describe, expect, it } from 'vitest'
import {
  clusterGrid,
  MAP_STATUS_COLORS,
  mostUrgentColor,
  mostUrgentStatus,
  paddedBounds,
  pointsInPaddedBounds,
  visibleScalePoints,
} from '../../src/lib/mapScale.js'

const point = (id, x, y, status = 'ok', lat = y, lng = x) => ({
  id,
  x,
  y,
  lat,
  lng,
  status,
})

describe('map scale grid', () => {
  it('bins on a fixed grid and returns deterministic rows and members', () => {
    const input = [
      point('c', 75, 5, 'ok'),
      point('b', 50, 15, 'overdue'),
      point('a', 10, 10, 'due-soon'),
      point('d', 10, 80, 'ok'),
    ]
    const project = (item) => ({ x: item.x, y: item.y })
    const summarize = (clusters) =>
      clusters.map((cluster) => ({
        key: cluster.key,
        ids: cluster.members.map((member) => member.id),
        point: cluster.point,
        status: cluster.status,
        bounds: cluster.bounds,
      }))

    const forward = summarize(clusterGrid(input, project, 72))
    const reversed = summarize(clusterGrid([...input].reverse(), project, 72))

    expect(reversed).toEqual(forward)
    expect(forward.map((cluster) => [cluster.key, cluster.ids])).toEqual([
      ['0:0', ['a', 'b']],
      ['1:0', ['c']],
      ['0:1', ['d']],
    ])
    expect(forward[0].point).toEqual({ x: 30, y: 12.5 })
    expect(forward[0].bounds).toEqual({ south: 10, west: 10, north: 15, east: 50 })
  })

  it('uses the most urgent member for both cluster status and color', () => {
    expect(mostUrgentStatus(['ok', 'due-soon', 'overdue', 'ok'])).toBe('overdue')
    expect(mostUrgentColor([{ status: 'ok' }, { status: 'due-soon' }])).toBe(
      MAP_STATUS_COLORS['due-soon']
    )
  })

  it('rejects an invalid grid size instead of producing unstable bins', () => {
    expect(() => clusterGrid([], () => ({ x: 0, y: 0 }), 0)).toThrow(
      'cellSize must be greater than zero'
    )
  })
})

describe('map scale visibility', () => {
  const points = [
    point('red', 1, 1, 'overdue'),
    point('yellow', 2, 2, 'due-soon'),
    point('green', 3, 3, 'ok'),
  ]

  it('filters only visuals and supports all statuses off', () => {
    expect(
      visibleScalePoints(points, { overdue: false, 'due-soon': true, ok: false }).map(
        (item) => item.id
      )
    ).toEqual(['yellow'])
    expect(
      visibleScalePoints(points, { overdue: false, 'due-soon': false, ok: false })
    ).toEqual([])
  })

  it('shows a direct navigation target without changing filter state', () => {
    const filters = { overdue: false, 'due-soon': false, ok: false }
    expect(visibleScalePoints(points, filters, 'green').map((item) => item.id)).toEqual([
      'green',
    ])
    expect(filters).toEqual({ overdue: false, 'due-soon': false, ok: false })
  })

  it('pads high-zoom bounds and keeps the direct target as the sole exception', () => {
    const bounds = { south: 0, west: 0, north: 10, east: 10 }
    expect(paddedBounds(bounds, 0.25)).toEqual({
      south: -2.5,
      west: -2.5,
      north: 12.5,
      east: 12.5,
    })
    const candidates = [
      point('inside', 0, 0, 'ok', 5, 5),
      point('padding-edge', 0, 0, 'ok', -2.5, 12.5),
      point('outside', 0, 0, 'ok', 20, 20),
      point('direct', 0, 0, 'ok', -40, -40),
    ]
    expect(
      pointsInPaddedBounds(candidates, bounds, 0.25, 'direct').map((item) => item.id)
    ).toEqual(['inside', 'padding-edge', 'direct'])
  })
})
