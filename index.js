/**
 * @local/dsh-mcp-manager — Host half (CONTRACT.md §1–§7).
 *
 * Mounts one Connection unary-RPC channel (`/dsh-mcp-rpc`) on the Host Web
 * server, keeps `ctx.pluginManager.listPlugins()` as the authoritative *live*
 * row source, and drives the real Plugin Manager to author and load one
 * configuration-only bundle per managed MCP server
 * (`~/.dsh/mcp-servers/<serverId>/`, CONTRACT §2/§3).
 *
 * Why a hand-written route instead of `ctx.connection.rpc.handle()`:
 * CONTRACT §6 requires this channel to fence *every* request with
 * `ctx.connection.requestRejection(req)` and to cap the body at 1 MiB.
 * Connection's generic channel adapter is a package-owned route that owns
 * neither (it caps only `/api`, at `maxRequestBodyBytes`). The wire envelopes
 * below are byte-identical to Connection's unary RPC, so
 * `ctx.connection.rpc.call("/dsh-mcp-rpc", endpoint, payload)` works unchanged
 * and `rpcId` correlation is preserved.
 *
 * This module imports no MCP library and no `@deepseek-ai/*` package: neither
 * is resolvable from a profile-installed bundle's own directory (CONTRACT §1).
 * The only imports are Node built-ins.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ identity */

/** Loader plugin name and bundle row id (CONTRACT §2). */
export const name = 'dsh-mcp-manager'

/**
 * The transport needs Connection for the per-request fence (CONTRACT §6).
 * `webServer` is requested lazily in {@link apply} so the plugin stays loadable
 * in profiles that have no HTTP carrier.
 */
export const inject = ['connection']

/** Connection unary-RPC channel; matches `/^\/[A-Za-z0-9._~-]+$/` (CONTRACT §2). */
const RPC_CHANNEL = '/dsh-mcp-rpc'

/** Every endpoint this channel answers (CONTRACT §6). */
const ENDPOINTS = new Set(['list', 'add', 'update', 'remove', 'catalog'])

/** The one module a managed or external MCP row runs (CONTRACT §4). */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Generated row ids use this prefix; its presence is what makes a row managed. */
const ROW_ID_PREFIX = 'mcp-manager-'

/** `serverName` constraint, copied verbatim from the mcp-client (CONTRACT §2). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** `serverId` constraint, checked before the id is ever joined into a path. */
const SERVER_ID_PATTERN = /^[a-z0-9-]+$/

/** Manager-private metadata file beside the bundle (CONTRACT §3a). */
const MANAGER_METADATA_FILE = 'manager.json'

/** Schema version written into `manager.json` (CONTRACT §3a). */
const MANAGER_SCHEMA_VERSION = 1

/** Ceiling for the free-form display name (CONTRACT §3a). */
const MAX_LABEL_LENGTH = 120

/**
 * Readable copy for `application: "overridden"`: the change was saved, but a
 * higher-priority layer still wins, so it is not live. Exposed through the
 * success value's optional `notice` field instead of a silent success (t6/O4).
 */
const OVERRIDDEN_MESSAGE = '配置已保存，但由于存在更高优先级的配置，当前更改尚未生效。建议：检查 profile 下的 cordis.patch.yml 文件，或重启 Harness 后再试。'

/** Request-body ceiling for this channel (CONTRACT §6). */
const MAX_BODY_BYTES = 1024 * 1024

/** The reconnect block every generated row carries (CONTRACT §3). */
const RECONNECT = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
})

/** Directory (relative to the plugin root) the offline catalog seed lives in. */
const CATALOG_PATHS = Object.freeze([
  ['client', 'catalog.json'],
  ['catalog.json'],
])

/** Official MCP Registry search endpoint (CONTRACT §6). */
const CATALOG_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers'

/** npm registry search endpoint (CONTRACT §6). */
const CATALOG_NPM_URL = 'https://registry.npmjs.org/-/v1/search'

/** npm registry document root, for looking one package up by name (t17). */
const CATALOG_NPM_PACKAGE_URL = 'https://registry.npmjs.org/'

/** Bin names that identify the server entry point when a package ships several. */
const CATALOG_BIN_HINTS = /mcp|skimmer|server/i

/**
 * The term appended to every npm query. See {@link fetchNpmPage} for the
 * measurements behind it.
 */
const CATALOG_NPM_TERM = 'mcp-server'

/** npm keywords that describe the protocol itself, not a subject area. */
const CATALOG_GENERIC_KEYWORDS = Object.freeze(new Set([
  'mcp',
  'mcp-server',
  'mcp-servers',
  'modelcontextprotocol',
  'model-context-protocol',
  'server',
  'ai',
]))

/** Remote `type` this Host's mcp-client can run. */
const CATALOG_REMOTE_TYPE = 'streamable-http'

/** Registry `_meta` key holding the official publication record. */
const CATALOG_REGISTRY_META_KEY = 'io.modelcontextprotocol.registry/official'

/** Per-request network budget (CONTRACT §6: at most 15 s). */
const CATALOG_TIMEOUT_MS = 12000

/** Page size when the payload omits `limit`, and its ceiling (CONTRACT §6). */
const CATALOG_DEFAULT_LIMIT = 24
const CATALOG_MAX_LIMIT = 50

/** How long one live answer may be reused (CONTRACT §6: at most 60 s). */
const CATALOG_CACHE_TTL_MS = 60000

/**
 * How long a failed query answers from its own fallback before the next request
 * tries the upstream again (t19). Keeps a slow search term from costing the user
 * a full timeout on every repeat.
 */
const CATALOG_FALLBACK_TTL_MS = 60000

/** Bound on memoized pages, so browsing cannot grow the cache forever. */
const CATALOG_CACHE_ENTRIES = 200

/** Memoized live catalog pages, keyed by `(source, query, cursor, limit)`. */
const catalogCache = new Map()

/** When each key last failed, so a repeat answers from its fallback at once (t19). */
const catalogFallbacks = new Map()

/** Keys with a background recovery fetch in flight (t19). */
const catalogRefreshing = new Set()

/** Absolute directory of this module, used only to locate the shipped catalog. */
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))

/* --------------------------------------------------------------------- apply */

/**
 * Mount the channel once a Web server exists. The route is owned by the
 * `webServer` scope, so collapsing that scope unmounts it (CONTRACT §6).
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    const connection = webCtx.get('connection')
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: RPC_CHANNEL,
        handler: (req, res) => handleChannelRequest(webCtx, connection, req, res),
      }),
      `${name}: ${RPC_CHANNEL} Connection RPC channel`,
    )
  })
}

/* ---------------------------------------------------------------- diagnostics */

/** An application-level failure carried in the response envelope (CONTRACT §6). */
class RpcFailure extends Error {
  /**
   * @param code - one of the CONTRACT §6 error codes.
   * @param message - user-facing, Simplified Chinese where possible.
   * @param details - JSON-serializable record.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RpcFailure'
    this.code = code
    this.details = details
  }
}

/** The request body exceeded the channel ceiling. */
class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/** Human-readable text for any thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** Best-effort text for a Plugin Manager `ManagementError` (CONTRACT §6). */
function diagnosticOf(error) {
  if (!isPlainObject(error)) return undefined
  const parts = []
  if (typeof error.code === 'string' && error.code !== '') parts.push(error.code)
  if (typeof error.diagnostic === 'string' && error.diagnostic !== '') parts.push(error.diagnostic)
  if (Array.isArray(error.incompatible) && error.incompatible.length > 0) {
    parts.push(error.incompatible
      .map((plugin) => (isPlainObject(plugin) ? `${plugin.name ?? '?'}@${plugin.version ?? '?'}` : String(plugin)))
      .join(', '))
  }
  return parts.length > 0 ? clip(parts.join(' · ')) : undefined
}

/** Keep an oversized diagnostic (pnpm output) inside a sane RPC response. */
function clip(text, limit = 4000) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/* ------------------------------------------------------------ small predicates */

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a non-empty string. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** The first string among the candidates, or undefined. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** One string field of an authored config, or null (never invented, §4). */
function text(config, key) {
  const value = isPlainObject(config) ? config[key] : undefined
  return typeof value === 'string' ? value : null
}

/** A string list field of an authored config, or [] (never invented, §4). */
function stringList(config, key) {
  const value = isPlainObject(config) ? config[key] : undefined
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/** A string→string record field of an authored config, or {} (never invented, §4). */
function stringRecord(config, key) {
  const value = isPlainObject(config) ? config[key] : undefined
  return isPlainObject(value) ? stringRecordOf(value) : {}
}

/** Copy only string-valued own entries, skipping the prototype-polluting key. */
function stringRecordOf(value) {
  const out = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === '__proto__') continue
    if (typeof entryValue === 'string') out[entryKey] = entryValue
  }
  return out
}

/* ------------------------------------------------------------- dsh home paths */

/**
 * Resolve `$DSH_HOME` exactly like the Harness does: an explicit, non-blank
 * `DSH_HOME` overrides the default `~/.dsh`. Nothing here is hardcoded
 * (CONTRACT §2 requires runtime resolution).
 * @param env - environment mapping, injectable for tests.
 * @returns the absolute Harness home.
 */
function resolveDshHome(env = process.env) {
  const configured = env?.DSH_HOME
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : join(homedir(), '.dsh')
  return resolve(raw)
}

/** @returns the absolute managed-bundle root `~/.dsh/mcp-servers`. */
function managedRoot() {
  return join(resolveDshHome(), 'mcp-servers')
}

/**
 * Validate one `serverId` before it becomes a path segment (t6/O7). `serverId`
 * is normally produced by {@link slugifyServerId}, but it can also be recovered
 * from a hand-written plugin row id, so the id is never trusted.
 * @param serverId - candidate id.
 * @returns the same id when it is safe to join.
 * @throws {RpcFailure} `internal` for anything that could escape the root.
 */
function assertServerId(serverId) {
  const describe = () => JSON.stringify(serverId)
  if (typeof serverId !== 'string' || serverId === '') {
    throw new RpcFailure('internal', `serverId 不合法（${describe()}）：不能为空。`, {})
  }
  if (serverId === '.' || serverId === '..' || serverId.includes('/') || serverId.includes('\\')) {
    throw new RpcFailure('internal', `serverId 不合法（${describe()}）：不能包含路径分隔符。`, {})
  }
  if (!SERVER_ID_PATTERN.test(serverId)) {
    throw new RpcFailure('internal', `serverId 不合法（${describe()}）：只允许小写字母、数字与连字符。`, {})
  }
  return serverId
}

/** True when an id derived from a row can safely name a directory. */
function isSafeServerId(serverId) {
  try {
    assertServerId(serverId)
    return true
  } catch {
    return false
  }
}

/** @returns the absolute bundle directory of one managed server. */
function serverDir(serverId) {
  return join(managedRoot(), assertServerId(serverId))
}

/** @returns the generated package name of one managed server (CONTRACT §2). */
function generatedPackageName(serverId) {
  return `@local/dsh-mcp-${serverId}`
}

/* ------------------------------------------------------------- serverId rules */

/**
 * Lowercase a `serverName` and reduce it to `[a-z0-9-]` (CONTRACT §2). Only
 * uppercase letters and `_` can be dropped by that reduction; both become a
 * separator so `my_server` reads as `my-server`.
 * @param serverName - validated `serverName`.
 * @returns the candidate `serverId` base.
 */
function slugifyServerId(serverName) {
  const slug = String(serverName)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'server' : slug
}

/**
 * Allocate a `serverId` that no live managed row uses, adding `-2`, `-3`, …
 * (CONTRACT §2). `serverId` is immutable for a server's lifetime, so a removed
 * server's directory is reusable by a later server with the same name.
 * @param serverName - validated `serverName`.
 * @param taken - serverIds already in use.
 * @returns the allocated `serverId`.
 */
function allocateServerId(serverName, taken = new Set()) {
  const base = slugifyServerId(serverName)
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 100000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new RpcFailure('internal', `无法为 "${serverName}" 分配唯一的 serverId。`, { name: serverName })
}

/* --------------------------------------------------------------- input parsing */

/**
 * Normalize and validate a `ServerInput` (CONTRACT §6).
 *
 * `displayName` is the user-facing title (§3a). It is free-form UTF-8 — a
 * Chinese name is expected — capped at {@link MAX_LABEL_LENGTH} characters, and
 * it is stored in `manager.json`, never in the generated patch.
 *
 * The property is copied **only when the caller actually sent it**, so the two
 * §3a paths stay distinguishable (t8/F1): an omitted field leaves the property
 * absent (`update` then preserves the stored label), while an explicit `''`
 * keeps an empty string (`update` then clears the label).
 *
 * @param raw - untrusted `payload.input`.
 * @returns the normalized input.
 * @throws {RpcFailure} `invalid-request` for anything malformed.
 */
function normalizeServerInput(raw) {
  if (!isPlainObject(raw)) throw invalid('input 必须是一个对象。')
  const { name: serverName } = raw
  if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
    throw invalid('name（serverName）必须匹配 /^[A-Za-z0-9_-]{1,32}$/。')
  }
  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw invalid('transport 只能是 "stdio" 或 "streamable-http"。')
  }
  const input = { name: serverName, transport }
  if (raw.displayName !== undefined && raw.displayName !== null) {
    if (typeof raw.displayName !== 'string') throw invalid('displayName 必须是字符串。')
    const displayName = raw.displayName.trim()
    if (displayName.length > MAX_LABEL_LENGTH) {
      throw invalid(`displayName 最多 ${MAX_LABEL_LENGTH} 个字符。`)
    }
    input.displayName = displayName
  }
  if (transport === 'stdio') {
    if (!nonEmptyString(raw.command)) throw invalid('stdio 服务器必须提供非空的 command。')
    input.command = raw.command
    input.args = readStringList(raw.args, 'args')
    input.env = readStringRecord(raw.env, 'env')
    if (raw.cwd !== undefined && raw.cwd !== null) {
      if (typeof raw.cwd !== 'string') throw invalid('cwd 必须是字符串。')
      input.cwd = raw.cwd
    }
  } else {
    if (!nonEmptyString(raw.url)) throw invalid('streamable-http 服务器必须提供非空的 url。')
    input.url = raw.url
    input.headers = readStringRecord(raw.headers, 'headers')
  }
  return input
}

/**
 * True when a normalized `ServerInput` actually carries a `displayName`
 * property (t8/F1). This is the one predicate that separates "the caller
 * omitted the field" from "the caller sent `''`": both are falsy-ish, but only
 * one of them may clear a stored label (CONTRACT §3a).
 * @param input - a normalized `ServerInput`.
 * @returns whether the caller supplied a display name.
 */
function carriesDisplayName(input) {
  return isPlainObject(input) && Object.hasOwn(input, 'displayName') && typeof input.displayName === 'string'
}

/** A required-or-absent string list field. */
function readStringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalid(`${field} 必须是字符串数组。`)
  }
  return [...value]
}

/** A required-or-absent string→string record field. */
function readStringRecord(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) throw invalid(`${field} 必须是字符串到字符串的对象。`)
  for (const entryValue of Object.values(value)) {
    if (typeof entryValue !== 'string') throw invalid(`${field} 的值必须是字符串。`)
  }
  return stringRecordOf(value)
}

/* ------------------------------------------------------- generated bundle files */

/**
 * The §3 manifest, key for key.
 * @param serverId - allocated server id.
 * @returns the manifest object.
 */
function generatedManifest(serverId) {
  return {
    name: generatedPackageName(serverId),
    version: '1.0.0',
    private: true,
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
}

/**
 * The §3 patch document, key for key: rows wrapped in `insert:` (CONTRACT §1),
 * transport-specific fields only, empty `args`/`env`/`cwd`/`headers` omitted.
 * @param serverId - allocated server id.
 * @param input - normalized `ServerInput`.
 * @returns the patch document (a plain array, emitted as JSON-as-YAML).
 */
function generatedPatch(serverId, input) {
  const config = {
    serverName: input.name,
    transport: input.transport,
  }
  if (input.transport === 'stdio') {
    config.command = input.command
    if (input.args.length > 0) config.args = [...input.args]
    if (Object.keys(input.env).length > 0) config.env = { ...input.env }
    if (typeof input.cwd === 'string' && input.cwd !== '') config.cwd = input.cwd
  } else {
    config.url = input.url
    if (Object.keys(input.headers).length > 0) config.headers = { ...input.headers }
  }
  config.failOnStartupError = true
  config.reconnect = { ...RECONNECT }
  return [{
    insert: [{
      id: `${ROW_ID_PREFIX}${serverId}`,
      name: MCP_CLIENT_MODULE,
      config,
    }],
  }]
}

/**
 * Write §3's two files. JSON is a valid YAML subset, so the patch is emitted as
 * pretty-printed JSON and no YAML dependency is added (CONTRACT §3). The patch
 * is written first so a manifest on disk always has its patch beside it.
 * @param serverId - allocated server id.
 * @param input - normalized `ServerInput`.
 * @returns the absolute bundle directory.
 */
async function writeGeneratedBundle(serverId, input) {
  const dir = serverDir(serverId)
  const patch = `${JSON.stringify(generatedPatch(serverId, input), null, 2)}\n`
  const manifest = `${JSON.stringify(generatedManifest(serverId), null, 2)}\n`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'cordis.patch.yml'), patch, { mode: 0o600 })
  await writeFile(join(dir, 'package.json'), manifest, { mode: 0o600 })
  return dir
}

/* ------------------------------------------------------------- managed/external */

/**
 * The `serverId` of a managed row, or null for an external one (CONTRACT §4).
 * Loader entry ids are tree-qualified (`include:<rowId>`), so the final segment
 * is what carries the authored row id; `patchId` is already the raw row id.
 *
 * A row id whose remainder is not a legal `serverId` (empty, `..`, or a path
 * separator) is treated as external rather than managed: it was never authored
 * by this manager, and classifying it as managed would make it writable
 * (t6/O7).
 * @param row - a `listPlugins()` row.
 * @returns the serverId, or null.
 */
function managedServerId(row) {
  for (const value of [row?.patchId, row?.entryId]) {
    if (typeof value !== 'string') continue
    const segment = value.slice(value.lastIndexOf(':') + 1)
    if (!segment.startsWith(ROW_ID_PREFIX)) continue
    const serverId = segment.slice(ROW_ID_PREFIX.length)
    if (isSafeServerId(serverId)) return serverId
  }
  return null
}

/** True for any row that runs the MCP client module. */
function isMcpClientRow(row) {
  return isPlainObject(row) && row.moduleName === MCP_CLIENT_MODULE
}

/* ------------------------------------------------------- config recovery (§4) */

/**
 * The Loader's own projection of a row's config, matched by entry id.
 * @param ctx - plugin context.
 * @param row - a `listPlugins()` row.
 * @returns the loader entry, or undefined when there is no loader.
 */
function loaderEntryFor(ctx, row) {
  const loader = ctx.get('loader')
  if (loader === undefined || typeof loader.entries !== 'function') return undefined
  try {
    for (const entry of loader.entries()) {
      if (entry !== null && typeof entry === 'object' && entry.id === row.entryId) return entry
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Recover an authored config from a managed bundle's own patch file (CONTRACT
 * §4). The file is JSON-as-YAML, so `JSON.parse` is exact; anything unreadable
 * yields null rather than an invented value.
 * @param serverId - managed server id.
 * @returns the authored config, or null.
 */
async function readAuthoredConfigFromDisk(serverId) {
  let document
  try {
    document = JSON.parse(await readFile(join(serverDir(serverId), 'cordis.patch.yml'), 'utf8'))
  } catch {
    return null
  }
  const rows = []
  collectInsertedRows(document, rows)
  const row = rows.find((candidate) => isPlainObject(candidate?.config))
  return row?.config ?? null
}

/** Collect every `insert:` row of a patch document (array of `{ insert: [...] }`). */
function collectInsertedRows(document, out) {
  const documents = Array.isArray(document) ? document : [document]
  for (const layer of documents) {
    if (!isPlainObject(layer)) continue
    const inserted = Array.isArray(layer.insert) ? layer.insert : []
    for (const row of inserted) if (isPlainObject(row)) out.push(row)
  }
  return out
}

/* -------------------------------------------------- manager metadata (§3a) */

/** @returns the absolute path of one server's manager-private metadata file. */
function managerMetadataPath(serverId) {
  return join(serverDir(serverId), MANAGER_METADATA_FILE)
}

/**
 * Read one `manager.json`, degrading to null for anything unusable. A missing,
 * unreadable, malformed or version-less file is never an error (CONTRACT §3a).
 * @param serverId - managed server id.
 * @returns the parsed record, or null.
 */
async function readManagerMetadata(serverId) {
  if (!isSafeServerId(serverId)) return null
  let parsed
  try {
    parsed = JSON.parse(await readFile(managerMetadataPath(serverId), 'utf8'))
  } catch {
    return null
  }
  return isPlainObject(parsed) ? parsed : null
}

/** A label is usable only when it is a non-empty string (§3a). */
function clipLabel(label) {
  return label.length > MAX_LABEL_LENGTH ? label.slice(0, MAX_LABEL_LENGTH) : label
}

/**
 * The display name stored for one server, or null when there is none to show.
 * @param serverId - managed server id.
 * @returns the usable label, or null (the caller falls back to `serverName`).
 */
async function readManagerLabel(serverId) {
  const record = await readManagerMetadata(serverId)
  const raw = typeof record?.label === 'string' ? record.label.trim() : ''
  return raw === '' ? null : clipLabel(raw)
}

/**
 * Write/refresh one `manager.json` (CONTRACT §3a).
 *
 * `displayName` is deliberately **three-state**, so "the caller omitted the
 * field" and "the caller explicitly sent an empty string" never collapse into
 * one path (t8/F1):
 * - `undefined`/`null` → keep the stored label unchanged;
 * - `''`               → clear the label (the view falls back to `serverName`);
 * - any other string    → replace it.
 *
 * `createdAt` is generated on the first write and preserved afterwards.
 * @param serverId - managed server id.
 * @param displayName - the requested display name, or undefined to preserve.
 * @returns the record written.
 */
async function writeManagerMetadata(serverId, displayName) {
  const previous = await readManagerMetadata(serverId)
  const createdAt = typeof previous?.createdAt === 'string' && previous.createdAt !== ''
    ? previous.createdAt
    : new Date().toISOString()
  const storedLabel = typeof previous?.label === 'string' ? previous.label.trim() : ''
  const label = displayName === undefined || displayName === null
    ? storedLabel
    : String(displayName).trim()
  const record = { schemaVersion: MANAGER_SCHEMA_VERSION }
  if (label !== '') record.label = clipLabel(label)
  record.createdAt = createdAt
  await mkdir(serverDir(serverId), { recursive: true, mode: 0o700 })
  await writeFile(managerMetadataPath(serverId), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return record
}

/**
 * Drop one server's whole directory (CONTRACT §3a: `remove` needs no separate
 * metadata handling). A failure to clean up is logged, never fatal: the plugin
 * row the user asked to remove is already gone.
 * @param ctx - plugin context, for the warning.
 * @param serverId - managed server id.
 */
async function removeServerDirectory(ctx, serverId) {
  let dir
  try {
    dir = serverDir(serverId)
  } catch {
    return
  }
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    ctx?.logger?.warn?.(`${name}: could not remove ${dir}: ${messageOf(error)}`)
  }
}

/**
 * The authored config of one row: the row's own projected config first, then
 * the Loader's projection, then the managed bundle's patch file (CONTRACT §4).
 * @param ctx - plugin context.
 * @param row - a `listPlugins()` row.
 * @param serverId - managed server id, or null for an external row.
 * @returns the authored config, or null.
 */
async function resolveAuthoredConfig(ctx, row, serverId) {
  if (isPlainObject(row?.config)) return row.config
  if (isPlainObject(row?.options?.config)) return row.options.config
  const entry = loaderEntryFor(ctx, row)
  if (isPlainObject(entry?.options?.config)) return entry.options.config
  if (serverId !== null) return await readAuthoredConfigFromDisk(serverId)
  return null
}

/* --------------------------------------------------------------- view (§5) */

/**
 * Derive `status` from `enabled` and `phase` — never stored (CONTRACT §5).
 * @param enabled - row enablement.
 * @param phase - row fiber phase.
 * @returns the derived status.
 */
function deriveStatus(enabled, phase) {
  if (enabled === false) return 'disabled'
  if (phase === 'active') return 'connected'
  if (phase === 'failed') return 'error'
  return 'loading'
}

/** The loader's failure text for a failed row, or null (CONTRACT §5). */
function failureText(ctx, row) {
  const entry = loaderEntryFor(ctx, row)
  const candidates = [
    row?.error,
    row?.meta?.error,
    entry?.error,
    entry?._error,
    entry?.fiber?._error,
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const value = messageOf(candidate)
    if (typeof value === 'string' && value !== '') return clip(value)
  }
  return null
}

/**
 * Build the one shape the Client sees (CONTRACT §5). Values the row never
 * authored stay null; nothing is invented.
 * @param ctx - plugin context.
 * @param entry - `{ row, serverId, managed, config }` from {@link readServerEntries}.
 * @returns an `McpServerView`.
 */
function buildServerView(ctx, entry) {
  const { row, serverId, managed, config } = entry
  const enabled = row.enabled !== false
  const phase = typeof row.fiberPhase === 'string' ? row.fiberPhase : null
  const serverName = text(config, 'serverName')
  const rowReason = typeof row.readOnlyReason === 'string' ? row.readOnlyReason : undefined
  // §3a: the user-facing title lives in manager.json; without a usable label the
  // view falls back to serverName (never to an invented title).
  const displayName = typeof entry.managerLabel === 'string' && entry.managerLabel !== '' ? entry.managerLabel : null
  return {
    id: managed ? serverId : '',
    name: serverName,
    label: displayName ?? serverName,
    // §5 allows exactly two transports: an unknown or unrecoverable transport is
    // reported as stdio (the mcp-client's first schema branch) so the Client
    // never has to guess (t6/O8).
    transport: config?.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    enabled,
    phase,
    managed,
    readOnlyReason: managed ? (rowReason ?? null) : (rowReason ?? 'external'),
    status: deriveStatus(enabled, phase),
    statusDetail: phase === 'failed' ? failureText(ctx, row) : null,
    bundle: managed ? generatedPackageName(serverId) : null,
    config: {
      command: text(config, 'command'),
      args: stringList(config, 'args'),
      env: stringRecord(config, 'env'),
      cwd: text(config, 'cwd'),
      url: text(config, 'url'),
      headers: stringRecord(config, 'headers'),
      failOnStartupError: isPlainObject(config) && config.failOnStartupError === true,
    },
  }
}

/* ------------------------------------------------------- Plugin Manager access */

/**
 * The Plugin Manager, or a `not-manager` failure (CONTRACT §6).
 * @param ctx - plugin context.
 * @returns the Plugin Manager service.
 * @throws {RpcFailure} `not-manager`.
 */
function requireManager(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || manager === null || typeof manager.listPlugins !== 'function') {
    throw new RpcFailure('not-manager', '当前 profile 没有提供 Plugin Manager，无法管理 MCP 服务器。', {})
  }
  return manager
}

/**
 * Read every MCP row with its resolved serverId, authored config and stored
 * display name.
 * @param ctx - plugin context.
 * @param manager - the Plugin Manager.
 * @returns `{ row, serverId, managed, config, managerLabel }` entries.
 */
async function readServerEntries(ctx, manager) {
  const rows = await manager.listPlugins()
  const entries = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isMcpClientRow(row)) continue
    const serverId = managedServerId(row)
    entries.push({
      row,
      serverId,
      managed: serverId !== null,
      config: await resolveAuthoredConfig(ctx, row, serverId),
      // §3a: degrade to null on a missing/corrupt metadata file — never fail.
      managerLabel: serverId === null ? null : await readManagerLabel(serverId),
    })
  }
  return entries
}

/** Every view, managed first, each group ordered by its stable identity. */
async function readServerViews(ctx, manager) {
  const entries = await readServerEntries(ctx, manager)
  return entries
    .map((entry) => buildServerView(ctx, entry))
    .sort((left, right) => {
      if (left.managed !== right.managed) return left.managed ? -1 : 1
      const leftKey = left.id !== '' ? left.id : (left.name ?? '')
      const rightKey = right.id !== '' ? right.id : (right.name ?? '')
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
}

/**
 * Run one Plugin Manager operation and fold its `ChangeResult` into either a
 * success or an `install-failed` failure (CONTRACT §6). Failures are never
 * swallowed (§3).
 * @param stage - `install` | `enable` | `remove`.
 * @param run - the operation.
 * @returns the `ChangeResult`.
 * @throws {RpcFailure} `install-failed`.
 */
async function runManager(stage, run) {
  let result
  try {
    result = await run()
  } catch (error) {
    throw installFailed(stage, messageOf(error))
  }
  if (isPlainObject(result)) {
    const diagnostic = diagnosticOf(result.error)
    if (result.application === 'failed') {
      throw installFailed(stage, diagnostic ?? 'Plugin Manager 报告操作失败。')
    }
    if (result.application === 'cancelled') {
      throw installFailed(stage, diagnostic ?? '操作被取消。')
    }
    if (isPlainObject(result.packageResult) && result.packageResult.exitCode !== 0) {
      throw installFailed(stage, diagnostic ?? clip(String(result.packageResult.output ?? 'package manager failed')))
    }
  }
  return result
}

/**
 * `application: "overridden"` means the change was saved but a higher-priority
 * layer still wins: it must not be reported as a plain success (t6/O4).
 * @param result - a Plugin Manager `ChangeResult`.
 * @returns the notice to carry in the success value, or undefined.
 */
function overriddenNotice(result) {
  if (!isPlainObject(result) || result.application !== 'overridden') return undefined
  return { code: 'overridden', message: OVERRIDDEN_MESSAGE }
}

/**
 * Attach an optional notice to a §6 success value. The shape stays
 * `{ servers, … }`; `notice` is additive and only present when something needs
 * the caller's attention.
 * @param value - the endpoint's success value.
 * @param notice - notice from {@link overriddenNotice}, or undefined.
 * @returns the value, with `notice` when there is one.
 */
function withNotice(value, notice) {
  return notice === undefined ? value : { ...value, notice }
}

/**
 * Whether the profile already records this bundle (t11/F1, t11/F4).
 *
 * The Plugin Manager's own **bundle records** are the source of truth. Never the
 * presence of a package directory or symlink under the profile's
 * `node_modules`: `removeBundle` can leave a dangling link behind, and a bundle
 * whose row files are missing is still "not installed" as far as a fresh
 * `installBundle` is concerned.
 *
 * This is what keeps `add`/`update` off the real manager's `ambiguous-install`
 * path: re-installing an already-installed dependency makes pnpm's dependency
 * diff empty, which the manager refuses.
 *
 * @param manager - the Plugin Manager.
 * @param packageName - generated package name.
 * @returns whether the bundle is already a record in this profile.
 */
async function bundleIsInstalled(manager, packageName) {
  if (typeof manager.listBundles !== 'function') return false
  try {
    const bundles = await manager.listBundles()
    return Array.isArray(bundles) && bundles.some((bundle) => (
      isPlainObject(bundle) && bundle.name === packageName && bundle.installed === true
    ))
  } catch {
    // An unreadable bundle list must not block the operation; the install path
    // below still reports its own failure.
    return false
  }
}

/**
 * Apply a freshly authored (or re-authored) bundle through the Plugin Manager
 * (t11/F1): an already-recorded bundle is **reloaded**, only a genuinely new one
 * is installed.
 * @param ctx - plugin context, for diagnostics.
 * @param manager - the Plugin Manager.
 * @param packageName - generated package name.
 * @param dir - the generated bundle directory.
 * @returns the Plugin Manager `ChangeResult`.
 */
async function applyBundle(ctx, manager, packageName, dir) {
  if (await bundleIsInstalled(manager, packageName)) {
    // Files were rewritten in place: re-selecting the bundle makes the manager
    // reconcile exactly this bundle's rows without touching pnpm.
    return await reloadBundle(ctx, manager, packageName)
  }
  return await runManager('install', () => manager.installBundle(dir, { enabled: true }))
}

/* ------------------------------------------------------------ file snapshots */

/** Snapshot one generated file so a failed write can be rolled back (t11/F3). */
async function snapshotFile(file) {
  try {
    return { exists: true, text: await readFile(file, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    throw error
  }
}

/** Restore one snapshot; best effort, never masks the original failure. */
async function restoreFile(file, snapshot) {
  try {
    if (snapshot.exists) await writeFile(file, snapshot.text, { mode: 0o600 })
    else await rm(file, { force: true })
  } catch (error) {
    // The original error is what the caller must see.
    return error
  }
  return undefined
}

/**
 * Undo a partially applied update: the authored files go back to exactly what
 * they were before the write, so a refused install/reload never leaves
 * "changed on disk but not live" state behind (t11/F3).
 * @param files - `[file, snapshot]` pairs, restored in order.
 * @param cause - the failure that triggered the rollback.
 * @returns never; always throws `cause`.
 */
async function rollbackFiles(files, cause) {
  const failures = []
  for (const [file, snapshot] of files) {
    const failure = await restoreFile(file, snapshot)
    if (failure !== undefined) failures.push(`${file}: ${messageOf(failure)}`)
  }
  if (failures.length > 0) {
    // Report the rollback problem alongside the original failure instead of
    // hiding either one.
    throw new RpcFailure(cause.code, `${cause.message}（回滚未完全成功：${failures.join('; ')}）`, cause.details)
  }
  throw cause
}

/* ---------------------------------------------------------------- endpoints */

/**
 * `list` → `{ servers, managedRoot }` (CONTRACT §6).
 * @param ctx - plugin context.
 * @returns the success result.
 */
async function listValue(ctx) {
  const manager = requireManager(ctx)
  return { servers: await readServerViews(ctx, manager), managedRoot: managedRoot() }
}

/**
 * `add` → `{ servers, created }` (CONTRACT §6): validate, allocate a serverId,
 * write §3's files plus §3a's metadata, then load them through the real Plugin
 * Manager.
 * @param ctx - plugin context.
 * @param payload - `{ input: ServerInput }`.
 * @returns the success result.
 */
async function addValue(ctx, payload) {
  const manager = requireManager(ctx)
  const input = normalizeServerInput(isPlainObject(payload) ? payload.input : undefined)
  const entries = await readServerEntries(ctx, manager)
  const duplicate = entries.find((entry) => text(entry.config, 'serverName') === input.name)
  if (duplicate !== undefined) throw nameConflict(input.name)
  const taken = new Set(entries.filter((entry) => entry.managed).map((entry) => entry.serverId))
  const serverId = allocateServerId(input.name, taken)
  const dir = await writeGeneratedBundle(serverId, input)
  // §3a: the display name is manager-private metadata, written before the row is
  // loaded so the very first `list` after `add` already reports it. A new server
  // has nothing to preserve, so an omitted field means "no label".
  await writeManagerMetadata(serverId, carriesDisplayName(input) ? input.displayName : '')
  // t11/F1: `applyBundle` installs a new bundle and reloads one that this
  // profile already records, so a leftover record can never become a permanent
  // `ambiguous-install` failure.
  const result = await applyBundle(ctx, manager, generatedPackageName(serverId), dir)
  return withNotice(
    { servers: await readServerViews(ctx, manager), created: serverId },
    overriddenNotice(result),
  )
}

/**
 * `update` → `{ servers, disabled }` (CONTRACT §6). Either the payload carries a
 * full `input` (config rewrite + §3a metadata refresh) or a `toggle`
 * (enablement only). Enablement is persisted through `setPluginEnabled`, as the
 * contract requires.
 * @param ctx - plugin context.
 * @param payload - `{ id, input }` or `{ id, toggle }`.
 * @returns the success result.
 */
async function updateValue(ctx, payload) {
  const manager = requireManager(ctx)
  if (!isPlainObject(payload)) throw invalid('update 需要一个对象 payload。')
  const id = requireId(payload.id)
  const hasInput = payload.input !== undefined && payload.input !== null
  const hasToggle = payload.toggle !== undefined && payload.toggle !== null
  if (hasInput === hasToggle) throw invalid('update 必须且只能提供 input 或 toggle 之一。')
  if (hasToggle && payload.toggle !== 'enable' && payload.toggle !== 'disable') {
    throw invalid('toggle 只能是 "enable" 或 "disable"。')
  }

  const entries = await readServerEntries(ctx, manager)
  const entry = findTargetEntry(entries, id)
  assertWritable(entry, id)

  let notice
  if (hasToggle) {
    const result = await runManager('enable', () => manager.setPluginEnabled(entry.row.entryId, payload.toggle === 'enable'))
    notice = overriddenNotice(result)
  } else {
    const input = normalizeServerInput(payload.input)
    const currentName = text(entry.config, 'serverName')
    // §2: `serverId` is immutable for a server's lifetime and renaming is
    // remove + add. An unreadable current name cannot be checked against that
    // rule, so the in-place update is refused instead of inventing one.
    if (currentName === null) {
      throw invalid(`读不到服务器 "${id}" 当前的 serverName，已拒绝就地更新；请先删除该服务器，再以新名称新增。`)
    }
    if (currentName !== input.name) {
      throw invalid(`不支持重命名（"${currentName}" → "${input.name}"）：请先删除该服务器，再以新名称新增。`)
    }
    const duplicate = entries.find((other) => other !== entry && text(other.config, 'serverName') === input.name)
    if (duplicate !== undefined) throw nameConflict(input.name)
    // t11/F3: snapshot the authored files first, so a refused install/reload can
    // put the server back exactly as it was instead of leaving a half-applied
    // "changed on disk but not live" state.
    const patchFile = join(serverDir(entry.serverId), 'cordis.patch.yml')
    const metadataFile = managerMetadataPath(entry.serverId)
    const snapshots = [
      [patchFile, await snapshotFile(patchFile)],
      [metadataFile, await snapshotFile(metadataFile)],
    ]
    let result
    try {
      await writeGeneratedBundle(entry.serverId, input)
      // §3a (t8/F1): only a *present* displayName touches the stored label — an
      // omitted field preserves it, an explicit `''` clears it. Passing undefined
      // through here is what keeps those two paths distinct.
      await writeManagerMetadata(entry.serverId, carriesDisplayName(input) ? input.displayName : undefined)
      // t11/F1: never re-install an already-recorded bundle. The real Plugin
      // Manager refuses a second install of the same dependency with
      // `ambiguous-install`; the files are already rewritten in place, so
      // re-selecting the bundle is what makes the change live.
      result = await applyBundle(ctx, manager, generatedPackageName(entry.serverId), serverDir(entry.serverId))
    } catch (error) {
      await rollbackFiles(snapshots, error)
    }
    notice = overriddenNotice(result)
  }

  const servers = await readServerViews(ctx, manager)
  const updated = servers.find((view) => view.id === id)
  return withNotice(
    { servers, disabled: updated === undefined ? entry.row.enabled === false : updated.enabled === false },
    notice,
  )
}

/**
 * `remove` → `{ servers }` (CONTRACT §6). The Plugin Manager's own removal path
 * runs first; only then is the whole server directory dropped, which is what
 * §3a requires for the manager-private metadata.
 * @param ctx - plugin context.
 * @param payload - `{ id }`.
 * @returns the success result.
 */
async function removeValue(ctx, payload) {
  const manager = requireManager(ctx)
  const id = requireId(isPlainObject(payload) ? payload.id : undefined)
  const entries = await readServerEntries(ctx, manager)
  const entry = findTargetEntry(entries, id)
  assertWritable(entry, id)
  const result = await runManager('remove', () => manager.removeBundle(generatedPackageName(entry.serverId)))
  await removeServerDirectory(ctx, entry.serverId)
  return withNotice({ servers: await readServerViews(ctx, manager) }, overriddenNotice(result))
}

/**
 * `catalog` → a **live registry browser** (CONTRACT §6).
 *
 * Two real sources, queried by the Host only (the browser half never fetches a
 * third-party host: no CORS, and the Connection fence stays the one trust
 * boundary):
 *
 * 1. the Official MCP Registry — `GET .../v0/servers?search=&limit=&cursor=`;
 * 2. the npm registry search — `GET .../-/v1/search?text=&size=&from=`.
 *
 * Either the answer is live, or `degraded: true` says it is not. A network
 * problem never reaches the HTTP layer: it degrades to (a) the previous answer
 * for the same key, or (b) the shipped offline seed.
 *
 * @param ctx - plugin context, for diagnostics.
 * @param payload - `{ source?, query?, cursor?, limit? }`.
 * @param options - injection points for tests (`fetchImpl`, `now`, `seedDir`, `cache`).
 * @returns the `catalog` value.
 */
async function catalogValue(ctx, payload, options = {}) {
  const request = readCatalogRequest(payload)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  const cache = options.cache ?? catalogCache
  const fallbackAt = options.fallbackAt ?? catalogFallbacks
  const refreshing = options.refreshing ?? catalogRefreshing
  const key = catalogCacheKey(request)

  const cached = cache.get(key)
  if (cached !== undefined && now() - cached.at <= CATALOG_CACHE_TTL_MS) {
    // A hit inside the TTL is exactly what the source answered moments ago.
    return cached.value
  }

  // t19: this query just failed (typically a slow upstream that hit the
  // timeout). Answer from its fallback at once instead of making the user wait
  // out another full timeout — the live cache stays untouched, so a recovered
  // network wins again as soon as a refresh succeeds.
  const failedAt = fallbackAt.get(key)
  if (failedAt !== undefined && now() - failedAt <= CATALOG_FALLBACK_TTL_MS) {
    return await catalogFallback(ctx, request, cached, options)
  }

  let live
  try {
    live = await fetchCatalogPage(request, fetchImpl)
  } catch (error) {
    const reason = messageOf(error)
    ctx?.logger?.warn?.(`${name}: catalog ${request.source} fetch failed (${reason})`)
    fallbackAt.set(key, now())
    // Keep probing in the background so recovery is noticed without the user
    // paying for it.
    scheduleCatalogRefresh(ctx, request, { fetchImpl, cache, fallbackAt, refreshing, now })
    return await catalogFallback(ctx, request, cached, options)
  }

  const value = catalogPageValue(request, live, new Date(now()).toISOString())
  fallbackAt.delete(key)
  rememberCatalog(cache, key, value, now())
  return value
}

/** The memo key for one catalog request (CONTRACT §6: source, query, cursor, limit). */
function catalogCacheKey(request) {
  return `${request.source}|${request.query}|${request.cursor ?? ''}|${request.limit}`
}

/** Route one request to its source. */
function fetchCatalogPage(request, fetchImpl) {
  return request.source === 'npm' ? fetchNpmPage(request, fetchImpl) : fetchRegistryPage(request, fetchImpl)
}

/** Assemble the §6 value from one live page. */
function catalogPageValue(request, live, fetchedAt) {
  return {
    source: request.source,
    entries: live.entries,
    nextCursor: live.nextCursor,
    total: live.total,
    hasMore: live.nextCursor !== null,
    degraded: false,
    fetchedAt,
  }
}

/**
 * The best answer available while the live source cannot be reached (t19).
 *
 * Priority: this query's own previous live result (marked `degraded: true`,
 * never presented as live), then the shipped offline seed. Neither path writes
 * the success cache, so recovery immediately returns live data again.
 */
async function catalogFallback(ctx, request, cached, options) {
  if (cached !== undefined) return { ...cached.value, degraded: true }
  return await readSeedCatalogValue(ctx, request.source, options.seedDir ?? PLUGIN_ROOT)
}

/**
 * Retry one failed request in the background (t19), so a network that comes back
 * is picked up by the next call instead of by the next timeout. The promise is
 * deliberately not awaited and failures are ignored.
 */
function scheduleCatalogRefresh(ctx, request, deps) {
  const key = catalogCacheKey(request)
  if (deps.refreshing.has(key)) return
  deps.refreshing.add(key)
  void fetchCatalogPage(request, deps.fetchImpl).then((live) => {
    const value = catalogPageValue(request, live, new Date(deps.now()).toISOString())
    rememberCatalog(deps.cache, key, value, deps.now())
    deps.fallbackAt.delete(key)
  }, () => {
    // Still unreachable: the next request keeps answering from the fallback.
  }).finally(() => {
    deps.refreshing.delete(key)
  })
}

/* --------------------------------------------------------- catalog: request */

/** Read and validate the `catalog` payload (CONTRACT §6). */
function readCatalogRequest(payload) {
  const raw = isPlainObject(payload) ? payload : {}
  const source = raw.source === undefined || raw.source === null ? 'registry' : raw.source
  if (source !== 'registry' && source !== 'npm') {
    throw invalid('source 只能是 "registry" 或 "npm"。')
  }
  if (raw.query !== undefined && raw.query !== null && typeof raw.query !== 'string') {
    throw invalid('query 必须是字符串。')
  }
  const query = typeof raw.query === 'string' ? raw.query.trim() : ''
  if (raw.cursor !== undefined && raw.cursor !== null && typeof raw.cursor !== 'string') {
    throw invalid('cursor 必须是字符串或 null。')
  }
  const cursor = typeof raw.cursor === 'string' && raw.cursor !== '' ? raw.cursor : null
  // The npm cursor is a plain `from` offset, so a malformed one is a payload
  // error — it must not be swallowed by the fetch-failure path below.
  if (source === 'npm' && cursor !== null && !/^\d+$/.test(cursor)) {
    throw invalid(`npm 的 cursor 必须是数字偏移，收到 ${JSON.stringify(cursor)}。`)
  }
  return { source, query, cursor, limit: readCatalogLimit(raw.limit) }
}

/** Page size: default {@link CATALOG_DEFAULT_LIMIT}, clamped to 1..{@link CATALOG_MAX_LIMIT}. */
function readCatalogLimit(value) {
  if (value === undefined || value === null) return CATALOG_DEFAULT_LIMIT
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return CATALOG_DEFAULT_LIMIT
  return Math.min(CATALOG_MAX_LIMIT, Math.max(1, Math.floor(parsed)))
}

/** Memoize one live answer, bounded so a long browsing session cannot grow forever. */
function rememberCatalog(cache, key, value, at) {
  cache.set(key, { at, value })
  while (cache.size > CATALOG_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/* ------------------------------------------------------- catalog: transport */

/** One JSON GET with a hard timeout; rejects with a readable, non-fatal error. */
async function fetchCatalogJson(fetchImpl, url, timeoutMs = CATALOG_TIMEOUT_MS) {
  if (typeof fetchImpl !== 'function') throw new RpcFailure('internal', '当前运行环境没有 fetch。', { url })
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (isPlainObject(response) && response.ok === false) {
    throw new RpcFailure('internal', `HTTP ${response.status} from ${url}`, { url, status: response.status })
  }
  return await response.json()
}

/* ------------------------------------------------------ catalog: registry 源 */

/**
 * One page of the Official MCP Registry.
 *
 * `metadata.count` is this page's size (measured: 50 for `limit=50`, 3 for
 * `limit=3`), not a total, so `total` stays null rather than reporting a number
 * the source does not offer.
 */
async function fetchRegistryPage(request, fetchImpl) {
  const url = new URL(CATALOG_REGISTRY_URL)
  url.searchParams.set('limit', String(request.limit))
  if (request.query !== '') url.searchParams.set('search', request.query)
  if (request.cursor !== null) url.searchParams.set('cursor', request.cursor)
  const body = await fetchCatalogJson(fetchImpl, url.href)
  const rows = Array.isArray(body?.servers) ? body.servers : []
  const nextCursor = nonEmptyString(body?.metadata?.nextCursor) ? body.metadata.nextCursor : null
  return { entries: mapRegistryRows(rows), nextCursor, total: null }
}

/**
 * Map registry rows to cards, de-duplicating by server name: the registry
 * returns one row per published version (`ac.inference.sh/mcp` appeared four
 * times in a single page), and the official meta says which one is the latest.
 */
function mapRegistryRows(rows) {
  const byName = new Map()
  for (const row of rows) {
    const entry = mapRegistryRow(row)
    if (entry === null) continue
    const existing = byName.get(entry.id)
    if (existing === undefined || (entry.official === true && existing.official !== true)) {
      byName.set(entry.id, entry)
    }
  }
  return [...byName.values()]
}

/** One registry row → `CatalogEntry`, or null when it has no usable endpoint. */
function mapRegistryRow(row) {
  const server = isPlainObject(row?.server) ? row.server : row
  if (!isPlainObject(server)) return null
  const serverName = nonEmptyString(server.name) ? server.name : null
  if (serverName === null) return null
  const target = registryTarget(server)
  // Rows carrying only a name/description cannot be installed; skipping them
  // beats rendering a half-built card (CONTRACT §6).
  if (target === null) return null
  const title = firstString(server.title, serverName)
  const description = firstString(server.description, server.title, serverName)
  const official = row?._meta?.[CATALOG_REGISTRY_META_KEY]
  const entry = {
    id: serverName,
    title: localizedText(title),
    description: localizedText(description),
    // CONTRACT §6: the registry namespace is the grouping key.
    category: serverName.includes('/') ? serverName.slice(0, serverName.indexOf('/')) : 'registry',
    transport: target.transport,
    origin: 'registry',
  }
  if (target.url !== undefined) entry.url = target.url
  if (target.command !== undefined) {
    entry.command = target.command
    if (target.args.length > 0) entry.args = target.args
  }
  // `envKeys` stays absent: the registry publishes no env-var contract, and
  // inventing one would be worse than letting the user fill the server's own
  // editor after install (CONTRACT §6).
  const docs = firstString(server.websiteUrl, server.repository?.url)
  if (docs !== undefined) entry.docs = docs
  if (target.packageId !== undefined) entry.packageId = target.packageId
  if (official !== undefined) entry.official = isPlainObject(official) && official.isLatest === true
  return entry
}

/**
 * The installable endpoint of a registry server: a hosted `remote` wins (zero
 * install), otherwise the first npm package, otherwise the first pypi package
 * through `uvx` (CONTRACT §6).
 * @returns `{transport, url?, command?, args, packageId?}` or null.
 */
function registryTarget(server) {
  const remotes = Array.isArray(server.remotes) ? server.remotes : []
  for (const remote of remotes) {
    if (!isPlainObject(remote)) continue
    const url = nonEmptyString(remote.url) ? remote.url : null
    if (url === null || !/^https?:\/\//i.test(url)) continue
    const type = typeof remote.type === 'string' ? remote.type.toLowerCase() : ''
    // Only the transport this Host's mcp-client can actually run: a bare `sse`
    // endpoint is a different protocol, so it is skipped rather than mislabelled.
    if (type === CATALOG_REMOTE_TYPE) return { transport: 'streamable-http', url, args: [] }
  }
  const packages = Array.isArray(server.packages) ? server.packages : []
  const npm = packages.find((entry) => isPlainObject(entry)
    && entry.registryType === 'npm' && nonEmptyString(entry.identifier))
  if (npm !== undefined) {
    return { transport: 'stdio', command: 'npx', args: ['-y', npm.identifier], packageId: `npm:${npm.identifier}` }
  }
  const pypi = packages.find((entry) => isPlainObject(entry)
    && entry.registryType === 'pypi' && nonEmptyString(entry.identifier))
  if (pypi !== undefined) {
    return { transport: 'stdio', command: 'uvx', args: [pypi.identifier], packageId: `pypi:${pypi.identifier}` }
  }
  return null
}

/* ----------------------------------------------------------- catalog: npm 源 */

/**
 * One page of the npm registry search.
 *
 * Query choice (measured on 2026-10-04): a bare `text=mcp server` matches
 * 412 022 packages whose first hit is unrelated tooling, and npm treats the
 * `keywords:` qualifier as a ranking hint rather than a filter
 * (`text=keywords:mcp-server` still ranked `yahoo-finance2` first). Appending
 * the literal term `mcp-server` to the user's words ranked real MCP servers
 * first for every probe (`notion` → `@notionhq/notion-mcp-server`, `postgres`
 * → `@henkey/postgres-mcp-server`, `slack` → `slack-mcp-server`), and browsing
 * without a query uses that term alone.
 */
async function fetchNpmPage(request, fetchImpl) {
  // A package-name spec is looked up directly: npm's search never finds a
  // package whose keywords are empty and whose description never says "MCP"
  // (t17's counter-example `@jokeran/frontend-code-skimmer`), yet the registry
  // document itself is right there.
  const spec = request.cursor === null ? readPackageSpec(request.query) : null
  if (spec !== null && spec.scoped) {
    const card = await fetchNpmPackageCard(spec, fetchImpl)
    return { entries: card === null ? [] : [card], nextCursor: null, total: card === null ? 0 : 1 }
  }
  const page = await searchNpmPage(request, fetchImpl)
  if (spec === null) return page
  // npm's search is fuzzy: it answers an exact package name with loosely related
  // packages (t18/F1), so "the page is empty" is the wrong test. If no hit *is*
  // that package, look the name up in the registry document and merge it in.
  if (page.entries.some((entry) => samePackageName(entry.id, spec.name))) return page
  // Bounded and harmless: a package without a bin produces no card at all (which
  // is why `postgres`/`github` results are byte-identical), and a supplementary
  // lookup that fails leaves the search page untouched (t19).
  let card = null
  try {
    card = await fetchNpmPackageCard(spec, fetchImpl)
  } catch {
    card = null
  }
  if (card === null) return page
  return { entries: mergeNpmEntries(page.entries, card), nextCursor: page.nextCursor, total: page.total }
}

/** Package-name equality: case-insensitive, ignoring an `@version` suffix. */
function samePackageName(left, right) {
  const one = normalizePackageName(left)
  const two = normalizePackageName(right)
  return one !== null && one === two
}

/** A comparable package name, or null when there is nothing to compare. */
function normalizePackageName(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return null
  // `npm:@scope/name` (the `packageId` form) and `@scope/name` are one package;
  // npm names never contain a colon, so any leading `<type>:` is that prefix.
  const withoutRegistry = trimmed.replace(/^[a-z]+:/, '')
  // A leading `@` opens a scope, so only a later `@` starts a version.
  const at = withoutRegistry.lastIndexOf('@')
  const name = at > 0 ? withoutRegistry.slice(0, at) : withoutRegistry
  return name === '' ? null : name
}

/**
 * Put a directly looked-up card into a search page, one card per package id
 * (t19). The direct card carries the runnable derived command, so it replaces a
 * same-id search hit in place; otherwise it is appended.
 */
function mergeNpmEntries(entries, card) {
  const merged = []
  let placed = false
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (isPlainObject(entry) && samePackageName(entry.id, card.id)) {
      if (!placed) {
        merged.push(card)
        placed = true
      }
      continue
    }
    merged.push(entry)
  }
  if (!placed) merged.push(card)
  return merged
}

/** One page of `/-/v1/search`, paged by the `from` offset. */
async function searchNpmPage(request, fetchImpl) {
  const from = readNpmOffset(request.cursor)
  const url = new URL(CATALOG_NPM_URL)
  url.searchParams.set('text', request.query === '' ? CATALOG_NPM_TERM : `${request.query} ${CATALOG_NPM_TERM}`)
  url.searchParams.set('size', String(request.limit))
  url.searchParams.set('from', String(from))
  const body = await fetchCatalogJson(fetchImpl, url.href)
  const objects = Array.isArray(body?.objects) ? body.objects : []
  const total = numberOrNull(body?.total)
  const next = from + objects.length
  const hasMore = total === null ? objects.length >= request.limit : next < total
  return { entries: mapNpmObjects(objects), nextCursor: hasMore ? String(next) : null, total }
}

/* ------------------------------------------- catalog: 直查包名 + bin 派生 */

/**
 * Read `query` as an exact npm package spec (t17): `name`, `@scope/name`, or
 * either with an `@version` suffix.
 *
 * A scoped spec is authoritative — a user typing `@scope/name` means exactly
 * that package. A bare word is ambiguous (`postgres` is both a search term and
 * a package name), so the caller only falls back to a direct lookup when the
 * search comes back empty; ordinary searches keep their results untouched.
 *
 * @param query - the trimmed payload `query`.
 * @returns `{name, version, scoped}` or null when it is not a package spec.
 */
function readPackageSpec(query) {
  if (typeof query !== 'string') return null
  const trimmed = query.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return null
  let name = trimmed
  let version = null
  // A leading `@` opens a scope; any later `@` introduces a version.
  const at = trimmed.lastIndexOf('@')
  if (at > 0) {
    name = trimmed.slice(0, at)
    version = trimmed.slice(at + 1)
    if (version === '' || /[^\w.+-]/.test(version)) return null
  }
  if (name.startsWith('@')) {
    if (!/^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/i.test(name)) return null
    return { name, version, scoped: true }
  }
  if (!/^[a-z0-9][a-z0-9._~-]*$/i.test(name)) return null
  return { name, version, scoped: false }
}

/** The registry document URL for one package name (a scope keeps its literal `@`). */
function npmPackageUrl(packageName) {
  const encoded = packageName
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%40/g, '@'))
    .join('%2f')
  return `${CATALOG_NPM_PACKAGE_URL}${encoded}`
}

/**
 * Fetch one package document and map it to a single npm card (t17).
 * @returns the card, or null when the package (or that version) does not exist.
 * @throws when the lookup fails for any reason other than "not found", so the
 * caller reports a degraded page instead of "this package does not exist".
 */
async function fetchNpmPackageCard(spec, fetchImpl) {
  let document
  try {
    document = await fetchCatalogJson(fetchImpl, npmPackageUrl(spec.name))
  } catch (error) {
    if (error?.details?.status === 404) return null
    throw error
  }
  return mapNpmPackageDocument(document, spec)
}

/** One registry package document → `CatalogEntry`, or null without a runnable bin. */
function mapNpmPackageDocument(document, spec) {
  if (!isPlainObject(document)) return null
  const packageName = nonEmptyString(document.name) ? document.name : spec.name
  const versions = isPlainObject(document.versions) ? document.versions : {}
  const distTags = isPlainObject(document['dist-tags']) ? document['dist-tags'] : {}
  const version = spec.version ?? (nonEmptyString(distTags.latest) ? distTags.latest : null)
  const manifest = version !== null && isPlainObject(versions[version]) ? versions[version] : null
  // An explicitly requested version the document does not carry is a miss.
  if (spec.version !== null && manifest === null) return null
  const derived = deriveNpmCommand(packageName, spec.version, manifest?.bin ?? document.bin)
  // Without a bin there is nothing to run, and a stdio card with no command
  // would be a half-built card (CONTRACT §6).
  if (derived === null) return null
  const entry = {
    id: packageName,
    title: localizedText(packageName),
    description: localizedText(firstString(manifest?.description, document.description, packageName)),
    category: npmKeywordBucket(document.keywords ?? manifest?.keywords),
    transport: 'stdio',
    command: 'npx',
    args: derived.args,
    origin: 'npm',
    packageId: `npm:${packageName}`,
    // The package document carries no popularity data; only search does.
    downloadsMonthly: null,
    score: null,
  }
  const repository = isPlainObject(document.repository) ? document.repository : {}
  const docs = firstString(document.homepage, repository.url)
  if (docs !== undefined) entry.docs = docs
  return entry
}

/**
 * Derive the `npx` invocation for one package from its `bin` (t17).
 *
 * - a single bin (a string, or an object with one key) → `npx -y <pkg>`: npx
 *   resolves the only executable itself, and the bin key need not match the
 *   package name (`@jokeran/frontend-code-skimmer` → bin
 *   `frontend-code-skimmer`);
 * - several bins → `npx -y -p <pkg> <bin>` with the bin named explicitly, so the
 *   command is never ambiguous and the choice is visible in the card's args.
 *   The bin is picked deterministically: a name mentioning mcp/skimmer/server
 *   wins, otherwise the first in sorted order.
 *
 * @param packageName - the real package name.
 * @param version - an explicitly requested version, or null for `latest`.
 * @param bin - the manifest's `bin` field.
 * @returns `{args, binName}` or null when the package declares no executable.
 */
function deriveNpmCommand(packageName, version, bin) {
  const bins = binEntries(packageName, bin)
  if (bins.length === 0) return null
  const ref = typeof version === 'string' && version !== '' ? `${packageName}@${version}` : packageName
  if (bins.length === 1) return { args: ['-y', ref], binName: bins[0].name }
  const chosen = pickNpmBin(bins)
  return { args: ['-y', '-p', ref, chosen.name], binName: chosen.name }
}

/** Normalize a manifest `bin` field into `[{name, path}]`, in declaration order. */
function binEntries(packageName, bin) {
  if (typeof bin === 'string' && bin !== '') {
    const segments = packageName.split('/')
    return [{ name: segments[segments.length - 1], path: bin }]
  }
  if (!isPlainObject(bin)) return []
  const entries = []
  for (const [name, path] of Object.entries(bin)) {
    if (typeof path !== 'string' || path === '' || name === '__proto__') continue
    entries.push({ name, path })
  }
  return entries
}

/** The bin to run when a package declares several, chosen deterministically. */
function pickNpmBin(bins) {
  const sorted = [...bins].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return sorted.find((entry) => CATALOG_BIN_HINTS.test(entry.name)) ?? sorted[0]
}

/** The npm cursor is a plain `from` offset (already validated by the payload reader). */
function readNpmOffset(cursor) {
  if (cursor === null) return 0
  const parsed = Number(cursor)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalid(`npm 的 cursor 超出范围：${cursor}`)
  }
  return parsed
}

/** Map npm search hits to cards; a hit without a package name is skipped. */
function mapNpmObjects(objects) {
  const entries = []
  for (const object of objects) {
    const entry = mapNpmObject(object)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/** One npm search hit → `CatalogEntry` (always an `npx` stdio card). */
function mapNpmObject(object) {
  const pkg = isPlainObject(object?.package) ? object.package : null
  const packageName = isPlainObject(pkg) && nonEmptyString(pkg.name) ? pkg.name : null
  if (packageName === null) return null
  const entry = {
    id: packageName,
    title: localizedText(firstString(pkg.title, packageName)),
    description: localizedText(firstString(pkg.description, packageName)),
    category: npmKeywordBucket(pkg.keywords),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', packageName],
    origin: 'npm',
    packageId: `npm:${packageName}`,
    downloadsMonthly: numberOrNull(object?.downloads?.monthly),
    score: numberOrNull(object?.score?.final),
  }
  const links = isPlainObject(pkg.links) ? pkg.links : {}
  const docs = firstString(links.homepage, links.repository, links.npm)
  if (docs !== undefined) entry.docs = docs
  return entry
}

/** npm cards group under their first non-generic keyword, else `mcp`. */
function npmKeywordBucket(keywords) {
  const list = Array.isArray(keywords) ? keywords : []
  for (const keyword of list) {
    if (typeof keyword !== 'string') continue
    const trimmed = keyword.trim()
    if (trimmed === '') continue
    if (CATALOG_GENERIC_KEYWORDS.has(trimmed.toLowerCase())) continue
    return trimmed
  }
  return 'mcp'
}

/** A finite number, or null — never a fabricated count (CONTRACT §6). */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* --------------------------------------------------------- catalog: 离线种子 */

/**
 * The shipped offline seed, served only when a live source fails and no earlier
 * answer exists. Every entry is marked `origin: 'seed'` and the caller sets
 * `degraded: true` (CONTRACT §6).
 */
async function readSeedCatalogValue(ctx, source, baseDir = PLUGIN_ROOT) {
  for (const segments of CATALOG_PATHS) {
    const file = join(baseDir, ...segments)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') ctx?.logger?.warn?.(`${name}: catalog seed ${file}: ${messageOf(error)}`)
      continue
    }
    let document
    try {
      document = JSON.parse(raw)
    } catch (error) {
      ctx?.logger?.warn?.(`${name}: catalog seed ${file} is not valid JSON: ${messageOf(error)}`)
      continue
    }
    const entries = normalizeCatalogDocument(document).map((entry) => ({ ...entry, origin: 'seed' }))
    return {
      source,
      entries,
      nextCursor: null,
      total: entries.length,
      hasMore: false,
      degraded: true,
      fetchedAt: new Date().toISOString(),
    }
  }
  ctx?.logger?.warn?.(`${name}: no catalog seed under ${baseDir}; the catalog endpoint returns an empty page`)
  return {
    source,
    entries: [],
    nextCursor: null,
    total: 0,
    hasMore: false,
    degraded: true,
    fetchedAt: new Date().toISOString(),
  }
}

/** Resolve the row `update`/`remove` must act on (CONTRACT §4/§6). */
function findTargetEntry(entries, id) {
  const managed = entries.find((entry) => entry.managed && entry.serverId === id)
  if (managed !== undefined) return managed
  const external = entries.find((entry) => entry.row.entryId === id || entry.row.patchId === id)
  if (external !== undefined) return external
  throw new RpcFailure('unknown-server', `找不到 id 为 "${id}" 的受管 MCP 服务器。`, { id })
}

/** Refuse every write against an external or manager-unaddressable row. */
function assertWritable(entry, id) {
  if (!entry.managed) {
    throw new RpcFailure('read-only', `MCP 服务器 "${id}" 不是本插件创建的，只能查看，不能修改或删除。`, { id, reason: 'external' })
  }
  if (typeof entry.row.readOnlyReason === 'string') {
    throw new RpcFailure('read-only', `Plugin Manager 将 "${id}" 标记为只读（${entry.row.readOnlyReason}）。`, {
      id,
      reason: entry.row.readOnlyReason,
    })
  }
}

/** Force a live reconcile of one already-installed bundle's rows. */
async function reloadBundle(ctx, manager, packageName) {
  if (typeof manager.setBundleEnabled !== 'function') {
    ctx?.logger?.warn?.(`${name}: Plugin Manager cannot reload ${packageName} in place; the change applies on restart`)
    return undefined
  }
  return await runManager('enable', () => manager.setBundleEnabled(packageName, true))
}

/* ---------------------------------------------------------------- catalog (§7) */

/** Normalize a whole catalog document into `CatalogEntry[]`. */
function normalizeCatalogDocument(document) {
  const raw = Array.isArray(document)
    ? document
    : isPlainObject(document) && Array.isArray(document.entries) ? document.entries : []
  const entries = []
  for (const candidate of raw) {
    const entry = normalizeCatalogEntry(candidate)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/** Normalize one `CatalogEntry`, or null when it cannot be installed (CONTRACT §7). */
function normalizeCatalogEntry(candidate) {
  if (!isPlainObject(candidate)) return null
  if (!nonEmptyString(candidate.id)) return null
  const transport = candidate.transport === 'stdio'
    ? 'stdio'
    : candidate.transport === 'streamable-http' ? 'streamable-http' : null
  if (transport === null) return null
  const entry = {
    id: candidate.id,
    title: localizedText(candidate.title),
    description: localizedText(candidate.description),
    category: nonEmptyString(candidate.category) ? candidate.category : 'other',
    transport,
  }
  if (transport === 'stdio') {
    if (nonEmptyString(candidate.command)) entry.command = candidate.command
    const args = readArgs(candidate.args)
    if (args.length > 0) entry.args = args
  } else if (nonEmptyString(candidate.url)) {
    entry.url = candidate.url
  }
  if (transport === 'streamable-http' && isPlainObject(candidate.headers)) {
    const headers = stringRecordOf(candidate.headers)
    if (Object.keys(headers).length > 0) entry.headers = headers
  }
  const envKeys = normalizeEnvKeys(candidate.envKeys)
  if (envKeys.length > 0) entry.envKeys = envKeys
  if (nonEmptyString(candidate.docs)) entry.docs = candidate.docs
  return entry
}

/** A catalog `args` list, ignoring non-strings. */
function readArgs(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/** `{ zh, en }`; a bare string fills both, a missing side reuses the other. */
function localizedText(value) {
  if (typeof value === 'string') return { zh: value, en: value }
  if (!isPlainObject(value)) return { zh: '', en: '' }
  const zh = typeof value.zh === 'string' ? value.zh : ''
  const en = typeof value.en === 'string' ? value.en : ''
  return { zh: zh === '' ? en : zh, en: en === '' ? zh : en }
}

/** Keep only well-formed `envKeys` rows. */
function normalizeEnvKeys(value) {
  if (!Array.isArray(value)) return []
  const keys = []
  for (const candidate of value) {
    if (!isPlainObject(candidate) || !nonEmptyString(candidate.key)) continue
    const entry = { key: candidate.key, label: localizedText(candidate.label), required: candidate.required === true }
    if (nonEmptyString(candidate.placeholder)) entry.placeholder = candidate.placeholder
    if (candidate.secret === true) entry.secret = true
    keys.push(entry)
  }
  return keys
}

/* ---------------------------------------------------------------- error helpers */

/** `invalid-request` (CONTRACT §6). */
function invalid(detail) {
  return new RpcFailure('invalid-request', `请求无效：${detail}`, {})
}

/** `name-conflict` (CONTRACT §6). */
function nameConflict(serverName) {
  return new RpcFailure('name-conflict', `服务器名称 "${serverName}" 已被占用，请换一个名称。`, { name: serverName })
}

/** `install-failed` (CONTRACT §6), always carrying `stage` + `diagnostic`. */
function installFailed(stage, diagnostic) {
  const text = clip(String(diagnostic))
  return new RpcFailure('install-failed', `Plugin Manager 在 ${stage} 阶段失败：${text}`, { stage, diagnostic: text })
}

/** A required non-empty `id` field (CONTRACT §6). */
function requireId(value) {
  if (!nonEmptyString(value)) throw invalid('必须提供非空的 id。')
  return value
}

/* ------------------------------------------------------------- RPC transport */

/**
 * Answer one `/dsh-mcp-rpc/<endpoint>` request (CONTRACT §6):
 * fence → route → content type → body cap → envelope → endpoint, with HTTP 200
 * for every application-level outcome and no exception reaching the HTTP layer.
 * @param ctx - the Web-server scope's context.
 * @param connection - the Connection service used for the fence.
 * @param req - Node request.
 * @param res - Node response.
 */
async function handleChannelRequest(ctx, connection, req, res) {
  let rpcId = 'invalid-request'
  try {
    const rejection = fence(connection, req)
    if (rejection !== undefined) {
      writeText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const endpoint = endpointFromPath(requestPath(req))
    if (req.method !== 'POST' || endpoint === undefined) {
      writeText(res, 404, 'not found')
      return
    }
    if (!hasJsonContentType(req)) {
      writeText(res, 415, 'content type must be application/json')
      return
    }
    const declared = declaredBodyBytes(req)
    if (declared !== undefined && declared > MAX_BODY_BYTES) {
      writeText(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
      return
    }
    let raw
    try {
      raw = await readRequestBody(req, MAX_BODY_BYTES)
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        writeText(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
        return
      }
      writeText(res, 400, 'request body could not be read')
      return
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      writeText(res, 400, 'body is not JSON')
      return
    }
    const envelope = readClientRequest(body)
    if (!envelope.ok) {
      const id = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
      writeJson(res, 200, responseEnvelope(id, fail('gateway/bad-request', 'invalid client-request message', { issues: envelope.issues })))
      return
    }
    rpcId = envelope.value.rpcId
    if (envelope.value.method !== endpoint) {
      writeJson(res, 200, responseEnvelope(rpcId, fail(
        'gateway/bad-request',
        `method ${JSON.stringify(envelope.value.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        { issues: [] },
      )))
      return
    }
    writeJson(res, 200, responseEnvelope(rpcId, await dispatch(ctx, endpoint, envelope.value.payload)))
  } catch (error) {
    if (res.headersSent === true || res.writableEnded === true) return
    const diagnostic = clip(messageOf(error))
    writeJson(res, 200, responseEnvelope(rpcId, fail('internal', `内部错误：${diagnostic}`, { diagnostic })))
  }
}

/**
 * Fence one request through Connection (CONTRACT §6). A missing or throwing
 * fence fails closed: an unfenced channel must not answer at all, and a fence
 * error must never surface as a `200 internal` or leak its text (t6/O9).
 * @param connection - the Connection service.
 * @param req - Node request (`headers` is all the fence reads).
 * @returns 401/403, or undefined when the request may proceed.
 */
function fence(connection, req) {
  if (connection === undefined || typeof connection.requestRejection !== 'function') return 403
  try {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined || rejection === null) return undefined
    return rejection === 401 ? 401 : 403
  } catch {
    return 403
  }
}

/** The pathname of a Node request, or '' when it is unusable. */
function requestPath(req) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    return ''
  }
}

/** Match `/dsh-mcp-rpc/<endpoint>` against the five known endpoints. */
function endpointFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(`${RPC_CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(RPC_CHANNEL.length + 1)
  return ENDPOINTS.has(endpoint) ? endpoint : undefined
}

/** Require `content-type: application/json` (parameters allowed). */
function hasJsonContentType(req) {
  const value = headerValue(req, 'content-type')
  return typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

/** A declared body length, when the client sent a usable one. */
function declaredBodyBytes(req) {
  const value = headerValue(req, 'content-length')
  if (typeof value !== 'string') return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** Read one request header, tolerating the array form. */
function headerValue(req, key) {
  const value = req?.headers?.[key]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Buffer the request body, refusing anything over the ceiling.
 * @param req - Node request (async-iterable).
 * @param limit - byte ceiling.
 * @returns the decoded body.
 * @throws {BodyTooLargeError} when the ceiling is exceeded.
 */
async function readRequestBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Validate the `client-request` envelope (CONTRACT §6). */
function readClientRequest(body) {
  const issues = []
  if (!isPlainObject(body)) return { ok: false, issues: ['body must be an object'] }
  if (body.type !== 'client-request') issues.push('type must be "client-request"')
  if (typeof body.rpcId !== 'string') issues.push('rpcId must be a string')
  if (typeof body.method !== 'string') issues.push('method must be a string')
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: { rpcId: body.rpcId, method: body.method, payload: body.payload } }
}

/** One response envelope (CONTRACT §6). */
function responseEnvelope(rpcId, result) {
  return { type: 'server-response', rpcId, result }
}

/** A success result. */
function succeed(value) {
  return { ok: true, value }
}

/** A failure result; `details` is always a record. */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details: isPlainObject(details) ? details : {} } }
}

/** Route one endpoint, folding every failure into the response envelope. */
async function dispatch(ctx, endpoint, payload) {
  try {
    switch (endpoint) {
      case 'list': return succeed(await listValue(ctx))
      case 'add': return succeed(await addValue(ctx, payload))
      case 'update': return succeed(await updateValue(ctx, payload))
      case 'remove': return succeed(await removeValue(ctx, payload))
      case 'catalog': return succeed(await catalogValue(ctx, payload))
      default: return fail('invalid-request', `请求无效：未知 endpoint "${endpoint}"。`, {})
    }
  } catch (error) {
    if (error instanceof RpcFailure) return fail(error.code, error.message, error.details)
    const diagnostic = clip(messageOf(error))
    return fail('internal', `内部错误：${diagnostic}`, { diagnostic })
  }
}

/** Write a plain-text response. */
function writeText(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Write a JSON response. */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/* ------------------------------------------------------------- test surface */

/**
 * Test-only view of the pure helpers above. The Loader ignores unknown exports;
 * this exists so `test/host.test.mjs` can assert the CONTRACT §2/§3/§5 rules
 * directly instead of re-deriving them.
 */
export const __internals = Object.freeze({
  RPC_CHANNEL,
  MAX_BODY_BYTES,
  MAX_LABEL_LENGTH,
  MANAGER_METADATA_FILE,
  MANAGER_SCHEMA_VERSION,
  MCP_CLIENT_MODULE,
  ROW_ID_PREFIX,
  SERVER_NAME_PATTERN,
  SERVER_ID_PATTERN,
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
  snapshotFile,
  restoreFile,
  generatedManifest,
  generatedPatch,
  writeGeneratedBundle,
  managedServerId,
  managerMetadataPath,
  readManagerMetadata,
  readManagerLabel,
  writeManagerMetadata,
  readAuthoredConfigFromDisk,
  resolveAuthoredConfig,
  buildServerView,
  deriveStatus,
  readServerEntries,
  catalogValue,
  readCatalogRequest,
  fetchRegistryPage,
  fetchNpmPage,
  mapRegistryRow,
  mapRegistryRows,
  registryTarget,
  mapNpmObject,
  mapNpmPackageDocument,
  readPackageSpec,
  npmPackageUrl,
  fetchNpmPackageCard,
  deriveNpmCommand,
  binEntries,
  pickNpmBin,
  npmKeywordBucket,
  samePackageName,
  normalizePackageName,
  mergeNpmEntries,
  CATALOG_NPM_PACKAGE_URL,
  fetchCatalogJson,
  readSeedCatalogValue,
  catalogCache,
  catalogFallbacks,
  catalogRefreshing,
  catalogCacheKey,
  catalogFallback,
  scheduleCatalogRefresh,
  CATALOG_REGISTRY_URL,
  CATALOG_NPM_URL,
  CATALOG_NPM_TERM,
  CATALOG_TIMEOUT_MS,
  CATALOG_CACHE_TTL_MS,
  CATALOG_FALLBACK_TTL_MS,
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_LIMIT,
  normalizeCatalogDocument,
  normalizeCatalogEntry,
  readClientRequest,
  endpointFromPath,
  responseEnvelope,
  overriddenNotice,
  withNotice,
  RpcFailure,
})
