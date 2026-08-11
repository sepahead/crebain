import type { MutableRefObject, ReactNode } from 'react'
import {
  MAX_SURVEILLANCE_CAMERA_FOV_DEGREES,
  MAX_SURVEILLANCE_CAMERA_PAN_DEGREES,
  MAX_SURVEILLANCE_CAMERA_TILT_DEGREES,
  MIN_SURVEILLANCE_CAMERA_FOV_DEGREES,
  MIN_SURVEILLANCE_CAMERA_PAN_DEGREES,
  MIN_SURVEILLANCE_CAMERA_TILT_DEGREES,
} from '../../lib/surveillanceCameraLimits'
import {
  handleHorizontalScrollKeyDown,
  handleVerticalScrollKeyDown,
} from '../horizontalScrollRegion'
import type { ConsoleMessage, SurveillanceCamera } from './types'

interface CameraDetailsOverlayProps {
  camera: SurveillanceCamera | null
  readOnly: boolean
  onDownload: (cameraId: string) => void | Promise<void>
  onUpdatePtz: (cameraId: string, pan?: number, tilt?: number, zoom?: number) => void
}

const PTZ_CONTROLS = [
  {
    label: 'SCHWENK',
    key: 'pan',
    min: MIN_SURVEILLANCE_CAMERA_PAN_DEGREES,
    max: MAX_SURVEILLANCE_CAMERA_PAN_DEGREES,
  },
  {
    label: 'NEIGUNG',
    key: 'tilt',
    min: MIN_SURVEILLANCE_CAMERA_TILT_DEGREES,
    max: MAX_SURVEILLANCE_CAMERA_TILT_DEGREES,
  },
  {
    label: 'ZOOM',
    key: 'zoom',
    min: MIN_SURVEILLANCE_CAMERA_FOV_DEGREES,
    max: MAX_SURVEILLANCE_CAMERA_FOV_DEGREES,
  },
] as const

/**
 * Own the conditional center overlays as one scrollable layout region when
 * viewport or text-scale pressure activates the docked layout.
 */
export function ViewerOverlayRail({
  children,
  isDocked,
}: {
  children: ReactNode
  isDocked: boolean
}) {
  return (
    <div
      data-viewer-overlay-rail
      role={isDocked ? 'region' : undefined}
      aria-label={isDocked ? 'Viewer information overlays' : undefined}
      tabIndex={isDocked ? 0 : undefined}
      onKeyDown={isDocked ? handleVerticalScrollKeyDown : undefined}
    >
      {children}
    </div>
  )
}

export function CameraDetailsOverlay({
  camera,
  readOnly,
  onDownload,
  onUpdatePtz,
}: CameraDetailsOverlayProps) {
  if (!camera) return null

  return (
    <div
      data-viewer-overlay="camera-details"
      role="region"
      aria-label={`${camera.name} camera details`}
      className="absolute top-[68px] right-3 w-52 z-40"
      style={{ fontSize: `calc(12px * var(--ui-scale, 1))` }}
    >
      <div className="bg-[#0c0c0c] border border-[#1a1a1a]">
        <div className="h-7 border-b border-[#1a1a1a] flex items-center justify-between px-3 bg-[#101010]">
          <span className="text-[1em] text-[#c0c0c0]">{camera.name}</span>
          <div className="flex items-center gap-2">
            <div
              role="status"
              aria-label={camera.isRecording ? 'Recording active' : 'Not recording'}
              className={`w-1.5 h-1.5 ${camera.isRecording ? 'bg-[#8b4a4a] animate-pulse' : 'bg-[#303030]'}`}
            />
            {!readOnly && (
              <button
                type="button"
                onClick={() => void onDownload(camera.id)}
                className="px-2 py-0.5 bg-[#101010] border border-[#252525] text-[0.75em] text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0]"
              >
                EXPORT
              </button>
            )}
          </div>
        </div>
        {!readOnly && camera.type === 'ptz' && (
          <div className="p-3 space-y-3">
            {PTZ_CONTROLS.map((control) => {
              const value = camera[control.key]
              return (
                <div key={control.key}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[0.75em] text-[#606060]">{control.label}</span>
                    <span className="text-[0.875em] text-[#a0a0a0]">{value.toFixed(0)}°</span>
                  </div>
                  <input
                    type="range"
                    aria-label={`${camera.name} ${control.label}`}
                    min={control.min}
                    max={control.max}
                    value={value}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      if (control.key === 'pan') onUpdatePtz(camera.id, next)
                      else if (control.key === 'tilt') onUpdatePtz(camera.id, undefined, next)
                      else onUpdatePtz(camera.id, undefined, undefined, next)
                    }}
                    className="w-full h-1 bg-[#1a1a1a] rounded-none appearance-none cursor-pointer [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#606060] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:border-0"
                  />
                </div>
              )
            })}
          </div>
        )}
        {(readOnly || camera.type !== 'ptz') && (
          <div className="p-3 text-[0.875em] text-[#606060]">
            <div>
              Position:{' '}
              <span className="text-[#a0a0a0]">
                {camera.camera.position.x.toFixed(1)}, {camera.camera.position.y.toFixed(1)},{' '}
                {camera.camera.position.z.toFixed(1)}
              </span>
            </div>
            <div className="mt-1">
              Status:{' '}
              <span className="text-[#3a6b4a]">
                {camera.type === 'patrol' ? 'PATROUILLE' : 'ÜBERWACHUNG'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface CameraFeedsOverlayProps {
  cameras: SurveillanceCamera[]
  visible: boolean
  selectedCameraId: string | null
  canvasRefs: MutableRefObject<Map<string, HTMLCanvasElement>>
  onSelect: (cameraId: string) => void
  onVisibleChange: (visible: boolean) => void
}

export function CameraFeedsOverlay({
  cameras,
  visible,
  selectedCameraId,
  canvasRefs,
  onSelect,
  onVisibleChange,
}: CameraFeedsOverlayProps) {
  if (cameras.length === 0) return null
  if (!visible) {
    return (
      <button
        type="button"
        data-viewer-overlay="camera-feeds"
        onClick={() => onVisibleChange(true)}
        aria-expanded={false}
        className="absolute right-3 z-40 px-2 py-1 bg-[#0c0c0c] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090]"
        style={{ bottom: 'calc(var(--viewer-footer-height) + 12px)' }}
      >
        FEEDS ({cameras.length})
      </button>
    )
  }

  return (
    <div
      data-viewer-overlay="camera-feeds"
      role="region"
      aria-label="Live camera feeds"
      className="absolute right-3 z-40"
      style={{
        bottom: 'calc(var(--viewer-footer-height) + 12px)',
        fontSize: `calc(12px * var(--ui-scale, 1))`,
      }}
    >
      <div className="flex items-center justify-between mb-1 px-1">
        <span className="text-[0.75em] text-[#707070] tracking-wider">LIVE</span>
        <button
          type="button"
          onClick={() => onVisibleChange(false)}
          aria-expanded={true}
          className="text-[0.75em] text-[#404040] hover:text-[#808080]"
        >
          AUSBLENDEN
        </button>
      </div>
      <div data-feed-list className="flex gap-1 flex-wrap justify-end max-w-sm">
        {cameras.slice(0, 4).map((camera) => {
          const selected = selectedCameraId === camera.id
          return (
            <button
              type="button"
              key={camera.id}
              onClick={() => onSelect(camera.id)}
              aria-pressed={selected}
              aria-label={`Select live feed ${camera.name}`}
              className={`relative cursor-pointer border transition-all ${selected ? 'border-[#505050]' : 'border-[#1a1a1a] hover:border-[#303030]'}`}
            >
              <canvas
                ref={(element) => {
                  if (element) canvasRefs.current.set(camera.id, element)
                  else canvasRefs.current.delete(camera.id)
                }}
                width={640}
                height={360}
                className="bg-black block w-[140px] h-[79px]"
              />
              <div className="absolute inset-0 pointer-events-none">
                {[
                  'top-0 left-0 border-t border-l',
                  'top-0 right-0 border-t border-r',
                  'bottom-0 left-0 border-b border-l',
                  'bottom-0 right-0 border-b border-r',
                ].map((position) => (
                  <div
                    key={position}
                    className={`absolute w-2 h-2 ${position} ${selected ? 'border-[#505050]' : 'border-[#303030]'}`}
                  />
                ))}
                {camera.isRecording && (
                  <div className="absolute top-1 right-1">
                    <div className="w-1.5 h-1.5 bg-[#8b4a4a] animate-pulse" />
                  </div>
                )}
                <div className="absolute bottom-0 left-0 right-0 h-3 bg-gradient-to-t from-black/80 to-transparent flex items-end px-1 pb-0.5">
                  <span className="text-[0.625em] text-[#808080]">{camera.name}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function ViewerEventLog({ messages }: { messages: ConsoleMessage[] }) {
  return (
    <div
      data-viewer-overlay="event-log"
      role="log"
      aria-live="polite"
      aria-label="Event log"
      className="absolute left-3 z-40 w-64"
      style={{
        bottom: 'calc(var(--viewer-footer-height) + 12px)',
        fontSize: `calc(12px * var(--ui-scale, 1))`,
      }}
    >
      <div className="text-[0.625em] text-[#505050] tracking-wider mb-1 px-1">PROTOKOLL</div>
      <div className="space-y-0.5 max-h-20 overflow-y-auto">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`px-2 py-1 text-[0.875em] bg-[#0c0c0c] border-l-2 ${
              message.type === 'success'
                ? 'border-[#3a6b4a] text-[#6a9a7a]'
                : message.type === 'error'
                  ? 'border-[#8b4a4a] text-[#a06060]'
                  : message.type === 'warning'
                    ? 'border-[#a08040] text-[#a08040]'
                    : message.type === 'tactical'
                      ? 'border-[#3a6b4a] text-[#808080]'
                      : 'border-[#303030] text-[#707070]'
            }`}
          >
            <span className="text-[#404040] text-[0.625em]">
              {new Date(message.timestamp).toISOString().slice(11, 19)}
            </span>{' '}
            {message.message}
          </div>
        ))}
      </div>
    </div>
  )
}

interface ViewerFooterProps {
  readOnly: boolean
  paused: boolean
  feedsVisible: boolean
  onTogglePause: () => void
  onResetSimulation: () => void
  onToggleFeeds: () => void
  onResetCamera: () => void
  onFocusContent: () => void
}

export function ViewerFooter({
  readOnly,
  paused,
  feedsVisible,
  onTogglePause,
  onResetSimulation,
  onToggleFeeds,
  onResetCamera,
  onFocusContent,
}: ViewerFooterProps) {
  return (
    <div
      role="region"
      aria-label="Simulation controls and shortcuts"
      tabIndex={0}
      onKeyDown={handleHorizontalScrollKeyDown}
      className="absolute bottom-0 left-0 right-0 z-30 overflow-x-auto overflow-y-hidden bg-[#0a0a0a] border-t border-[#1a1a1a]"
      style={{
        height: 'var(--viewer-footer-height)',
        fontSize: `calc(12px * var(--ui-scale, 1))`,
      }}
    >
      <div className="h-full w-max min-w-full flex items-center justify-between gap-6 px-4">
        <div className="flex items-center gap-4 text-[0.75em] text-[#505050] tracking-wider">
          <span>
            NAV: <span className="text-[#707070]">WASD</span>
          </span>
          <span>
            VERT: <span className="text-[#707070]">Q/E</span>
          </span>
          <span>
            ROT: <span className="text-[#707070]">Z/X/←/→</span>
          </span>
          <span>
            SPRINT: <span className="text-[#707070]">⇧</span>
          </span>
          <span>
            PRÄZ: <span className="text-[#707070]">⌃</span>
          </span>
          <span>
            STOP: <span className="text-[#707070]">␣</span>
          </span>
          {!readOnly && (
            <>
              <span className="text-[#303030]">│</span>
              <span>
                CAM: <span className="text-[#707070]">1/2/3</span>
              </span>
            </>
          )}
          <span>
            WECHS: <span className="text-[#707070]">⇥</span>
          </span>
          <span>
            FEEDS: <span className="text-[#707070]">V</span>
          </span>
          {!readOnly && (
            <span>
              DETEK: <span className="text-[#707070]">T</span>
            </span>
          )}
          <span className="text-[#303030]">│</span>
          <span>
            RESET: <span className="text-[#707070]">R</span>
          </span>
          <span>
            FOKUS: <span className="text-[#707070]">F</span>
          </span>
          {!readOnly && (
            <span>
              LADEN: <span className="text-[#707070]">⌃O</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!readOnly && (
            <>
              <button
                type="button"
                onClick={onTogglePause}
                className={`px-2 py-1 border text-[0.875em] transition-all ${paused ? 'bg-[#1a3a1a] border-[#3a6b4a] text-[#3a6b4a]' : 'bg-[#101010] border-[#252525] text-[#606060] hover:border-[#404040] hover:text-[#909090]'}`}
              >
                {paused ? '▶ START SIM' : '⏸ PAUSE'}
              </button>
              <button
                type="button"
                onClick={onResetSimulation}
                className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all"
              >
                SIM-RESET
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onToggleFeeds}
            aria-pressed={feedsVisible}
            className={`px-2 py-1 border text-[0.875em] transition-all ${feedsVisible ? 'bg-[#1a2a1a] border-[#3a6b4a] text-[#3a6b4a]' : 'bg-[#101010] border-[#252525] text-[#606060] hover:border-[#404040] hover:text-[#909090]'}`}
          >
            FEEDS
          </button>
          <button
            type="button"
            onClick={onResetCamera}
            className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all"
          >
            CAM-RESET
          </button>
          <button
            type="button"
            onClick={onFocusContent}
            className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all"
          >
            FOKUS
          </button>
        </div>
      </div>
    </div>
  )
}

export function ViewerLoadingOverlay({
  name,
  progress,
  stage,
}: {
  name: string | null
  progress: number
  stage: 'reading' | 'processing' | 'rendering'
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute top-24 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 px-6 py-3 bg-[#0c0c0c] border border-[#252525] min-w-[240px]"
    >
      <div className="flex items-center gap-3 w-full">
        <div
          aria-hidden="true"
          className="w-2 h-2 border border-[#808080] border-t-transparent animate-spin motion-reduce:animate-none"
        />
        <span className="text-[#808080] text-[1em] flex-1">
          {stage === 'reading' && 'LESEN'}
          {stage === 'processing' && 'VERARBEITEN'}
          {stage === 'rendering' && 'RENDERN'}: <span className="text-[#a0a0a0]">{name}</span>
        </span>
        <span className="text-[#606060] text-[1em]">{Math.round(progress)}%</span>
      </div>
      <div className="w-full h-1 bg-[#1a1a1a] rounded overflow-hidden">
        <div
          className="h-full bg-[#3a6b4a] transition-[width] duration-200 motion-reduce:transition-none"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
