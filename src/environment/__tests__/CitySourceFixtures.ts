import { ENGINE_MODEL } from '../../physics/ForceAttitudeController'
import type { ForceCityBatch } from '../../physics/ForceCityWorld'
import { CITY_ENVIRONMENT_PROFILE, type CityEnvironmentPlan } from '../CitySourceContract'
import type { CityObservation } from '../ForceCityEnvironment'
import type { SceneCamera } from '../SceneSpec'

export function cityPlan(
  count = 2,
  selected = { rgb: 1, thermal: 1, pressure: 1 }
): CityEnvironmentPlan {
  const camera = (id: string, index: number): SceneCamera => ({
    id,
    position: [index * 3, 28, 38],
    target: [0, 23, 0],
    width: 8,
    height: 8,
    fovDegrees: 70,
    periodTicks: 1,
  })
  const geometry = [
    {
      id: 'wall',
      center: [-5, 3, 0] as [number, number, number],
      halfExtents: [1, 3, 6] as [number, number, number],
      yaw: 0.2,
      friction: 0.7,
      restitution: 0.1,
    },
  ]
  const plan: CityEnvironmentPlan = {
    profile: CITY_ENVIRONMENT_PROFILE,
    world: {
      profile: 'crebain.rapier-force-city.v1',
      runId: 'city-source-control',
      sourceIdentity: 'e'.repeat(64),
      horizonTicks: 24,
      actionBudget: Math.max(count, 12),
      staticGeometry: geometry,
      drones: Array.from({ length: count }, (_, index) => ({
        id: `drone-${String(index).padStart(3, '0')}`,
        position: [(index % 16) * 3, 23 + (index % 3), Math.floor(index / 16) * 3],
        controller: {
          engineModel: ENGINE_MODEL,
          referenceAltitudeM: 23 + (index % 3),
          referenceHeadingRad: (index % 2) * 0.02,
        },
      })),
    },
    scene: {
      profile: 'crebain.city-scene.v1',
      id: 'city-source-scene',
      frame: 'three-y-up-z-forward-m',
      solids: geometry.map((shape) => ({ shape, materialId: 'concrete' })),
      materials: [
        {
          id: 'concrete',
          linearRgb: [0.35, 0.38, 0.43],
          gaussianOpacity: 0.85,
          temperatureK: 293.15,
          emissivity: 0.9,
        },
      ],
      rgbCameras: Array.from({ length: selected.rgb }, (_, index) => camera(`rgb-${index}`, index)),
      thermalCameras: Array.from({ length: selected.thermal }, (_, index) =>
        camera(`thermal-${index}`, index)
      ),
      microphones: Array.from({ length: selected.pressure }, (_, index) => ({
        id: `mic-${index}`,
        position: [index * 3, 24, 4] as [number, number, number],
      })),
    },
    requests: [],
    ...(selected.pressure
      ? {
          acoustic: {
            profile: 'crebain.discrete-direct-acoustic.v1' as const,
            sampleRateHz: 16000 as const,
            soundSpeedMps: 343,
            maximumRangeM: 32,
            referenceDistanceM: 1,
            referencePressurePa: 1,
            bladeCount: 2 as const,
            blockedGain: 0,
            noiseStdPa: 0.001,
            seed: 9,
          },
        }
      : {}),
    ...(selected.thermal
      ? {
          thermal: {
            profile: 'crebain.lumped-gray-thermal.v1' as const,
            ambientK: 293.15,
            initialK: 293.15,
            capacityJPerK: 100,
            areaM2: 0.1,
            convectionWPerM2K: 10,
            emissivity: 0.9,
            motorEfficiency: 0.7,
          },
        }
      : {}),
  }
  for (const [kind, rows] of [
    ['rgb', plan.scene.rgbCameras],
    ['thermal', plan.scene.thermalCameras],
    ['pressure', plan.scene.microphones],
  ] as const)
    for (const row of rows) {
      const index = plan.requests.length
      plan.requests.push({
        requestId: `request-${String(index).padStart(2, '0')}`,
        sourceId: `source-${String(index).padStart(2, '0')}`,
        entityId: plan.world.drones[index % count]?.id ?? 'missing',
        kind,
        sceneSourceId: row.id,
        periodTicks: 1,
      })
    }
  return plan
}

export function citySet(plan: CityEnvironmentPlan): ForceCityBatch {
  return {
    tick: 1,
    rows: plan.world.drones.map((row, index) => ({
      kind: 'set',
      droneId: row.id,
      armed: true,
      target: {
        kind: 'force_attitude_height',
        roll_rad: index % 2 ? -0.02 : 0.03,
        pitch_rad: 0.01,
        heading_rad: row.controller.referenceHeadingRad,
        altitude_m: row.controller.referenceAltitudeM,
      },
    })),
  }
}

export function cityHold(batch: CityObservation): ForceCityBatch {
  return {
    tick: batch.tick + 1,
    rows: batch.control.rows.map((row) => ({
      kind: 'hold',
      droneId: row.entityId,
      actionSha256: row.actionSha256,
    })),
  }
}
