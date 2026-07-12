import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfigFromFile } from 'vite'

const root = process.cwd()
const tauriConfig = JSON.parse(readFileSync(`${root}/src-tauri/tauri.conf.json`, 'utf8')) as {
  app: { security: { csp: string; devCsp: string } }
}
const viteConfig = readFileSync(`${root}/vite.config.ts`, 'utf8')
const disabledRendererBridge = readFileSync(`${root}/src/ros/ROSBridgeDisabled.ts`, 'utf8')
const rosPublicIndex = readFileSync(`${root}/src/ros/index.ts`, 'utf8')
const rosHook = readFileSync(`${root}/src/hooks/useRosBridge.ts`, 'utf8')
const sensorHook = readFileSync(`${root}/src/ros/useROSSensors.ts`, 'utf8')
const transportTrait = readFileSync(`${root}/src-tauri/src/transport/mod.rs`, 'utf8')
const nativeRosbridge = readFileSync(`${root}/src-tauri/src/transport/rosbridge.rs`, 'utf8')
const nativeZenoh = readFileSync(`${root}/src-tauri/src/transport/zenoh.rs`, 'utf8')
const packageScripts = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
  scripts: Record<string, string>
}
const nativeRosbridgeImplementation = nativeRosbridge.slice(
  nativeRosbridge.indexOf('impl Transport for RosbridgeTransport'),
  nativeRosbridge.lastIndexOf('#[cfg(test)]\nmod tests')
)

function cspDirective(policy: string, directive: string): string[] {
  const entry = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `))
  return entry?.split(/\s+/).slice(1) ?? []
}

describe('authority and renderer network boundary', () => {
  it('denies every raw WebSocket destination in the production Tauri CSP', () => {
    const sources = cspDirective(tauriConfig.app.security.csp, 'connect-src')

    expect(sources).toEqual([
      "'self'",
      'https:',
      'http://localhost:*',
      'http://127.0.0.1:*',
      'http://[::1]:*',
      'ipc:',
      'http://ipc.localhost',
    ])
    expect(sources.join(' ')).not.toMatch(/\bws(?:s)?:/)
  })

  it('limits passive content and pins navigation-related CSP directives', () => {
    expect(cspDirective(tauriConfig.app.security.csp, 'img-src')).toEqual([
      "'self'",
      'blob:',
      'data:',
    ])
    for (const directive of ['base-uri', 'form-action', 'object-src', 'frame-ancestors']) {
      expect(cspDirective(tauriConfig.app.security.csp, directive)).toEqual(["'none'"])
    }
  })

  it('keeps development WebSockets explicit and free of wildcard hosts or ports', () => {
    const sources = cspDirective(tauriConfig.app.security.devCsp, 'connect-src')
    const websocketSources = sources.filter((source) => /^wss?:/.test(source))

    expect(websocketSources).toEqual([
      'ws://localhost:5173',
      'ws://127.0.0.1:5173',
      'ws://localhost:9090',
      'ws://127.0.0.1:9090',
    ])
    expect(websocketSources.join(' ')).not.toContain('*')
  })

  it('resolves production builds to the network-free renderer bridge', () => {
    expect(viteConfig).toContain("command === 'serve'")
    expect(viteConfig).not.toMatch(/command === 'serve'\s*\|\|/)
    expect(viteConfig).toContain("'./src/ros/ROSBridgeDisabled.ts'")
    expect(disabledRendererBridge).not.toMatch(/new\s+WebSocket\b/)
    expect(disabledRendererBridge).not.toMatch(/\b(?:publish|callService|advertise)\s*\(/)
    expect(rosPublicIndex).not.toMatch(/export\s+\*\s+from\s+['"]\.\/ROSBridge['"]/)
    expect(rosHook).toContain("from '#renderer-rosbridge'")
    expect(rosHook).toContain("transport: import.meta.env.DEV ? 'websocket' : 'zenoh'")
    expect(sensorHook).toContain("from '#renderer-rosbridge'")
  })

  it('keeps build --mode test on the disabled production adapter', async () => {
    const buildResult = await loadConfigFromFile(
      { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false },
      `${root}/vite.config.ts`
    )
    const serveResult = await loadConfigFromFile(
      { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false },
      `${root}/vite.config.ts`
    )
    const buildConfig = buildResult?.config as { resolve?: { alias?: Record<string, string> } }
    const serveConfig = serveResult?.config as { resolve?: { alias?: Record<string, string> } }

    expect(buildConfig.resolve?.alias?.['#renderer-rosbridge']).toMatch(
      /src\/ros\/ROSBridgeDisabled\.ts$/
    )
    expect(serveConfig.resolve?.alias?.['#renderer-rosbridge']).toMatch(/src\/ros\/ROSBridge\.ts$/)
  })

  it('runs the module-graph boundary proof in every packaged frontend build', () => {
    expect(packageScripts.scripts.build).toContain('bun run check:production-boundary')
    expect(packageScripts.scripts['check:bundle']).toContain('bun run build')
  })

  it('keeps native product transports subscription-only', () => {
    expect(transportTrait).not.toMatch(
      /fn\s+(?:publish_velocity|publish_twist_stamped|publish_pose|call_service)\b/
    )
    expect(nativeRosbridgeImplementation).not.toMatch(/"op"\s*:\s*"(?:publish|call_service)"/)
    expect(nativeZenoh).not.toMatch(/\.put\s*\(/)
  })
})
