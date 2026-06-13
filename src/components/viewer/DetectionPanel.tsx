import type { FusionStats } from '../../detection/SensorFusion'
import type { Detection, FusedTrack } from '../../detection/types'
import { THREAT_LEVEL_COLORS } from '../../detection/types'
import type { SurveillanceCamera } from './types'

interface DetectionPanelProps {
  totalDetections: number
  fusedTracks: FusedTrack[]
  cameraDetections: Map<string, Detection[]>
  cameras: SurveillanceCamera[]
  fusionStats: FusionStats | null
  onClose: () => void
}

/**
 * Read-only overlay listing confirmed fused tracks, per-camera detections, and
 * fusion statistics. Rendered by {@link CrebainViewer} when detections exist.
 */
export default function DetectionPanel({
  totalDetections,
  fusedTracks,
  cameraDetections,
  cameras,
  fusionStats,
  onClose,
}: DetectionPanelProps) {
  return (
    <div
      className="absolute top-[68px] right-[220px] w-56 z-40"
      style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}
    >
      <div className="bg-[#0c0c0c] border border-[#1a1a1a]">
        <div className="h-7 border-b border-[#1a1a1a] flex items-center justify-between px-3 bg-[#101010]">
          <span className="text-[0.875em] text-[#909090] tracking-[0.2em]">DETEKTIONEN</span>
          <button onClick={onClose} className="text-[1em] text-[#404040] hover:text-[#808080]">
            ×
          </button>
        </div>

        <div className="p-2 max-h-[300px] overflow-y-auto">
          {/* Fused Tracks Section */}
          {fusedTracks.length > 0 && (
            <div className="mb-3">
              <div className="text-[0.75em] text-[#606060] tracking-wider mb-1.5">
                BESTÄTIGTE TRACKS
              </div>
              <div className="space-y-1">
                {fusedTracks.slice(0, 5).map((track) => (
                  <div
                    key={track.id}
                    className={`p-1.5 border ${track.state === 'confirmed' ? 'border-[#3a6b4a] bg-[#0a1a0a]' : 'border-[#252525] bg-[#0e0e0e]'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-1.5 h-1.5"
                          style={{ backgroundColor: THREAT_LEVEL_COLORS[track.threatLevel] }}
                        />
                        <span className="text-[1em] text-[#c0c0c0]">{track.id}</span>
                      </div>
                      <span
                        className="text-[0.875em]"
                        style={{ color: THREAT_LEVEL_COLORS[track.threatLevel] }}
                      >
                        {track.class.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1 text-[0.75em] text-[#606060]">
                      <span>
                        Konfidenz:{' '}
                        <span className="text-[#a0a0a0]">
                          {(track.fusedConfidence * 100).toFixed(0)}%
                        </span>
                      </span>
                      <span>
                        Kameras:{' '}
                        <span className="text-[#a0a0a0]">{track.contributingCameras.length}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Camera Detections Section */}
          {totalDetections > 0 && (
            <div>
              <div className="text-[0.75em] text-[#606060] tracking-wider mb-1.5">
                KAMERA DETEKTIONEN
              </div>
              {Array.from(cameraDetections.entries()).map(([camId, dets]) => {
                if (dets.length === 0) return null
                const cam = cameras.find((c) => c.id === camId)
                return (
                  <div key={camId} className="mb-2">
                    <div className="text-[0.875em] text-[#808080] mb-1">{cam?.name || camId}</div>
                    <div className="space-y-0.5">
                      {dets.slice(0, 3).map((det) => (
                        <div
                          key={det.id}
                          className="flex items-center justify-between px-1.5 py-1 bg-[#0e0e0e] border border-[#1a1a1a]"
                        >
                          <div className="flex items-center gap-1.5">
                            <div
                              className="w-1 h-1"
                              style={{
                                backgroundColor: THREAT_LEVEL_COLORS[det.threatLevel ?? 1],
                              }}
                            />
                            <span className="text-[0.875em] text-[#909090]">
                              {det.class.toUpperCase()}
                            </span>
                          </div>
                          <span
                            className="text-[0.875em]"
                            style={{ color: THREAT_LEVEL_COLORS[det.threatLevel ?? 1] }}
                          >
                            {(det.confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                      ))}
                      {dets.length > 3 && (
                        <div className="text-[0.75em] text-[#505050] text-center">
                          +{dets.length - 3} weitere
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Fusion Stats Footer */}
        {fusionStats && (
          <div className="border-t border-[#1a1a1a] px-3 py-1.5 flex items-center justify-between text-[0.75em] text-[#505050]">
            <span>FRAME: {fusionStats.frameCount}</span>
            <span>KONF: {(fusionStats.avgFusedConfidence * 100).toFixed(0)}%</span>
            <span className={fusionStats.highThreatCount > 0 ? 'text-[#a08040]' : ''}>
              BEDR: {fusionStats.highThreatCount}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
