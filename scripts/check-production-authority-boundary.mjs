#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import {
  AUDITED_DATA_COPIER_PATH,
  auditedDataDescriptorReference,
} from './verify-phase0-baseline.mjs'

const DIST = resolve(process.cwd(), 'dist')
const REPORT_PATH = resolve(DIST, 'authority-boundary.json')
const DEVELOPMENT_MODULE = 'src/ros/ROSBridge.ts'
const PRODUCTION_REPLACEMENT = 'src/ros/ROSBridgeDisabled.ts'
const APPROVED_FETCH_MODULE = 'src/lib/boundedFetch.ts'
const APPROVED_DIRECT_FETCH_CALLS = 1
const APPROVED_VENDOR_FUNCTION_CHUNKS = new Map([
  [
    'node_modules/@sparkjsdev/spark/dist/spark.module.js',
    Object.freeze({ displayName: 'Spark', exactConstructors: 2 }),
  ],
  [
    'node_modules/@dimforge/rapier3d-compat/rapier.mjs',
    Object.freeze({ displayName: 'Rapier', exactConstructors: 1 }),
  ],
])
// Finalized bundles do not retain a trustworthy semantic type for arbitrary
// receivers. Reserve these exact capability names whenever their values are
// referenced, regardless of ownership. Plain protocol data keys, declaration
// names, and strings remain valid, but shorthand properties and member reads
// are value references. Only a bare `fetch(...)` callee can reach the separately
// counted and source-verified canonical-call exception below.
const RESERVED_CALL_CAPABILITIES = new Set([
  'fetch',
  'sendBeacon',
  'publish',
  'callService',
  'sendCommand',
])
const DYNAMIC_CODE_CAPABILITIES = new Set(['Function', 'eval'])
const COMPUTED_RUNTIME_CAPABILITIES = new Set([
  'WebSocket',
  'fetch',
  'XMLHttpRequest',
  'EventSource',
  'WebTransport',
  'sendBeacon',
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
const ARRAY_CALLBACK_METHODS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'sort',
  'toSorted',
])
const DIRECT_CALLBACK_SINKS = new Set([
  'queueMicrotask',
  'requestAnimationFrame',
  'requestIdleCallback',
  'setInterval',
  'setTimeout',
])
const MEMBER_CALLBACK_SINKS = new Map([
  ['addEventListener', [1]],
  ['catch', [0]],
  ['finally', [0]],
  ['replace', [1]],
  ['replaceAll', [1]],
  ['then', [0, 1]],
])
const CONSTRUCTOR_CALLBACK_SINKS = new Map([
  ['IntersectionObserver', [0]],
  ['MutationObserver', [0]],
  ['PerformanceObserver', [0]],
  ['Promise', [0]],
  ['ResizeObserver', [0]],
])
const EVENT_HANDLER_PROPERTIES = new Set([
  'onabort',
  'onbeforeunload',
  'onblur',
  'onchange',
  'onclick',
  'onclose',
  'onerror',
  'onfocus',
  'oninput',
  'onkeydown',
  'onkeyup',
  'onload',
  'onmessage',
  'onopen',
  'onprogress',
  'onreadystatechange',
  'onsubmit',
])
const DYNAMIC_CAPABILITY_SOURCE =
  /\b(?:WebSocket|fetch|XMLHttpRequest|EventSource|WebTransport|sendBeacon|publish|callService|sendCommand|Reflect|globalThis|window|self)\b/

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

function createBindingResolver(file, source) {
  const virtualFile = `/__crebain_production_boundary__/${file.replaceAll('\\', '/').replace(/^\/+/, '')}`
  const scriptKind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS
  const compilerOptions = {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  }
  let sourceFile
  const host = {
    directoryExists: () => true,
    fileExists: (candidate) => candidate === virtualFile,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => '/__crebain_production_boundary__',
    getDefaultLibFileName: () => '',
    getDirectories: () => [],
    getNewLine: () => '\n',
    getSourceFile: (candidate) => {
      if (candidate !== virtualFile) return undefined
      sourceFile ??= ts.createSourceFile(
        virtualFile,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
      )
      return sourceFile
    },
    readFile: (candidate) => (candidate === virtualFile ? source : undefined),
    realpath: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  }
  const program = ts.createProgram([virtualFile], compilerOptions, host)
  sourceFile = program.getSourceFile(virtualFile)
  assert(sourceFile, `could not bind finalized JavaScript for ${file}`)

  const checker = program.getTypeChecker()
  const assignmentExpressions = new Map()
  const parameterExpressions = new Map()
  const bindings = {
    assignmentExpressions,
    bindingCache: new Map(),
    checker,
    localFunctionForExpression: null,
    parameterExpressions,
    sourceFile,
  }
  const assignmentOperators = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ])
  const collectAssignments = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      assignmentOperators.has(node.operatorToken.kind)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left)
      if (symbol) {
        const expressions = assignmentExpressions.get(symbol) ?? []
        expressions.push(node.right)
        assignmentExpressions.set(symbol, expressions)
      }
    }
    ts.forEachChild(node, collectAssignments)
  }
  collectAssignments(sourceFile)

  const localFunctionForExpression = (expression, seen = new Set()) => {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      expression = expression.expression
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression
    if (!ts.isIdentifier(expression)) return null
    const symbol = checker.getSymbolAtLocation(expression)
    if (!symbol || seen.has(symbol)) return null
    const nextSeen = new Set(seen)
    nextSeen.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration)) return declaration
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const resolved = localFunctionForExpression(declaration.initializer, nextSeen)
        if (resolved) return resolved
      }
    }
    const assignments = assignmentExpressions.get(symbol) ?? []
    if (assignments.length === 1) {
      return localFunctionForExpression(assignments[0], nextSeen)
    }
    return null
  }
  bindings.localFunctionForExpression = localFunctionForExpression

  let parameterFlowChanged = false
  const recordLocalCallArguments = (callee, args) => {
    const localFunction = localFunctionForExpression(callee)
    if (!localFunction) return
    for (let index = 0; index < localFunction.parameters.length; index += 1) {
      const parameter = localFunction.parameters[index]
      if (!ts.isIdentifier(parameter.name)) continue
      const symbol = checker.getSymbolAtLocation(parameter.name)
      if (!symbol) continue
      const values = parameterExpressions.get(symbol) ?? []
      const incoming = parameter.dotDotDotToken
        ? args.slice(index)
        : args[index]
          ? [args[index]]
          : []
      for (const value of incoming) {
        if (!values.includes(value)) {
          values.push(value)
          parameterFlowChanged = true
        }
      }
      parameterExpressions.set(symbol, values)
    }
  }

  const collectLocalCallFlows = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let callee = node.expression
      let args = [...(node.arguments ?? [])]
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const wrapper = propertyName(callee, bindings)
        if (wrapper === 'call' || wrapper === 'bind') {
          callee = callee.expression
          args = args.slice(1)
        } else if (wrapper === 'apply') {
          callee = callee.expression
          const applied = args[1]
          args = applied && ts.isArrayLiteralExpression(applied) ? [...applied.elements] : []
        }
      }
      recordLocalCallArguments(callee, args)

      if (
        ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
        ARRAY_CALLBACK_METHODS.has(propertyName(node.expression, bindings)) &&
        node.arguments[0]
      ) {
        const collection = resolvedExpression(node.expression.expression, bindings)
        if (ts.isArrayLiteralExpression(collection)) {
          for (const element of collection.elements) {
            if (!ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) {
              const method = propertyName(node.expression, bindings)
              recordLocalCallArguments(
                node.arguments[0],
                method === 'reduce' || method === 'reduceRight' ? [element, element] : [element]
              )
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
        propertyName(node.expression, bindings) === 'then' &&
        node.arguments[0]
      ) {
        const promiseFactory = resolvedExpression(node.expression.expression, bindings)
        if (
          ts.isCallExpression(promiseFactory) &&
          resolvedMethod(promiseFactory.expression, bindings)?.owner === 'Promise' &&
          resolvedMethod(promiseFactory.expression, bindings)?.name === 'resolve' &&
          promiseFactory.arguments[0]
        ) {
          recordLocalCallArguments(node.arguments[0], [promiseFactory.arguments[0]])
        }
      }
    }
    ts.forEachChild(node, collectLocalCallFlows)
  }
  // A callback source can itself arrive through another local parameter. Run
  // the finite node-identity flow to a fixed point, and invalidate cached
  // bindings between passes. A single source-order pass can otherwise miss a
  // later call such as `invoke([bridge[key]])` for an earlier `values.map(...)`.
  do {
    parameterFlowChanged = false
    bindings.bindingCache.clear()
    collectLocalCallFlows(sourceFile)
  } while (parameterFlowChanged)
  bindings.bindingCache.clear()

  return bindings
}

function directReturnExpressions(fn) {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body]
  if (!fn.body || !ts.isBlock(fn.body)) return []
  const expressions = []
  const visit = (node) => {
    if (node !== fn && ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node)) {
      if (node.expression) expressions.push(node.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(fn.body)
  return expressions
}

function arrayBindingElementExpression(declaration, bindings) {
  if (!ts.isArrayBindingPattern(declaration.parent)) return null
  const pattern = declaration.parent
  const index = pattern.elements.indexOf(declaration)
  if (index < 0) return null

  const container = pattern.parent
  const initializer =
    ts.isVariableDeclaration(container) || ts.isParameter(container) ? container.initializer : null
  if (!initializer) return null

  const source = resolvedExpression(initializer, bindings)
  if (!ts.isArrayLiteralExpression(source)) return null
  const element = source.elements[index]
  return element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)
    ? element
    : null
}

function bindingInfo(identifier, bindings) {
  const symbol = bindings.checker.getSymbolAtLocation(identifier)
  if (!symbol) return null
  const cached = bindings.bindingCache.get(symbol)
  if (cached) return cached

  const info = { capabilities: [], expressions: [], symbol }
  bindings.bindingCache.set(symbol, info)
  for (const declaration of symbol.declarations ?? []) {
    if (
      (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      declaration.initializer
    ) {
      info.expressions.push(declaration.initializer)
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const name = bindingElementName(declaration, bindings)
      if (name && RESERVED_CALL_CAPABILITIES.has(name)) info.capabilities.push(name)
      if (declaration.initializer) info.expressions.push(declaration.initializer)
    }
    if (ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent)) {
      const element = arrayBindingElementExpression(declaration, bindings)
      if (element) info.expressions.push(element)
      if (declaration.initializer) info.expressions.push(declaration.initializer)
    }
  }
  info.expressions.push(...(bindings.assignmentExpressions.get(symbol) ?? []))
  info.expressions.push(...(bindings.parameterExpressions.get(symbol) ?? []))
  return info
}

function staticArray(expression, bindings, seen = new Set()) {
  if (ts.isIdentifier(expression)) {
    const info = bindingInfo(expression, bindings)
    if (!info || seen.has(info.symbol) || info.expressions.length !== 1) return null
    const nextSeen = new Set(seen)
    nextSeen.add(info.symbol)
    return staticArray(info.expressions[0], bindings, nextSeen)
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
    const info = bindingInfo(expression, bindings)
    if (!info || seen.has(info.symbol) || info.expressions.length !== 1) return null
    const nextSeen = new Set(seen)
    nextSeen.add(info.symbol)
    return staticString(info.expressions[0], bindings, nextSeen)
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
    const info = bindingInfo(expression, bindings)
    if (!info || seen.has(info.symbol) || info.expressions.length !== 1) {
      return expression.text
    }
    const nextSeen = new Set(seen)
    nextSeen.add(info.symbol)
    return resolvedObjectName(info.expressions[0], bindings, nextSeen)
  }
  return propertyName(expression, bindings)
}

function resolvedExpressionState(expression, bindings, seen = new Set()) {
  if (ts.isParenthesizedExpression(expression)) {
    return resolvedExpressionState(expression.expression, bindings, seen)
  }
  if (ts.isIdentifier(expression)) {
    const info = bindingInfo(expression, bindings)
    if (!info || seen.has(info.symbol) || info.expressions.length !== 1) {
      return { expression, seen }
    }
    const nextSeen = new Set(seen)
    nextSeen.add(info.symbol)
    return resolvedExpressionState(info.expressions[0], bindings, nextSeen)
  }
  if (ts.isCallExpression(expression)) {
    let callee = expression.expression
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const wrapper = propertyName(callee, bindings)
      if (wrapper === 'call' || wrapper === 'apply') callee = callee.expression
    }
    const localFunction = bindings.localFunctionForExpression?.(callee)
    if (localFunction && !seen.has(localFunction)) {
      const returned = directReturnExpressions(localFunction)
      if (returned.length === 1) {
        const nextSeen = new Set(seen)
        nextSeen.add(localFunction)
        return resolvedExpressionState(returned[0], bindings, nextSeen)
      }
    }
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const owner = resolvedExpressionState(expression.expression, bindings, seen)
    if (ts.isObjectLiteralExpression(owner.expression)) {
      const name = propertyName(expression, bindings)
      if (name !== null) {
        const properties = owner.expression.properties.filter(
          (property) => objectLiteralPropertyName(property, bindings) === name
        )
        if (properties.length === 1) {
          const property = properties[0]
          if (ts.isPropertyAssignment(property)) {
            return resolvedExpressionState(property.initializer, bindings, owner.seen)
          }
          if (ts.isGetAccessorDeclaration(property)) {
            const returned = directReturnExpressions(property)
            if (returned.length === 1) {
              return resolvedExpressionState(returned[0], bindings, owner.seen)
            }
          }
        }
      }
    }
    if (
      ts.isArrayLiteralExpression(owner.expression) &&
      ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      ts.isNumericLiteral(expression.argumentExpression)
    ) {
      const index = Number(expression.argumentExpression.text)
      const element = Number.isSafeInteger(index) ? owner.expression.elements[index] : undefined
      if (element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) {
        return resolvedExpressionState(element, bindings, owner.seen)
      }
    }
  }
  return { expression, seen }
}

function resolvedExpression(expression, bindings, seen = new Set()) {
  return resolvedExpressionState(expression, bindings, seen).expression
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

function callableCapability(expression, bindings, seen = new Set()) {
  if (ts.isParenthesizedExpression(expression)) {
    return callableCapability(expression.expression, bindings, seen)
  }
  if (ts.isIdentifier(expression)) {
    if (RESERVED_CALL_CAPABILITIES.has(expression.text)) {
      return { name: expression.text, form: 'direct' }
    }
    const info = bindingInfo(expression, bindings)
    if (!info || seen.has(info.symbol)) return null
    if (info.capabilities.length > 0) {
      return { name: info.capabilities[0], form: 'aliased' }
    }
    const nextSeen = new Set(seen)
    nextSeen.add(info.symbol)
    for (const initializer of info.expressions) {
      const capability = callableCapability(initializer, bindings, nextSeen)
      if (capability) return { ...capability, form: 'aliased' }
    }
    return null
  }

  if (
    ts.isCallExpression(expression) &&
    (ts.isPropertyAccessExpression(expression.expression) ||
      ts.isElementAccessExpression(expression.expression)) &&
    propertyName(expression.expression, bindings) === 'bind'
  ) {
    const capability = callableCapability(expression.expression.expression, bindings, seen)
    return capability ? { ...capability, form: 'aliased' } : null
  }

  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return null
  }

  const name = propertyName(expression, bindings)
  if (name === 'call' || name === 'apply' || name === 'bind') {
    const capability = callableCapability(expression.expression, bindings, seen)
    return capability ? { ...capability, form: 'wrapped' } : null
  }
  if (!name || !RESERVED_CALL_CAPABILITIES.has(name)) return null

  return {
    name,
    form: 'member',
  }
}

function isUnknownComputedCallable(expression, bindings, seen = new Set()) {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return isUnknownComputedCallable(expression.expression, bindings, seen)
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isUnknownComputedCallable(expression.whenTrue, bindings, seen) ||
      isUnknownComputedCallable(expression.whenFalse, bindings, seen)
    )
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.CommaToken ||
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      isUnknownComputedCallable(expression.left, bindings, seen) ||
      isUnknownComputedCallable(expression.right, bindings, seen)
    )
  }
  if (ts.isIdentifier(expression)) {
    const info = bindingInfo(expression, bindings)
    if (!info || seen.has(info.symbol)) return false
    if (
      (info.symbol.declarations ?? []).some(
        (declaration) =>
          ts.isBindingElement(declaration) &&
          declaration.propertyName &&
          ts.isComputedPropertyName(declaration.propertyName) &&
          staticString(declaration.propertyName.expression, bindings) === null
      )
    ) {
      return true
    }
    const nextSeen = new Set(seen)
    nextSeen.add(info.symbol)
    return info.expressions.some((initializer) =>
      isUnknownComputedCallable(initializer, bindings, nextSeen)
    )
  }

  // Resolve statically indexed array/object wrappers before examining the
  // member itself. This closes value-boxing forms such as
  // `[bridge[key]][0]()` and `{ invoke: bridge[key] }.invoke()` while retaining
  // ordinary computed data reads that are never invoked.
  const resolved = resolvedExpressionState(expression, bindings, seen)
  if (resolved.expression !== expression) {
    return isUnknownComputedCallable(resolved.expression, bindings, resolved.seen)
  }

  if (
    ts.isCallExpression(expression) &&
    (ts.isPropertyAccessExpression(expression.expression) ||
      ts.isElementAccessExpression(expression.expression)) &&
    propertyName(expression.expression, bindings) === 'bind'
  ) {
    return isUnknownComputedCallable(expression.expression.expression, bindings, seen)
  }
  if (ts.isCallExpression(expression)) {
    const method = resolvedMethod(expression.expression, bindings)
    if (
      method?.owner === 'Promise' &&
      method.name === 'resolve' &&
      expression.arguments[0] &&
      isUnknownComputedCallable(expression.arguments[0], bindings, seen)
    ) {
      return true
    }
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return false
  }

  const name = propertyName(expression, bindings)
  if (name === 'call' || name === 'apply' || name === 'bind') {
    return isUnknownComputedCallable(expression.expression, bindings, seen)
  }
  if (ts.isElementAccessExpression(expression) && name === null) return true
  if (isUnknownDescriptorLookup(expression.expression, bindings)) return true

  const owner = resolvedExpression(expression.expression, bindings)
  if (ts.isCallExpression(owner)) {
    const descriptor = descriptorInvocation(owner, bindings)
    if (descriptor && descriptor.key !== null && staticString(descriptor.key, bindings) === null) {
      return true
    }
  }
  return false
}

function callbackSinkArguments(node, bindings) {
  const directName = resolvedObjectName(node.expression, bindings)
  if (DIRECT_CALLBACK_SINKS.has(directName)) return node.arguments[0] ? [node.arguments[0]] : []
  if (
    !ts.isPropertyAccessExpression(node.expression) &&
    !ts.isElementAccessExpression(node.expression)
  ) {
    return []
  }
  const memberName = propertyName(node.expression, bindings)
  if (ARRAY_CALLBACK_METHODS.has(memberName)) {
    return node.arguments[0] ? [node.arguments[0]] : []
  }
  const argumentIndexes = MEMBER_CALLBACK_SINKS.get(memberName) ?? []
  return argumentIndexes.flatMap((argumentIndex) =>
    node.arguments[argumentIndex] ? [node.arguments[argumentIndex]] : []
  )
}

function constructorCallbackArguments(node, bindings) {
  const constructorName = resolvedObjectName(node.expression, bindings)
  const argumentIndexes = CONSTRUCTOR_CALLBACK_SINKS.get(constructorName) ?? []
  return argumentIndexes.flatMap((argumentIndex) =>
    node.arguments?.[argumentIndex] ? [node.arguments[argumentIndex]] : []
  )
}

function isUnknownCallbackValue(expression, bindings, seen = new Set()) {
  if (isUnknownComputedCallable(expression, bindings, seen)) return true
  const resolved = resolvedExpressionState(expression, bindings, seen)
  if (resolved.expression !== expression) {
    return isUnknownCallbackValue(resolved.expression, bindings, resolved.seen)
  }
  if (!ts.isObjectLiteralExpression(expression)) return false
  return expression.properties.some((property) => {
    if (objectLiteralPropertyName(property, bindings) !== 'handleEvent') return false
    if (ts.isPropertyAssignment(property)) {
      return isUnknownComputedCallable(property.initializer, bindings, seen)
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return isUnknownComputedCallable(property.name, bindings, seen)
    }
    return false
  })
}

function isExactCallCallee(node) {
  return ts.isCallExpression(node.parent) && node.parent.expression === node
}

function isExactDynamicInvocationCallee(node) {
  return (
    (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) &&
    node.parent.expression === node
  )
}

function isPropertyAccessName(node) {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
}

function isReservedBareValueReference(node) {
  return (
    RESERVED_CALL_CAPABILITIES.has(node.text) &&
    ts.isExpressionNode(node) &&
    !isPropertyAccessName(node) &&
    !isExactCallCallee(node)
  )
}

function isDynamicCodeBareValueReference(node) {
  return (
    DYNAMIC_CODE_CAPABILITIES.has(node.text) &&
    ts.isExpressionNode(node) &&
    !isPropertyAccessName(node) &&
    !isExactDynamicInvocationCallee(node)
  )
}

function descriptorMethod(expression, bindings) {
  const method = resolvedMethod(expression, bindings)
  return method && DESCRIPTOR_METHODS.get(method.owner)?.has(method.name) ? method : null
}

function descriptorInvocation(node, bindings) {
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
  return {
    key: args[1] ?? null,
    target: args[0] ?? null,
  }
}

function isUnknownDescriptorLookup(expression, bindings) {
  const current = resolvedExpression(expression, bindings)
  if (
    !ts.isElementAccessExpression(current) ||
    staticString(current.argumentExpression, bindings) !== null
  ) {
    return false
  }
  const owner = resolvedExpression(current.expression, bindings)
  if (!ts.isCallExpression(owner)) return false
  const method = descriptorMethod(owner.expression, bindings)
  return method?.owner === 'Object' && method.name === 'getOwnPropertyDescriptors'
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

function runtimeBoundaryReferences(
  file,
  source,
  {
    allowVendorFunctionConstructors = false,
    rejectPropertyDescriptors = false,
    rejectUnknownCallableMembers = false,
  } = {}
) {
  const bindings = createBindingResolver(file, source)
  const { sourceFile } = bindings
  const permittedDataDescriptor = auditedDataDescriptorReference(file, source, sourceFile)
  const references = []

  const record = (node, label) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    references.push(`${label}@${line + 1}:${character + 1}`)
  }
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      ['WebSocket', 'XMLHttpRequest', 'EventSource', 'WebTransport'].includes(node.text)
    ) {
      record(node, node.text)
    }
    if (ts.isIdentifier(node) && isReservedBareValueReference(node)) {
      record(node, `capability reference ${node.text}`)
    }
    if (ts.isIdentifier(node) && isDynamicCodeBareValueReference(node)) {
      record(node, `dynamic ${node.text} value`)
    }
    if (ts.isShorthandPropertyAssignment(node) && RESERVED_CALL_CAPABILITIES.has(node.name.text)) {
      record(node.name, `capability reference ${node.name.text}`)
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      propertyName(node, bindings) === 'sendBeacon'
    ) {
      record(node, 'sendBeacon')
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      RESERVED_CALL_CAPABILITIES.has(propertyName(node, bindings)) &&
      !isExactCallCallee(node)
    ) {
      record(node, `capability reference ${propertyName(node, bindings)}`)
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      DYNAMIC_CODE_CAPABILITIES.has(propertyName(node, bindings)) &&
      isGlobalObject(node.expression, bindings) &&
      !isExactDynamicInvocationCallee(node)
    ) {
      record(node, `dynamic global ${propertyName(node, bindings)} value`)
    }
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
      const descriptor = descriptorInvocation(node, bindings)
      if (
        rejectPropertyDescriptors &&
        descriptor !== undefined &&
        node.expression !== permittedDataDescriptor
      ) {
        record(node, 'property descriptor access')
      }
      if (
        descriptor !== undefined &&
        (descriptor.target === null || isGlobalObject(descriptor.target, bindings))
      ) {
        record(node, 'global property descriptor capability recovery')
      }
      const descriptorKey =
        descriptor?.key === null ? null : staticString(descriptor?.key, bindings)
      if (descriptorKey && RESERVED_CALL_CAPABILITIES.has(descriptorKey)) {
        record(node, `property descriptor capability reference ${descriptorKey}`)
      }
      const dynamicKind = dynamicConstructorKind(node.expression, bindings)
      if (dynamicKind) record(node, `dynamic ${dynamicKind}`)
      const reflectiveInvocation = resolvedMethod(node.expression, bindings)
      if (
        reflectiveInvocation?.owner === 'Reflect' &&
        (reflectiveInvocation.name === 'apply' || reflectiveInvocation.name === 'construct') &&
        node.arguments[0]
      ) {
        const reflectiveTarget = dynamicConstructorKind(node.arguments[0], bindings)
        if (reflectiveTarget) record(node, `reflective dynamic ${reflectiveTarget}`)
        if (
          rejectUnknownCallableMembers &&
          isUnknownComputedCallable(node.arguments[0], bindings)
        ) {
          record(node, 'unknown computed reflective target')
        }
      }
      const capability = callableCapability(node.expression, bindings)
      if (capability) {
        const form =
          capability.form === 'direct' && node.questionDotToken ? 'optional' : capability.form
        record(node, `${form} ${capability.name}`)
      }
      if (rejectUnknownCallableMembers && isUnknownComputedCallable(node.expression, bindings)) {
        record(node, 'unknown computed callable')
      }
      if (
        rejectUnknownCallableMembers &&
        callbackSinkArguments(node, bindings).some((argument) =>
          isUnknownCallbackValue(argument, bindings)
        )
      ) {
        record(node, 'unknown computed callback sink')
      }
    }
    if (ts.isNewExpression(node)) {
      const dynamicKind = dynamicConstructorKind(node.expression, bindings)
      const staticPayloads = (node.arguments ?? [])
        .map((argument) => staticString(argument, bindings))
        .filter((value) => value !== null)
      const capabilityPayload = staticPayloads.some((value) =>
        DYNAMIC_CAPABILITY_SOURCE.test(value)
      )
      const exactBareFunctionConstructor =
        ts.isIdentifier(node.expression) && node.expression.text === 'Function'
      if (
        (dynamicKind !== null && capabilityPayload) ||
        (dynamicKind === 'Function' &&
          (!allowVendorFunctionConstructors || !exactBareFunctionConstructor)) ||
        (dynamicKind === 'callable.constructor' && staticPayloads.length > 0)
      ) {
        const label =
          dynamicKind === 'Function' && !exactBareFunctionConstructor
            ? 'dynamic non-canonical Function code'
            : `dynamic ${dynamicKind ?? 'constructor'} code`
        record(node, label)
      }
      if (rejectUnknownCallableMembers && isUnknownComputedCallable(node.expression, bindings)) {
        record(node, 'unknown computed constructor')
      }
      if (
        rejectUnknownCallableMembers &&
        constructorCallbackArguments(node, bindings).some((argument) =>
          isUnknownCallbackValue(argument, bindings)
        )
      ) {
        record(node, 'unknown computed constructor callback')
      }
    }
    if (
      rejectUnknownCallableMembers &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
      EVENT_HANDLER_PROPERTIES.has(propertyName(node.left, bindings)) &&
      isUnknownCallbackValue(node.right, bindings)
    ) {
      record(node, 'unknown computed event handler')
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
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = bindingElementName(node, bindings)
      if (name && RESERVED_CALL_CAPABILITIES.has(name)) {
        record(node, `capability reference ${name}`)
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left)
    ) {
      const visitAssignmentPattern = (pattern) => {
        for (const property of pattern.properties) {
          const name = objectLiteralPropertyName(property, bindings)
          if (name && RESERVED_CALL_CAPABILITIES.has(name)) {
            record(property, `capability reference ${name}`)
          }
          if (
            ts.isPropertyAssignment(property) &&
            ts.isObjectLiteralExpression(property.initializer)
          ) {
            visitAssignmentPattern(property.initializer)
          }
        }
      }
      visitAssignmentPattern(node.left)
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

function verifyApprovedFetchSource(moduleId, expectedCalls) {
  const path = resolve(process.cwd(), moduleId)
  assert(existsSync(path), `approved fetch module is missing: ${moduleId}`)
  const references = runtimeBoundaryReferences(moduleId, readFileSync(path, 'utf8'))
  assert(
    references.length === expectedCalls &&
      references.every((reference) => reference.startsWith('direct fetch@')),
    `${moduleId} must contain exactly ${expectedCalls} canonical direct fetch call and no other forbidden runtime capability; got ${references.join(',') || '<none>'}`
  )
}

export function assertQualifiedProductionModules(file, moduleIds) {
  assert(
    !moduleIds.includes(AUDITED_DATA_COPIER_PATH),
    `${file} includes the audited data copier without finalized-call qualification`
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
  assert(report.schema_version === 2, 'authority report schema_version must be 2')
  assert(report.build_mode === 'production', 'authority report build_mode must be production')
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
  const reportedVendorModules = new Set()
  const approvedVendorFunctionChunks = new Set()
  let approvedFetchChunks = 0
  let approvedDirectFetchCalls = 0
  for (const chunk of report.chunks) {
    assert(
      typeof chunk.file === 'string' && /^[A-Za-z0-9_./-]+\.js$/.test(chunk.file),
      'invalid chunk path'
    )
    assert(!chunk.file.split('/').includes('..'), `unsafe chunk path '${chunk.file}'`)
    assert(!reportedFiles.has(chunk.file), `duplicate reported chunk '${chunk.file}'`)
    reportedFiles.add(chunk.file)
    assert(Array.isArray(chunk.project_modules), `${chunk.file} has no project module inventory`)
    assertQualifiedProductionModules(chunk.file, chunk.project_modules)
    assert(Array.isArray(chunk.vendor_modules), `${chunk.file} has no vendor module inventory`)
    for (const moduleId of chunk.vendor_modules) {
      assert(
        typeof moduleId === 'string' &&
          moduleId.startsWith('node_modules/') &&
          !moduleId.includes('\\') &&
          !moduleId.split('/').includes('..'),
        `${chunk.file} contains an unsafe vendor module ID`
      )
      assert(
        !reportedVendorModules.has(moduleId),
        `vendor module '${moduleId}' appears more than once in the report`
      )
      reportedVendorModules.add(moduleId)
    }
    assert(/^[0-9a-f]{64}$/.test(chunk.sha256), `${chunk.file} has invalid SHA-256`)
    const path = resolve(DIST, chunk.file)
    assert(existsSync(path), `reported chunk is missing: ${chunk.file}`)
    const source = readFileSync(path, 'utf8')
    const hash = createHash('sha256').update(source).digest('hex')
    assert(hash === chunk.sha256, `${chunk.file} content hash does not match the Vite report`)
    const references = runtimeBoundaryReferences(chunk.file, source)
    const approvedFunctionSpec =
      chunk.vendor_modules.length === 1
        ? APPROVED_VENDOR_FUNCTION_CHUNKS.get(chunk.vendor_modules[0])
        : undefined
    const exactVendorFunctionReferences = references.filter((reference) =>
      reference.startsWith('dynamic Function code@')
    )
    if (approvedFunctionSpec) {
      assert(
        chunk.project_modules.length === 0,
        `${approvedFunctionSpec.displayName} Function chunk must not contain project modules`
      )
      assert(
        exactVendorFunctionReferences.length === approvedFunctionSpec.exactConstructors,
        `${approvedFunctionSpec.displayName} chunk must contain exactly ${approvedFunctionSpec.exactConstructors} canonical Function constructors, got ${exactVendorFunctionReferences.length}`
      )
      approvedVendorFunctionChunks.add(chunk.vendor_modules[0])
    }
    const carriesApprovedFetchModule = chunk.project_modules.includes(APPROVED_FETCH_MODULE)
    if (carriesApprovedFetchModule) approvedFetchChunks += 1
    const canonicalFetchCalls = references.filter((reference) =>
      reference.startsWith('direct fetch@')
    )
    if (canonicalFetchCalls.length > 0) {
      assert(
        carriesApprovedFetchModule,
        `${chunk.file} contains direct fetch outside approved module provenance`
      )
      approvedDirectFetchCalls += canonicalFetchCalls.length
    }
    const forbiddenReferences = references.filter(
      (reference) =>
        !reference.startsWith('direct fetch@') &&
        !(approvedFunctionSpec && exactVendorFunctionReferences.includes(reference))
    )
    assert(
      forbiddenReferences.length === 0,
      `${chunk.file} contains forbidden renderer runtime capability references: ${forbiddenReferences.join(',')}`
    )

    for (const moduleId of chunk.project_modules) {
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
  assert(
    reportedModules.has(APPROVED_FETCH_MODULE),
    `module graph omits approved fetch module ${APPROVED_FETCH_MODULE}`
  )
  assert(
    approvedFetchChunks === 1,
    `approved fetch module must belong to exactly one chunk, got ${approvedFetchChunks}`
  )
  assert(
    approvedDirectFetchCalls === APPROVED_DIRECT_FETCH_CALLS,
    `finalized bundle must contain exactly ${APPROVED_DIRECT_FETCH_CALLS} approved direct fetch call, got ${approvedDirectFetchCalls}`
  )
  for (const [moduleId, spec] of APPROVED_VENDOR_FUNCTION_CHUNKS) {
    assert(
      approvedVendorFunctionChunks.has(moduleId),
      `module graph omits the exact ${spec.displayName} Function-constructor chunk`
    )
  }
  for (const moduleId of reportedModules) {
    if (!/\.[cm]?[jt]sx?$/.test(moduleId)) continue
    const modulePath = resolve(process.cwd(), moduleId)
    assert(existsSync(modulePath), `reported project module is missing: ${moduleId}`)
    const unresolvedCalls = runtimeBoundaryReferences(moduleId, readFileSync(modulePath, 'utf8'), {
      rejectPropertyDescriptors: true,
      rejectUnknownCallableMembers: true,
    }).filter(
      (reference) =>
        reference.startsWith('unknown computed ') ||
        reference.startsWith('property descriptor access@')
    )
    assert(
      unresolvedCalls.length === 0,
      `${moduleId} uses runtime-computed callable dispatch: ${unresolvedCalls.join(',')}`
    )
  }
  verifyApprovedFetchSource(APPROVED_FETCH_MODULE, APPROVED_DIRECT_FETCH_CALLS)

  return { chunks: report.chunks.length }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    const result = verifyProductionAuthorityBoundary()
    console.log(
      `OK: production module graph and ${result.chunks} hashed chunks prove development-adapter exclusion and guarded runtime capabilities`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
