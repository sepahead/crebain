import { readFileSync } from 'node:fs'
import { SourceTextModule, SyntheticModule } from 'node:vm'

/** Run exact maintained module text with declared synthetic ports; this is not process isolation. */
export async function controlledModule(url, ports) {
  const dependencies = new Map()
  async function dependency(specifier) {
    if (!dependencies.has(specifier)) {
      const values = Object.hasOwn(ports, specifier)
        ? ports[specifier]
        : await import(specifier.startsWith('.') ? new URL(specifier, url).href : specifier)
      const names = Object.keys(values)
      const module = new SyntheticModule(names, function () {
        for (const name of names) this.setExport(name, values[name])
      })
      await module.link(() => {
        throw new Error('Synthetic ports cannot import dependencies')
      })
      await module.evaluate()
      dependencies.set(specifier, module)
    }
    return dependencies.get(specifier)
  }
  const module = new SourceTextModule(readFileSync(url, 'utf8'), {
    identifier: url.href,
    initializeImportMeta(meta) {
      meta.url = url.href
    },
    importModuleDynamically: dependency,
  })
  await module.link(dependency)
  await module.evaluate()
  return module.namespace
}
