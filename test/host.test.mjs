/**
 * Host-half tests for @local/dsh-mcp-manager (CONTRACT §1–§7).
 *
 * Every test runs with `DSH_HOME` pointed at an owned temporary directory, so
 * nothing here touches the real `~/.dsh` or any user-authored
 * `cordis.patch.yml`. No test opens a network connection: the Plugin Manager is
 * always an injected fake, and `installBundle` never runs pnpm.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { apply, inject as pluginInject, name as pluginName, __internals } from '../index.js'

const {
  RPC_CHANNEL,
  MAX_BODY_BYTES,
  MAX_LABEL_LENGTH,
  MANAGER_METADATA_FILE,
  MCP_CLIENT_MODULE,
  ROW_ID_PREFIX,
  managedRoot,
  serverDir,
  assertServerId,
  generatedPackageName,
  slugifyServerId,
  allocateServerId,
  normalizeServerInput,
  carriesDisplayName,
  bundleIsInstalled,
  applyBundle,
  generatedManifest,
  generatedPatch,
  managedServerId,
  managerMetadataPath,
  readManagerMetadata,
  writeManagerMetadata,
  readAuthoredConfigFromDisk,
  buildServerView,
  deriveStatus,
  catalogValue,
  readSeedCatalogValue,
  readPackageSpec,
  npmPackageUrl,
  fetchNpmPackageCard,
  mapNpmPackageDocument,
  deriveNpmCommand,
  binEntries,
  pickNpmBin,
  CATALOG_NPM_PACKAGE_URL,
  samePackageName,
  normalizePackageName,
  mergeNpmEntries,
  CATALOG_REGISTRY_URL,
  CATALOG_NPM_URL,
  CATALOG_NPM_TERM,
  CATALOG_TIMEOUT_MS,
  CATALOG_CACHE_TTL_MS,
  CATALOG_FALLBACK_TTL_MS,
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_LIMIT,
  normalizeCatalogDocument,
  endpointFromPath,
  RpcFailure,
} = __internals

const RECONNECT = { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }

/* ------------------------------------------------------------------ harness */

/** Run one test body inside an owned `DSH_HOME`. */
async function withTempHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** A managed row exactly as `pluginManager.listPlugins()` reports one. */
function managedRow(serverId, overrides = {}) {
  return {
    entryId: `include:${ROW_ID_PREFIX}${serverId}`,
    patchId: `${ROW_ID_PREFIX}${serverId}`,
    moduleName: MCP_CLIENT_MODULE,
    enabled: true,
    fiberPhase: 'active',
    ...overrides,
  }
}

/** A hand-authored row, exactly as the live profile's `mcp-obscura` appears. */
function externalRow(rowId, overrides = {}) {
  return {
    entryId: `include:${rowId}`,
    patchId: rowId,
    moduleName: MCP_CLIENT_MODULE,
    enabled: true,
    fiberPhase: 'active',
    ...overrides,
  }
}

/**
 * A fake Host context plus a fake Plugin Manager that records every call and
 * projects a newly installed bundle's config the way the Loader would.
 */
function createHarness({
  seeds = [],
  seedBundle,
  rejection,
  rejectionThrows = false,
  withManager = true,
  withConnection = true,
  logger,
  managerOverrides = {},
} = {}) {
  const state = {
    calls: [],
    rows: seeds.map((seed) => ({ ...seed.row })),
    entries: seeds.map((seed) => ({ id: seed.row.entryId, options: { config: seed.config } })),
    // The fake keeps real bundle *records*, and models the real manager's
    // refusal to install a dependency that is already recorded (t11/F1).
    bundles: new Map(),
    routes: new Map(),
    effects: [],
  }
  if (seedBundle !== undefined) {
    state.bundles.set(seedBundle, { name: seedBundle, installed: true, enabled: true, dir: null })
  }

  const manager = {
    async listPlugins() {
      state.calls.push({ method: 'listPlugins' })
      return state.rows.map((row) => ({ ...row }))
    },
    async listBundles() {
      state.calls.push({ method: 'listBundles' })
      return [...state.bundles.values()].map((record) => ({ ...record }))
    },
    async installBundle(dir, options) {
      // Read the files the Host authored: a real install would consume exactly these.
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      const patch = JSON.parse(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'))
      state.calls.push({ method: 'installBundle', dir, options, manifest, patch })
      if (state.bundles.has(manifest.name)) {
        // Re-installing an already-installed dependency leaves pnpm's dependency
        // diff empty, which the real Plugin Manager refuses with
        // `ManagementFailure('ambiguous-install')` (thrown, not returned).
        throw new Error('ambiguous-install')
      }
      const serverId = manifest.name.slice('@local/dsh-mcp-'.length)
      state.bundles.set(manifest.name, { name: manifest.name, installed: true, enabled: options?.enabled !== false, dir })
      const row = managedRow(serverId)
      const at = state.rows.findIndex((candidate) => candidate.entryId === row.entryId)
      if (at === -1) state.rows.push(row)
      else state.rows[at] = row
      const projected = state.entries.find((entry) => entry.id === row.entryId)
      if (projected === undefined) state.entries.push({ id: row.entryId, options: { config: patch[0].insert[0].config } })
      else projected.options = { config: patch[0].insert[0].config }
      return {
        changed: true,
        application: 'applied',
        stage: 'install',
        target: dir,
        bundle: manifest.name,
      }
    },
    async setPluginEnabled(id, enabled) {
      state.calls.push({ method: 'setPluginEnabled', id, enabled })
      const row = state.rows.find((candidate) => candidate.entryId === id)
      if (row !== undefined) row.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: id, enabled }
    },
    async setBundleEnabled(bundle, enabled) {
      state.calls.push({ method: 'setBundleEnabled', name: bundle, enabled })
      const record = state.bundles.get(bundle)
      if (record === undefined) {
        return { changed: false, application: 'failed', stage: 'enable', target: bundle, error: { code: 'not-bundle' } }
      }
      record.enabled = enabled
      // The real manager reconciles the bundle's rows from disk on reload.
      if (record.dir !== null) {
        const serverId = bundle.slice('@local/dsh-mcp-'.length)
        const patch = JSON.parse(await readFile(join(record.dir, 'cordis.patch.yml'), 'utf8'))
        const projected = state.entries.find((entry) => entry.id === `include:${ROW_ID_PREFIX}${serverId}`)
        if (projected !== undefined) projected.options = { config: patch[0].insert[0].config }
      }
      return { changed: true, application: 'applied', stage: 'enable', target: bundle, enabled }
    },
    async removeBundle(bundle) {
      state.calls.push({ method: 'removeBundle', name: bundle })
      state.bundles.delete(bundle)
      state.rows = state.rows.filter((row) => {
        const serverId = managedServerId(row)
        return serverId === null || generatedPackageName(serverId) !== bundle
      })
      return { changed: true, application: 'applied', stage: 'remove', target: bundle }
    },
  }
  Object.assign(manager, managerOverrides)

  const services = {
    loader: { entries: () => state.entries },
    webServer: {
      register(route) {
        if (state.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        state.routes.set(route.path, route)
        return () => state.routes.delete(route.path)
      },
    },
  }
  if (withConnection) {
    services.connection = {
      requestRejection: () => {
        if (rejectionThrows) throw new Error('fence exploded: secret host detail')
        return rejection
      },
    }
  }
  if (withManager) services.pluginManager = manager

  const makeCtx = () => ({
    get: (key) => services[key],
    effect: (fn, label) => {
      const dispose = fn()
      state.effects.push({ label, dispose })
      return dispose
    },
    inject: (deps, callback) => {
      if (deps.every((dep) => services[dep] !== undefined)) callback(makeCtx())
    },
    logger: logger ?? { warn() {}, error() {} },
    webServer: services.webServer,
    connection: services.connection,
  })

  apply(makeCtx())
  return { state, services, manager, calls: state.calls, routes: state.routes }
}

/** A Node-request stand-in: headers, url, method, and an async body iterator. */
function makeRequest({ url, method, text, headers }) {
  const chunks = text === undefined || text === '' ? [] : [Buffer.from(text)]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A Node-response stand-in that records the status, headers, and body. */
function makeResponse() {
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers = {}) {
      res.statusCode = status
      Object.assign(res.headers, headers)
      res.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      res.writableEnded = true
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
  return res
}

/** Drive one request through the mounted channel. */
async function callChannel(harness, endpoint, options = {}) {
  const route = harness.routes.get(RPC_CHANNEL)
  assert.ok(route !== undefined, `the ${RPC_CHANNEL} channel must be mounted`)
  const rpcId = options.rpcId ?? 'rpc-test-1'
  const hasBody = Object.hasOwn(options, 'body')
  const body = hasBody
    ? options.body
    : {
      type: 'client-request',
      rpcId,
      method: options.envelopeMethod ?? endpoint,
      payload: Object.hasOwn(options, 'payload') ? options.payload : {},
    }
  const text = options.raw ?? (body === undefined ? '' : JSON.stringify(body))
  const res = makeResponse()
  await route.handler(makeRequest({
    url: options.url ?? `${RPC_CHANNEL}/${endpoint ?? ''}`,
    method: options.method ?? 'POST',
    text,
    headers: options.headers,
  }), res)
  const raw = res.text()
  const isJson = String(res.headers['content-type'] ?? '').startsWith('application/json')
  return { res, status: res.statusCode, text: raw, envelope: isJson && raw !== '' ? JSON.parse(raw) : undefined }
}

/** The success value of a response envelope, asserting `ok: true` first. */
function valueOf(response) {
  assert.equal(response.status, 200, `HTTP 200 expected, got ${response.status}: ${response.text}`)
  assert.equal(response.envelope?.type, 'server-response')
  assert.equal(response.envelope?.result?.ok, true, `ok:true expected: ${response.text}`)
  return response.envelope.result.value
}

/** The failure of a response envelope, asserting `ok: false` first. */
function errorOf(response) {
  assert.equal(response.status, 200, `HTTP 200 expected for application failures, got ${response.status}: ${response.text}`)
  assert.equal(response.envelope?.type, 'server-response')
  assert.equal(response.envelope?.result?.ok, false, `ok:false expected: ${response.text}`)
  return response.envelope.result.error
}

/** A context shaped like the Loader's, exposing projected entry configs. */
function loaderContext(entries) {
  return { get: (key) => (key === 'loader' ? { entries: () => entries } : undefined) }
}

/* --------------------------------------------------------------- identity */

describe('identity and mount', () => {
  it('exports name / inject / apply with the frozen identity', () => {
    assert.equal(pluginName, 'dsh-mcp-manager')
    assert.deepEqual(pluginInject, ['connection'])
    assert.equal(typeof apply, 'function')
  })

  it('imports only Node built-ins (never an MCP library or @deepseek-ai/*)', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
      .sort()
    assert.deepEqual(specifiers, ['node:fs/promises', 'node:os', 'node:path', 'node:url'])
    assert.equal(/require\s*\(/.test(source), false)
  })

  it('mounts one prefix route on /dsh-mcp-rpc', () => {
    const harness = createHarness()
    const route = harness.routes.get(RPC_CHANNEL)
    assert.equal(typeof route.handler, 'function')
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, RPC_CHANNEL)
  })
})

/* ------------------------------------------------------------------- fence */

describe('request fence', () => {
  it('fences every request through ctx.connection.requestRejection', async () => {
    const harness = createHarness({ rejection: 403 })
    const forbidden = await callChannel(harness, 'list')
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.text, 'forbidden')
    assert.equal(forbidden.envelope, undefined)

    // the fence runs before routing: a non-POST is still refused with 403
    const get = await callChannel(harness, 'list', { method: 'GET' })
    assert.equal(get.status, 403)
  })

  it('answers 401 unauthorized when authentication is missing', async () => {
    const harness = createHarness({ rejection: 401 })
    const response = await callChannel(harness, 'list')
    assert.equal(response.status, 401)
    assert.equal(response.text, 'unauthorized')
  })

  it('fails closed when no fence is available', async () => {
    const harness = createHarness({ withConnection: false })
    const response = await callChannel(harness, 'list')
    assert.equal(response.status, 403)
    assert.equal(response.text, 'forbidden')
  })

  it('fails closed when the fence itself throws (t6/O9)', async () => {
    const harness = createHarness({ rejectionThrows: true })
    for (const endpoint of ['list', 'catalog']) {
      const response = await callChannel(harness, endpoint)
      assert.equal(response.status, 403, `${endpoint} must be refused`)
      assert.equal(response.text, 'forbidden')
      assert.equal(response.envelope, undefined, 'no application envelope is produced')
      assert.equal(response.text.includes('fence exploded'), false, 'the fence error text must not leak')
      assert.equal(response.text.includes('secret host detail'), false)
    }
    // Nothing behind the fence ran: not even the plugin manager was consulted.
    assert.deepEqual(harness.calls, [])
  })

  it('normalizes an unexpected fence return value to a rejection', async () => {
    const harness = createHarness({ rejection: 500 })
    const response = await callChannel(harness, 'list')
    assert.equal(response.status, 403, 'anything that is not undefined/401 is refused')
  })
})

/* --------------------------------------------------------------- transport */

describe('channel transport rules', () => {
  it('answers 404 for a missing or unknown endpoint and for a non-POST', async () => {
    const harness = createHarness()
    assert.equal((await callChannel(harness, '', { url: RPC_CHANNEL })).status, 404)
    assert.equal((await callChannel(harness, 'nope', { url: `${RPC_CHANNEL}/nope` })).status, 404)
    assert.equal((await callChannel(harness, 'list/extra', { url: `${RPC_CHANNEL}/list/extra` })).status, 404)
    assert.equal((await callChannel(harness, 'list', { method: 'GET' })).status, 404)
  })

  it('requires content-type: application/json', async () => {
    const harness = createHarness()
    const response = await callChannel(harness, 'list', { headers: { 'content-type': 'text/plain' } })
    assert.equal(response.status, 415)
    assert.equal(response.text, 'content type must be application/json')

    const parameters = await callChannel(harness, 'list', { headers: { 'content-type': 'Application/JSON; charset=utf-8' } })
    assert.equal(parameters.status, 200)
  })

  it('caps the body at 1 MiB', async () => {
    const harness = createHarness()
    assert.equal(MAX_BODY_BYTES, 1024 * 1024)

    const oversized = await callChannel(harness, 'list', { raw: `"${'x'.repeat(MAX_BODY_BYTES)}"` })
    assert.equal(oversized.status, 413)
    assert.match(oversized.text, /exceeds 1048576 bytes/)

    const declared = await callChannel(harness, 'list', {
      raw: '{}',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    })
    assert.equal(declared.status, 413)
  })

  it('answers 400 when the body is not JSON', async () => {
    const harness = createHarness()
    const response = await callChannel(harness, 'list', { raw: 'not json' })
    assert.equal(response.status, 400)
    assert.equal(response.text, 'body is not JSON')
  })

  it('returns HTTP 200 with a gateway/bad-request envelope for a malformed envelope', async () => {
    const harness = createHarness()
    const response = await callChannel(harness, 'list', { body: { rpcId: 'abc', method: 'list' } })
    assert.equal(response.status, 200)
    assert.equal(response.envelope.rpcId, 'abc')
    assert.equal(response.envelope.result.ok, false)
    assert.equal(response.envelope.result.error.code, 'gateway/bad-request')
    assert.ok(Array.isArray(response.envelope.result.error.details.issues))
    assert.ok(response.envelope.result.error.details.issues.length > 0)

    const unusable = await callChannel(harness, 'list', { body: 42 })
    assert.equal(unusable.status, 200)
    assert.equal(unusable.envelope.rpcId, 'invalid-request')
  })

  it('rejects a method that does not match the URL endpoint (HTTP 200)', async () => {
    const harness = createHarness()
    const response = await callChannel(harness, 'list', { envelopeMethod: 'catalog' })
    assert.equal(response.status, 200)
    assert.equal(response.envelope.rpcId, 'rpc-test-1')
    assert.equal(response.envelope.result.ok, false)
    assert.equal(response.envelope.result.error.code, 'gateway/bad-request')
    assert.match(response.envelope.result.error.message, /does not match endpoint/)
  })

  it('uses the literal §6 success envelope', async () => {
    const harness = createHarness()
    const response = await callChannel(harness, 'list', { rpcId: 'rpc-42' })
    assert.deepEqual(Object.keys(response.envelope), ['type', 'rpcId', 'result'])
    assert.deepEqual(Object.keys(response.envelope.result), ['ok', 'value'])
    assert.equal(response.envelope.rpcId, 'rpc-42')
    assert.equal(response.envelope.type, 'server-response')
  })

  it('never lets an exception reach the HTTP layer', async () => {
    const harness = createHarness({
      managerOverrides: {
        async listPlugins() {
          throw new Error('manager exploded')
        },
      },
    })
    const response = await callChannel(harness, 'list')
    assert.equal(response.status, 200)
    assert.equal(response.envelope.result.ok, false)
    assert.equal(response.envelope.result.error.code, 'internal')
    assert.match(response.envelope.result.error.message, /manager exploded/)
  })
})

/* --------------------------------------------------------------- serverId */

describe('serverId rules', () => {
  it('lowercases and reduces the serverName to [a-z0-9-]', () => {
    assert.equal(slugifyServerId('demo'), 'demo')
    assert.equal(slugifyServerId('My_Server'), 'my-server')
    assert.equal(slugifyServerId('GitHub-MCP'), 'github-mcp')
    assert.equal(slugifyServerId('A__B'), 'a-b')
    assert.equal(slugifyServerId('-' + 'x'.repeat(4) + '-'), 'x'.repeat(4))
  })

  it('resolves collisions with a -2, -3, … suffix', () => {
    assert.equal(allocateServerId('demo', new Set()), 'demo')
    assert.equal(allocateServerId('demo', new Set(['demo'])), 'demo-2')
    assert.equal(allocateServerId('demo', new Set(['demo', 'demo-2'])), 'demo-3')
    assert.equal(allocateServerId('github-mcp', new Set(['github-mcp', 'github-mcp-2'])), 'github-mcp-3')
  })

  it('allocates distinct ids for names that reduce to the same id', async () => {
    await withTempHome(async (home) => {
      const harness = createHarness()
      const first = valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } },
      }))
      const second = valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'Demo', transport: 'stdio', command: 'node' } },
      }))
      assert.equal(first.created, 'demo')
      assert.equal(second.created, 'demo-2')
      assert.deepEqual(second.servers.map((view) => view.id).sort(), ['demo', 'demo-2'])
      for (const id of ['demo', 'demo-2']) {
        const manifest = JSON.parse(await readFile(join(serverDir(id), 'package.json'), 'utf8'))
        assert.equal(manifest.name, generatedPackageName(id))
      }
      assert.equal(serverDir('demo'), join(home, 'mcp-servers', 'demo'))
      assert.equal(managedRoot(), join(home, 'mcp-servers'))
    })
  })

  it('treats only mcp-manager- rows as managed (§4)', () => {
    assert.equal(managedServerId({ entryId: 'include:mcp-manager-demo', patchId: 'mcp-manager-demo' }), 'demo')
    assert.equal(managedServerId({ entryId: 'include:mcp-manager-demo' }), 'demo')
    assert.equal(managedServerId({ patchId: 'mcp-manager-demo' }), 'demo')
    assert.equal(managedServerId({ entryId: 'include:mcp-obscura', patchId: 'mcp-obscura' }), null)
    assert.equal(managedServerId({ entryId: 'include:mcp-manager-', patchId: 'mcp-manager-' }), null)
    assert.equal(managedServerId({}), null)
  })

  it('validates a serverId before it can become a path segment (t6/O7)', () => {
    for (const bad of ['', '.', '..', '../evil', 'a/b', 'a\\b', 'A-B', 'a_b', 'a b', 'demo\n']) {
      assert.throws(() => assertServerId(bad), (error) => {
        assert.ok(error instanceof RpcFailure)
        assert.equal(error.code, 'internal')
        return true
      }, `expected a rejection for ${JSON.stringify(bad)}`)
      assert.throws(() => serverDir(bad), `serverDir must refuse ${JSON.stringify(bad)}`)
    }
    for (const good of ['demo', 'demo-2', 'a-b-c', 'x', '9']) {
      assert.equal(assertServerId(good), good)
      assert.equal(serverDir(good), join(managedRoot(), good))
    }
  })

  it('never classifies a path-escaping row id as managed (t6/O7)', async () => {
    const hostile = 'mcp-manager-../evil'
    const harness = createHarness({
      seeds: [{
        row: { entryId: `include:${hostile}`, patchId: hostile, moduleName: MCP_CLIENT_MODULE, enabled: true, fiberPhase: 'active' },
        config: { serverName: 'evil', transport: 'stdio', command: 'node' },
      }],
    })
    assert.equal(managedServerId({ patchId: hostile, entryId: `include:${hostile}` }), null)
    const value = valueOf(await callChannel(harness, 'list'))
    assert.equal(value.servers.length, 1)
    assert.equal(value.servers[0].managed, false)
    assert.equal(value.servers[0].id, '')
    assert.equal(value.servers[0].readOnlyReason, 'external')
    const error = errorOf(await callChannel(harness, 'remove', { payload: { id: hostile } }))
    assert.equal(error.code, 'read-only')
    assert.equal(harness.calls.some((call) => call.method === 'removeBundle'), false)
  })
})

/* ---------------------------------------------------------- input validation */

describe('ServerInput validation', () => {
  it('accepts a stdio input and fills the optional collections', () => {
    const input = normalizeServerInput({ name: 'demo', transport: 'stdio', command: 'node' })
    assert.deepEqual(input, { name: 'demo', transport: 'stdio', command: 'node', args: [], env: {} })
  })

  it('accepts a streamable-http input', () => {
    const input = normalizeServerInput({
      name: 'web',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer t' },
    })
    assert.deepEqual(input, {
      name: 'web',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer t' },
    })
  })

  it('rejects every malformed field with invalid-request', () => {
    const cases = [
      undefined,
      null,
      'demo',
      { transport: 'stdio', command: 'node' },
      { name: '', transport: 'stdio', command: 'node' },
      { name: 'with space', transport: 'stdio', command: 'node' },
      { name: `x${'y'.repeat(32)}`, transport: 'stdio', command: 'node' },
      { name: 'demo', transport: 'sse', command: 'node' },
      { name: 'demo', transport: 'stdio' },
      { name: 'demo', transport: 'stdio', command: '   ' },
      { name: 'demo', transport: 'stdio', command: 'node', args: ['ok', 3] },
      { name: 'demo', transport: 'stdio', command: 'node', env: { K: 1 } },
      { name: 'demo', transport: 'stdio', command: 'node', cwd: 7 },
      { name: 'demo', transport: 'streamable-http' },
      { name: 'demo', transport: 'streamable-http', url: '' },
      { name: 'demo', transport: 'stdio', command: 'node', displayName: 3 },
      { name: 'demo', transport: 'stdio', command: 'node', displayName: 'x'.repeat(MAX_LABEL_LENGTH + 1) },
    ]
    for (const value of cases) {
      assert.throws(() => normalizeServerInput(value), (error) => {
        assert.ok(error instanceof RpcFailure)
        assert.equal(error.code, 'invalid-request')
        return true
      }, `expected invalid-request for ${JSON.stringify(value)}`)
    }
  })

  it('accepts a free-form display name, including a Chinese one (§3a)', () => {
    const input = normalizeServerInput({
      name: 'filesystem',
      displayName: '  我的文件系统  ',
      transport: 'stdio',
      command: 'node',
    })
    assert.equal(input.displayName, '我的文件系统')
    assert.equal(
      normalizeServerInput({ name: 'a', displayName: 'x'.repeat(MAX_LABEL_LENGTH), transport: 'stdio', command: 'node' })
        .displayName.length,
      MAX_LABEL_LENGTH,
    )
    assert.equal(
      normalizeServerInput({ name: 'a', displayName: '', transport: 'stdio', command: 'node' }).displayName,
      '',
      'an empty display name is kept so update can clear a stored label',
    )
  })

  it('reports invalid-request through the channel for a bad serverName', async () => {
    const harness = createHarness()
    const response = await callChannel(harness, 'add', {
      payload: { input: { name: 'bad name', transport: 'stdio', command: 'node' } },
    })
    const error = errorOf(response)
    assert.equal(error.code, 'invalid-request')
    assert.match(error.message, /serverName/)
    assert.equal(harness.calls.length, 0, 'nothing may reach the Plugin Manager')
  })

  it('reports name-conflict against a hand-authored row too (§2)', async () => {
    const harness = createHarness({
      seeds: [{ row: externalRow('mcp-obscura'), config: { serverName: 'obscura', transport: 'stdio', command: '/opt/obscura' } }],
    })
    const response = await callChannel(harness, 'add', {
      payload: { input: { name: 'obscura', transport: 'stdio', command: 'node' } },
    })
    const error = errorOf(response)
    assert.equal(error.code, 'name-conflict')
    assert.deepEqual(error.details, { name: 'obscura' })
  })

  it('reports name-conflict for a repeated serverName', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      await callChannel(harness, 'add', { payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } } })
      const response = await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } },
      })
      assert.equal(errorOf(response).code, 'name-conflict')
    })
  })
})

/* ------------------------------------------------------------- generated files */

describe('generated bundle files (§3)', () => {
  it('writes the exact §3 package.json and stdio patch', async () => {
    await withTempHome(async (home) => {
      const harness = createHarness()
      const value = valueOf(await callChannel(harness, 'add', {
        payload: {
          input: {
            name: 'filesystem',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: { GITHUB_TOKEN: 'secret' },
            cwd: '/tmp',
          },
        },
      }))

      const dir = join(home, 'mcp-servers', 'filesystem')
      assert.equal(dir, serverDir('filesystem'))
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')), {
        name: '@local/dsh-mcp-filesystem',
        version: '1.0.0',
        private: true,
        type: 'module',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      })
      const patch = JSON.parse(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'))
      assert.deepEqual(patch, [{
        insert: [{
          id: 'mcp-manager-filesystem',
          name: MCP_CLIENT_MODULE,
          config: {
            serverName: 'filesystem',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: { GITHUB_TOKEN: 'secret' },
            cwd: '/tmp',
            failOnStartupError: true,
            reconnect: RECONNECT,
          },
        }],
      }])
      assert.deepEqual(
        Object.keys(patch[0].insert[0].config),
        ['serverName', 'transport', 'command', 'args', 'env', 'cwd', 'failOnStartupError', 'reconnect'],
      )
      // JSON-as-YAML: the file is JSON text (a YAML subset), with no YAML dependency.
      const raw = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
      assert.equal(raw, `${JSON.stringify(patch, null, 2)}\n`)

      // the real Plugin Manager is driven with the authored directory
      const install = harness.calls.find((call) => call.method === 'installBundle')
      assert.equal(install.dir, dir)
      assert.deepEqual(install.options, { enabled: true })
      assert.deepEqual(
        harness.calls.map((call) => call.method),
        ['listPlugins', 'listBundles', 'installBundle', 'listPlugins'],
        'add asks for bundle records before installing (t11/F1)',
      )

      // ...and the §4 disk fallback recovers exactly that config
      assert.deepEqual(await readAuthoredConfigFromDisk('filesystem'), {
        serverName: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { GITHUB_TOKEN: 'secret' },
        cwd: '/tmp',
        failOnStartupError: true,
        reconnect: RECONNECT,
      })

      assert.equal(value.created, 'filesystem')
      const listed = valueOf(await callChannel(harness, 'list', { payload: {} }))
      assert.equal(listed.managedRoot, managedRoot())
      assert.equal(listed.managedRoot, join(home, 'mcp-servers'))
      const view = value.servers.find((candidate) => candidate.id === 'filesystem')
      assert.equal(view.name, 'filesystem')
      assert.equal(view.label, 'filesystem')
      assert.equal(view.transport, 'stdio')
      assert.equal(view.managed, true)
      assert.equal(view.readOnlyReason, null)
      assert.equal(view.bundle, '@local/dsh-mcp-filesystem')
      assert.equal(view.status, 'connected')
      assert.equal(view.phase, 'active')
      assert.equal(view.enabled, true)
      assert.deepEqual(view.config, {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { GITHUB_TOKEN: 'secret' },
        cwd: '/tmp',
        url: null,
        headers: {},
        failOnStartupError: true,
      })
    })
  })

  it('writes the streamable-http variant with url and headers only', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      valueOf(await callChannel(harness, 'add', {
        payload: {
          input: {
            name: 'remote',
            transport: 'streamable-http',
            url: 'https://mcp.example.test/mcp',
            headers: { Authorization: 'Bearer t' },
          },
        },
      }))
      const patch = JSON.parse(await readFile(join(serverDir('remote'), 'cordis.patch.yml'), 'utf8'))
      assert.deepEqual(patch[0].insert[0].config, {
        serverName: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.test/mcp',
        headers: { Authorization: 'Bearer t' },
        failOnStartupError: true,
        reconnect: RECONNECT,
      })
      assert.deepEqual(
        Object.keys(patch[0].insert[0].config),
        ['serverName', 'transport', 'url', 'headers', 'failOnStartupError', 'reconnect'],
      )
    })
  })

  it('omits empty args, env, cwd and headers (§3)', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'plain', transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' } },
      }))
      const patch = JSON.parse(await readFile(join(serverDir('plain'), 'cordis.patch.yml'), 'utf8'))
      assert.deepEqual(Object.keys(patch[0].insert[0].config), [
        'serverName', 'transport', 'command', 'failOnStartupError', 'reconnect',
      ])

      valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'plainhttp', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', headers: {} } },
      }))
      const http = JSON.parse(await readFile(join(serverDir('plainhttp'), 'cordis.patch.yml'), 'utf8'))
      assert.deepEqual(Object.keys(http[0].insert[0].config), [
        'serverName', 'transport', 'url', 'failOnStartupError', 'reconnect',
      ])
    })
  })

  it('builds the same documents through the pure generators', () => {
    assert.deepEqual(generatedManifest('demo'), {
      name: '@local/dsh-mcp-demo',
      version: '1.0.0',
      private: true,
      type: 'module',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    const input = normalizeServerInput({ name: 'demo', transport: 'stdio', command: 'node' })
    assert.deepEqual(generatedPatch('demo', input), [{
      insert: [{
        id: 'mcp-manager-demo',
        name: MCP_CLIENT_MODULE,
        config: {
          serverName: 'demo',
          transport: 'stdio',
          command: 'node',
          failOnStartupError: true,
          reconnect: RECONNECT,
        },
      }],
    }])
  })
})

/* ------------------------------------------------- manager metadata (§3a) */

describe('manager metadata / displayName (§3a, t6/O2)', () => {
  it('persists a Chinese display name into manager.json and reads it back', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      const value = valueOf(await callChannel(harness, 'add', {
        payload: {
          input: { name: 'filesystem', displayName: '我的文件系统', transport: 'stdio', command: 'npx' },
        },
      }))
      const record = JSON.parse(await readFile(managerMetadataPath('filesystem'), 'utf8'))
      assert.deepEqual(Object.keys(record), ['schemaVersion', 'label', 'createdAt'])
      assert.equal(record.schemaVersion, 1)
      assert.equal(record.label, '我的文件系统')
      assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)

      const view = value.servers.find((candidate) => candidate.id === 'filesystem')
      assert.equal(view.label, '我的文件系统')
      assert.equal(view.name, 'filesystem', 'serverName stays the model-facing namespace')

      // A second list re-reads the file, so the title survives a reload.
      const listed = valueOf(await callChannel(harness, 'list'))
      assert.equal(listed.servers.find((candidate) => candidate.id === 'filesystem').label, '我的文件系统')

      // The metadata is manager-private: it never reaches the generated patch.
      const patch = await readFile(join(serverDir('filesystem'), 'cordis.patch.yml'), 'utf8')
      assert.equal(patch.includes('我的文件系统'), false)
      assert.equal(patch.includes('label'), false)
    })
  })

  it('defaults label to serverName when no display name was given', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      const value = valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'plain', transport: 'stdio', command: 'node' } },
      }))
      const record = JSON.parse(await readFile(managerMetadataPath('plain'), 'utf8'))
      assert.deepEqual(Object.keys(record), ['schemaVersion', 'createdAt'], 'an empty display name stores no label')
      assert.equal(value.servers[0].label, 'plain')
    })
  })

  it('refreshes the display name on update and keeps createdAt', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', displayName: '旧标题', transport: 'stdio', command: 'node' } },
      })
      const created = JSON.parse(await readFile(managerMetadataPath('demo'), 'utf8'))

      const updated = valueOf(await callChannel(harness, 'update', {
        payload: {
          id: 'demo',
          input: { name: 'demo', displayName: '新标题 🚀', transport: 'stdio', command: 'node', args: ['v2.js'] },
        },
      }))
      const refreshed = JSON.parse(await readFile(managerMetadataPath('demo'), 'utf8'))
      assert.equal(refreshed.label, '新标题 🚀')
      assert.equal(refreshed.createdAt, created.createdAt, 'createdAt records when the server was added')
      assert.equal(refreshed.schemaVersion, 1)
      assert.equal(updated.servers[0].label, '新标题 🚀')

      // An explicit empty display name clears the stored label.
      const cleared = valueOf(await callChannel(harness, 'update', {
        payload: { id: 'demo', input: { name: 'demo', displayName: '', transport: 'stdio', command: 'node' } },
      }))
      const afterClear = JSON.parse(await readFile(managerMetadataPath('demo'), 'utf8'))
      assert.equal('label' in afterClear, false)
      assert.equal(cleared.servers[0].label, 'demo', 'the view falls back to serverName')
    })
  })

  it('preserves the label when update omits displayName, and clears it on "" (t8/F1)', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      const added = valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', displayName: '保留我', transport: 'stdio', command: 'node' } },
      }))
      const created = JSON.parse(await readFile(managerMetadataPath('demo'), 'utf8'))
      assert.equal(added.servers[0].label, '保留我')

      // (1) The update payload carries no `displayName` property at all.
      const omitted = { name: 'demo', transport: 'stdio', command: 'node', args: ['changed.js'] }
      assert.equal(Object.hasOwn(omitted, 'displayName'), false)
      const updated = valueOf(await callChannel(harness, 'update', { payload: { id: 'demo', input: omitted } }))
      const afterOmit = JSON.parse(await readFile(managerMetadataPath('demo'), 'utf8'))
      assert.equal(updated.servers[0].label, '保留我', 'an omitted displayName preserves the stored label')
      assert.equal(afterOmit.label, '保留我', 'manager.json keeps its label')
      assert.equal(afterOmit.createdAt, created.createdAt, 'createdAt is untouched by update')
      assert.deepEqual(updated.servers[0].config.args, ['changed.js'], 'the update itself did land')

      // (2) The explicit empty string takes the other branch.
      const cleared = valueOf(await callChannel(harness, 'update', {
        payload: { id: 'demo', input: { name: 'demo', displayName: '', transport: 'stdio', command: 'node' } },
      }))
      const afterClear = JSON.parse(await readFile(managerMetadataPath('demo'), 'utf8'))
      assert.equal(cleared.servers[0].label, 'demo', 'an explicit empty displayName clears the label')
      assert.equal(Object.hasOwn(afterClear, 'label'), false, 'manager.json no longer carries a label')

      // (3) The two paths are provably different, not merely both "not an error".
      assert.equal(Object.hasOwn(afterOmit, 'label'), true)
      assert.equal(Object.hasOwn(afterClear, 'label'), false)
      assert.notDeepEqual(afterOmit, afterClear, 'omitted and "" must not collapse into one result')
      assert.notEqual(updated.servers[0].label, cleared.servers[0].label)
    })
  })

  it('writeManagerMetadata is three-state: undefined preserves, "" clears (t8/F1)', async () => {
    await withTempHome(async () => {
      const first = await writeManagerMetadata('demo', '原值')
      assert.equal(first.label, '原值')

      // undefined === "the caller omitted the field" → keep what is stored.
      const preserved = await writeManagerMetadata('demo', undefined)
      assert.equal(preserved.label, '原值')
      assert.equal((await readManagerMetadata('demo')).label, '原值')

      // '' === "the caller cleared the field" → drop the label.
      const cleared = await writeManagerMetadata('demo', '')
      assert.equal(Object.hasOwn(cleared, 'label'), false)
      assert.equal(Object.hasOwn(await readManagerMetadata('demo'), 'label'), false)

      const replaced = await writeManagerMetadata('demo', '新值')
      assert.equal(replaced.label, '新值')
      assert.equal(replaced.createdAt, first.createdAt, 'createdAt survives every path')
    })
  })

  it('carriesDisplayName separates an omitted field from an empty string (t8/F1)', () => {
    const base = { name: 'demo', transport: 'stdio', command: 'node' }
    assert.equal(carriesDisplayName(normalizeServerInput(base)), false)
    assert.equal(carriesDisplayName(normalizeServerInput(Object.assign({}, base, { displayName: '' }))), true)
    assert.equal(carriesDisplayName(normalizeServerInput(Object.assign({}, base, { displayName: '标题' }))), true)
    assert.equal(carriesDisplayName({}), false)
    assert.equal(carriesDisplayName(null), false)
    assert.equal(carriesDisplayName({ displayName: undefined }), false)
  })

  it('degrades to serverName for a missing, malformed or unusable manager.json', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', displayName: '原名', transport: 'stdio', command: 'node' } },
      }))
      const file = managerMetadataPath('demo')
      const broken = [
        '{not json',
        '[]',
        'null',
        '"just a string"',
        '{"schemaVersion":1}',
        '{"label":42}',
        '{"label":"   "}',
        '{"label":"x".repeat}',
      ]
      for (const raw of broken) {
        await writeFile(file, raw)
        const response = await callChannel(harness, 'list')
        const value = valueOf(response)
        assert.equal(value.servers[0].label, 'demo', `must fall back for ${raw}`)
      }
      // A file that is not even readable as text is not an error either.
      await rm(file, { force: true })
      assert.equal(valueOf(await callChannel(harness, 'list')).servers[0].label, 'demo')
    })
  })

  it('clips an over-long stored label to 120 characters instead of failing', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } },
      })
      await writeFile(managerMetadataPath('demo'), JSON.stringify({ schemaVersion: 1, label: 'x'.repeat(400) }))
      const value = valueOf(await callChannel(harness, 'list'))
      assert.equal(value.servers[0].label.length, MAX_LABEL_LENGTH)
    })
  })

  it('reads a label written by a previous session', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } },
      })
      const written = await writeManagerMetadata('demo', '外部写入的标题')
      assert.equal(written.label, '外部写入的标题')
      assert.equal(written.schemaVersion, 1)
      assert.equal((await readManagerMetadata('demo')).label, '外部写入的标题')
      assert.equal(valueOf(await callChannel(harness, 'list')).servers[0].label, '外部写入的标题')
    })
  })

  it('reports the metadata path inside the server directory', () => {
    assert.equal(managerMetadataPath('demo'), join(serverDir('demo'), MANAGER_METADATA_FILE))
    assert.equal(MANAGER_METADATA_FILE, 'manager.json')
  })
})

/* --------------------------------------------------------------- view (§5) */

describe('server view derivation', () => {
  const config = {
    serverName: 'demo',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { A: '1' },
    failOnStartupError: true,
  }

  function view(row, { config: authored = config, serverId = 'demo', managed = true } = {}) {
    const entry = { id: row.entryId, options: { config: authored } }
    return buildServerView(loaderContext([entry]), { row, serverId, managed, config: authored })
  }

  it('derives status from enabled/phase for all four combinations', () => {
    assert.equal(deriveStatus(true, 'active'), 'connected')
    assert.equal(deriveStatus(true, 'failed'), 'error')
    assert.equal(deriveStatus(true, 'loading'), 'loading')
    assert.equal(deriveStatus(true, 'pending'), 'loading')
    assert.equal(deriveStatus(true, null), 'loading')
    assert.equal(deriveStatus(false, 'active'), 'disabled')
    assert.equal(deriveStatus(false, 'failed'), 'disabled')
    assert.equal(deriveStatus(false, 'unloading'), 'disabled')

    assert.equal(view(managedRow('demo', { enabled: true, fiberPhase: 'active' })).status, 'connected')
    assert.equal(view(managedRow('demo', { enabled: true, fiberPhase: 'failed' })).status, 'error')
    assert.equal(view(managedRow('demo', { enabled: true, fiberPhase: 'loading' })).status, 'loading')
    assert.equal(view(managedRow('demo', { enabled: false, fiberPhase: 'active' })).status, 'disabled')
  })

  it('carries the loader error text as statusDetail only when failed', () => {
    const failed = new Error('spawn node ENOENT')
    const failedView = buildServerView(
      loaderContext([{ id: 'include:mcp-manager-demo', options: { config }, _error: failed }]),
      { row: managedRow('demo', { fiberPhase: 'failed' }), serverId: 'demo', managed: true, config },
    )
    assert.equal(failedView.status, 'error')
    assert.equal(failedView.statusDetail, 'spawn node ENOENT')

    const activeView = buildServerView(
      loaderContext([{ id: 'include:mcp-manager-demo', options: { config }, _error: failed }]),
      { row: managedRow('demo'), serverId: 'demo', managed: true, config },
    )
    assert.equal(activeView.status, 'connected')
    assert.equal(activeView.statusDetail, null)
  })

  it('marks unmanaged rows read-only with an empty id and no bundle', () => {
    const authored = { serverName: 'obscura', transport: 'stdio', command: '/opt/obscura/obscura' }
    const entry = { id: 'include:mcp-obscura', options: { config: authored } }
    const external = buildServerView(loaderContext([entry]), {
      row: externalRow('mcp-obscura'),
      serverId: null,
      managed: false,
      config: authored,
    })
    assert.equal(external.id, '')
    assert.equal(external.managed, false)
    assert.equal(external.readOnlyReason, 'external')
    assert.equal(external.bundle, null)
    assert.equal(external.name, 'obscura')
    assert.equal(external.config.command, '/opt/obscura/obscura')
  })

  it('never invents a config value: unrecoverable fields are null (§4)', () => {
    const ghost = buildServerView({ get: () => undefined }, {
      row: managedRow('ghost'),
      serverId: 'ghost',
      managed: true,
      config: null,
    })
    assert.equal(ghost.name, null)
    assert.equal(ghost.label, null)
    assert.deepEqual(ghost.config, {
      command: null,
      args: [],
      env: {},
      cwd: null,
      url: null,
      headers: {},
      failOnStartupError: false,
    })
    assert.equal(ghost.bundle, '@local/dsh-mcp-ghost')
    assert.equal(ghost.readOnlyReason, null)
  })

  it('always reports a legal transport: unknown falls back to stdio (t6/O8)', () => {
    // §5 allows exactly two values, so the Host decides instead of leaving the
    // Client to guess. `url` alone does not make it streamable-http.
    const unknown = buildServerView({ get: () => undefined }, {
      row: managedRow('ghost'),
      serverId: 'ghost',
      managed: true,
      config: null,
    })
    assert.equal(unknown.transport, 'stdio')

    const urlOnly = buildServerView({ get: () => undefined }, {
      row: managedRow('ghost'),
      serverId: 'ghost',
      managed: true,
      config: { serverName: 'ghost', url: 'https://example.test/mcp' },
    })
    assert.equal(urlOnly.transport, 'stdio')

    const http = buildServerView({ get: () => undefined }, {
      row: managedRow('ghost'),
      serverId: 'ghost',
      managed: true,
      config: { serverName: 'ghost', transport: 'streamable-http', url: 'https://example.test/mcp' },
    })
    assert.equal(http.transport, 'streamable-http')

    const stdio = buildServerView({ get: () => undefined }, {
      row: managedRow('ghost'),
      serverId: 'ghost',
      managed: true,
      config: { serverName: 'ghost', transport: 'stdio', command: 'node' },
    })
    assert.equal(stdio.transport, 'stdio')
  })

  it('orders managed rows before external ones', async () => {
    const harness = createHarness({
      seeds: [
        { row: externalRow('mcp-obscura'), config: { serverName: 'obscura', transport: 'stdio', command: '/opt/obscura' } },
        { row: managedRow('zeta'), config: { serverName: 'zeta', transport: 'stdio', command: 'node' } },
        { row: managedRow('alpha'), config: { serverName: 'alpha', transport: 'stdio', command: 'node' } },
      ],
    })
    const value = valueOf(await callChannel(harness, 'list'))
    assert.deepEqual(value.servers.map((entry) => entry.id), ['alpha', 'zeta', ''])
    assert.deepEqual(value.servers.map((entry) => entry.managed), [true, true, false])
  })
})

/* ------------------------------------------------------------ plugin manager */

describe('Plugin Manager integration', () => {
  it('reports not-manager when ctx.pluginManager is unavailable', async () => {
    const harness = createHarness({ withManager: false })
    for (const endpoint of ['list', 'add', 'update', 'remove']) {
      const response = await callChannel(harness, endpoint, { payload: { id: 'x', input: { name: 'a', transport: 'stdio', command: 'node' } } })
      const error = errorOf(response)
      assert.equal(error.code, 'not-manager', `${endpoint} must report not-manager`)
    }
  })

  it('drives add → update → toggle → remove in order', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      const methodNames = () => harness.calls.map((call) => call.method)

      const added = valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', transport: 'stdio', command: 'node', args: ['old.js'] } },
      }))
      assert.equal(added.created, 'demo')
      assert.deepEqual(methodNames(), ['listPlugins', 'listBundles', 'installBundle', 'listPlugins'])

      // Config rewrite: the files are authored again, and because the profile
      // already records this bundle the change is made live by re-selecting it —
      // never by re-installing it (t11/F1: the real manager answers a repeat
      // install with `ambiguous-install`).
      const updated = valueOf(await callChannel(harness, 'update', {
        payload: { id: 'demo', input: { name: 'demo', transport: 'stdio', command: 'node', args: ['new.js'] } },
      }))
      assert.deepEqual(methodNames(), [
        'listPlugins', 'listBundles', 'installBundle', 'listPlugins',
        'listPlugins', 'listBundles', 'setBundleEnabled', 'listPlugins',
      ])
      assert.equal(
        harness.calls.filter((call) => call.method === 'installBundle').length,
        1,
        'update must never install an already-recorded bundle again',
      )
      const reload = harness.calls.find((call) => call.method === 'setBundleEnabled')
      assert.deepEqual(reload, { method: 'setBundleEnabled', name: '@local/dsh-mcp-demo', enabled: true })
      const patchAfter = JSON.parse(await readFile(join(serverDir('demo'), 'cordis.patch.yml'), 'utf8'))
      assert.deepEqual(patchAfter[0].insert[0].config.args, ['new.js'], 'the bundle files are rewritten in place')
      assert.equal(updated.disabled, false)
      assert.deepEqual(updated.servers[0].config.args, ['new.js'], 'the reload projected the new config')

      // enablement only: persisted through setPluginEnabled
      const disabled = valueOf(await callChannel(harness, 'update', { payload: { id: 'demo', toggle: 'disable' } }))
      assert.deepEqual(harness.calls.at(-2), { method: 'setPluginEnabled', id: 'include:mcp-manager-demo', enabled: false })
      assert.equal(disabled.disabled, true)
      assert.equal(disabled.servers[0].status, 'disabled')
      assert.equal(disabled.servers[0].enabled, false)

      const enabled = valueOf(await callChannel(harness, 'update', { payload: { id: 'demo', toggle: 'enable' } }))
      assert.deepEqual(harness.calls.at(-2), { method: 'setPluginEnabled', id: 'include:mcp-manager-demo', enabled: true })
      assert.equal(enabled.disabled, false)

      const removed = valueOf(await callChannel(harness, 'remove', { payload: { id: 'demo' } }))
      assert.deepEqual(methodNames().slice(-3), ['listPlugins', 'removeBundle', 'listPlugins'])
      assert.deepEqual(harness.calls.find((call) => call.method === 'removeBundle'), {
        method: 'removeBundle',
        name: '@local/dsh-mcp-demo',
      })
      assert.deepEqual(removed.servers, [])
    })
  })

  it('rejects a rename with invalid-request and points at remove + add', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      await callChannel(harness, 'add', { payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } } })
      const before = harness.calls.length
      const response = await callChannel(harness, 'update', {
        payload: { id: 'demo', input: { name: 'renamed', transport: 'stdio', command: 'node' } },
      })
      const error = errorOf(response)
      assert.equal(error.code, 'invalid-request')
      assert.match(error.message, /删除该服务器/)
      assert.equal(harness.calls.length, before + 1, 'only the row lookup may run')
    })
  })

  it('refuses an in-place update when the current serverName cannot be read', async () => {
    // A managed row with no projected config and no bundle file behind it: the
    // rename rule (§2) cannot be checked, so the write is refused rather than
    // silently renaming the server behind its immutable serverId.
    const harness = createHarness({ seeds: [{ row: managedRow('ghost') }] })
    const error = errorOf(await callChannel(harness, 'update', {
      payload: { id: 'ghost', input: { name: 'ghost', transport: 'stdio', command: 'node' } },
    }))
    assert.equal(error.code, 'invalid-request')
    assert.match(error.message, /读不到服务器/)
    assert.equal(harness.calls.filter((call) => call.method === 'installBundle').length, 0)
  })

  it('requires exactly one of input/toggle', async () => {
    const harness = createHarness({ seeds: [{ row: managedRow('demo'), config: { serverName: 'demo', transport: 'stdio', command: 'node' } }] })
    for (const payload of [{ id: 'demo' }, { id: 'demo', input: { name: 'demo', transport: 'stdio', command: 'node' }, toggle: 'enable' }, { id: '' }, {}]) {
      const error = errorOf(await callChannel(harness, 'update', { payload }))
      assert.equal(error.code, 'invalid-request')
    }
    const badToggle = errorOf(await callChannel(harness, 'update', { payload: { id: 'demo', toggle: 'sideways' } }))
    assert.equal(badToggle.code, 'invalid-request')
  })

  it('reports unknown-server for an unknown id', async () => {
    const harness = createHarness({ seeds: [{ row: managedRow('demo'), config: { serverName: 'demo', transport: 'stdio', command: 'node' } }] })
    const removeError = errorOf(await callChannel(harness, 'remove', { payload: { id: 'nope' } }))
    assert.equal(removeError.code, 'unknown-server')
    assert.deepEqual(removeError.details, { id: 'nope' })
    const updateError = errorOf(await callChannel(harness, 'update', { payload: { id: 'nope', toggle: 'enable' } }))
    assert.equal(updateError.code, 'unknown-server')
  })

  it('refuses writes against external and manager-unaddressable rows', async () => {
    const seeds = [
      { row: externalRow('mcp-obscura'), config: { serverName: 'obscura', transport: 'stdio', command: '/opt/obscura' } },
      { row: managedRow('locked', { readOnlyReason: 'unaddressable', patchId: undefined }), config: { serverName: 'locked', transport: 'stdio', command: 'node' } },
    ]
    const harness = createHarness({ seeds })

    const external = errorOf(await callChannel(harness, 'remove', { payload: { id: 'mcp-obscura' } }))
    assert.equal(external.code, 'read-only')
    assert.equal(external.details.reason, 'external')

    const lockedView = valueOf(await callChannel(harness, 'list')).servers.find((view) => view.id === 'locked')
    assert.equal(lockedView.managed, true)
    assert.equal(lockedView.readOnlyReason, 'unaddressable')

    const locked = errorOf(await callChannel(harness, 'update', { payload: { id: 'locked', toggle: 'disable' } }))
    assert.equal(locked.code, 'read-only')
    assert.equal(locked.details.reason, 'unaddressable')
    assert.equal(harness.calls.some((call) => call.method === 'setPluginEnabled'), false)
    assert.equal(harness.calls.some((call) => call.method === 'removeBundle'), false)
  })

  it('reports install-failed with stage and diagnostic', async () => {
    const harness = createHarness({
      managerOverrides: {
        async installBundle() {
          return {
            changed: false,
            application: 'failed',
            stage: 'install',
            target: 'x',
            error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_404 not found' },
          }
        },
      },
    })
    const response = await callChannel(harness, 'add', {
      payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } },
    })
    const error = errorOf(response)
    assert.equal(error.code, 'install-failed')
    assert.equal(error.details.stage, 'install')
    assert.match(error.details.diagnostic, /ERR_PNPM_FETCH_404/)
  })

  it('turns a throwing Plugin Manager into install-failed, not a 500', async () => {
    const harness = createHarness({
      managerOverrides: {
        async installBundle() {
          throw new Error('pnpm is missing')
        },
      },
    })
    const response = await callChannel(harness, 'add', {
      payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } },
    })
    const error = errorOf(response)
    assert.equal(error.code, 'install-failed')
    assert.equal(error.details.stage, 'install')
    assert.match(error.details.diagnostic, /pnpm is missing/)
  })

  it('reports a failed removal with stage remove', async () => {
    const harness = createHarness({
      seeds: [{ row: managedRow('demo'), config: { serverName: 'demo', transport: 'stdio', command: 'node' } }],
      managerOverrides: {
        async removeBundle() {
          return { changed: false, application: 'failed', stage: 'remove', target: 'x', error: { code: 'not-removable' } }
        },
      },
    })
    const error = errorOf(await callChannel(harness, 'remove', { payload: { id: 'demo' } }))
    assert.equal(error.code, 'install-failed')
    assert.equal(error.details.stage, 'remove')
    assert.match(error.details.diagnostic, /not-removable/)
  })

  it('reports a cancelled install as install-failed', async () => {
    const harness = createHarness({
      managerOverrides: {
        async installBundle() {
          return { changed: false, application: 'cancelled', stage: 'install', target: 'x' }
        },
      },
    })
    const error = errorOf(await callChannel(harness, 'add', {
      payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } },
    }))
    assert.equal(error.code, 'install-failed')
    assert.match(error.details.diagnostic, /取消/)
  })

  it('surfaces application:"overridden" as an explicit notice, never a silent success (t6/O4)', async () => {
    // add
    const addHarness = createHarness({
      managerOverrides: {
        async installBundle() {
          return { changed: true, application: 'overridden', stage: 'install', target: 'x' }
        },
      },
    })
    const added = valueOf(await callChannel(addHarness, 'add', {
      payload: { input: { name: 'demo', transport: 'stdio', command: 'node' } },
    }))
    assert.equal(added.created, 'demo', 'the change is still reported as saved')
    assert.equal(added.notice.code, 'overridden')
    // Assert the semantics the user relies on, not the exact wording: the change
    // must be reported as not-yet-in-effect and must tell the user what to do.
    assert.match(added.notice.message, /尚未生效|未生效|未改变/)
    assert.match(added.notice.message, /cordis\.patch\.yml|重启/)

    // update (toggle) — the only operation the Plugin Manager can override
    const toggleHarness = createHarness({
      seeds: [{ row: managedRow('demo'), config: { serverName: 'demo', transport: 'stdio', command: 'node' } }],
      managerOverrides: {
        async setPluginEnabled() {
          return { changed: true, application: 'overridden', stage: 'enable', target: 'x', enabled: true }
        },
      },
    })
    const toggled = valueOf(await callChannel(toggleHarness, 'update', { payload: { id: 'demo', toggle: 'enable' } }))
    assert.equal(toggled.notice.code, 'overridden')
    assert.equal(toggled.disabled, false)

    // remove
    const removeHarness = createHarness({
      seeds: [{ row: managedRow('demo'), config: { serverName: 'demo', transport: 'stdio', command: 'node' } }],
      managerOverrides: {
        async removeBundle() {
          return { changed: true, application: 'overridden', stage: 'remove', target: 'x' }
        },
      },
    })
    const removed = valueOf(await callChannel(removeHarness, 'remove', { payload: { id: 'demo' } }))
    assert.equal(removed.notice.code, 'overridden')

    // a plain 'applied' result carries no notice at all
    const plainHarness = createHarness()
    const plainValue = valueOf(await callChannel(plainHarness, 'add', {
      payload: { input: { name: 'plain', transport: 'stdio', command: 'node' } },
    }))
    assert.equal('notice' in plainValue, false)
  })

  it('updates an installed bundle by reloading it, never by re-installing it (t11/F1)', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      valueOf(await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', transport: 'stdio', command: 'node', args: ['v1.js'] } },
      }))
      // The fake refuses a repeat install exactly like the real Plugin Manager.
      await assert.rejects(
        () => harness.manager.installBundle(serverDir('demo'), { enabled: true }),
        /ambiguous-install/,
        'the harness must model the real manager trap',
      )
      harness.calls.length = 0

      const updated = valueOf(await callChannel(harness, 'update', {
        payload: { id: 'demo', input: { name: 'demo', transport: 'stdio', command: 'node', args: ['v2.js'] } },
      }))
      assert.deepEqual(harness.calls.map((call) => call.method), [
        'listPlugins', 'listBundles', 'setBundleEnabled', 'listPlugins',
      ])
      assert.equal(harness.calls.some((call) => call.method === 'installBundle'), false, 'no second install')
      assert.equal(updated.disabled, false)
      assert.deepEqual(updated.servers[0].config.args, ['v2.js'])
      assert.equal('notice' in updated, false, 'a normal reload is a plain success')
    })
  })

  it('falls back to installBundle when the profile records no such bundle (t11/F1)', async () => {
    await withTempHome(async () => {
      // A managed row whose bundle was never installed (e.g. a leftover
      // directory from a failed add): the install branch must still run.
      const harness = createHarness({
        seeds: [{ row: managedRow('demo'), config: { serverName: 'demo', transport: 'stdio', command: 'node' } }],
      })
      const updated = valueOf(await callChannel(harness, 'update', {
        payload: { id: 'demo', input: { name: 'demo', transport: 'stdio', command: 'node', args: ['fresh.js'] } },
      }))
      assert.deepEqual(harness.calls.map((call) => call.method), [
        'listPlugins', 'listBundles', 'installBundle', 'listPlugins',
      ])
      assert.equal(harness.calls.some((call) => call.method === 'setBundleEnabled'), false)
      assert.equal(harness.calls.find((call) => call.method === 'installBundle').dir, serverDir('demo'))
      assert.deepEqual(updated.servers[0].config.args, ['fresh.js'])
    })
  })

  it('rolls the authored files back when the update does not apply (t11/F3)', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      valueOf(await callChannel(harness, 'add', {
        payload: {
          input: { name: 'demo', displayName: '原名', transport: 'stdio', command: 'node', args: ['v1.js'] },
        },
      }))
      const patchBefore = await readFile(join(serverDir('demo'), 'cordis.patch.yml'), 'utf8')
      const metadataBefore = await readFile(managerMetadataPath('demo'), 'utf8')

      // Fault injection: the manager reports a failed reload (the real one can
      // refuse for `not-bundle`, `stop-profile`, an incompatible version, …).
      harness.manager.setBundleEnabled = async () => ({
        changed: false,
        application: 'failed',
        stage: 'enable',
        target: 'x',
        error: { code: 'operation-error', diagnostic: 'injected-reload-failure' },
      })
      const error = errorOf(await callChannel(harness, 'update', {
        payload: {
          id: 'demo',
          input: { name: 'demo', displayName: '', transport: 'stdio', command: 'node', args: ['v2.js'] },
        },
      }))
      assert.equal(error.code, 'install-failed')
      assert.equal(error.details.stage, 'enable')
      assert.match(error.details.diagnostic, /injected-reload-failure/)

      assert.equal(
        await readFile(join(serverDir('demo'), 'cordis.patch.yml'), 'utf8'),
        patchBefore,
        'a refused update restores cordis.patch.yml',
      )
      assert.equal(
        await readFile(managerMetadataPath('demo'), 'utf8'),
        metadataBefore,
        'a refused update restores manager.json instead of half-applying it',
      )
      const listed = valueOf(await callChannel(harness, 'list'))
      assert.equal(listed.servers[0].label, '原名', 'the label shown to the user is unchanged')
      assert.deepEqual(listed.servers[0].config.args, ['v1.js'])
    })
  })

  it('decides "installed" from listBundles records, never from links on disk (t11/F4)', async () => {
    await withTempHome(async (home) => {
      const harness = createHarness()
      // A leftover server directory, a leftover profile node_modules entry that
      // looks like the linked package, and NO bundle record.
      await mkdir(serverDir('demo'), { recursive: true })
      await mkdir(join(home, 'profiles', 'desktop', 'node_modules', '@local', 'dsh-mcp-demo'), { recursive: true })
      assert.equal(await bundleIsInstalled(harness.manager, '@local/dsh-mcp-demo'), false,
        'a directory or link on disk is not an installation')
      assert.equal(harness.calls.some((call) => call.method === 'installBundle'), false,
        'the check itself must not install anything')

      // A record that exists but is not an installed dependency is not one either.
      harness.state.bundles.set('@local/dsh-mcp-demo', { name: '@local/dsh-mcp-demo', installed: false, enabled: true, dir: null })
      assert.equal(await bundleIsInstalled(harness.manager, '@local/dsh-mcp-demo'), false)

      // The bundle record is what makes it installed.
      harness.state.bundles.set('@local/dsh-mcp-demo', { name: '@local/dsh-mcp-demo', installed: true, enabled: true, dir: null })
      assert.equal(await bundleIsInstalled(harness.manager, '@local/dsh-mcp-demo'), true)

      // A manager without bundle records cannot answer: install (safe default).
      const bare = createHarness({ managerOverrides: { listBundles: undefined } })
      assert.equal(await bundleIsInstalled(bare.manager, '@local/dsh-mcp-demo'), false)
    })
  })

  it('source: the Host never inspects the profile filesystem for installed state (t11/F4)', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
    // Comments may name the trap; code may not probe it.
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '')
    assert.equal(/\b(?:readlink|lstat|symlink|realpath|opendir|existsSync|statSync)\b/.test(code), false,
      'no link/stat probing in the Host half')
    assert.equal(/node_modules/.test(code), false,
      'the Host half never looks into a profile node_modules tree')
  })

  it('drops the whole server directory on remove (§3a)', async () => {
    await withTempHome(async () => {
      const harness = createHarness()
      await callChannel(harness, 'add', {
        payload: { input: { name: 'demo', displayName: '演示', transport: 'stdio', command: 'node' } },
      })
      const dir = serverDir('demo')
      assert.equal(existsSync(join(dir, 'package.json')), true)
      assert.equal(existsSync(managerMetadataPath('demo')), true)

      const removed = valueOf(await callChannel(harness, 'remove', { payload: { id: 'demo' } }))
      assert.deepEqual(removed.servers, [])
      assert.equal(existsSync(dir), false, 'manager.json and the bundle go away with the directory')
    })
  })

  it('keeps a failed removal from touching the server directory', async () => {
    await withTempHome(async () => {
      const harness = createHarness({
        seeds: [{ row: managedRow('demo'), config: { serverName: 'demo', transport: 'stdio', command: 'node' } }],
        managerOverrides: {
          async removeBundle() {
            return { changed: false, application: 'failed', stage: 'remove', target: 'x', error: { code: 'not-removable' } }
          },
        },
      })
      await writeManagerMetadata('demo', '仍然存在')
      const error = errorOf(await callChannel(harness, 'remove', { payload: { id: 'demo' } }))
      assert.equal(error.code, 'install-failed')
      assert.equal(existsSync(managerMetadataPath('demo')), true, 'a refused removal leaves the files alone')
    })
  })

  it('keeps working when the manager cannot reload a bundle in place', async () => {
    await withTempHome(async () => {
      const warnings = []
      const harness = createHarness({ logger: { warn: (message) => warnings.push(message), error() {} } })
      await callChannel(harness, 'add', { payload: { input: { name: 'demo', transport: 'stdio', command: 'node', args: ['v1.js'] } } })
      delete harness.manager.setBundleEnabled
      const value = valueOf(await callChannel(harness, 'update', {
        payload: { id: 'demo', input: { name: 'demo', transport: 'stdio', command: 'node', args: ['v2.js'] } },
      }))
      // The frozen files are rewritten either way; without a reload API the
      // running row keeps its old projection until a restart, and that is said.
      const patch = JSON.parse(await readFile(join(serverDir('demo'), 'cordis.patch.yml'), 'utf8'))
      assert.deepEqual(patch[0].insert[0].config.args, ['v2.js'])
      assert.deepEqual(value.servers[0].config.args, ['v1.js'], 'the live projection waits for a restart')
      assert.equal(harness.calls.some((call) => call.method === 'setBundleEnabled'), false)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /applies on restart/)
    })
  })
})

/* ---------------------------------------------------------------- catalog */

describe('catalog endpoint — live registry browser (§6)', () => {
  /** A stub `fetch` that records calls and answers from a queue. */
  function stubFetch(handler) {
    const calls = []
    const impl = async (url, init) => {
      calls.push({ url: String(url), init })
      const reply = await handler(String(url), init)
      if (reply instanceof Error) throw reply
      return {
        ok: reply.status === undefined ? true : reply.status < 400,
        status: reply.status ?? 200,
        json: async () => reply.body,
      }
    }
    impl.calls = calls
    return impl
  }

  /** A registry page shaped exactly like the live endpoint's answer. */
  function registryBody(servers, metadata = {}) {
    return { servers, metadata }
  }

  /** A registry row with the official meta block the live API attaches. */
  function registryRow(server, isLatest = true) {
    return { server, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest } } }
  }

  /** Run one catalog call with injected fetch/clock/cache (no network, no shared state). */
  function callCatalog(payload, fetchImpl, extra = {}) {
    return catalogValue({}, payload, {
      fetchImpl,
      cache: extra.cache ?? new Map(),
      // t19 state is per-call by default: a failure marker must never leak from
      // one test into the next.
      fallbackAt: extra.fallbackAt ?? new Map(),
      refreshing: extra.refreshing ?? new Set(),
      now: extra.now ?? Date.now,
      seedDir: extra.seedDir,
    })
  }

  /** Wait for any background recovery fetch of this test to settle. */
  async function settleRefreshes(refreshing) {
    for (let tick = 0; tick < 20 && refreshing.size > 0; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  it('defaults to the official registry and returns the §6 value shape', async () => {
    const fetchImpl = stubFetch(async () => ({
      body: registryBody([
        registryRow({
          $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
          name: 'ai.smithery/demo',
          title: 'Demo server',
          description: 'A hosted demo.',
          version: '1.0.0',
          remotes: [{ type: 'streamable-http', url: 'https://demo.example/mcp' }],
          websiteUrl: 'https://demo.example/docs',
        }, true),
      ], { nextCursor: 'ai.smithery/demo:1.0.0', count: 1 }),
    }))
    const value = await callCatalog({}, fetchImpl)

    assert.deepEqual(Object.keys(value).sort(), [
      'degraded', 'entries', 'fetchedAt', 'hasMore', 'nextCursor', 'source', 'total',
    ])
    assert.equal(value.source, 'registry')
    assert.equal(value.degraded, false)
    assert.equal(value.hasMore, true)
    assert.equal(value.nextCursor, 'ai.smithery/demo:1.0.0', 'metadata.nextCursor is passed through')
    assert.equal(value.total, null, 'the registry reports a page count, not a total')
    assert.match(value.fetchedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)

    const requested = new URL(fetchImpl.calls[0].url)
    assert.equal(requested.origin + requested.pathname, CATALOG_REGISTRY_URL)
    assert.equal(requested.searchParams.get('limit'), String(CATALOG_DEFAULT_LIMIT))
    assert.equal(requested.searchParams.get('search'), null, 'browsing sends no search term')
    assert.equal(requested.searchParams.get('cursor'), null)
    assert.equal(fetchImpl.calls[0].init.headers.accept, 'application/json')
    assert.ok(fetchImpl.calls[0].init.signal !== undefined, 'every request carries a timeout signal')

    assert.deepEqual(value.entries, [{
      id: 'ai.smithery/demo',
      title: { zh: 'Demo server', en: 'Demo server' },
      description: { zh: 'A hosted demo.', en: 'A hosted demo.' },
      category: 'ai.smithery',
      transport: 'streamable-http',
      origin: 'registry',
      url: 'https://demo.example/mcp',
      docs: 'https://demo.example/docs',
      official: true,
    }])
  })

  it('forwards search, limit (clamped) and cursor to the registry', async () => {
    const fetchImpl = stubFetch(async () => ({ body: registryBody([], {}) }))
    await callCatalog({ query: '  github  ', limit: 500, cursor: 'abc' }, fetchImpl)
    const first = new URL(fetchImpl.calls[0].url)
    assert.equal(first.searchParams.get('search'), 'github', 'the query is trimmed and sent as search')
    assert.equal(first.searchParams.get('limit'), String(CATALOG_MAX_LIMIT), 'limit clamps at 50')
    assert.equal(first.searchParams.get('cursor'), 'abc')

    await callCatalog({ limit: 0 }, fetchImpl)
    assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get('limit'), '1', 'limit clamps at 1')
    await callCatalog({ limit: 7 }, fetchImpl)
    assert.equal(new URL(fetchImpl.calls[2].url).searchParams.get('limit'), '7')
    await callCatalog({}, fetchImpl)
    assert.equal(new URL(fetchImpl.calls[3].url).searchParams.get('limit'), String(CATALOG_DEFAULT_LIMIT))
  })

  it('maps remotes, npm and pypi packages, and skips entries with no endpoint', async () => {
    const fetchImpl = stubFetch(async () => ({
      body: registryBody([
        registryRow({ name: 'io.github.x/remote', description: 'hosted', remotes: [{ type: 'streamable-http', url: 'https://r.example/mcp' }] }),
        registryRow({
          name: 'io.github.x/npm',
          title: 'Npm server',
          packages: [{ registryType: 'npm', identifier: '@scope/pkg' }],
        }),
        registryRow({
          name: 'io.github.x/pypi',
          packages: [{ registryType: 'pypi', identifier: 'my-mcp' }],
        }),
        registryRow({ name: 'io.github.x/empty', description: 'nothing to run' }),
        registryRow({ name: 'io.github.x/badsse', remotes: [{ type: 'sse', url: 'https://s.example/sse' }] }),
        registryRow({ name: 'io.github.x/nouri', remotes: [{ type: 'streamable-http' }] }),
        'nonsense',
        registryRow({ description: 'no name' }),
      ], {}),
    }))
    const value = await callCatalog({}, fetchImpl)
    assert.deepEqual(value.entries.map((entry) => entry.id), ['io.github.x/remote', 'io.github.x/npm', 'io.github.x/pypi'])

    const [remote, npm, pypi] = value.entries
    assert.equal(remote.transport, 'streamable-http')
    assert.equal(remote.url, 'https://r.example/mcp')
    assert.equal('command' in remote, false, 'a remote never carries a stdio command')
    assert.equal(npm.transport, 'stdio')
    assert.equal(npm.command, 'npx')
    assert.deepEqual(npm.args, ['-y', '@scope/pkg'])
    assert.equal(npm.packageId, 'npm:@scope/pkg')
    assert.equal(npm.url, undefined)
    assert.equal(pypi.command, 'uvx')
    assert.deepEqual(pypi.args, ['my-mcp'])
    assert.equal(pypi.packageId, 'pypi:my-mcp')
    for (const entry of value.entries) {
      assert.equal(entry.origin, 'registry')
      assert.equal(entry.title.zh, entry.title.en, 'one source text serves both languages — no fake translation')
      assert.equal('envKeys' in entry, false, 'a live entry never invents a credential requirement')
    }
  })

  it('de-duplicates registry versions by name, preferring the latest', async () => {
    const fetchImpl = stubFetch(async () => ({
      body: registryBody([
        registryRow({ name: 'ac.x/mcp', description: 'older', remotes: [{ type: 'streamable-http', url: 'https://old.example/mcp' }] }, false),
        registryRow({ name: 'ac.x/mcp', description: 'newest', remotes: [{ type: 'streamable-http', url: 'https://new.example/mcp' }] }, true),
        registryRow({ name: 'ac.x/mcp', description: 'older again', remotes: [{ type: 'streamable-http', url: 'https://older.example/mcp' }] }, false),
      ], { count: 3 }),
    }))
    const value = await callCatalog({}, fetchImpl)
    assert.equal(value.entries.length, 1)
    assert.equal(value.entries[0].url, 'https://new.example/mcp')
    assert.equal(value.entries[0].official, true)
  })

  it('pages the npm source by `from` offset and reports popularity', async () => {
    const fetchImpl = stubFetch(async () => ({
      body: {
        total: 100,
        objects: [{
          package: {
            name: '@zereight/mcp-gitlab',
            description: 'GitLab MCP server',
            keywords: ['mcp', 'mcp-server', 'gitlab'],
            links: { npm: 'https://www.npmjs.com/package/@zereight/mcp-gitlab' },
          },
          score: { final: 42.734 },
          downloads: { monthly: 487993, weekly: 120000 },
        }],
      },
    }))
    const value = await callCatalog({ source: 'npm', query: 'gitlab', limit: 10, cursor: '20' }, fetchImpl)
    const requested = new URL(fetchImpl.calls[0].url)
    assert.equal(requested.origin + requested.pathname, CATALOG_NPM_URL)
    assert.equal(requested.searchParams.get('text'), `gitlab ${CATALOG_NPM_TERM}`)
    assert.equal(requested.searchParams.get('size'), '10')
    assert.equal(requested.searchParams.get('from'), '20')

    assert.equal(value.source, 'npm')
    assert.equal(value.total, 100)
    assert.equal(value.hasMore, true)
    assert.equal(value.nextCursor, '21', 'the offset advances by the page size')
    assert.equal(value.degraded, false)
    assert.deepEqual(value.entries, [{
      id: '@zereight/mcp-gitlab',
      title: { zh: '@zereight/mcp-gitlab', en: '@zereight/mcp-gitlab' },
      description: { zh: 'GitLab MCP server', en: 'GitLab MCP server' },
      category: 'gitlab',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@zereight/mcp-gitlab'],
      origin: 'npm',
      packageId: 'npm:@zereight/mcp-gitlab',
      downloadsMonthly: 487993,
      score: 42.734,
      docs: 'https://www.npmjs.com/package/@zereight/mcp-gitlab',
    }])

    // Browsing without a query still asks for the MCP term.
    await callCatalog({ source: 'npm' }, fetchImpl)
    assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get('text'), CATALOG_NPM_TERM)

    // The last page has no cursor.
    const last = await callCatalog({ source: 'npm', cursor: '99' }, fetchImpl)
    assert.equal(last.hasMore, false)
    assert.equal(last.nextCursor, null)
  })

  it('degrades to the offline seed when the live source fails, and never 5xx', async () => {
    await withTempHome(async (home) => {
      const base = join(home, 'plugin')
      await writeFixture(join(base, 'client', 'catalog.json'), [
        { id: 'seed-one', title: { zh: '种子', en: 'Seed' }, description: { zh: '离线', en: 'Offline' }, category: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'seed-one'] },
      ])
      for (const failure of [new Error('offline'), { status: 503, body: {} }]) {
        const fetchImpl = stubFetch(async () => failure)
        const value = await callCatalog({ source: 'registry', query: `q-${String(failure.status ?? 'throw')}` }, fetchImpl, { seedDir: base })
        assert.equal(value.degraded, true, 'a failed live source is marked degraded')
        assert.equal(value.hasMore, false)
        assert.equal(value.nextCursor, null)
        assert.equal(value.entries.length, 1)
        assert.equal(value.entries[0].origin, 'seed', 'seed entries are labelled as such')
        assert.equal(value.entries[0].id, 'seed-one')
      }
    })
  })

  it('answers the channel with HTTP 200 and a degraded page when the network is down', async () => {
    const harness = createHarness()
    // The endpoint reads `globalThis.fetch` at call time, so a stubbed offline
    // fetch exercises the real channel path without touching the network.
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND registry.modelcontextprotocol.io') }
    try {
      const response = await callChannel(harness, 'catalog', { payload: { query: 'offline-probe' } })
      assert.equal(response.status, 200, 'a network failure is never an HTTP error')
      const value = valueOf(response)
      assert.equal(value.degraded, true)
      assert.ok(Array.isArray(value.entries))
      assert.ok(value.entries.length > 0, 'the shipped seed still renders')
      assert.equal(value.entries.every((entry) => entry.origin === 'seed'), true)
    } finally {
      globalThis.fetch = original
    }
  })

  it('memoizes one live page for 60 s and reports a stale answer as degraded', async () => {
    const cache = new Map()
    const refreshing = new Set()
    let clock = 1_000_000
    let failNext = false
    const fetchImpl = stubFetch(async () => {
      if (failNext) throw new Error('upstream down')
      return { body: registryBody([registryRow({ name: 'ac.x/live', description: 'live', remotes: [{ type: 'streamable-http', url: 'https://l.example/mcp' }] })], {}) }
    })
    const now = () => clock
    const request = { query: 'cached' }

    const first = await callCatalog(request, fetchImpl, { cache, now })
    assert.equal(first.degraded, false)
    assert.equal(fetchImpl.calls.length, 1)

    // Inside the TTL the memo answers: no second request, still live.
    clock += CATALOG_CACHE_TTL_MS - 1
    const second = await callCatalog(request, fetchImpl, { cache, now })
    assert.equal(fetchImpl.calls.length, 1, 'a fresh cache hit never refetches')
    assert.equal(second.degraded, false)
    assert.equal(second.entries[0].id, 'ac.x/live')

    // Past the TTL it refetches.
    clock += 2
    await callCatalog(request, fetchImpl, { cache, now })
    assert.equal(fetchImpl.calls.length, 2, 'an expired cache entry refetches')

    // A failed refetch refills from the previous answer — as degraded, never live.
    failNext = true
    clock += CATALOG_CACHE_TTL_MS + 1
    const stale = await callCatalog(request, fetchImpl, { cache, now, refreshing })
    // The failed refetch also schedules one background recovery attempt (t19),
    // which the response does not await.
    assert.ok(fetchImpl.calls.length >= 3, 'the expired entry refetched and a recovery was scheduled')
    await settleRefreshes(refreshing)
    assert.equal(stale.degraded, true, 'a stale answer must never masquerade as live')
    assert.equal(stale.entries[0].id, 'ac.x/live')

    // A brand-new query has no cache to refill from: it goes to the seed.
    const fresh = await callCatalog({ query: 'brand-new' }, fetchImpl, { cache, now })
    assert.equal(fresh.degraded, true)
    assert.equal(fresh.entries.every((entry) => entry.origin === 'seed'), true)
  })

  it('answers a repeated failing query from its fallback without a second timeout (t19)', async () => {
    const refreshing = new Set()
    const fallbackAt = new Map()
    let clock = 5_000_000
    const fetchImpl = stubFetch(async () => { throw new Error('upstream is slow / offline') })
    const now = () => clock
    const request = { source: 'registry', query: 'notion', cursor: null, limit: 24 }
    const cache = new Map()

    const first = await callCatalog(request, fetchImpl, { cache, now, refreshing, fallbackAt })
    assert.equal(first.degraded, true, 'the first attempt degrades')
    assert.equal(first.entries.every((entry) => entry.origin === 'seed'), true, 'nothing was cached yet, so the seed is served')
    await settleRefreshes(refreshing)
    const afterFirst = fetchImpl.calls.length

    // The repeat must not pay for another upstream round trip.
    const second = await callCatalog(request, fetchImpl, { cache, now, refreshing, fallbackAt })
    assert.equal(fetchImpl.calls.length, afterFirst, 'a repeat answers from the fallback without touching the upstream')
    assert.equal(second.degraded, true)
    assert.equal(second.entries.length, first.entries.length)

    // The fallback is a marker, not a success: nothing was written as live.
    assert.equal(cache.has('registry|notion||24'), false, 'a degraded answer never becomes the success cache')

    // Past the grace window the upstream is tried again.
    clock += CATALOG_FALLBACK_TTL_MS + 1
    await callCatalog(request, fetchImpl, { cache, now, refreshing, fallbackAt })
    assert.ok(fetchImpl.calls.length > afterFirst, 'after the fallback window the upstream is retried')
    await settleRefreshes(refreshing)
  })

  it('prefers the query\'s own previous live page over the seed, and recovers (t19)', async () => {
    const refreshing = new Set()
    const fallbackAt = new Map()
    const cache = new Map()
    let clock = 9_000_000
    // Call 1 answers, call 2 times out, call 3 (the background retry) answers.
    let attempts = 0
    const fetchImpl = stubFetch(async () => {
      attempts += 1
      if (attempts === 2) throw new Error('upstream timed out')
      return { body: registryBody([registryRow({ name: 'ac.x/live', description: 'live', remotes: [{ type: 'streamable-http', url: 'https://l.example/mcp' }] })], {}) }
    })
    const now = () => clock
    const request = { source: 'registry', query: 'notion', cursor: null, limit: 24 }

    const live = await callCatalog(request, fetchImpl, { cache, now, refreshing, fallbackAt })
    assert.equal(live.degraded, false)
    assert.equal(live.entries[0].id, 'ac.x/live')

    // The upstream goes slow after the TTL: the user gets this query's own last
    // live page, never the unrelated seed.
    clock += CATALOG_CACHE_TTL_MS + 1
    const slow = await callCatalog(request, fetchImpl, { cache, now, refreshing, fallbackAt })
    assert.equal(slow.degraded, true)
    assert.equal(slow.entries[0].id, 'ac.x/live', 'the previous live result is preferred over the seed')
    assert.equal(slow.entries.every((entry) => entry.origin === 'seed'), false)

    // The background retry already put a real page back in the live cache, so the
    // next call is live again without waiting for the fallback window.
    await settleRefreshes(refreshing)
    const callsBefore = fetchImpl.calls.length
    const recovered = await callCatalog(request, fetchImpl, { cache, now, refreshing, fallbackAt })
    assert.equal(recovered.degraded, false, 'once the upstream answers again the page is live')
    assert.equal(recovered.entries[0].id, 'ac.x/live')
    assert.equal(fetchImpl.calls.length, callsBefore, 'the recovered page came from the cache, not another round trip')
    assert.equal(refreshing.size, 0)
  })

  it('picks up a recovered network in the background, not on the next timeout (t19)', async () => {
    const refreshing = new Set()
    const fallbackAt = new Map()
    const cache = new Map()
    let clock = 7_000_000
    // Offline for the first attempt, then reachable for the background retry.
    let attempts = 0
    const fetchImpl = stubFetch(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return { body: registryBody([registryRow({ name: 'ac.x/back', description: 'back', remotes: [{ type: 'streamable-http', url: 'https://b.example/mcp' }] })], {}) }
    })
    const now = () => clock
    const request = { source: 'registry', query: 'recovering', cursor: null, limit: 24 }

    const offline = await callCatalog(request, fetchImpl, { cache, now, refreshing, fallbackAt })
    assert.equal(offline.degraded, true)
    assert.equal(offline.entries.every((entry) => entry.origin === 'seed'), true, 'never succeeded, so the seed is served once')

    await settleRefreshes(refreshing)
    const callsBefore = fetchImpl.calls.length
    const next = await callCatalog(request, fetchImpl, { cache, now, refreshing, fallbackAt })
    assert.equal(next.degraded, false, 'the background refresh made the next call live again')
    assert.equal(next.entries[0].id, 'ac.x/back')
    assert.equal(fetchImpl.calls.length, callsBefore, 'no extra wait: the page came from the recovered cache')
  })

  it('merges an exact package the fuzzy search missed (t18/F1)', async () => {
    // The crafted shape: the search answers with something unrelated, while the
    // package really exists with no keywords, no "MCP" in its description, and a
    // single bin.
    const document = {
      name: 'frontend-code-skimmer',
      description: '不读全文，只看骨架',
      'dist-tags': { latest: '0.8.4' },
      versions: { '0.8.4': { name: 'frontend-code-skimmer', version: '0.8.4', bin: { 'frontend-code-skimmer': 'dist/index.js' } } },
    }
    const fetchImpl = stubFetch(async (url) => {
      if (url.startsWith(CATALOG_NPM_URL)) {
        return { body: { total: 12, objects: [{ package: { name: 'unrelated-package', description: 'nothing to do with it' }, score: { final: 1 }, downloads: { monthly: 5 } }] } }
      }
      assert.equal(url, `${CATALOG_NPM_PACKAGE_URL}frontend-code-skimmer`)
      return { body: document }
    })
    const value = await callCatalog({ source: 'npm', query: 'frontend-code-skimmer', limit: 5 }, fetchImpl)
    assert.deepEqual(value.entries.map((entry) => entry.id), ['unrelated-package', 'frontend-code-skimmer'],
      'the exact package is merged into the fuzzy page instead of being lost')
    const merged = value.entries[1]
    assert.equal(merged.origin, 'npm')
    assert.equal(merged.packageId, 'npm:frontend-code-skimmer')
    assert.deepEqual(merged.args, ['-y', 'frontend-code-skimmer'], 'the merged card carries the derived command')
    assert.equal(value.total, 12, 'the source total is untouched')
    assert.equal(value.nextCursor, '1', 'paging still belongs to the search')
    assert.equal(value.degraded, false)
  })

  it('trusts the search when it already returned that exact package (t18/F1)', async () => {
    for (const query of ['frontend-code-skimmer', 'Frontend-Code-Skimmer', 'frontend-code-skimmer@1.0.0']) {
      const fetchImpl = stubFetch(async (url) => {
        assert.equal(url.startsWith(CATALOG_NPM_URL), true, 'no second lookup for an exact hit')
        return { body: { total: 1, objects: [{ package: { name: 'frontend-code-skimmer', description: 'x', keywords: ['mcp-server'] }, score: { final: 1 }, downloads: { monthly: 1 } }] } }
      })
      const value = await callCatalog({ source: 'npm', query, limit: 5 }, fetchImpl)
      assert.equal(fetchImpl.calls.length, 1, `one request for ${query}`)
      assert.deepEqual(value.entries.map((entry) => entry.id), ['frontend-code-skimmer'])
    }
    assert.equal(samePackageName('@Scope/Name', '@scope/name@2.0.0'), true, 'case and version are normalized')
    assert.equal(samePackageName('@scope/name', 'other/name'), false)
    assert.equal(samePackageName('', 'x'), false)
    assert.equal(samePackageName(undefined, 'x'), false)
  })

  it('leaves the search page intact when the supplementary lookup fails (t18/F1)', async () => {
    const page = { total: 3, objects: [{ package: { name: 'unrelated', description: 'x' }, score: { final: 1 }, downloads: { monthly: 2 } }] }
    for (const failure of [new Error('offline'), { status: 503, body: {} }, { status: 404, body: {} }]) {
      const fetchImpl = stubFetch(async (url) => {
        if (url.startsWith(CATALOG_NPM_URL)) return { body: page }
        throw failure
      })
      const value = await callCatalog({ source: 'npm', query: 'frontend-code-skimmer', limit: 5 }, fetchImpl)
      assert.equal(value.degraded, false, 'a failed extra lookup never degrades a good search page')
      assert.deepEqual(value.entries.map((entry) => entry.id), ['unrelated'])
      assert.equal(value.total, 3)
    }
  })

  it('places an exact card where a same-id search hit would have been (t19 helper)', () => {
    const search = [{ id: 'a' }, { id: 'npm:@scope/name' }, { id: 'b' }]
    const card = { id: '@scope/name', packageId: 'npm:@scope/name' }
    assert.deepEqual(mergeNpmEntries(search, card).map((entry) => entry.id), ['a', '@scope/name', 'b'])
    assert.deepEqual(mergeNpmEntries([], card).map((entry) => entry.id), ['@scope/name'])
    assert.deepEqual(mergeNpmEntries([{ id: 'x' }], card).map((entry) => entry.id), ['x', '@scope/name'])
  })

  it('rejects a malformed catalog payload with invalid-request', async () => {
    const harness = createHarness()
    for (const payload of [
      { source: 'pypi' },
      { query: 42 },
      { cursor: 7 },
      { source: 'npm', cursor: 'not-a-number' },
    ]) {
      const error = errorOf(await callChannel(harness, 'catalog', { payload }))
      assert.equal(error.code, 'invalid-request', `expected invalid-request for ${JSON.stringify(payload)}`)
    }
  })

  it('reads a query as an exact package spec only when it is one (t17)', () => {
    assert.deepEqual(readPackageSpec('@jokeran/frontend-code-skimmer'), {
      name: '@jokeran/frontend-code-skimmer', version: null, scoped: true,
    })
    assert.deepEqual(readPackageSpec('frontend-code-skimmer'), {
      name: 'frontend-code-skimmer', version: null, scoped: false,
    })
    assert.deepEqual(readPackageSpec('@scope/name@1.2.3'), { name: '@scope/name', version: '1.2.3', scoped: true })
    assert.deepEqual(readPackageSpec('plain@2.0.0'), { name: 'plain', version: '2.0.0', scoped: false })
    for (const notASpec of ['', '   ', 'github server', 'ai.smithery/foo', '@scope/', '@scope/name@', 'a@', 'pkg@1 2', 42, null]) {
      assert.equal(readPackageSpec(notASpec), null, `must not be a package spec: ${JSON.stringify(notASpec)}`)
    }
  })

  it('derives an npx command from a package bin, whatever the bin is called (t17)', () => {
    // The t17 counter-example: one bin whose key differs from the package name.
    assert.deepEqual(deriveNpmCommand('@jokeran/frontend-code-skimmer', null, { 'frontend-code-skimmer': 'dist/index.js' }), {
      args: ['-y', '@jokeran/frontend-code-skimmer'], binName: 'frontend-code-skimmer',
    })
    // A string bin means the package name itself is the executable name.
    assert.deepEqual(deriveNpmCommand('some-server', null, 'dist/cli.js'), { args: ['-y', 'some-server'], binName: 'some-server' })
    // A pinned version rides along.
    assert.deepEqual(deriveNpmCommand('some-server', '1.2.3', { bin1: 'a.js' }), { args: ['-y', 'some-server@1.2.3'], binName: 'bin1' })
    // Several bins: the mcp/skimmer/server name wins and is named explicitly.
    assert.deepEqual(deriveNpmCommand('multi', null, { helper: 'a.js', 'multi-mcp-server': 'b.js' }), {
      args: ['-y', '-p', 'multi', 'multi-mcp-server'], binName: 'multi-mcp-server',
    })
    // No hint: the first bin in sorted order, still explicitly named.
    assert.deepEqual(deriveNpmCommand('multi', null, { zeta: 'z.js', alpha: 'a.js' }), {
      args: ['-y', '-p', 'multi', 'alpha'], binName: 'alpha',
    })
    // Nothing to run.
    assert.equal(deriveNpmCommand('lib-only', null, undefined), null)
    assert.equal(deriveNpmCommand('lib-only', null, {}), null)
    assert.equal(deriveNpmCommand('lib-only', null, { empty: '' }), null)
  })

  it('looks a scoped package up by name and returns one card, MCP metadata or not (t17)', async () => {
    const document = {
      name: '@jokeran/frontend-code-skimmer',
      description: 'Frontend-Code-Skimmer: 不读全文，只看骨架；不搜字符，搜语义关联。支持 Vue2/Vue3/React Hooks',
      // keywords absent and the description never says "MCP": search cannot find it.
      'dist-tags': { latest: '0.8.4' },
      versions: {
        '0.8.4': {
          name: '@jokeran/frontend-code-skimmer',
          version: '0.8.4',
          bin: { 'frontend-code-skimmer': 'dist/index.js' },
          dependencies: { '@modelcontextprotocol/sdk': '~1.29.0' },
        },
      },
      repository: { url: 'https://github.com/jokeran/frontend-code-skimmer' },
    }
    const fetchImpl = stubFetch(async (url) => {
      assert.equal(url, `${CATALOG_NPM_PACKAGE_URL}@jokeran%2ffrontend-code-skimmer`, 'the scoped name is looked up directly')
      return { body: document }
    })
    const value = await callCatalog({ source: 'npm', query: '@jokeran/frontend-code-skimmer' }, fetchImpl)

    assert.equal(fetchImpl.calls.length, 1, 'a scoped spec is answered by the direct lookup alone')
    assert.equal(value.degraded, false)
    assert.equal(value.total, 1)
    assert.equal(value.hasMore, false)
    assert.equal(value.nextCursor, null)
    assert.deepEqual(Object.keys(value).sort(), ['degraded', 'entries', 'fetchedAt', 'hasMore', 'nextCursor', 'source', 'total'])
    assert.deepEqual(value.entries, [{
      id: '@jokeran/frontend-code-skimmer',
      title: { zh: '@jokeran/frontend-code-skimmer', en: '@jokeran/frontend-code-skimmer' },
      description: { zh: document.description, en: document.description },
      category: 'mcp',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@jokeran/frontend-code-skimmer'],
      origin: 'npm',
      packageId: 'npm:@jokeran/frontend-code-skimmer',
      downloadsMonthly: null,
      score: null,
      docs: 'https://github.com/jokeran/frontend-code-skimmer',
    }])
  })

  it('answers an unknown package or a bin-less package with an empty page, never a half card (t17)', async () => {
    const missing = stubFetch(async () => ({ status: 404, body: {} }))
    const notFound = await callCatalog({ source: 'npm', query: '@scope/definitely-not-here' }, missing)
    assert.equal(notFound.degraded, false, 'a 404 is "no such package", not a degraded source')
    assert.equal(notFound.total, 0)
    assert.deepEqual(notFound.entries, [])

    const library = stubFetch(async () => ({
      body: { name: '@modelcontextprotocol/sdk', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: '@modelcontextprotocol/sdk' } } },
    }))
    const noBin = await callCatalog({ source: 'npm', query: '@modelcontextprotocol/sdk' }, library)
    assert.equal(noBin.total, 0, 'a package with no bin cannot become a stdio card')
    assert.deepEqual(noBin.entries, [])
  })

  it('treats a version pin and an unknown version correctly (t17)', async () => {
    const document = {
      name: 'pin-me',
      'dist-tags': { latest: '2.0.0' },
      versions: { '1.0.0': { name: 'pin-me', version: '1.0.0', bin: { 'pin-me': 'cli.js' } }, '2.0.0': { name: 'pin-me', version: '2.0.0', bin: { 'pin-me': 'cli.js' } } },
    }
    const fetchImpl = stubFetch(async (url) => (
      url.startsWith(CATALOG_NPM_URL) ? { body: { total: 0, objects: [] } } : { body: document }
    ))
    const pinned = await callCatalog({ source: 'npm', query: 'pin-me@1.0.0' }, fetchImpl)
    assert.deepEqual(pinned.entries[0].args, ['-y', 'pin-me@1.0.0'])
    const latest = await callCatalog({ source: 'npm', query: 'pin-me' }, fetchImpl)
    assert.deepEqual(latest.entries[0].args, ['-y', 'pin-me'], 'an unpinned spec runs the latest version')
    const unknown = await callCatalog({ source: 'npm', query: 'pin-me@9.9.9' }, fetchImpl)
    assert.deepEqual(unknown.entries, [])
    assert.equal(unknown.total, 0)
  })

  it('keeps an ordinary search page unchanged when the supplementary lookup adds nothing (t17/t18)', async () => {
    const searchHit = { package: { name: '@henkey/postgres-mcp-server', description: 'Postgres MCP', keywords: ['postgresql'] }, score: { final: 1 }, downloads: { monthly: 5975 } }
    const fetchImpl = stubFetch(async (url) => {
      if (url.startsWith(CATALOG_NPM_URL)) return { body: { total: 401786, objects: [searchHit] } }
      // `postgres` itself is a real package without a bin, so the supplementary
      // lookup yields no card (measured against the live registry).
      assert.equal(url, `${CATALOG_NPM_PACKAGE_URL}postgres`)
      return { body: { name: 'postgres', 'dist-tags': { latest: '3.4.9' }, versions: { '3.4.9': { name: 'postgres', version: '3.4.9' } } } }
    })
    const value = await callCatalog({ source: 'npm', query: 'postgres', limit: 5 }, fetchImpl)
    assert.equal(fetchImpl.calls.length, 2, 'the exact name is looked up once, after the search')
    assert.deepEqual(value.entries.map((entry) => entry.id), ['@henkey/postgres-mcp-server'], 'a bin-less package adds nothing')
    assert.equal(value.total, 401786, 'the source total is reported as-is')
    assert.equal(value.degraded, false)
    assert.equal(value.nextCursor, '1', 'paging still follows the search cursor')
  })

  it('never looks a package up while paging (t18)', async () => {
    const fetchImpl = stubFetch(async (url) => {
      assert.equal(url.startsWith(CATALOG_NPM_URL), true, 'a cursor page only queries the search endpoint')
      return { body: { total: 100, objects: [{ package: { name: 'some-package', description: 'x' }, score: { final: 1 }, downloads: { monthly: 1 } }] } }
    })
    const value = await callCatalog({ source: 'npm', query: 'frontend-code-skimmer', limit: 5, cursor: '5' }, fetchImpl)
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(value.entries.length, 1)
  })

  it('falls back to a direct lookup when a plain name finds nothing by search (t17)', async () => {
    const fetchImpl = stubFetch(async (url) => {
      if (url.startsWith(CATALOG_NPM_URL)) return { body: { total: 0, objects: [] } }
      assert.equal(url, `${CATALOG_NPM_PACKAGE_URL}frontend-code-skimmer`)
      return { body: { name: 'frontend-code-skimmer', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { bin: { 'frontend-code-skimmer': 'cli.js' } } } } }
    })
    const value = await callCatalog({ source: 'npm', query: 'frontend-code-skimmer' }, fetchImpl)
    assert.equal(fetchImpl.calls.length, 2)
    // The search source reported 0 hits; the card is a supplementary exact hit,
    // so the reported total stays the source's own number.
    assert.equal(value.total, 0)
    assert.deepEqual(value.entries[0].args, ['-y', 'frontend-code-skimmer'])
  })

  it('degrades when the direct lookup itself cannot reach the registry (t17)', async () => {
    const fetchImpl = stubFetch(async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') })
    const value = await callCatalog({ source: 'npm', query: '@jokeran/frontend-code-skimmer' }, fetchImpl)
    assert.equal(value.degraded, true, 'a network failure must not look like "no such package"')
    assert.equal(value.entries.every((entry) => entry.origin === 'seed'), true)
  })

  it('bounds every network call and keeps the §6 budgets', () => {
    assert.ok(CATALOG_TIMEOUT_MS <= 15000, 'a single request may not exceed 15 s')
    assert.ok(CATALOG_CACHE_TTL_MS <= 60000, 'the memo may not live longer than 60 s')
    assert.equal(CATALOG_DEFAULT_LIMIT, 24)
    assert.equal(CATALOG_MAX_LIMIT, 50)
    assert.equal(CATALOG_REGISTRY_URL, 'https://registry.modelcontextprotocol.io/v0/servers')
    assert.equal(CATALOG_NPM_URL, 'https://registry.npmjs.org/-/v1/search')
  })

  it('keeps the seed reader working for a shipped client/catalog.json', async () => {
    await withTempHome(async (home) => {
      const base = join(home, 'plugin')
      await writeFixture(join(base, 'client', 'catalog.json'), {
        entries: [
          {
            id: 'filesystem',
            title: { zh: '文件系统', en: 'Filesystem' },
            description: { en: 'File tools' },
            category: 'files',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            docs: 'https://example.test',
          },
          {
            id: 'remote',
            title: 'Remote',
            description: 'HTTP server',
            transport: 'streamable-http',
            url: 'https://mcp.example.test/mcp',
            headers: { 'X-Token': 't' },
            envKeys: [
              { key: 'API_KEY', label: { zh: '密钥', en: 'Key' }, required: true, placeholder: 'sk-…', secret: true },
              { label: { zh: '无 key' }, required: true },
            ],
          },
          { id: 'broken', transport: 'sse' },
          'nonsense',
        ],
      })
      const value = await readSeedCatalogValue({}, 'registry', base)
      assert.equal(value.degraded, true)
      assert.equal(value.source, 'registry')
      assert.equal(value.total, 2)
      assert.equal(value.hasMore, false)
      assert.deepEqual(value.entries, [
        {
          id: 'filesystem',
          title: { zh: '文件系统', en: 'Filesystem' },
          description: { zh: 'File tools', en: 'File tools' },
          category: 'files',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          docs: 'https://example.test',
          origin: 'seed',
        },
        {
          id: 'remote',
          title: { zh: 'Remote', en: 'Remote' },
          description: { zh: 'HTTP server', en: 'HTTP server' },
          category: 'other',
          transport: 'streamable-http',
          url: 'https://mcp.example.test/mcp',
          headers: { 'X-Token': 't' },
          envKeys: [
            { key: 'API_KEY', label: { zh: '密钥', en: 'Key' }, required: true, placeholder: 'sk-…', secret: true },
          ],
          origin: 'seed',
        },
      ])
    })
  })

  it('normalizes a bare array seed document too', () => {
    assert.deepEqual(normalizeCatalogDocument([]), [])
    assert.deepEqual(normalizeCatalogDocument({}), [])
    assert.deepEqual(normalizeCatalogDocument([{ id: 'a', transport: 'stdio' }]), [
      { id: 'a', title: { zh: '', en: '' }, description: { zh: '', en: '' }, category: 'other', transport: 'stdio' },
    ])
  })
})

/* ------------------------------------------------------------- endpoint path */

describe('endpoint matching', () => {
  it('accepts only the five exact endpoints under the channel', () => {
    for (const endpoint of ['list', 'add', 'update', 'remove', 'catalog']) {
      assert.equal(endpointFromPath(`${RPC_CHANNEL}/${endpoint}`), endpoint)
    }
    assert.equal(endpointFromPath(RPC_CHANNEL), undefined)
    assert.equal(endpointFromPath(`${RPC_CHANNEL}/`), undefined)
    assert.equal(endpointFromPath(`${RPC_CHANNEL}/list/`), undefined)
    assert.equal(endpointFromPath(`${RPC_CHANNEL}/list/extra`), undefined)
    assert.equal(endpointFromPath(`/other/list`), undefined)
  })
})

/* -------------------------------------------------------------------- utils */

/** Write a JSON fixture, creating its directory. */
async function writeFixture(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}
