import type { Detection, ThreatLevel } from '../../detection/types'
import type { SurveillanceCamera } from './types'
import { formatZuluTime, formatCoordinate } from './types'

interface HeaderBarProps {
  backendStatusColor: string
  threatLevel: ThreatLevel
  onThreatLevelChange: (level: ThreatLevel) => void
  scalePercent: number
  isAtMin: boolean
  isAtMax: boolean
  onDecreaseScale: () => void
  onIncreaseScale: () => void
  currentTime: Date
  operatorPosition: { lat: number; lon: number; alt: number }
  altitude: number
  bearing: number
  cameras: SurveillanceCamera[]
  objectCount: number
  totalDetections: number
  fusedTrackCount: number
  showGrid: boolean
  detectionEnabled: boolean
  highestThreat: Detection | null
}

/**
 * Top status bar: branding, threat level selector, diagnostics indicators, UI
 * scale controls, live clock/position/heading readouts, and a status strip with
 * camera/detection/fusion counters. Purely presentational; state lives in
 * {@link CrebainViewer}.
 */
export default function HeaderBar({
  backendStatusColor,
  threatLevel,
  onThreatLevelChange,
  scalePercent,
  isAtMin,
  isAtMax,
  onDecreaseScale,
  onIncreaseScale,
  currentTime,
  operatorPosition,
  altitude,
  bearing,
  cameras,
  objectCount,
  totalDetections,
  fusedTrackCount,
  showGrid,
  detectionEnabled,
  highestThreat,
}: HeaderBarProps) {
  return (
    <div
      className="absolute top-0 left-0 right-0 z-50 pointer-events-none"
      style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}
    >
      <div className="h-11 bg-[#0c0c0c] border-b border-[#1a1a1a] flex items-center px-4">
        <div className="flex items-center gap-3 pointer-events-auto">
          <img src="/crebain-logo.png" alt="CREBAIN" className="w-9 h-9" />
          <div>
            <div className="text-[1.25em] text-[#e0e0e0] font-medium tracking-[0.3em] whitespace-nowrap">
              CREBAIN
            </div>
            <div className="text-[0.875em] text-[#606060] tracking-[0.15em] whitespace-nowrap">
              REAKTIONS- UND AUFKLÄRUNGSSYSTEM
            </div>
          </div>
        </div>

        <div className="w-px h-6 bg-[#1a1a1a] mx-4" />

        <div className="flex items-center gap-2 pointer-events-auto">
          <span className="text-[0.875em] text-[#606060] tracking-wider mr-1">STUFE</span>
          {([1, 2, 3, 4] as ThreatLevel[]).map((level) => (
            <button
              key={level}
              onClick={() => onThreatLevelChange(level)}
              className={`w-6 h-5 text-[1.125em] font-bold border transition-all ${
                threatLevel === level
                  ? level <= 2
                    ? 'bg-[#1a1a1a] border-[#404040] text-[#c0c0c0]'
                    : level === 3
                      ? 'bg-[#1a1408] border-[#a08040] text-[#a08040]'
                      : 'bg-[#1a0808] border-[#8b4a4a] text-[#8b4a4a]'
                  : 'bg-[#0c0c0c] border-[#1a1a1a] text-[#404040] hover:border-[#303030]'
              }`}
            >
              {level}
            </button>
          ))}
        </div>

        <div className="w-px h-6 bg-[#1a1a1a] mx-4" />

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 ${backendStatusColor}`} />
            <span className="text-[0.875em] text-[#707070]">DIAG</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 bg-[#a08040]" />
            <span className="text-[0.875em] text-[#707070]">KRYPTO CFG</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 bg-[#505050]" />
            <span className="text-[0.875em] text-[#707070]">POS SIM</span>
          </div>
        </div>

        <div className="w-px h-6 bg-[#1a1a1a] mx-2" />

        {/* UI Scale Controls */}
        <div className="flex items-center gap-1 pointer-events-auto">
          <span className="text-[0.875em] text-[#505050] tracking-wider mr-1">UI</span>
          <button
            onClick={onDecreaseScale}
            disabled={isAtMin}
            className={`w-5 h-5 bg-[#101010] border border-[#252525] text-[1.25em] flex items-center justify-center ${
              isAtMin
                ? 'text-[#404040] cursor-not-allowed'
                : 'text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0]'
            }`}
            title="Decrease UI size"
          >
            −
          </button>
          <span className="text-[1em] text-[#606060] w-8 text-center">{scalePercent}%</span>
          <button
            onClick={onIncreaseScale}
            disabled={isAtMax}
            className={`w-5 h-5 bg-[#101010] border border-[#252525] text-[1.25em] flex items-center justify-center ${
              isAtMax
                ? 'text-[#404040] cursor-not-allowed'
                : 'text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0]'
            }`}
            title="Increase UI size"
          >
            +
          </button>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-6 text-[1.125em]">
          <div className="text-right">
            <div className="text-[0.75em] text-[#505050] tracking-wider">ZEIT</div>
            <div className="text-[#a0a0a0] tracking-wider">{formatZuluTime(currentTime)}</div>
          </div>
          <div className="w-px h-5 bg-[#1a1a1a]" />
          <div className="text-right">
            <div className="text-[0.75em] text-[#505050] tracking-wider">SIM POS</div>
            <div className="text-[#a0a0a0]">
              {formatCoordinate(operatorPosition.lat, true)}{' '}
              {formatCoordinate(operatorPosition.lon, false)}
            </div>
          </div>
          <div className="w-px h-5 bg-[#1a1a1a]" />
          <div className="text-right">
            <div className="text-[0.75em] text-[#505050] tracking-wider">HÖHE</div>
            <div className="text-[#a0a0a0]">{(altitude + operatorPosition.alt).toFixed(1)}m</div>
          </div>
          <div className="w-px h-5 bg-[#1a1a1a]" />
          <div className="text-right">
            <div className="text-[0.75em] text-[#505050] tracking-wider">KURS</div>
            <div className="text-[#a0a0a0]">{bearing.toFixed(0).padStart(3, '0')}°</div>
          </div>
        </div>

        <div className="flex items-center gap-2 ml-6">
          <div className="px-2 py-1 bg-[#101010] border border-[#252525] text-[1em]">
            <span className="text-[#606060]">ISR</span>{' '}
            <span className="text-[#b0b0b0]">{cameras.length}</span>
          </div>
          <div className="px-2 py-1 bg-[#101010] border border-[#252525] text-[1em]">
            <span className="text-[#606060]">OBJ</span>{' '}
            <span className="text-[#b0b0b0]">{objectCount}</span>
          </div>
          <div
            className={`px-2 py-1 border text-[1em] ${totalDetections > 0 ? 'bg-[#1a1408] border-[#a08040]' : 'bg-[#101010] border-[#252525]'}`}
          >
            <span className="text-[#606060]">DET</span>{' '}
            <span className={totalDetections > 0 ? 'text-[#a08040]' : 'text-[#b0b0b0]'}>
              {totalDetections}
            </span>
          </div>
          <div
            className={`px-2 py-1 border text-[1em] ${fusedTrackCount > 0 ? 'bg-[#0a1a0a] border-[#3a6b4a]' : 'bg-[#101010] border-[#252525]'}`}
          >
            <span className="text-[#606060]">TRK</span>{' '}
            <span className={fusedTrackCount > 0 ? 'text-[#3a6b4a]' : 'text-[#b0b0b0]'}>
              {fusedTrackCount}
            </span>
          </div>
        </div>
      </div>

      <div className="h-5 bg-[#0a0a0a] border-b border-[#1a1a1a] flex items-center px-4 text-[0.875em] text-[#505050] tracking-wider">
        <span>
          RASTER:{' '}
          <span className={showGrid ? 'text-[#808080]' : 'text-[#404040]'}>
            {showGrid ? 'EIN' : 'AUS'}
          </span>
        </span>
        <span className="mx-3 text-[#252525]">│</span>
        <span>
          SK:{' '}
          <span className="text-[#808080]">
            {cameras.filter((c) => c.type === 'static').length}
          </span>
        </span>
        <span className="mx-2">
          PTZ:{' '}
          <span className="text-[#808080]">{cameras.filter((c) => c.type === 'ptz').length}</span>
        </span>
        <span>
          PK:{' '}
          <span className="text-[#808080]">
            {cameras.filter((c) => c.type === 'patrol').length}
          </span>
        </span>
        <span className="mx-3 text-[#252525]">│</span>
        <span>
          AUFZ:{' '}
          <span
            className={
              cameras.filter((c) => c.isRecording).length > 0 ? 'text-[#8b4a4a]' : 'text-[#404040]'
            }
          >
            {cameras.filter((c) => c.isRecording).length}
          </span>
        </span>
        <span className="mx-3 text-[#252525]">│</span>
        <span>
          YOLO:{' '}
          <span className={detectionEnabled ? 'text-[#3a6b4a]' : 'text-[#404040]'}>
            {detectionEnabled ? 'AKTIV' : 'AUS'}
          </span>
        </span>
        <span className="mx-2">
          FUSION:{' '}
          <span
            className={cameras.length > 1 && detectionEnabled ? 'text-[#3a6b4a]' : 'text-[#404040]'}
          >
            {cameras.length > 1 && detectionEnabled ? 'AN' : 'AUS'}
          </span>
        </span>
        {highestThreat && (
          <>
            <span className="mx-3 text-[#252525]">│</span>
            <span className="text-[#a08040]">
              BEDROHUNG: {highestThreat.class.toUpperCase()}{' '}
              {((highestThreat.confidence ?? 0) * 100).toFixed(0)}%
            </span>
          </>
        )}
      </div>
    </div>
  )
}
