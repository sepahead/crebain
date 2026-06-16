/**
 * @fileoverview Tactical grid overlay for 3D scene visualization.
 * Provides a shader-based infinite grid with distance fading, axis highlighting,
 * and compass/distance markers for spatial orientation.
 * @license MIT
 */

import * as THREE from 'three'

/**
 * Creates a tactical grid with infinite plane illusion, distance fading,
 * and high-contrast precision lines suitable for tactical visualization.
 *
 * Features:
 * - 1m minor grid lines with 10m major grid lines
 * - 50m radial distance rings
 * - Red X-axis and Blue Z-axis highlighting
 * - Distance-based fade to prevent horizon artifacts
 * - Anti-aliased lines using screen-space derivatives
 *
 * @param scene - THREE.Scene to add the grid to
 * @param size - Grid plane size in world units (default: 2000)
 * @returns THREE.Mesh with custom shader material
 */
export function createTacticalGrid(scene: THREE.Scene, size: number = 2000): THREE.Mesh {
  const vertexShader = `
    varying vec3 vWorldPos;
    varying vec2 vUv;
    
    void main() {
      vUv = uv;
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
    }
  `

  const fragmentShader = `
    varying vec3 vWorldPos;
    varying vec2 vUv;
    
    uniform vec3 uColor;
    uniform vec3 uColorThick;
    uniform float uDistance;
    uniform vec3 uCameraPos;

    // Grid parameters
    const float gridSpacing = 1.0; // 1 meter
    const float gridSpacingThick = 10.0; // 10 meters

    void main() {
      // Calculate derivatives for anti-aliasing (fwidth)
      // This ensures crisp lines at any distance/angle
      vec2 coord = vWorldPos.xz;
      
      // Basic 1m grid
      vec2 grid = abs(fract(coord / gridSpacing - 0.5) - 0.5) / fwidth(coord / gridSpacing);
      float line = min(grid.x, grid.y);
      float lineStrength = 1.0 - min(line, 1.0);
      
      // Major 10m grid
      vec2 gridThick = abs(fract(coord / gridSpacingThick - 0.5) - 0.5) / fwidth(coord / gridSpacingThick);
      float lineThick = min(gridThick.x, gridThick.y);
      float lineThickStrength = 1.0 - min(lineThick, 1.0);
      
      // Radial markers (every 50m)
      float distFromOrigin = length(coord);
      float ring = abs(fract(distFromOrigin / 50.0 - 0.5) - 0.5) / fwidth(distFromOrigin / 50.0);
      float ringStrength = (1.0 - min(ring, 1.0));
      
      // Combine patterns
      vec3 color = mix(vec3(0.0), uColor, lineStrength);
      color = mix(color, uColorThick, lineThickStrength);
      color = mix(color, uColorThick * 1.5, ringStrength * 0.5); // Rings are subtle
      
      // Alpha composition
      float alpha = max(lineStrength * 0.3, lineThickStrength * 0.8);
      alpha = max(alpha, ringStrength * 0.4);
      
      // Axis lines (X and Z) - Brighter
      float axisX = 1.0 - min(abs(coord.x) / fwidth(coord.x), 1.0);
      float axisZ = 1.0 - min(abs(coord.y) / fwidth(coord.y), 1.0); // coord.y is world Z
      float axisStrength = max(axisX, axisZ);
      
      color = mix(color, vec3(1.0, 0.2, 0.2), axisX); // Red X
      color = mix(color, vec3(0.2, 0.2, 1.0), axisZ); // Blue Z
      alpha = max(alpha, axisStrength);

      // Distance fog/fade
      float dist = length(uCameraPos.xz - vWorldPos.xz);
      float fade = 1.0 - smoothstep(uDistance * 0.2, uDistance, dist);
      
      // Hard cut for fade to avoid artifacts at edge of plane
      alpha *= fade;
      
      if (alpha < 0.01) discard;

      gl_FragColor = vec4(color, alpha);
    }
  `

  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false, // Important for overlay
    uniforms: {
      uColor: { value: new THREE.Color(0x404040) }, // Dark Grey
      uColorThick: { value: new THREE.Color(0x606060) }, // Lighter Grey
      uDistance: { value: 500.0 },
      uCameraPos: { value: new THREE.Vector3() },
    },
    vertexShader,
    fragmentShader,
    // derivatives: true is default in WebGL2, which Three.js uses
  })

  const geometry = new THREE.PlaneGeometry(size, size)
  geometry.rotateX(-Math.PI / 2) // Lay flat on XZ plane

  const mesh = new THREE.Mesh(geometry, material)

  // Custom update method to keep uniforms in sync
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    ;(material.uniforms.uCameraPos.value as THREE.Vector3).copy(camera.position)
  }

  mesh.renderOrder = -1 // Render first (behind transparent objects if depthWrite were true, but with depthWrite false it sits "on top" of background)

  scene.add(mesh)
  return mesh
}

/**
 * Creates text sprites for compass directions and distance markers.
 * Adds N/S/E/W compass labels at the specified radius and distance markers
 * every 50m along the cardinal axes up to 200m.
 *
 * @param scene - THREE.Scene to add the label group to
 * @param radius - Distance from origin for compass direction labels (default: 50)
 * @returns THREE.Group containing all label sprites
 *
 * @example
 * ```ts
 * const labels = createGridLabels(scene, 100)
 * // Later, to remove:
 * scene.remove(labels)
 * ```
 */
export function createGridLabels(scene: THREE.Scene, radius: number = 50): THREE.Group {
  const group = new THREE.Group()

  const createLabel = (text: string, color: string = '#888888', size: number = 24) => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const fontScale = 4 // High res for sharp text
    canvas.width = size * fontScale * 3
    canvas.height = size * fontScale

    ctx.font = `bold ${size * fontScale}px monospace`
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.scale.set((size / 10) * 3, size / 10, 1)

    return sprite
  }

  // Compass directions. pos is [x, z]; the HUD bearing uses atan2(camDir.x,
  // camDir.z), so +Z is North (0°), +X East (90°), -Z South, -X West. N/S must
  // sit on +Z/-Z to agree with that readout.
  const directions = [
    { text: 'N', pos: [0, radius] },
    { text: 'S', pos: [0, -radius] },
    { text: 'E', pos: [radius, 0] },
    { text: 'W', pos: [-radius, 0] },
  ]

  directions.forEach(({ text, pos }) => {
    const sprite = createLabel(text, '#a0a0a0', 32)
    if (sprite) {
      sprite.position.set(pos[0], 0.5, pos[1]) // Slightly above grid
      group.add(sprite)
    }
  })

  // Distance markers (every 50m up to 200m)
  for (let r = 50; r <= 200; r += 50) {
    if (r === radius) continue // Skip if overlaps with compass

    // Add markers along axes
    const markers = [
      { text: `${r}m`, pos: [r, 0] },
      { text: `${r}m`, pos: [-r, 0] },
      { text: `${r}m`, pos: [0, r] },
      { text: `${r}m`, pos: [0, -r] },
    ]

    markers.forEach(({ text, pos }) => {
      const sprite = createLabel(text, '#606060', 16)
      if (sprite) {
        sprite.position.set(pos[0], 0.2, pos[1])
        group.add(sprite)
      }
    })
  }

  scene.add(group)
  return group
}
