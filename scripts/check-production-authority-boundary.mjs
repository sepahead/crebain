#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const DIST = resolve(process.cwd(), 'dist')
const REPORT_PATH = resolve(DIST, 'authority-boundary.json')
const DEVELOPMENT_MODULE = 'src/ros/ROSBridge.ts'
const PRODUCTION_REPLACEMENT = 'src/ros/ROSBridgeDisabled.ts'
const COMPUTED_RUNTIME_CAPABILITIES = new Set([
  'WebSocket',
  'fetch',
  'publish',
  'callService',
  'sendCommand',
  'Function',
  'eval',
])
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'window', 'self', 'top', 'parent'])
const DESCRIPTOR_METHODS = new Map([
  ['Object', new Set(['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors'])],
  ['Reflect', new Set(['getOwnPropertyDescriptor'])],
])
const DYNAMIC_CAPABILITY_SOURCE =
  /\b(?:WebSocket|fetch|publish|callService|sendCommand|Reflect|globalThis|window|self)\b/

function fail(message) {
  throw new Error(`Production authority boundary failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function filesWithExtension(directory, pattern) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return filesWithExtension(path, pattern)
    return entry.isFile() && pattern.test(entry.name) ? [path] : []
  })
}

function staticArray(expression, bindings, seen = new Set()) {
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return null
    const initializer = bindings.get(expression.text)
    if (!initializer) return null
    const nextSeen = new Set(seen)
    nextSeen.add(expression.text)
    return staticArray(initializer, bindings, nextSeen)
  }
  if (!ts.isArrayLiteralExpression(expression)) return null
  const values = expression.elements.map((element) => staticString(element, bindings, seen))
  return values.some((value) => value === null) ? null : values
}

function staticString(expression, bindings, seen = new Set()) {
  if (!expression) return null
  if (ts.isParenthesizedExpression(expression)) {
    return staticString(expression.expression, bindings, seen)
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text
  }
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return null
    const initializer = bindings.get(expression.text)
    if (!initializer) return null
    const nextSeen = new Set(seen)
    nextSeen.add(expression.text)
    return staticString(initializer, bindings, nextSeen)
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(expression.left, bindings, seen)
    const right = staticString(expression.right, bindings, seen)
    return left === null || right === null ? null : left + right
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text
    for (const span of expression.templateSpans) {
      const substitution = staticString(span.expression, bindings, seen)
      if (substitution === null) return null
      value += substitution + span.literal.text
    }
    return value
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'join'
  ) {
    const values = staticArray(expression.expression.expression, bindings, seen)
    const separator =
      expression.arguments.length === 0
        ? ','
        : staticString(expression.arguments[0], bindings, seen)
    if (!values || separator === null) return null
    return values.join(separator)
  }
  return null
}

function propertyName(expression, bindings) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression)) {
    return staticString(expression.argumentExpression, bindings)
  }
  return null
}

function resolvedObjectName(expression, bindings, seen = new Set()) {
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return null
    const initializer = bindings.get(expression.text)
    if (!initializer) return expression.text
    const nextSeen = new Set(seen)
    nextSeen.add(expression.text)
    return resolvedObjectName(initializer, bindings, nextSeen)
  }
  return propertyName(expression, bindings)
}

function resolvedExpression(expression, bindings, seen = new Set()) {
  if (ts.isParenthesizedExpression(expression)) {
    return resolvedExpression(expression.expression, bindings, seen)
  }
  if (!ts.isIdentifier(expression)) return expression
  if (seen.has(expression.text)) return expression
  const initializer = bindings.get(expression.text)
  if (!initializer) return expression
  const nextSeen = new Set(seen)
  nextSeen.add(expression.text)
  return resolvedExpression(initializer, bindings, nextSeen)
}

function isGlobalObject(expression, bindings) {
  const current = resolvedExpression(expression, bindings)
  if (GLOBAL_OBJECT_NAMES.has(resolvedObjectName(current, bindings))) return true
  return (
    (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
    propertyName(current, bindings) === 'defaultView' &&
    resolvedObjectName(current.expression, bindings) === 'document'
  )
}

function resolvedMethod(expression, bindings) {
  const current = resolvedExpression(expression, bindings)
  if (
    ts.isCallExpression(current) &&
    (ts.isPropertyAccessExpression(current.expression) ||
      ts.isElementAccessExpression(current.expression)) &&
    propertyName(current.expression, bindings) === 'bind'
  ) {
    return resolvedMethod(current.expression.expression, bindings)
  }
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
    return null
  }
  return {
    owner: resolvedObjectName(current.expression, bindings),
    name: propertyName(current, bindings),
  }
}

function descriptorMethod(expression, bindings) {
  const method = resolvedMethod(expression, bindings)
  return method && DESCRIPTOR_METHODS.get(method.owner)?.has(method.name) ? method : null
}

function descriptorInvocationTarget(node, bindings) {
  let method = descriptorMethod(node.expression, bindings)
  let args = [...node.arguments]
  const callee = resolvedExpression(node.expression, bindings)
  if (!method && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
    const wrapper = propertyName(callee, bindings)
    if (wrapper === 'call' || wrapper === 'apply') {
      method = descriptorMethod(callee.expression, bindings)
      if (wrapper === 'call') args = args.slice(1)
      else {
        const applied = args[1] ? resolvedExpression(args[1], bindings) : null
        args = applied && ts.isArrayLiteralExpression(applied) ? [...applied.elements] : []
      }
    }
  }
  if (!method) return undefined
  return args[0] ?? null
}

function bindingElementName(element, bindings) {
  if (!element.propertyName) return ts.isIdentifier(element.name) ? element.name.text : null
  if (ts.isComputedPropertyName(element.propertyName)) {
    return staticString(element.propertyName.expression, bindings)
  }
  return ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
    ? element.propertyName.text
    : null
}

function objectLiteralPropertyName(property, bindings) {
  if (!property.name) return null
  if (ts.isComputedPropertyName(property.name)) {
    return staticString(property.name.expression, bindings)
  }
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : null
}

function dynamicConstructorKind(expression, bindings) {
  const current = resolvedExpression(expression, bindings)
  if (ts.isIdentifier(current) && current.text === 'Function') return 'Function'
  if (ts.isIdentifier(current) && current.text === 'eval') return 'eval'
  if (
    ts.isCallExpression(current) &&
    (ts.isPropertyAccessExpression(current.expression) ||
      ts.isElementAccessExpression(current.expression)) &&
    propertyName(current.expression, bindings) === 'bind'
  ) {
    return dynamicConstructorKind(current.expression.expression, bindings)
  }
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
    return null
  }
  const name = propertyName(current, bindings)
  if (name === 'call' || name === 'apply' || name === 'bind') {
    return dynamicConstructorKind(current.expression, bindings)
  }
  if (name === 'Function' && isGlobalObject(current.expression, bindings)) return 'Function'
  if (name === 'eval' && isGlobalObject(current.expression, bindings)) return 'eval'
  return name === 'constructor' ? 'callable.constructor' : null
}

function reflectMethod(expression, bindings) {
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return null
  }
  const owner = resolvedObjectName(expression.expression, bindings)
  return owner === 'Reflect' ? propertyName(expression, bindings) : null
}

function runtimeBoundaryReferences(file, source, { allowVendorFunctionConstructors = false } = {}) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const bindings = new Map()
  const ambiguousBindings = new Set()
  const references = []
  const collectBindings = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (bindings.has(node.name.text) || ambiguousBindings.has(node.name.text)) {
        bindings.delete(node.name.text)
        ambiguousBindings.add(node.name.text)
      } else {
        bindings.set(node.name.text, node.initializer)
      }
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(sourceFile)

  const record = (node, label) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    references.push(`${label}@${line + 1}:${character + 1}`)
  }
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'WebSocket') record(node, 'WebSocket')
    if (ts.isElementAccessExpression(node)) {
      const name = staticString(node.argumentExpression, bindings)
      if (name && COMPUTED_RUNTIME_CAPABILITIES.has(name)) {
        record(node, `computed ${name}`)
      }
      if (isGlobalObject(node.expression, bindings) && name === null) {
        record(node, 'unresolved computed global capability')
      }
    }
    if (ts.isCallExpression(node)) {
      const descriptorTarget = descriptorInvocationTarget(node, bindings)
      if (
        descriptorTarget !== undefined &&
        (descriptorTarget === null || isGlobalObject(descriptorTarget, bindings))
      ) {
        record(node, 'global property descriptor capability recovery')
      }
      const dynamicKind = dynamicConstructorKind(node.expression, bindings)
      if (dynamicKind) record(node, `dynamic ${dynamicKind}`)
    }
    if (ts.isNewExpression(node)) {
      const dynamicKind = dynamicConstructorKind(node.expression, bindings)
      const staticPayloads = (node.arguments ?? [])
        .map((argument) => staticString(argument, bindings))
        .filter((value) => value !== null)
      const capabilityPayload = staticPayloads.some((value) =>
        DYNAMIC_CAPABILITY_SOURCE.test(value)
      )
      if (
        (dynamicKind !== null && capabilityPayload) ||
        (dynamicKind === 'Function' && !allowVendorFunctionConstructors) ||
        (dynamicKind === 'callable.constructor' && staticPayloads.length > 0)
      ) {
        record(node, `dynamic ${dynamicKind ?? 'constructor'} code`)
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      reflectMethod(node, bindings) === 'get'
    ) {
      // Reflect.get can recover globals/capabilities without leaving their name
      // as an Identifier in the finalized chunk. It is unnecessary in the
      // current product graph, so the artifact proof rejects it fail-closed.
      record(node, 'Reflect.get')
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      resolvedObjectName(node.initializer, bindings) === 'Reflect'
    ) {
      for (const element of node.name.elements) {
        const name = element.propertyName
          ? ts.isComputedPropertyName(element.propertyName)
            ? staticString(element.propertyName.expression, bindings)
            : ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
              ? element.propertyName.text
              : null
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null
        if (name === 'get') record(element, 'Reflect.get destructuring')
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const owner = resolvedObjectName(node.initializer, bindings)
      const descriptorNames = DESCRIPTOR_METHODS.get(owner)
      if (descriptorNames) {
        for (const element of node.name.elements) {
          if (descriptorNames.has(bindingElementName(element, bindings))) {
            record(element, 'property descriptor method destructuring')
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isGlobalObject(node.initializer, bindings)
    ) {
      for (const element of node.name.elements) {
        const name = bindingElementName(element, bindings)
        if (
          element.dotDotDotToken ||
          !ts.isIdentifier(element.name) ||
          (element.propertyName &&
            ts.isComputedPropertyName(element.propertyName) &&
            name === null) ||
          (name !== null && COMPUTED_RUNTIME_CAPABILITIES.has(name)) ||
          name === 'Function' ||
          name === 'eval'
        ) {
          record(element, 'global capability destructuring')
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left) &&
      isGlobalObject(node.right, bindings)
    ) {
      for (const property of node.left.properties) {
        const name = objectLiteralPropertyName(property, bindings)
        if (
          ts.isSpreadAssignment(property) ||
          (ts.isPropertyAssignment(property) &&
            ts.isObjectLiteralExpression(property.initializer)) ||
          (property.name && ts.isComputedPropertyName(property.name) && name === null) ||
          (name !== null && COMPUTED_RUNTIME_CAPABILITIES.has(name)) ||
          name === 'Function' ||
          name === 'eval'
        ) {
          record(property, 'global capability destructuring assignment')
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

export function assertNoForbiddenRuntimeCapabilities(file, source, options) {
  const references = runtimeBoundaryReferences(file, source, options)
  assert(
    references.length === 0,
    `${file} contains forbidden renderer runtime capability references: ${references.join(',')}`
  )
}

export function verifyProductionAuthorityBoundary() {
  assert(existsSync(DIST), `production bundle is missing at ${DIST}; run \`bun run build\` first`)
  assert(existsSync(REPORT_PATH), 'Vite module-graph authority report is missing')

  let report
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'))
  } catch (error) {
    fail(
      `authority report is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  assert(report.schema_version === 1, 'authority report schema_version must be 1')
  assert(
    report.development_module === DEVELOPMENT_MODULE,
    'authority report development module drift'
  )
  assert(
    report.production_replacement === PRODUCTION_REPLACEMENT,
    'authority report production replacement drift'
  )
  assert(Array.isArray(report.chunks) && report.chunks.length > 0, 'authority report has no chunks')

  const reportedFiles = new Set()
  const reportedModules = new Set()
  for (const chunk of report.chunks) {
    assert(
      typeof chunk.file === 'string' && /^[A-Za-z0-9_./-]+\.js$/.test(chunk.file),
      'invalid chunk path'
    )
    assert(!chunk.file.split('/').includes('..'), `unsafe chunk path '${chunk.file}'`)
    assert(!reportedFiles.has(chunk.file), `duplicate reported chunk '${chunk.file}'`)
    reportedFiles.add(chunk.file)
    assert(/^[0-9a-f]{64}$/.test(chunk.sha256), `${chunk.file} has invalid SHA-256`)
    const path = resolve(DIST, chunk.file)
    assert(existsSync(path), `reported chunk is missing: ${chunk.file}`)
    const source = readFileSync(path, 'utf8')
    const hash = createHash('sha256').update(source).digest('hex')
    assert(hash === chunk.sha256, `${chunk.file} content hash does not match the Vite report`)
    assertNoForbiddenRuntimeCapabilities(chunk.file, source, {
      allowVendorFunctionConstructors: (chunk.project_modules ?? []).length === 0,
    })

    for (const moduleId of chunk.project_modules ?? []) {
      assert(
        typeof moduleId === 'string' &&
          !moduleId.startsWith('/') &&
          !moduleId.split('/').includes('..'),
        `${chunk.file} contains an unsafe project module ID`
      )
      reportedModules.add(moduleId)
    }
  }

  const actualFiles = new Set(
    filesWithExtension(DIST, /\.js$/).map((path) => relative(DIST, path).replaceAll('\\', '/'))
  )
  assert(
    actualFiles.size === reportedFiles.size &&
      [...actualFiles].every((file) => reportedFiles.has(file)),
    'Vite authority report does not cover every emitted JavaScript chunk'
  )
  for (const chunk of report.chunks) {
    for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamic_imports ?? [])]) {
      if (imported.endsWith('.js')) {
        assert(reportedFiles.has(imported), `${chunk.file} imports unreported chunk '${imported}'`)
      }
    }
  }

  assert(!reportedModules.has(DEVELOPMENT_MODULE), `module graph includes ${DEVELOPMENT_MODULE}`)
  assert(
    reportedModules.has(PRODUCTION_REPLACEMENT),
    `module graph omits ${PRODUCTION_REPLACEMENT}`
  )

  return { chunks: report.chunks.length }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    const result = verifyProductionAuthorityBoundary()
    console.log(
      `OK: production module graph and ${result.chunks} hashed chunks prove the renderer network boundary`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
