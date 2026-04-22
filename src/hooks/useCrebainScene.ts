/**
 * CREBAIN Scene Hook
 * Manages Three.js scene, camera, renderer, and controls lifecycle
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createTacticalGrid, createGridLabels } from '../components/viewer/TacticalGrid'

export interface RendererWithAsync extends THREE.WebGLRenderer {
  initAsync?: () => Promise<void>
}

export interface SceneConfig {
  backgroundColor?: number
  fogColor?: number
  fogNear?: number
  fogFar?: number
  ambientLightIntensity?: number
  enableShadows?: boolean
}

export interface MovementConfig {
  baseSpeed: number
  sprintMultiplier: number
  precisionMultiplier: number
  acceleration: number
  deceleration: number
  maxVelocity: number
  rotateSpeed: number
  verticalSpeed: number
}

export interface MoveState {
  forward: boolean
  backward: boolean
  left: boolean
  right: boolean
  up: boolean
  down: boolean
  sprint: boolean
  precision: boolean
  rotateLeft: boolean
  rotateRight: boolean
  lookUp: boolean
  lookDown: boolean
}

export interface UseCrebainSceneReturn {
  containerRef: React.RefObject<HTMLDivElement | null>
  scene: THREE.Scene | null
  camera: THREE.PerspectiveCamera | null
  renderer: RendererWithAsync | null
  controls: OrbitControls | null
  glbLoader: GLTFLoader | null
  raycaster: THREE.Raycaster
  mouse: THREE.Vector2
  gridVisible: boolean
  setGridVisible: (visible: boolean) => void
  resetCamera: () => void
  focusOnContent: () => void
  getWorldPosition: (screenX: number, screenY: number) => THREE.Vector3 | null
}

const DEFAULT_SCENE_CONFIG: Required<SceneConfig> = {
  backgroundColor: 0x0a0a0a,
  fogColor: 0x0a0a0a,
  fogNear: 100,
  fogFar: 400,
  ambientLightIntensity: 1.2,
  enableShadows: true,
}

const DEFAULT_MOVEMENT_CONFIG: MovementConfig = {
  baseSpeed: 8.0,
  sprintMultiplier: 3.0,
  precisionMultiplier: 0.2,
  acceleration: 25.0,
  deceleration: 20.0,
  maxVelocity: 50.0,
  rotateSpeed: 90.0,
  verticalSpeed: 6.0,
}

function disposeMeshMaterials(mesh: THREE.Mesh): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const material of materials) {
    if (material instanceof THREE.MeshStandardMaterial) {
      material.map?.dispose()
      material.normalMap?.dispose()
      material.roughnessMap?.dispose()
      material.metalnessMap?.dispose()
      material.aoMap?.dispose()
      material.emissiveMap?.dispose()
    }
    material.dispose()
  }
}

export function useCrebainScene(
  sceneConfig: SceneConfig = {},
  movementConfig: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
  onMessage?: (level: 'info' | 'system', text: string) => void
): UseCrebainSceneReturn {
  const config = { ...DEFAULT_SCENE_CONFIG, ...sceneConfig }

  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const rendererRef = useRef<RendererWithAsync | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const glbLoaderRef = useRef<GLTFLoader | null>(null)
  const gridRef = useRef<THREE.Mesh | null>(null)
  const gridLabelsRef = useRef<THREE.Group | null>(null)
  // Signal consumers to re-render once the scene objects are populated
  const [isReady, setIsReady] = useState(false)
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster())
  const mouseRef = useRef<THREE.Vector2>(new THREE.Vector2())

  const moveStateRef = useRef<MoveState>({
    forward: false, backward: false, left: false, right: false,
    up: false, down: false, sprint: false, precision: false,
    rotateLeft: false, rotateRight: false, lookUp: false, lookDown: false,
  })
  const velocityRef = useRef(new THREE.Vector3())
  const lastFrameTimeRef = useRef(performance.now())
  const gridVisibleRef = useRef(true)

  const setGridVisible = useCallback((visible: boolean) => {
    gridVisibleRef.current = visible
    if (gridRef.current) gridRef.current.visible = visible
    if (gridLabelsRef.current) gridLabelsRef.current.visible = visible
  }, [])

  const resetCamera = useCallback(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls) return

    camera.position.set(0, 1.6, 5)
    controls.target.set(0, 0, 0)
    controls.update()
  }, [])

  const focusOnContent = useCallback(() => {
    const scene = sceneRef.current
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!scene || !camera || !controls) return

    const box = new THREE.Box3()
    let hasContent = false

    scene.traverse((object) => {
      if (object instanceof THREE.Mesh && object.visible && object !== gridRef.current) {
        box.expandByObject(object)
        hasContent = true
      }
    })

    if (hasContent && !box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const distance = maxDim * 2

      camera.position.set(center.x + distance, center.y + distance * 0.5, center.z + distance)
      controls.target.copy(center)
      controls.update()
    }
  }, [])

  const getWorldPosition = useCallback((screenX: number, screenY: number): THREE.Vector3 | null => {
    const container = containerRef.current
    const camera = cameraRef.current
    if (!container || !camera) return null

    const rect = container.getBoundingClientRect()
    const x = ((screenX - rect.left) / rect.width) * 2 - 1
    const y = -((screenY - rect.top) / rect.height) * 2 + 1

    raycasterRef.current.setFromCamera(new THREE.Vector2(x, y), camera)
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const intersection = new THREE.Vector3()

    if (raycasterRef.current.ray.intersectPlane(groundPlane, intersection)) {
      return intersection
    }
    return null
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const width = container.clientWidth
    const height = container.clientHeight

    // Scene setup
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(config.backgroundColor)
    scene.fog = new THREE.Fog(config.fogColor, config.fogNear, config.fogFar)
    sceneRef.current = scene

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404040, config.ambientLightIntensity)
    scene.add(ambientLight)

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.5)
    dirLight1.position.set(5, 10, 5)
    dirLight1.castShadow = config.enableShadows
    scene.add(dirLight1)

    const dirLight2 = new THREE.DirectionalLight(0x8080a0, 0.2)
    dirLight2.position.set(-5, 5, -5)
    scene.add(dirLight2)

    // Camera
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000)
    camera.position.set(0, 1.6, 5)
    cameraRef.current = camera

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    }) as RendererWithAsync

    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    if (renderer.outputColorSpace !== undefined) {
      renderer.outputColorSpace = THREE.SRGBColorSpace
    }
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.7
    renderer.shadowMap.enabled = config.enableShadows
    renderer.shadowMap.type = THREE.PCFSoftShadowMap

    container.appendChild(renderer.domElement)
    rendererRef.current = renderer
    onMessage?.('system', 'BACKEND: WebGL')

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.rotateSpeed = 0.6
    controls.panSpeed = 0.8
    controls.zoomSpeed = 1.0
    controls.minDistance = 0.1
    controls.maxDistance = 500
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.maxPolarAngle = Math.PI * 0.95
    controlsRef.current = controls

    // Loaders
    glbLoaderRef.current = new GLTFLoader()

    // Grid
    gridRef.current = createTacticalGrid(scene)
    gridLabelsRef.current = createGridLabels(scene)

    // Signal consumers that scene objects are ready
    setIsReady(true)

    // Resize handler
    const handleResize = () => {
      const newWidth = container.clientWidth
      const newHeight = container.clientHeight
      camera.aspect = newWidth / newHeight
      camera.updateProjectionMatrix()
      renderer.setSize(newWidth, newHeight)
    }
    window.addEventListener('resize', handleResize)

    // Pre-allocate scratch vectors to avoid GC pressure in the 60fps animate loop
    const _forward = new THREE.Vector3()
    const _right = new THREE.Vector3()
    const _targetVelocity = new THREE.Vector3()
    const _velocityDiff = new THREE.Vector3()
    const _movement = new THREE.Vector3()
    const _offset = new THREE.Vector3()
    const _yAxis = new THREE.Vector3(0, 1, 0)

    // Animation loop with WASD movement
    const animate = () => {
      const now = performance.now()
      const deltaTime = Math.min((now - lastFrameTimeRef.current) / 1000, 0.1)
      lastFrameTimeRef.current = now

      const ms = moveStateRef.current
      const cfg = movementConfig

      let speedMultiplier = 1.0
      if (ms.sprint) speedMultiplier = cfg.sprintMultiplier
      if (ms.precision) speedMultiplier = cfg.precisionMultiplier
      const targetSpeed = cfg.baseSpeed * speedMultiplier

      camera.getWorldDirection(_forward)
      _forward.y = 0
      _forward.normalize()
      _right.crossVectors(_forward, camera.up).normalize()

      _targetVelocity.set(0, 0, 0)
      if (ms.forward) _targetVelocity.addScaledVector(_forward, targetSpeed)
      if (ms.backward) _targetVelocity.addScaledVector(_forward, -targetSpeed)
      if (ms.left) _targetVelocity.addScaledVector(_right, -targetSpeed)
      if (ms.right) _targetVelocity.addScaledVector(_right, targetSpeed)
      if (ms.up) _targetVelocity.y += cfg.verticalSpeed * speedMultiplier
      if (ms.down) _targetVelocity.y -= cfg.verticalSpeed * speedMultiplier

      const isMoving = _targetVelocity.length() > 0.001
      const accelRate = isMoving ? cfg.acceleration : cfg.deceleration
      _velocityDiff.subVectors(_targetVelocity, velocityRef.current)
      const maxDelta = accelRate * deltaTime

      if (_velocityDiff.length() <= maxDelta) {
        velocityRef.current.copy(_targetVelocity)
      } else {
        velocityRef.current.addScaledVector(_velocityDiff.normalize(), maxDelta)
      }

      if (velocityRef.current.length() > cfg.maxVelocity) {
        velocityRef.current.normalize().multiplyScalar(cfg.maxVelocity)
      }

      if (velocityRef.current.length() > 0.001) {
        _movement.copy(velocityRef.current).multiplyScalar(deltaTime)
        camera.position.add(_movement)
        controls.target.add(_movement)
      }

      // Keyboard look rotation
      if (ms.rotateLeft || ms.rotateRight) {
        const rotateAmount = cfg.rotateSpeed * deltaTime * (Math.PI / 180)
        const direction = ms.rotateLeft ? 1 : -1
        _offset.subVectors(controls.target, camera.position)
        _offset.applyAxisAngle(_yAxis, rotateAmount * direction)
        controls.target.copy(camera.position).add(_offset)
      }

      controls.update()
      renderer.render(scene, camera)
    }

    renderer.setAnimationLoop(animate)

    // Keyboard handlers
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const key = e.key.toLowerCase()
      const ms = moveStateRef.current

      switch (key) {
        case 'w': ms.forward = true; break
        case 's': ms.backward = true; break
        case 'a': ms.left = true; break
        case 'd': ms.right = true; break
        case 'q': ms.down = true; break
        case 'e': ms.up = true; break
        case 'z': case 'arrowleft': ms.rotateLeft = true; break
        case 'x': case 'arrowright': ms.rotateRight = true; break
        case 'shift': ms.sprint = true; break
        case 'control': case 'meta': ms.precision = true; break
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const ms = moveStateRef.current

      switch (key) {
        case 'w': ms.forward = false; break
        case 's': ms.backward = false; break
        case 'a': ms.left = false; break
        case 'd': ms.right = false; break
        case 'q': ms.down = false; break
        case 'e': ms.up = false; break
        case 'z': case 'arrowleft': ms.rotateLeft = false; break
        case 'x': case 'arrowright': ms.rotateRight = false; break
        case 'shift': ms.sprint = false; break
        case 'control': case 'meta': ms.precision = false; break
      }
    }

    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    container.addEventListener('mousemove', handleMouseMove)

    // Cleanup
    return () => {
      renderer.setAnimationLoop(null)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      container.removeEventListener('mousemove', handleMouseMove)

      // Dispose grid
      if (gridRef.current) {
        disposeMeshMaterials(gridRef.current)
        gridRef.current.geometry.dispose()
      }

      controls.dispose()
      renderer.dispose()
      container.removeChild(renderer.domElement)
      setIsReady(false)
    }
  }, [config.backgroundColor, config.fogColor, config.fogNear, config.fogFar, 
      config.ambientLightIntensity, config.enableShadows, movementConfig, onMessage])

  // Re-read refs when isReady flips so consumers get non-null values
  return {
    containerRef,
    scene: isReady ? sceneRef.current : null,
    camera: isReady ? cameraRef.current : null,
    renderer: isReady ? rendererRef.current : null,
    controls: isReady ? controlsRef.current : null,
    glbLoader: isReady ? glbLoaderRef.current : null,
    raycaster: raycasterRef.current,
    mouse: mouseRef.current,
    gridVisible: gridVisibleRef.current,
    setGridVisible,
    resetCamera,
    focusOnContent,
    getWorldPosition,
  }
}

export default useCrebainScene
