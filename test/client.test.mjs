/**
 * Client-half tests for @local/dsh-mcp-manager (frozen contract §6–§8).
 *
 * There is no `node_modules` in this workspace, so `react` and
 * `react-dom/server` are not installable here. Instead this file provides a
 * small, deterministic React substitute (hooks, class components and an error
 * boundary) plus a hostile-tolerant renderer. That still exercises the real
 * module: the module body runs for real inside a `vm` context with a fake
 * `window.__ModuleLoader__`, the real factory is invoked with only the
 * specifiers it may require, the real `apply` registers into fake services, and
 * the registered component is rendered to HTML for both empty and populated
 * states.
 *
 * No third-party dependency is used, so `node test/client.test.mjs` runs
 * anywhere.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.resolve(HERE, '..', 'client', 'client.js');
const CATALOG_PATH = path.resolve(HERE, '..', 'client', 'catalog.json');
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');
/**
 * The shipped offline seed (contract §6): a small list of zero-configuration
 * servers the Host serves with `degraded: true` when both live sources fail.
 * The live registry/npm browsing is provided by the Host and is faked here.
 */
const CATALOG = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Drain timers and immediates: the slash source defers its submit by two ticks. */
const flushTimers = async () => {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};
/** Re-alien values created inside the vm context for strict cross-realm comparison. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const log = (message) => console.log('  ' + message);

// ---------------------------------------------------------------------------
// Minimal React substitute
// ---------------------------------------------------------------------------

function createMiniReact() {
  const Fragment = Symbol('dshmcp.fragment');
  const instances = new Map();
  let current = null;
  let dirty = false;
  let idSeq = 0;
  let hostNodes = [];

  function createElement(type, props, ...children) {
    const next = Object.assign({}, props || {});
    let kids = children;
    if (kids.length === 0 && next.children !== undefined) {
      kids = Array.isArray(next.children) ? next.children : [next.children];
    }
    if (kids.length === 1) next.children = kids[0];
    else if (kids.length > 1) next.children = kids;
    return { type, props: next, key: next.key === undefined ? null : next.key };
  }

  class Component {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }

    setState(update) {
      const patch = typeof update === 'function' ? update(this.state) : update;
      this.state = Object.assign({}, this.state, patch || {});
      dirty = true;
    }
  }

  function instanceAt(key) {
    let instance = instances.get(key);
    if (!instance) {
      instance = { kind: 'function', hooks: [], cursor: 0, instance: null, type: null };
      instances.set(key, instance);
    }
    return instance;
  }

  function hook(index, seed, kind) {
    const instance = current;
    if (!instance) throw new Error('mini-react: hook called outside a component render');
    instance.cursor = index + 1;
    if (!(index in instance.hooks)) instance.hooks[index] = Object.assign({ kind }, seed || {});
    return instance.hooks[index];
  }

  function depsChanged(previous, next) {
    if (!previous || !next || previous.length !== next.length) return true;
    for (let index = 0; index < next.length; index += 1) {
      if (!Object.is(previous[index], next[index])) return true;
    }
    return false;
  }

  function useState(initial) {
    const instance = current;
    const index = instance.cursor;
    const slot = hook(index, null, 'state');
    instance.cursor = index + 1;
    if (!slot.initialized) {
      slot.value = typeof initial === 'function' ? initial() : initial;
      slot.initialized = true;
    }
    const setState = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      dirty = true;
    };
    return [slot.value, setState];
  }

  function useRef(initial) {
    const instance = current;
    const index = instance.cursor;
    const slot = hook(index, null, 'ref');
    instance.cursor = index + 1;
    if (!slot.initialized) {
      slot.value = { current: initial };
      slot.initialized = true;
    }
    return slot.value;
  }

  function useMemo(factory, deps) {
    const instance = current;
    const index = instance.cursor;
    const slot = hook(index, null, 'memo');
    instance.cursor = index + 1;
    if (!slot.initialized || depsChanged(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps ? deps.slice() : null;
      slot.initialized = true;
    }
    return slot.value;
  }

  function useCallback(callback, deps) {
    return useMemo(() => callback, deps);
  }

  function useEffect(effect, deps) {
    const instance = current;
    const index = instance.cursor;
    const slot = hook(index, null, 'effect');
    instance.cursor = index + 1;
    if (!slot.initialized || depsChanged(slot.deps, deps)) {
      slot.fn = effect;
      slot.deps = deps ? deps.slice() : null;
      slot.pending = true;
      slot.initialized = true;
    }
  }

  function useId() {
    idSeq += 1;
    return 'dshmcp-id-' + idSeq;
  }

  const api = {
    createElement,
    Fragment,
    Component,
    useState,
    useRef,
    useMemo,
    useCallback,
    useEffect,
    useId,
  };
  api.displayName = 'mini-react';

  function escapeText(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderElement(element, elementPath) {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return escapeText(String(element));
    if (Array.isArray(element)) {
      return element.map((child, index) => renderElement(child, elementPath + '[' + index + ']')).join('');
    }
    if (typeof element !== 'object') return escapeText(String(element));
    const type = element.type;
    const props = element.props || {};
    const suffix = element.key === null || element.key === undefined ? '' : ':' + String(element.key);
    if (typeof type === 'string') {
      hostNodes.push({ type, props });
      const children = renderElement(props.children, elementPath + '/' + type + suffix);
      const className = props.className ? ' class="' + String(props.className).replace(/"/g, '&quot;') + '"' : '';
      return '<' + type + className + '>' + children + '</' + type + '>';
    }
    if (type === Fragment) return renderElement(props.children, elementPath + '/fragment' + suffix);
    if (typeof type === 'function') {
      const name = (type.displayName || type.name || 'anonymous') + suffix;
      if (type.prototype && typeof type.prototype.render === 'function') {
        return renderClassComponent(type, props, elementPath + '/' + name);
      }
      return renderFunctionComponent(type, props, elementPath + '/' + name);
    }
    throw new Error('mini-react: unsupported element type ' + String(type));
  }

  function renderFunctionComponent(type, props, elementPath) {
    const instance = instanceAt(elementPath);
    instance.cursor = 0;
    const previous = current;
    current = instance;
    let output;
    try {
      output = type(props);
    } finally {
      current = previous;
    }
    return renderElement(output, elementPath + '/out');
  }

  function renderClassComponent(type, props, elementPath) {
    let instance = instances.get(elementPath);
    if (!instance || instance.kind !== 'class' || instance.type !== type) {
      instance = { kind: 'class', hooks: [], cursor: 0, instance: null, type };
      instances.set(elementPath, instance);
      instance.instance = new type(props);
    }
    instance.instance.props = props;
    const catches = typeof instance.instance.componentDidCatch === 'function'
      || typeof type.getDerivedStateFromError === 'function';
    try {
      const output = instance.instance.render();
      return renderElement(output, elementPath + '/out');
    } catch (error) {
      if (!catches) throw error;
      const derived = typeof type.getDerivedStateFromError === 'function'
        ? type.getDerivedStateFromError(error)
        : { error };
      instance.instance.state = Object.assign({}, instance.instance.state, derived);
      if (typeof instance.instance.componentDidCatch === 'function') {
        try {
          instance.instance.componentDidCatch(error, { componentStack: '' });
        } catch (ignored) {
          // A boundary hook that throws must not escape.
        }
      }
      return renderElement(instance.instance.render(), elementPath + '/boundary');
    }
  }

  function runEffects() {
    for (const instance of instances.values()) {
      for (const slot of instance.hooks) {
        if (!slot || slot.kind !== 'effect' || slot.pending !== true) continue;
        slot.pending = false;
        if (typeof slot.cleanup === 'function') {
          try {
            slot.cleanup();
          } catch (ignored) {
            // A cleanup failure is not a render failure.
          }
          slot.cleanup = null;
        }
        const cleanup = slot.fn();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
      }
    }
  }

  function render(element) {
    let html = '';
    let rounds = 0;
    dirty = true;
    while (rounds < 40) {
      rounds += 1;
      if (dirty) {
        dirty = false;
        hostNodes = [];
        html = renderElement(element, 'root');
      }
      runEffects();
      if (!dirty) break;
    }
    return html;
  }

  function unmountAll() {
    for (const instance of instances.values()) {
      for (const slot of instance.hooks) {
        if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
          try {
            slot.cleanup();
          } catch (ignored) {
            // ignore
          }
          slot.cleanup = null;
        }
      }
      if (instance.instance && typeof instance.instance.componentWillUnmount === 'function') {
        try {
          instance.instance.componentWillUnmount();
        } catch (ignored) {
          // ignore
        }
      }
    }
  }

  function childText(children) {
    if (typeof children === 'string' || typeof children === 'number') return String(children);
    if (Array.isArray(children)) return children.map(childText).join('');
    return '';
  }

  return {
    api,
    jsxRuntime: { jsx: createElement, jsxs: createElement, Fragment },
    render,
    unmountAll,
    nodes: () => hostNodes.slice(),
    find: (predicate) => hostNodes.find(predicate),
    findAll: (predicate) => hostNodes.filter(predicate),
    findByClass: (name) => hostNodes.find((node) => String(node.props.className || '').split(/\s+/).includes(name)),
    findAllByClass: (name) => hostNodes.filter((node) => String(node.props.className || '').split(/\s+/).includes(name)),
    findAllByText: (text) => hostNodes.filter((node) => childText(node.props.children).includes(text)),
    findByText: (text) => hostNodes.find((node) => childText(node.props.children).includes(text)),
    click: (node) => {
      assert.ok(node, 'click target must exist');
      assert.equal(typeof node.props.onClick, 'function', 'click target must have an onClick handler');
      node.props.onClick({ target: {}, preventDefault() {}, stopPropagation() {} });
    },
    type: (node, value) => {
      assert.ok(node, 'type target must exist');
      assert.equal(typeof node.props.onChange, 'function', 'type target must have an onChange handler');
      node.props.onChange({ target: { value } });
    },
  };
}

// ---------------------------------------------------------------------------
// Fake browser context (slots / locale / connection / effect)
// ---------------------------------------------------------------------------

function createFakeContext(options) {
  const dicts = new Map();
  const registered = [];
  const injected = [];
  const effects = [];

  function resolve(ns, key, params) {
    const table = dicts.get(ns) || {};
    const active = options.active || 'zh';
    const candidates = [active, active.toLowerCase().startsWith('zh') ? 'en' : 'zh'];
    for (const locale of candidates) {
      const value = table[locale] && table[locale][key];
      if (typeof value === 'string') {
        if (!params) return value;
        return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
      }
    }
    return key;
  }

  const ctx = {
    locale: {
      register(ns, pair) {
        dicts.set(ns, Object.assign({}, dicts.get(ns) || {}, pair));
        return () => {};
      },
      bind(ns) {
        return (key, params) => resolve(ns, key, params);
      },
      getSnapshot() {
        return { active: options.active || 'zh', revision: 0 };
      },
      subscribe() {
        return () => {};
      },
    },
    slots: {
      inject(key, callback) {
        injected.push(key);
        return callback();
      },
      register(registration, component) {
        registered.push({ options: registration, component });
        return () => {};
      },
      entries() {
        return [];
      },
      getVersion() {
        return 0;
      },
      subscribe() {
        return () => {};
      },
    },
    connection: { rpc: { call: options.rpcCall } },
    effect(callback) {
      const disposer = callback();
      effects.push(typeof disposer === 'function' ? disposer : () => {});
      return () => {};
    },
    on() {
      return () => {};
    },
    logger: { error() {}, warn() {}, info() {} },
  };

  return { ctx, dicts, registered, injected, effects };
}

/** Load client.js in a vm, materialize the factory, run apply. */
function boot(options = {}) {
  const loaderRegistrations = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          loaderRegistrations.push(registration);
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client/client.js' });

  assert.equal(loaderRegistrations.length, 1, 'client.js must call window.__ModuleLoader__.load exactly once');
  const registration = loaderRegistrations[0];
  const react = createMiniReact();
  const required = [];
  const requireStub = (specifier) => {
    required.push(specifier);
    if (specifier === 'react') return react.api;
    if (specifier === 'react/jsx-runtime') return react.jsxRuntime;
    throw new Error('client.js required a forbidden module: ' + specifier);
  };
  const moduleExports = registration.factory(requireStub);

  const calls = [];
  const rpcCall = async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload });
    return options.rpc(endpoint, payload, calls.length);
  };
  const fake = createFakeContext({ active: options.active || 'zh', rpcCall });
  moduleExports.apply(fake.ctx);

  const registerdTab = fake.registered[0];
  assert.ok(registerdTab, 'apply must register exactly one settings.plugins.tab entry');
  const element = react.api.createElement(registerdTab.component, {});
  return { registration, moduleExports, react, required, fake, calls, element };
}

// ---------------------------------------------------------------------------
// Synthetic live catalog (t15): the fake Host answers the §6 `catalog` contract
// with two sources, offset pagination, search, a degraded mode and a failure
// mode, so every browsing path is exercised without touching the network.
// ---------------------------------------------------------------------------

function liveEntry(prefix, index, overrides) {
  return Object.assign({
    id: prefix + '.example/server-' + index,
    title: { zh: '演示服务器 ' + index, en: 'Demo server ' + index },
    description: { zh: '第 ' + index + ' 个演示条目。', en: 'Demo entry number ' + index + '.' },
    category: prefix + '.example',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@demo/server-' + index],
    origin: 'registry',
    packageId: 'npm:@demo/server-' + index,
    docs: 'https://example.com/server-' + index,
  }, overrides || {});
}

/** 28 registry entries → two pages at the contract default limit of 24. */
const REGISTRY_POOL = [
  // A token-required entry drives the env form (secret → password input).
  liveEntry('io.github', 0, {
    title: { zh: '需要令牌的服务器', en: 'Token server' },
    envKeys: [{
      key: 'DEMO_TOKEN',
      label: { zh: '演示令牌', en: 'Demo token' },
      required: true,
      placeholder: 'demo_…',
      secret: true,
    }],
  }),
  // An official entry drives the "official" badge.
  liveEntry('io.github', 1, { official: true, title: { zh: '官方演示服务器', en: 'Official demo server' } }),
  // No `origin` at all: the card must fall back to the source that served it.
  liveEntry('originless.example', 2, {
    origin: undefined,
    title: { zh: '无来源条目', en: 'Originless entry' },
    packageId: undefined,
  }),
].concat(Array.from({ length: 25 }, (unused, index) => liveEntry('io.github', index + 3)));

/** npm entries carry the popularity signal: monthly downloads and score. */
const NPM_POOL = [
  liveEntry('npm', 0, {
    origin: 'npm',
    packageId: 'npm:demo-popular',
    downloadsMonthly: 730000,
    score: 0.87,
    title: { zh: '热门 npm 包', en: 'Popular npm package' },
  }),
  liveEntry('npm', 1, {
    origin: 'npm',
    packageId: 'npm:demo-small',
    downloadsMonthly: 1200,
    score: 0.51,
    title: { zh: '小众 npm 包', en: 'Small npm package' },
  }),
  liveEntry('npm', 2, {
    origin: 'npm',
    packageId: 'npm:demo-malformed',
    // Hostile payload: wrong types everywhere, still must not throw (t15).
    transport: 'streamable-http',
    url: 'https://npm.example/mcp',
    title: 'plain string title',
    description: null,
    category: '',
    downloadsMonthly: 'not-a-number',
    score: {},
    official: 'yes',
  }),
];

function catalogHaystack(entry) {
  return [
    entry.id,
    entry.packageId,
    entry.category,
    entry.title && entry.title.zh,
    entry.title && entry.title.en,
    entry.description && entry.description.zh,
    entry.command,
    entry.url,
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();
}

/** The §6 `catalog` value for one request. */
function catalogPage(payload) {
  const source = payload && payload.source === 'npm' ? 'npm' : 'registry';
  const pool = source === 'npm' ? NPM_POOL : REGISTRY_POOL;
  const query = typeof (payload && payload.query) === 'string' ? payload.query.trim().toLowerCase() : '';
  const matched = query === '' ? pool : pool.filter((entry) => catalogHaystack(entry).includes(query));
  const rawLimit = payload && payload.limit;
  const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(50, Math.floor(rawLimit)) : 24;
  const cursor = typeof (payload && payload.cursor) === 'string' ? payload.cursor : '';
  const offset = Number((cursor.split(':')[1] || '0')) || 0;
  const entries = matched.slice(offset, offset + limit);
  const next = offset + limit;
  const hasMore = next < matched.length;
  return {
    source,
    entries,
    nextCursor: hasMore ? 'offset:' + next : null,
    total: matched.length,
    hasMore,
    degraded: false,
    fetchedAt: '2026-10-04T00:00:00.000Z',
  };
}

/** A stateful Host stand-in: servers + the live `catalog` endpoint. */
function createHost(seedServers, options = {}) {
  let live = seedServers.slice();
  let failNext = null;
  let catalogMode = options.catalog || 'live';
  let totalHidden = false;
  const catalogCalls = [];
  return {
    setFailure(failure) {
      failNext = failure;
    },
    failCatalog() {
      catalogMode = 'fail';
    },
    /** The real registry always reports `total: null` (t14 hand-off). */
    hideTotal() {
      totalHidden = true;
    },
    degradeCatalog() {
      catalogMode = 'degraded';
    },
    liveCatalog() {
      catalogMode = 'live';
    },
    catalogCalls: () => catalogCalls.slice(),
    servers: () => live,
    rpc(endpoint, payload) {
      if (failNext) {
        const next = failNext;
        failNext = null;
        return next;
      }
      if (endpoint === 'catalog') {
        catalogCalls.push(payload);
        if (catalogMode === 'fail') return { ok: false, error: { code: 'internal', message: 'catalog unavailable' } };
        const page = catalogPage(payload);
        if (totalHidden) page.total = null;
        if (catalogMode === 'degraded') {
          return {
            ok: true,
            value: Object.assign({}, page, {
              degraded: true,
              entries: CATALOG.map((entry) => Object.assign({}, entry, { origin: 'seed' })),
              nextCursor: null,
              hasMore: false,
              total: CATALOG.length,
            }),
          };
        }
        return { ok: true, value: page };
      }
      if (endpoint === 'list') return { ok: true, value: { servers: live, managedRoot: '/Users/example/.dsh/mcp-servers' } };
      if (endpoint === 'remove') {
        live = live.filter((server) => server.id !== payload.id);
        return { ok: true, value: { servers: live } };
      }
      if (endpoint === 'update') {
        if (payload.toggle) {
          const enabled = payload.toggle === 'enable';
          live = live.map((server) => (server.id === payload.id
            ? Object.assign({}, server, { enabled, phase: enabled ? 'active' : null, status: enabled ? 'connected' : 'disabled' })
            : server));
          return { ok: true, value: { servers: live, disabled: !enabled } };
        }
        live = live.map((server) => (server.id === payload.id
          ? Object.assign({}, server, {
            // §3a: an empty displayName clears the label, so the Host falls back
            // to serverName — mirror that here.
            label: payload.input.displayName || server.name,
            config: Object.assign({}, server.config, {
              command: payload.input.command || server.config.command,
              args: payload.input.args || server.config.args,
            }),
          })
          : server));
        return { ok: true, value: { servers: live, disabled: false } };
      }
      if (endpoint === 'add') {
        const input = payload.input;
        live = live.concat([{
          id: input.name,
          name: input.name,
          label: input.displayName || input.name,
          transport: input.transport,
          enabled: true,
          phase: 'active',
          managed: true,
          readOnlyReason: null,
          status: 'connected',
          statusDetail: null,
          bundle: '@local/dsh-mcp-' + input.name,
          config: {
            command: input.command || null,
            args: input.args || [],
            env: input.env || {},
            cwd: input.cwd || null,
            url: input.url || null,
            headers: input.headers || {},
            failOnStartupError: true,
          },
        }]);
        return { ok: true, value: { servers: live, created: input.name } };
      }
      return { ok: false, error: { code: 'invalid-request', message: 'unknown endpoint ' + String(endpoint) } };
    },
  };
}

function serverFixture(overrides) {
  return Object.assign({
    id: 'alpha',
    name: 'alpha',
    label: 'Alpha 服务器',
    transport: 'stdio',
    enabled: true,
    phase: 'active',
    managed: true,
    readOnlyReason: null,
    status: 'connected',
    statusDetail: null,
    bundle: '@local/dsh-mcp-alpha',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: { MEMORY_FILE_PATH: '/tmp/memory.json' },
      cwd: null,
      url: null,
      headers: {},
      failOnStartupError: true,
    },
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// 1. Module face and source-level constraints
// ---------------------------------------------------------------------------

console.log('client/client.js');

const host = createHost([serverFixture()]);
const booted = boot({ rpc: host.rpc });
const { registration, moduleExports, fake, required } = booted;

assert.equal(registration.id, '@local/dsh-mcp-manager', 'module id must equal the package name');
assert.equal(typeof registration.factory, 'function');
assert.equal(moduleExports.name, '@local/dsh-mcp-manager');
assert.deepEqual(plain(moduleExports.inject), ['slots', 'connection', 'locale'], 'inject is the activation gate');
assert.equal(typeof moduleExports.apply, 'function');
assert.deepEqual([...new Set(required)], ['react'], 'client.js may require only react');
for (const specifier of required) {
  assert.ok(!specifier.startsWith('@deepseek-ai/'), 'a @deepseek-ai/* package must never be required: ' + specifier);
}
log('module face: id/name/inject/apply + require set OK');

assert.ok(!/require\((['"])@deepseek-ai/.test(SOURCE), 'no @deepseek-ai/* require anywhere in the source');
assert.ok(!/dsh-client-ui-primitives/.test(SOURCE), 'no ui-primitives reference');
assert.ok(!/document\s*\.\s*(body|head)\s*\.\s*appendChild/.test(SOURCE), 'no DOM outside the component');
assert.ok(SOURCE.includes("window.__ModuleLoader__.load("), 'registered through the module loader');
log('source: no forbidden imports, no DOM writes');

const hexColors = SOURCE.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
assert.deepEqual(hexColors, [], 'no literal hex colors');
assert.equal(/(^|[^a-z])rgba?\(/i.test(SOURCE), false, 'no literal rgb() colors');
assert.equal(/(^|[^a-z])hsla?\(/i.test(SOURCE), false, 'no literal hsl() colors');
const cssRegion = SOURCE.slice(SOURCE.indexOf('const CSS = ['), SOURCE.indexOf("].join('')"));
assert.ok(cssRegion.length > 0);
for (const match of cssRegion.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) {
  assert.ok(match[1].startsWith('dshmcp'), 'CSS selector must use the dshmcp prefix: .' + match[1]);
}
for (const match of cssRegion.matchAll(/--([A-Za-z][A-Za-z0-9-]*)/g)) {
  assert.ok(match[1].startsWith('dsw'), 'CSS custom property must be a --dsw-* token: --' + match[1]);
}
for (const match of SOURCE.matchAll(/className:\s*'([^']+)'/g)) {
  for (const token of match[1].split(/\s+/).filter(Boolean)) {
    assert.ok(token.startsWith('dshmcp'), 'class must use the dshmcp prefix: ' + token);
  }
}
log('styles: --dsw-* tokens only, every class prefixed dshmcp');

// ---------------------------------------------------------------------------
// 2. Tab registration
// ---------------------------------------------------------------------------

assert.deepEqual(fake.injected, ['settings.plugins.tab'], 'exactly one slot is injected');
assert.equal(fake.registered.length, 1, 'exactly one slot registration');
const tabOptions = fake.registered[0].options;
assert.equal(tabOptions.name, 'settings.plugins.tab');
assert.equal(tabOptions.id, 'mcp-manager', 'the tab id must be the fresh mcp-manager id');
assert.notEqual(tabOptions.id, 'all', 'the shipped all tab must never be replaced');
assert.equal(tabOptions.order, 20);
assert.equal(typeof tabOptions.label, 'function');
assert.equal(tabOptions.label(), 'MCP');
assert.equal(tabOptions.locale, moduleExports.internals.NS);
assert.ok(fake.effects.length >= 1, 'the dictionary registration is an owned effect');
log('slot registration: settings.plugins.tab/mcp-manager order 20, label MCP');

// ---------------------------------------------------------------------------
// 3. Dictionaries and catalog shape
// ---------------------------------------------------------------------------

const internals = moduleExports.internals;
assert.ok(internals && typeof internals === 'object', 'internals surface exists');
const { zh, en } = internals.dictionaries;
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en dictionaries must share one key set');
const registeredDicts = fake.dicts.get(internals.NS);
assert.ok(registeredDicts, 'dictionaries are registered under the dshMcpManager namespace');
assert.deepEqual(Object.keys(registeredDicts.zh).sort(), Object.keys(registeredDicts.en).sort());
for (const key of ['tab', 'title', 'catalogTitle', 'add', 'install', 'errorInvalidRequest', 'errorNetwork']) {
  assert.equal(typeof zh[key], 'string', 'zh dictionary is missing ' + key);
  assert.equal(typeof en[key], 'string', 'en dictionary is missing ' + key);
}
for (const key of Object.values(internals.errorKeys)) {
  assert.equal(typeof zh[key], 'string', 'error code mapping target missing from zh: ' + key);
  assert.equal(typeof en[key], 'string', 'error code mapping target missing from en: ' + key);
}
log('dictionaries: ' + Object.keys(zh).length + ' keys, zh/en key sets identical, error codes covered');

// ---------------------------------------------------------------------------
// 3b. t6/O5 + O6 — no dead theme tokens or dictionary keys, mono fallback stack
// ---------------------------------------------------------------------------

for (const dead of ['loading', 'save', 'editTitle', 'installDone', 'requiredMark']) {
  assert.equal(dead in internals.dictionaries.zh, false, 'dead zh dictionary key still present: ' + dead);
  assert.equal(dead in internals.dictionaries.en, false, 'dead en dictionary key still present: ' + dead);
}
const tokenStart = SOURCE.indexOf('const T = {');
const tokenEnd = SOURCE.indexOf('\n    };', tokenStart);
assert.ok(tokenStart > 0 && tokenEnd > tokenStart, 'the theme-token block must exist');
const tokenBlock = SOURCE.slice(tokenStart, tokenEnd);
const tokenNames = [...tokenBlock.matchAll(/^\s{6}([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
assert.ok(tokenNames.length > 10, 'the token table keeps its content');
for (const name of tokenNames) {
  if (name === 'mono') continue; // referenced through styles.mono, checked below
  assert.ok(new RegExp('T\\.' + name + '\\b').test(SOURCE), 'unused theme-token constant: T.' + name);
}
for (const dead of ['labelDimmed', 'elevationSoft', 'buttonPrimaryHover', 'interactiveHover', 'interactiveHoverDanger']) {
  assert.equal(tokenNames.includes(dead), false, 'dead token constant still declared: T.' + dead);
}
assert.ok(
  SOURCE.includes('var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'),
  '--dsw-font-mono must carry the ui-monospace/SF Mono fallback stack (t6/O5)',
);
log('dead code: no unused token constants or dictionary keys, mono fallback stack (t6/O5/O6)');

/** Full §7 shape validation, shared by the shipped file and the offline seed. */
function validateCatalog(entries, label, options = {}) {
const ids = new Set();
const categories = new Set();
let httpEntries = 0;
let requiredTokenEntries = 0;
for (const entry of entries) {
  assert.ok(entry && typeof entry === 'object', 'catalog entry must be an object');
  assert.equal(typeof entry.id, 'string');
  assert.ok(entry.id.length > 0 && /^[A-Za-z0-9_-]+$/.test(entry.id), 'bad catalog id: ' + entry.id);
  assert.ok(!ids.has(entry.id), 'duplicate catalog id: ' + entry.id);
  ids.add(entry.id);
  assert.equal(typeof entry.category, 'string');
  assert.ok(entry.category.length > 0);
  categories.add(entry.category);
  for (const lang of ['zh', 'en']) {
    assert.equal(typeof (entry.title || {})[lang], 'string', entry.id + ' title.' + lang + ' must be a string');
    assert.ok(entry.title[lang].length > 0, entry.id + ' title.' + lang + ' must not be empty');
    assert.equal(typeof (entry.description || {})[lang], 'string', entry.id + ' description.' + lang);
    assert.ok(entry.description[lang].length > 0, entry.id + ' description.' + lang + ' must not be empty');
  }
  assert.ok(entry.transport === 'stdio' || entry.transport === 'streamable-http', entry.id + ' transport must be legal');
  if (entry.transport === 'stdio') {
    assert.equal(typeof entry.command, 'string', entry.id + ' (stdio) needs a command');
    assert.ok(entry.command.length > 0);
    if (entry.args !== undefined) {
      assert.ok(Array.isArray(entry.args), entry.id + ' args must be an array');
      for (const arg of entry.args) assert.equal(typeof arg, 'string');
    }
    assert.equal(entry.url, undefined, entry.id + ' (stdio) must not carry a url');
  } else {
    httpEntries += 1;
    assert.equal(typeof entry.url, 'string', entry.id + ' (http) needs a url');
    assert.ok(/^https?:\/\//.test(entry.url), entry.id + ' url must be absolute: ' + entry.url);
    assert.equal(entry.command, undefined, entry.id + ' (http) must not carry a command');
  }
  if (entry.envKeys !== undefined) {
    assert.ok(Array.isArray(entry.envKeys), entry.id + ' envKeys must be an array');
    for (const envKey of entry.envKeys) {
      assert.equal(typeof envKey.key, 'string');
      assert.ok(/^[A-Z][A-Z0-9_]*$/.test(envKey.key), entry.id + ' env key must be an env var name: ' + envKey.key);
      assert.ok(envKey.label && typeof envKey.label.zh === 'string' && envKey.label.zh.length > 0, entry.id + ' envKey needs label.zh');
      assert.ok(envKey.label && typeof envKey.label.en === 'string' && envKey.label.en.length > 0, entry.id + ' envKey needs label.en');
      assert.equal(typeof envKey.required, 'boolean', entry.id + ' envKey.required must be boolean');
      if (envKey.placeholder !== undefined) assert.equal(typeof envKey.placeholder, 'string');
      if (envKey.secret !== undefined) assert.equal(typeof envKey.secret, 'boolean');
      if (envKey.required === true) requiredTokenEntries += 1;
    }
  }
  if (entry.docs !== undefined) assert.ok(/^https?:\/\//.test(entry.docs), entry.id + ' docs must be a URL');
  if (entry.origin !== undefined) {
    assert.ok(['registry', 'npm', 'seed'].includes(entry.origin), entry.id + ' origin must be registry|npm|seed');
  }
  if (entry.packageId !== undefined) assert.equal(typeof entry.packageId, 'string');
  if (entry.downloadsMonthly !== undefined && entry.downloadsMonthly !== null) {
    assert.equal(typeof entry.downloadsMonthly, 'number', entry.id + ' downloadsMonthly must be a number');
  }
  if (entry.score !== undefined && entry.score !== null) {
    assert.equal(typeof entry.score, 'number', entry.id + ' score must be a number');
  }
  if (entry.official !== undefined) assert.equal(typeof entry.official, 'boolean', entry.id + ' official must be boolean');
}
assert.equal(httpEntries >= 1, true, label + ' needs at least one streamable-http entry');
if (options.requireToken === true) {
  assert.equal(requiredTokenEntries >= 1, true, label + ' needs at least one token-required entry');
}
for (const entry of entries) {
  for (const lang of ['zh', 'en']) {
    const table = lang === 'zh' ? zh : en;
    assert.equal(typeof table['category_' + entry.category], 'string',
      label + ' category "' + entry.category + '" has no ' + lang + ' dictionary key');
  }
}
if (options.minimum !== undefined) {
  assert.ok(entries.length >= options.minimum, label + ' must ship at least ' + options.minimum + ' entries, got ' + entries.length);
}
return { categories: categories.size, httpEntries, requiredTokenEntries };
}

// `client/catalog.json` is the offline seed the Host serves with degraded:true.
assert.ok(Array.isArray(CATALOG), 'client/catalog.json must parse to an array');
const catalog = CATALOG;
const fileStats = validateCatalog(catalog, 'client/catalog.json', { minimum: 3 });
for (const entry of catalog) {
  assert.equal(entry.origin, 'seed', 'an offline seed entry must declare origin=seed: ' + entry.id);
  const required = (entry.envKeys || []).filter((key) => key.required === true);
  assert.equal(required.length, 0, 'the offline seed must install without credentials: ' + entry.id);
}

// The catalog's test-friendly server must be present exactly as t5 needs it.
const everything = catalog.find((entry) => entry.id === 'everything');
assert.ok(everything, 'the seed must ship the zero-credential test server');
assert.equal(everything.transport, 'stdio');
assert.equal(everything.command, 'npx');
assert.deepEqual(everything.args, ['-y', '@modelcontextprotocol/server-everything']);
assert.equal(everything.envKeys, undefined, 'the everything server needs no credentials');
log('catalog.json (offline seed): ' + catalog.length + ' entries, ' + fileStats.categories + ' categories, shapes complete');

// The embedded seed is the same offline list, used when the endpoint itself
// fails; both must stay legal and identical in content.
const seed = internals.catalogSeed;
assert.ok(Array.isArray(seed), 'the embedded seed is an array');
assert.ok(seed.length >= 3 && seed.length <= 8, 'the seed stays small, got ' + seed.length);
validateCatalog(seed, 'CATALOG_SEED');
for (const entry of seed) {
  assert.equal(entry.origin, 'seed', 'the embedded seed entry must declare origin=seed: ' + entry.id);
}
assert.deepEqual(
  [...seed.map((entry) => entry.id)].sort(),
  catalog.map((entry) => entry.id).sort(),
  'the embedded seed and client/catalog.json must ship the same offline servers',
);
assert.ok(seed.some((entry) => entry.id === 'everything'), 'the seed keeps the zero-credential server for offline use');
log('catalog seed: ' + seed.length + ' entries, identical to client/catalog.json, shapes complete');

// ---------------------------------------------------------------------------
// 4. Render — loading skeleton, then empty state
// ---------------------------------------------------------------------------

const emptyHost = createHost([]);
const empty = boot({ rpc: emptyHost.rpc });
let html = empty.react.render(empty.element);
assert.ok(html.includes('class="dshmcp-card dshmcp-skeleton"'), 'the first pass must render the loading skeleton');
assert.ok(html.includes('公共 MCP 目录'), 'the public catalog section renders immediately');
assert.ok(!html.includes('还没有 MCP 服务器'), 'the empty state waits for the list result');
await settle();
html = empty.react.render(empty.element);
assert.ok(html.includes('还没有 MCP 服务器'), 'empty state after an empty list');
assert.ok(html.includes('class="dshmcp-empty"'), 'an explicit empty-state block');
assert.ok(html.includes('官方演示服务器'), 'the live registry page renders cards');
assert.ok(!html.includes('class="dshmcp-card dshmcp-skeleton"'), 'the skeleton is gone once loaded');
assert.ok(empty.calls.some((call) => call.endpoint === 'catalog' && call.channel === '/dsh-mcp-rpc'),
  'the catalog is loaded through the connection RPC endpoint');
const catalogCall = empty.calls.find((call) => call.endpoint === 'catalog');
assert.deepEqual(plain(catalogCall.payload), { source: 'registry', query: '', cursor: null, limit: 24 },
  'the first catalog request is the registry browse page (contract §6)');
assert.ok(html.includes('官方演示服务器'), 'the live registry page is what renders');
assert.ok(html.includes('需要令牌的服务器'), 'the token-required live entry renders');
assert.ok(html.includes('一键安装'), 'zero-configuration entries are marked as one-click installs');
assert.ok(!html.includes('目录服务不可用'), 'no offline hint while the endpoint answers');
assert.ok(html.includes('共 28 个结果'), 'the source-reported total is displayed');
empty.react.unmountAll();
log('render (empty): skeleton → empty state, live registry page from the endpoint');

// ---------------------------------------------------------------------------
// 4b. Catalog source: endpoint wins; the embedded seed is fallback-only
// ---------------------------------------------------------------------------

const seedHost = createHost([]);
seedHost.failCatalog();
const seedBoot = boot({ rpc: seedHost.rpc });
seedBoot.react.render(seedBoot.element);
await settle();
html = seedBoot.react.render(seedBoot.element);
assert.ok(html.includes('目录服务不可用，显示离线种子'), 'a failed catalog endpoint surfaces the offline hint');
assert.ok(html.includes('Everything 测试服务器'), 'the embedded seed renders when the endpoint fails');
assert.ok(html.includes('离线种子'), 'the seed cards carry the offline-seed origin badge');
assert.ok(!html.includes('官方演示服务器'), 'seed-only mode never shows live entries');
seedBoot.react.unmountAll();
log('catalog source: endpoint failure → embedded seed renders');

// `degraded: true` (the Host served the seed after both live sources failed)
// must be stated explicitly and never look like a live result.
const degradedHost = createHost([]);
degradedHost.degradeCatalog();
const degraded = boot({ rpc: degradedHost.rpc });
degraded.react.render(degraded.element);
await settle();
html = degraded.react.render(degraded.element);
assert.ok(html.includes('目录服务不可用，显示离线种子'), 'degraded:true shows the offline notice');
assert.ok(html.includes('离线种子'), 'degraded cards are badged as the offline seed');
assert.ok(!html.includes('官方演示服务器'), 'a degraded page never shows live entries');
assert.equal(degraded.react.findByClass('dshmcp-load-more'), undefined, 'a degraded page offers no further page');
degraded.react.unmountAll();
log('catalog source: degraded:true → explicit offline notice, no live entries');

// ---------------------------------------------------------------------------
// 4c. Live registry browser (t15): card info, sources, paging, search, refresh
// ---------------------------------------------------------------------------

const browseHost = createHost([]);
const browse = boot({ rpc: browseHost.rpc });
const catalogCalls = () => browse.calls.filter((call) => call.endpoint === 'catalog');
const installCards = () => browse.react.findAllByClass('dshmcp-install-btn').length;
/**
 * One interaction cycle. The harness runs effects inside `render()`, so a click
 * needs render → settle → render to observe the response.
 */
const cycle = async () => {
  browse.react.render(browse.element);
  await settle();
  return browse.react.render(browse.element);
};
/**
 * Type → arm the debounce timer (effects run in render) → wait past 350ms →
 * let the debounced value issue the request → render the response.
 */
const afterDebounce = async () => {
  browse.react.render(browse.element);
  await new Promise((resolve) => setTimeout(resolve, 460));
  return cycle();
};

html = await cycle();

// --- card information: enough to judge whether a card is worth installing ---
assert.ok(html.includes('npm:@demo/server-0'), 'the card shows its packageId');
assert.ok(html.includes('Registry'), 'a registry card carries the Registry origin badge');
assert.ok(html.includes('官方'), 'an official registry entry is badged');
assert.ok(html.includes('STDIO'), 'the transport badge is rendered');
assert.ok(html.includes('需要令牌'), 'a token-required entry is badged instead of claiming one-click');
assert.ok(html.includes('一键安装'), 'a zero-configuration entry is badged one-click');
assert.ok(html.includes('第 2 个演示条目。'), 'the description is rendered');
assert.ok(!html.includes('月下载'), 'a registry card without downloads renders no placeholder');
assert.ok(!html.includes('评分'), 'a registry card without a score renders no placeholder');
log('catalog cards: title/description/packageId/origin/official/transport/token badges');

// --- source switch: npm carries downloads + score ---------------------------
const sourceTabs = browse.react.findAllByClass('dshmcp-segment-item');
assert.equal(sourceTabs.length, 2, 'a registry/npm segmented control is rendered');
assert.equal(sourceTabs[0].props['aria-selected'], 'true', 'registry is the default source');
assert.equal(sourceTabs[1].props['aria-selected'], 'false');
browse.react.click(sourceTabs[1]);
html = await cycle();
const npmCall = catalogCalls().pop();
assert.equal(npmCall.payload.source, 'npm', 'the npm source is requested');
assert.equal(npmCall.payload.query, '', 'switching source keeps the query');
assert.equal(npmCall.payload.cursor, null, 'switching source resets the cursor');
assert.ok(html.includes('月下载 73万'), 'monthly downloads are human readable (73万)');
assert.ok(html.includes('月下载 1.2k'), 'monthly downloads scale down (1.2k)');
assert.ok(html.includes('评分 0.87'), 'the npm score is rendered');
assert.ok(html.includes('npm'), 'npm cards are badged npm');
assert.ok(html.includes('Popular npm package') === false, 'the en title is not used while zh is active');
assert.ok(!html.includes('官方演示服务器'), 'the registry page is replaced, not merged');
assert.equal(installCards(), 3, 'a malformed entry still renders a card (no throw)');
assert.equal(html.split('月下载').length - 1, 2, 'a non-numeric downloads value renders no placeholder');
assert.equal(html.split('评分').length - 1, 2, 'a non-object score renders no placeholder');
log('catalog source: npm page with downloads/score, malformed entry tolerated');

// --- back to registry -------------------------------------------------------
browse.react.click(browse.react.findAllByClass('dshmcp-segment-item')[0]);
html = await cycle();
assert.equal(catalogCalls().pop().payload.source, 'registry', 'switching back requests registry again');
assert.equal(installCards(), 24, 'the registry first page holds the contract default of 24 entries');
log('catalog source: switching back resets the list');

// --- pagination: append, never replace --------------------------------------
assert.ok(browse.react.findByClass('dshmcp-load-more'), 'a nextCursor offers load more');
browse.react.click(browse.react.findByClass('dshmcp-load-more'));
html = browse.react.render(browse.element);
assert.ok(html.includes('加载中…'), 'load more shows a progress state');
assert.equal(browse.react.findByClass('dshmcp-load-more').props.disabled, true,
  'load more is disabled while the page is in flight');
await settle();
html = browse.react.render(browse.element);
assert.equal(catalogCalls().pop().payload.cursor, 'offset:24', 'load more uses the returned cursor');
assert.equal(installCards(), 28, 'the next page is appended to the list, not swapped in');
assert.ok(html.includes('已经到底了'), 'the end of the result set is stated');
assert.equal(browse.react.findByClass('dshmcp-load-more'), undefined, 'no further page is offered at the end');
log('catalog paging: 24 → 28 appended, end-of-list stated');

// --- the same cursor is never requested twice -------------------------------
const doubleHost = createHost([]);
const doubleBoot = boot({ rpc: doubleHost.rpc });
doubleBoot.react.render(doubleBoot.element);
await settle();
doubleBoot.react.render(doubleBoot.element);
const doubleMore = doubleBoot.react.findByClass('dshmcp-load-more');
doubleBoot.react.click(doubleMore);
doubleBoot.react.click(doubleMore);
doubleBoot.react.render(doubleBoot.element);
await settle();
doubleBoot.react.render(doubleBoot.element);
assert.deepEqual(
  doubleBoot.calls.filter((call) => call.endpoint === 'catalog' && call.payload.cursor).map((call) => call.payload.cursor),
  ['offset:24'],
  'a second click before the response lands does not refetch the same cursor',
);
doubleBoot.react.unmountAll();
log('catalog paging: the same cursor is requested at most once');

// --- search: debounced, with a total ----------------------------------------
const searchBox = browse.react.findAll((node) => node.type === 'input' && node.props.type === 'search')[0];
const beforeTyping = catalogCalls().length;
browse.react.type(searchBox, 'server-27');
browse.react.render(browse.element);
assert.equal(catalogCalls().length, beforeTyping, 'typing does not query immediately (debounce ≥300ms)');
html = await afterDebounce();
const searchCall = catalogCalls().pop();
assert.equal(searchCall.payload.query, 'server-27', 'the debounced query reaches the endpoint');
assert.equal(searchCall.payload.cursor, null, 'a new query resets the cursor');
assert.ok(html.includes('共 1 个结果'), 'the source-reported total is displayed for a search');
assert.ok(html.includes('演示服务器 27'), 'the matching entry is rendered');
assert.ok(!html.includes('官方演示服务器'), 'non-matching entries are gone');
log('catalog search: 350ms debounce, endpoint query, total shown');

// --- a query survives a source switch ---------------------------------------
browse.react.click(browse.react.findAllByClass('dshmcp-segment-item')[1]);
html = await cycle();
const switched = catalogCalls().pop();
assert.equal(switched.payload.source, 'npm', 'the source switched');
assert.equal(switched.payload.query, 'server-27', 'the search term survives the switch');
assert.equal(switched.payload.cursor, null, 'the cursor is reset by the switch');

// --- clearing the search returns to the default browse listing --------------
browse.react.type(searchBox, '');
html = await afterDebounce();
const cleared = catalogCalls().pop();
assert.equal(cleared.payload.query, '', 'clearing the box queries the default listing');
assert.equal(cleared.payload.cursor, null);
assert.equal(installCards(), 3, 'the npm source shows its own entries again');
log('catalog search: clearing returns to the default browse listing');

// --- refresh: refetch the current (source, query) first page, replace -------
browse.react.type(searchBox, 'demo-small');
html = await afterDebounce();
assert.equal(catalogCalls().pop().payload.query, 'demo-small', 'the npm search is applied');
assert.equal(installCards(), 1, 'the npm search narrows the page');
browse.react.click(browse.react.findByClass('dshmcp-catalog-refresh'));
html = browse.react.render(browse.element);
assert.ok(html.includes('刷新中…'), 'refresh shows a progress state');
assert.equal(browse.react.findByClass('dshmcp-catalog-refresh').props.disabled, true,
  'the refresh control is disabled while refreshing');
await settle();
html = browse.react.render(browse.element);
const refreshCall = catalogCalls().pop();
assert.equal(refreshCall.payload.query, 'demo-small', 'refresh refetches the current query');
assert.equal(refreshCall.payload.cursor, null, 'refresh refetches the first page');
assert.equal(refreshCall.payload.source, 'npm', 'refresh keeps the current source');
assert.equal(installCards(), 1, 'refresh replaces the list instead of appending to it');
assert.ok(!html.includes('刷新中…'), 'the progress state clears when the response lands');
log('catalog refresh: current (source,query) first page replaces the list');

// --- a live page never offers paging at the end -----------------------------
assert.equal(browse.react.findByClass('dshmcp-load-more'), undefined, 'a single-page result offers no load-more');

// --- an entry without `origin` falls back to the serving source -------------
browse.react.click(browse.react.findAllByClass('dshmcp-segment-item')[0]);
await cycle();
browse.react.type(searchBox, 'originless');
html = await afterDebounce();
assert.ok(html.includes('无来源条目'), 'an entry without origin still renders');
assert.ok(html.includes('Registry'), 'a missing origin falls back to the source that served the page');
assert.equal(installCards(), 1, 'the origin-less entry is the only match');
browse.react.unmountAll();

// --- registry reports total: null → no count placeholder --------------------
const nullTotalHost = createHost([]);
nullTotalHost.hideTotal();
const nullTotal = boot({ rpc: nullTotalHost.rpc });
nullTotal.react.render(nullTotal.element);
await settle();
html = nullTotal.react.render(nullTotal.element);
assert.ok(html.includes('官方演示服务器'), 'a null-total page still renders its cards');
assert.ok(!html.includes('个结果'), 'a null total renders no count placeholder');
assert.ok(!html.includes('null'), 'a null total is never printed');
nullTotal.react.unmountAll();
log('catalog total: null renders no placeholder (real registry behaviour)');

// --- the same numbers localize for English ----------------------------------
const englishHost = createHost([]);
const englishBoot = boot({ rpc: englishHost.rpc, active: 'en' });
englishBoot.react.render(englishBoot.element);
await settle();
html = englishBoot.react.render(englishBoot.element);
const englishNpm = englishBoot.react.findAllByClass('dshmcp-segment-item')[1];
englishBoot.react.click(englishNpm);
englishBoot.react.render(englishBoot.element);
await settle();
html = englishBoot.react.render(englishBoot.element);
assert.ok(html.includes('730k/mo'), 'English formats monthly downloads as 730k');
assert.ok(html.includes('1.2k/mo'), 'English formats monthly downloads as 1.2k');
assert.ok(html.includes('Score 0.87'), 'the English score label is localized');
assert.ok(html.includes('Offline seed') === false, 'a live page never claims the offline seed');
englishBoot.react.unmountAll();
log('catalog cards: en locale formats downloads as 730k/1.2k');

// ---------------------------------------------------------------------------
// 4d. Catalog install paths (t15): one click vs env form
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 5. Render — populated list, detail, inline edit, toggle, delete
// ---------------------------------------------------------------------------

const externalServer = serverFixture({
  id: '',
  name: 'mcp-obscura',
  label: 'Obscura 远程',
  transport: 'streamable-http',
  managed: false,
  readOnlyReason: 'hand-authored in cordis.patch.yml',
  phase: 'failed',
  status: 'error',
  statusDetail: 'connect ECONNREFUSED 127.0.0.1:9',
  bundle: null,
  config: {
    command: null,
    args: [],
    env: {},
    cwd: null,
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer super-secret' },
    failOnStartupError: true,
  },
});
const hostileServer = { name: null, transport: 'nonsense', config: 42, enabled: 'yes', args: 'not-an-array' };
const dataHost = createHost([serverFixture(), externalServer, hostileServer]);
const data = boot({ rpc: dataHost.rpc });
html = data.react.render(data.element);
await settle();
html = data.react.render(data.element);

assert.ok(html.includes('Alpha 服务器'), 'a managed server card renders its label');
assert.ok(html.includes('Obscura 远程'), 'an external server card renders');
assert.ok(html.includes('已连接'), 'status text for a connected server');
assert.ok(html.includes('错误'), 'status text for a failed server');
assert.ok(html.includes('外部配置'), 'external servers are labelled read-only');
assert.ok(html.includes('class="dshmcp-switch"'), 'every card carries an enable switch');
assert.ok(data.calls.filter((call) => call.endpoint === 'list').every((call) => call.channel === '/dsh-mcp-rpc'));
log('render (data): managed + external + malformed rows, no throw');

// Expand a card by its title control.
const titleButton = data.react.findByClass('dshmcp-title-btn');
data.react.click(titleButton);
html = data.react.render(data.element);
assert.ok(html.includes('连接配置'), 'clicking the card expands the detail panel');
assert.ok(html.includes('MEMORY_FILE_PATH=/tmp/memory.json'), 'the detail panel shows the config');
log('interaction: card click expands the read-only detail');

// Expand an external card → no editor, a read-only note instead.
const externalTitle = data.react.findAllByClass('dshmcp-title-btn')[1];
data.react.click(externalTitle);
html = data.react.render(data.element);
assert.ok(html.includes('只能查看'), 'external servers show a read-only reason');

// Open the inline editor with the gear.
data.react.click(data.react.findByClass('dshmcp-title-btn'));
const gear = data.react.findByClass('dshmcp-icon-btn');
assert.equal(gear.props.title, '编辑', 'the first icon button on a managed card is the gear');
data.react.click(gear);
html = data.react.render(data.element);
assert.ok(html.includes('保存修改'), 'the gear opens the inline editor');
assert.ok(html.includes('class="dshmcp-input"'), 'the editor renders inputs');
data.react.click(data.react.findByText('保存修改'));
await settle();
html = data.react.render(data.element);
assert.ok(data.calls.some((call) => call.endpoint === 'update' && call.payload.id === 'alpha'), 'save calls update');
assert.ok(html.includes('已保存'), 'a success notice is shown');
log('interaction: gear → inline edit → save (update RPC)');

// Enable/disable toggle.
data.react.click(data.react.findByClass('dshmcp-switch'));
await settle();
data.react.render(data.element);
assert.ok(
  data.calls.some((call) => call.endpoint === 'update' && call.payload.id === 'alpha' && call.payload.toggle === 'disable'),
  'the switch calls update with toggle=disable',
);
log('interaction: enable switch → update {toggle}');

// Delete with the two-step confirm.
data.react.click(data.react.findByClass('dshmcp-icon-btn-danger'));
html = data.react.render(data.element);
assert.ok(html.includes('确定删除该服务器？'), 'delete asks for confirmation first');
data.react.click(data.react.findByClass('dshmcp-btn-danger'));
await settle();
data.react.render(data.element);
assert.ok(data.calls.some((call) => call.endpoint === 'remove' && call.payload.id === 'alpha'), 'confirm removes');
assert.ok(dataHost.servers().every((server) => server.id !== 'alpha'), 'the host list is updated');
data.react.unmountAll();
log('interaction: delete → confirm → remove');

// ---------------------------------------------------------------------------
// 5b. t6/O1 — external rows must not share one expansion slot
// ---------------------------------------------------------------------------

const externalA = serverFixture({
  id: '',
  name: 'external-a',
  label: 'External A',
  managed: false,
  readOnlyReason: 'external',
  bundle: null,
  config: {
    command: 'aaa-tool', args: [], env: {}, cwd: null, url: null, headers: {}, failOnStartupError: true,
  },
});
const externalB = serverFixture({
  id: '',
  name: 'external-b',
  label: 'External B',
  transport: 'streamable-http',
  managed: false,
  readOnlyReason: 'external',
  bundle: null,
  config: {
    command: null, args: [], env: {}, cwd: null, url: 'https://bbb.example/mcp', headers: {}, failOnStartupError: true,
  },
});
assert.equal(externalA.id, '', 'the fixture is an external row with an empty id');
assert.equal(externalB.id, '');
const externalsHost = createHost([externalA, externalB]);
const externals = boot({ rpc: externalsHost.rpc });
externals.react.render(externals.element);
await settle();
html = externals.react.render(externals.element);
assert.equal(html.includes('连接配置'), false, 'nothing is expanded before a click');
assert.equal(externals.react.findAllByClass('dshmcp-title-btn').length, 2, 'both external cards render');

// Click the SECOND external card only.
externals.react.click(externals.react.findAllByClass('dshmcp-title-btn')[1]);
html = externals.react.render(externals.element);
assert.equal(html.split('连接配置').length - 1, 1, 'exactly one external card is expanded (t6/O1)');
assert.ok(html.includes('https://bbb.example/mcp'), 'the clicked card shows its own config');
assert.equal(html.includes('aaa-tool'), false, 'the other external card stays collapsed');

// Clicking the first one moves the expansion instead of adding a second panel.
externals.react.click(externals.react.findAllByClass('dshmcp-title-btn')[0]);
html = externals.react.render(externals.element);
assert.equal(html.split('连接配置').length - 1, 1);
assert.ok(html.includes('aaa-tool'), 'the newly clicked card expanded');
assert.equal(html.includes('https://bbb.example/mcp'), false, 'the previously expanded card collapsed');
externals.react.unmountAll();
log('interaction: two external rows expand independently (t6/O1)');

// ---------------------------------------------------------------------------
// 5c. t6/O3 — a managed row the Host marked read-only offers no write controls
// ---------------------------------------------------------------------------

const readonlyServer = serverFixture({
  id: 'locked',
  name: 'locked',
  label: 'Locked 服务器',
  managed: true,
  readOnlyReason: 'unaddressable',
});
const readonlyHost = createHost([readonlyServer]);
const readonly = boot({ rpc: readonlyHost.rpc });
readonly.react.render(readonly.element);
await settle();
html = readonly.react.render(readonly.element);
assert.ok(html.includes('Locked 服务器'), 'the read-only managed row still renders');
assert.ok(html.includes('只读'), 'it is tagged read-only instead of external');
assert.equal(readonly.react.findByClass('dshmcp-icon-btn'), undefined, 'no gear is offered');
assert.equal(readonly.react.findByClass('dshmcp-icon-btn-danger'), undefined, 'no delete control is offered');
assert.equal(readonly.react.findByClass('dshmcp-switch').props.disabled, true, 'the switch is disabled');
readonly.react.click(readonly.react.findAllByClass('dshmcp-title-btn')[0]);
html = readonly.react.render(readonly.element);
assert.ok(html.includes('只能查看') || html.includes('只读'), 'the detail explains why it is read-only');
assert.equal(html.includes('编辑'), false, 'no edit button inside the detail either');
assert.equal(readonly.calls.some((call) => call.endpoint === 'update' || call.endpoint === 'remove'), false);
readonly.react.unmountAll();
log('interaction: managed + readOnlyReason → no write controls (t6/O3)');

// ---------------------------------------------------------------------------
// 5d. t6/O2 — displayName round trip through the inline editor
// ---------------------------------------------------------------------------

const nameHost = createHost([serverFixture()]);
const named = boot({ rpc: nameHost.rpc });
named.react.render(named.element);
await settle();
named.react.render(named.element);
assert.ok(named.react.render(named.element).includes('Alpha 服务器'), 'the card title is view.label');
named.react.click(named.react.findAllByClass('dshmcp-title-btn')[0]);
named.react.click(named.react.findByClass('dshmcp-icon-btn'));
html = named.react.render(named.element);
assert.ok(html.includes('显示名称'), 'the editor offers a display-name field');
const displayInput = named.react.find((node) => node.type === 'input' && node.props.placeholder === '显示名称');
assert.ok(displayInput, 'the display-name input exists');
assert.equal(displayInput.props.value, 'Alpha 服务器', 'it is pre-filled with the stored label');
assert.equal(displayInput.props.maxLength, 120, 'the input caps the label at 120 characters');

// A Chinese display name must survive the form → RPC boundary.
named.react.type(displayInput, '我的中文标题');
named.react.render(named.element);
named.react.click(named.react.findByText('保存修改'));
await settle();
named.react.render(named.element);
const namedSave = named.calls.filter((call) => call.endpoint === 'update').pop();
assert.equal(namedSave.payload.input.displayName, '我的中文标题', 'displayName carries the Chinese title');
assert.equal('label' in namedSave.payload.input, false, 'ServerInput never carries the old label field');
assert.ok(named.react.render(named.element).includes('我的中文标题'), 'the card title follows the new label');
named.react.unmountAll();
log('interaction: displayName round trip (中文) through update (t6/O2)');

// Over the ceiling: the form refuses locally instead of round-tripping.
const longHost = createHost([serverFixture()]);
const longName = boot({ rpc: longHost.rpc });
longName.react.render(longName.element);
await settle();
longName.react.render(longName.element);
longName.react.click(longName.react.findAllByClass('dshmcp-title-btn')[0]);
longName.react.click(longName.react.findByClass('dshmcp-icon-btn'));
longName.react.render(longName.element);
longName.react.type(longName.react.find((node) => node.type === 'input' && node.props.placeholder === '显示名称'), 'x'.repeat(121));
longName.react.render(longName.element);
longName.react.click(longName.react.findByText('保存修改'));
await settle();
html = longName.react.render(longName.element);
assert.ok(html.includes('显示名称最多 120 个字符。'), 'the form shows the display-name ceiling');
assert.equal(longName.calls.some((call) => call.endpoint === 'update'), false, 'an invalid title never reaches the Host');
longName.react.unmountAll();
log('interaction: display name ceiling validated in the form (t6/O2)');

// ---------------------------------------------------------------------------
// 5e. t6/O4 — a success notice is surfaced instead of a plain "saved"
// ---------------------------------------------------------------------------

const noticeHost = createHost([serverFixture({ enabled: false, phase: null, status: 'disabled' })]);
const noticed = boot({ rpc: noticeHost.rpc });
noticed.react.render(noticed.element);
await settle();
noticed.react.render(noticed.element);
// Enabling a disabled row shows the plain success toast ("已启用"); the status
// tag says "已连接" instead, so the two strings cannot be confused below.
noticed.react.click(noticed.react.findAllByClass('dshmcp-title-btn')[0]);
noticed.react.click(noticed.react.findByClass('dshmcp-switch'));
await settle();
html = noticed.react.render(noticed.element);
assert.ok(html.includes('已启用'), 'a plain success still shows its confirmation');

// The Host reports "saved but overridden" on the next call.
noticeHost.setFailure({
  ok: true,
  value: {
    servers: noticeHost.servers(),
    disabled: false,
    notice: { code: 'overridden', message: 'host-side detail' },
  },
});
noticed.react.render(noticed.element);
noticed.react.click(noticed.react.findByClass('dshmcp-switch'));
await settle();
html = noticed.react.render(noticed.element);
// The client localizes the notice text itself and keeps the Host message as the
// detail line; assert that semantic split, not one exact wording.
assert.ok(html.includes('当前更改尚未生效'), 'the overridden notice is shown (t6/O4)');
assert.ok(!html.includes('已停用'), 'the change is never reported as a plain success');
assert.ok(html.includes('host-side detail'), 'the Host message is kept as the detail line');
assert.ok(html.includes('dshmcp-notice'), 'the notice renders in the notice slot');
noticed.react.unmountAll();
log('interaction: application:overridden → explicit notice (t6/O4)');

// ---------------------------------------------------------------------------
// 6. Render — search, category filter and the add menu
// ---------------------------------------------------------------------------

const menuHost = createHost([serverFixture()]);
const menu = boot({ rpc: menuHost.rpc });
menu.react.render(menu.element);
await settle();
html = menu.react.render(menu.element);

const searchInputs = menu.react.findAll((node) => node.type === 'input' && node.props.type === 'search');
assert.equal(searchInputs.length, 2, 'one search box for the catalog and one for the server list');
menu.react.type(searchInputs[1], 'nothing-matches-this');
html = menu.react.render(menu.element);
assert.ok(html.includes('还没有 MCP 服务器'), 'a server search with no match falls back to the empty state');
menu.react.type(searchInputs[1], '');

// Category chips still filter the loaded page locally (the endpoint owns search).
const chip = menu.react.findAllByClass('dshmcp-chip').find((node) => node.props.children === 'io.github.example');
assert.ok(chip, 'category chips render from the loaded page');
menu.react.click(chip);
html = menu.react.render(menu.element);
assert.ok(html.includes('官方演示服务器'), 'category filter keeps its members');
assert.ok(html.includes('本页筛选出'), 'an active category filter reports the filtered count');
menu.react.click(menu.react.findByText('添加'));
html = menu.react.render(menu.element);
assert.ok(html.includes('STDIO 服务器') && html.includes('流式 HTTP 服务器'), 'the add menu offers both transports');
menu.react.click(menu.react.findAllByClass('dshmcp-menu-item')[1]);
html = menu.react.render(menu.element);
assert.ok(html.includes('class="dshmcp-overlay"'), 'the http add form opens as a modal');
assert.ok(html.includes('端点 URL'), 'the http form asks for a URL');
// The modal submit is the last control labelled 添加 (the toolbar button precedes it).
const addSubmit = () => menu.react.findAllByText('添加').pop();
menu.react.click(addSubmit());
html = menu.react.render(menu.element);
assert.ok(html.includes('请填写服务器名称。'), 'the add form validates the name');
const httpUrlInput = menu.react.find((node) => node.type === 'input' && node.props.placeholder === 'https://example.com/mcp');
const nameInput = menu.react.find((node) => node.type === 'input' && node.props.placeholder === 'my-server');
menu.react.type(nameInput, 'my-http-server');
menu.react.type(httpUrlInput, 'https://example.com/mcp');
menu.react.render(menu.element);
menu.react.click(addSubmit());
await settle();
menu.react.render(menu.element);
const addCall = menu.calls.find((call) => call.endpoint === 'add');
assert.ok(addCall, 'the add form calls add');
assert.deepEqual(plain(addCall.payload.input), {
  name: 'my-http-server',
  // §3a: displayName is always sent, so an emptied form field can clear a label.
  displayName: '',
  transport: 'streamable-http',
  url: 'https://example.com/mcp',
}, 'an empty display name is sent as an empty string, never as a label field');
menu.react.unmountAll();
log('interaction: server search, category chips, add menu, add form validation + add RPC');

// ---------------------------------------------------------------------------
// 7. Catalog install paths (t15): one click vs env form
// ---------------------------------------------------------------------------

const installHost = createHost([]);
const install = boot({ rpc: installHost.rpc });
install.react.render(install.element);
await settle();
html = install.react.render(install.element);

const installButtons = install.react.findAllByClass('dshmcp-install-btn');
assert.equal(installButtons.length, 24, 'every card on the live page offers an install button');

// Zero-configuration entry → one click, straight to `add`.
install.react.click(installButtons[1]);
install.react.render(install.element);
await settle();
html = install.react.render(install.element);
const oneClickCall = install.calls.find((call) => call.endpoint === 'add');
assert.ok(oneClickCall, 'a zero-envKeys entry installs in one click');
assert.equal(oneClickCall.channel, '/dsh-mcp-rpc', 'the only network path is the connection RPC channel');
assert.deepEqual(plain(oneClickCall.payload.input), {
  // The packageId tail becomes the serverName, the title the display name (§3a).
  name: 'server-1',
  displayName: '官方演示服务器',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@demo/server-1'],
}, 'a one-click install sends ServerInput without an env block');
assert.ok(html.includes('已安装'), 'the installed card switches to its installed state');
log('install: zero-config entry → one click → add');

// Entry with a required secret → env form, then add with env folded in.
const refreshed = install.react.findAllByClass('dshmcp-install-btn');
install.react.click(refreshed[0]);
html = install.react.render(install.element);
assert.ok(html.includes('该服务器需要以下凭据'), 'a token entry opens the env form');
const secretInput = install.react.find((node) => node.type === 'input' && node.props.type === 'password');
assert.ok(secretInput, 'secret env fields must use a password input');

install.react.click(install.react.findAllByText('安装').pop());
html = install.react.render(install.element);
assert.ok(html.includes('请填写「DEMO_TOKEN」。'), 'a required env key is validated before install');

install.react.type(secretInput, 'demo_secret_token');
install.react.render(install.element);
install.react.click(install.react.findAllByText('安装').pop());
await settle();
html = install.react.render(install.element);
const installCall = install.calls.filter((call) => call.endpoint === 'add').pop();
assert.equal(installCall.channel, '/dsh-mcp-rpc');
assert.deepEqual(plain(installCall.payload.input), {
  name: 'server-0',
  displayName: '需要令牌的服务器',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@demo/server-0'],
  env: { DEMO_TOKEN: 'demo_secret_token' },
});
assert.ok(html.includes('已安装'), 'the second install also lands in the installed state');
install.react.unmountAll();
log('install: token entry → env form (password input) → add with env folded in');

// ---------------------------------------------------------------------------
// 7b. t17 — direct install by package name, and the add-form command suggestion
// ---------------------------------------------------------------------------

const directHost = createHost([]);
const direct = boot({ rpc: directHost.rpc });
const directCycle = async () => {
  direct.react.render(direct.element);
  await settle();
  return direct.react.render(direct.element);
};
const directSearch = () => direct.react.findAll((node) => node.type === 'input' && node.props.type === 'search')[0];
const directDebounce = async () => {
  direct.react.render(direct.element);
  await new Promise((resolve) => setTimeout(resolve, 460));
  return directCycle();
};
let directHtml = await directCycle();

// A bare word in the registry tab is a search term, not an npm package.
direct.react.type(directSearch(), 'postgres');
directHtml = await directDebounce();
assert.equal(direct.react.findByClass('dshmcp-direct-install'), undefined,
  'a bare word in the registry tab is not offered as an npm package');

// In the npm tab an exact package name offers the direct install (t17).
direct.react.click(direct.react.findAllByClass('dshmcp-segment-item')[1]);
directHtml = await directCycle();
direct.react.type(directSearch(), '@jokeran/frontend-code-skimmer');
directHtml = await directDebounce();
const directCard = direct.react.findByClass('dshmcp-direct-install');
assert.ok(directCard, 'an exact package name in the npm tab offers a direct install');
assert.ok(directHtml.includes('npx -y @jokeran/frontend-code-skimmer'), 'the card shows the derived command');
assert.ok(directHtml.includes('直接安装 @jokeran/frontend-code-skimmer'), 'the card names the package');
assert.equal(direct.react.findByClass('dshmcp-catalog-empty') !== undefined, true,
  'the search itself returned nothing — this is exactly the t17 gap');

// One click installs it with the derived stdio command and no env form.
const directButton = direct.react.findByClass('dshmcp-direct-install-btn');
assert.equal(typeof directButton.props.onClick, 'function');
direct.react.click(directButton);
await settle();
direct.react.render(direct.element);
const directAdd = direct.calls.filter((call) => call.endpoint === 'add').pop();
assert.ok(directAdd, 'the direct install calls add');
assert.deepEqual(plain(directAdd.payload.input), {
  // The install name seed is the packageId tail without its scope (t15), so the
  // model-facing namespace stays readable: `npm:@jokeran/x` → `x`.
  name: 'frontend-code-skimmer',
  displayName: '@jokeran/frontend-code-skimmer',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@jokeran/frontend-code-skimmer'],
}, 'the direct install sends the derived npx command and nothing else');
assert.equal(direct.react.findByClass('dshmcp-overlay'), undefined, 'no env form is needed (zero envKeys)');

// A scoped package is unambiguous in either tab.
direct.react.click(direct.react.findAllByClass('dshmcp-segment-item')[0]);
directHtml = await directCycle();
assert.ok(direct.react.findByClass('dshmcp-direct-install'),
  'a scoped npm package is offered from the registry tab too');

// A multi-word phrase is never a package.
direct.react.type(directSearch(), 'github server');
directHtml = await directDebounce();
assert.equal(direct.react.findByClass('dshmcp-direct-install'), undefined, 'a phrase is not a package');
direct.react.unmountAll();
log('direct install: exact package name → one click → add with npx command (t17)');

// --- the custom-add form suggests the command for a package name -------------

const formHost = createHost([serverFixture()]);
const form = boot({ rpc: formHost.rpc });
form.react.render(form.element);
await settle();
form.react.render(form.element);
form.react.click(form.react.findByText('添加'));
form.react.render(form.element);
form.react.click(form.react.findAllByClass('dshmcp-menu-item')[0]);
let formHtml = form.react.render(form.element);
assert.ok(formHtml.includes('每行一个参数：`-y` 一行'), 'an empty args field explains the npx shape (t17)');

const formName = form.react.find((node) => node.type === 'input' && node.props.placeholder === 'my-server');
const formDisplay = form.react.find((node) => node.type === 'input' && node.props.placeholder === '显示名称');
form.react.type(formName, 'skimmer');
form.react.type(formDisplay, '@jokeran/frontend-code-skimmer');
formHtml = form.react.render(form.element);
const suggest = form.react.findByClass('dshmcp-arg-suggest');
assert.ok(suggest, 'a package name in the form offers the exact arguments');
assert.ok(formHtml.includes('填入 -y @jokeran/frontend-code-skimmer'), 'the suggestion names the package');
form.react.click(suggest);
formHtml = form.react.render(form.element);
const argsArea = form.react.find((node) => node.type === 'textarea' && String(node.props.value).includes('-y'));
assert.equal(argsArea.props.value, '-y\n@jokeran/frontend-code-skimmer',
  'the suggestion writes one argument per line');
formHtml = form.react.render(form.element);
form.react.click(form.react.findAllByText('添加').pop());
await settle();
form.react.render(form.element);
const formAdd = form.calls.filter((call) => call.endpoint === 'add').pop();
assert.deepEqual(plain(formAdd.payload.input), {
  name: 'skimmer',
  displayName: '@jokeran/frontend-code-skimmer',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@jokeran/frontend-code-skimmer'],
}, 'the suggested arguments reach the Host as two argv entries');
form.react.unmountAll();
log('add form: package name → command suggestion → add with -y <pkg> (t17)');

// ---------------------------------------------------------------------------
// 7c. t19/F1 — a server split across pages must stay one card
// ---------------------------------------------------------------------------

/** Four pages of two entries, with two servers repeated across a page boundary. */
function dedupEntry(id, version, official, description) {
  return {
    id,
    title: { zh: id + ' ' + version, en: id + ' ' + version },
    description: { zh: description, en: description },
    category: 'dedup.example',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', id],
    origin: 'registry',
    packageId: 'npm:' + id,
    official,
  };
}
const DEDUP_PAGES = [
  [dedupEntry('agency.goji/goji', '1.0.0', false, 'old-goji-1.0.0'), dedupEntry('dedup.example/one', '1.0.0', false, 'plain-one')],
  [dedupEntry('agency.ottobot/licensed-house-painters', '0.1.1', false, 'old-painters-0.1.1'), dedupEntry('dedup.example/two', '1.0.0', false, 'plain-two')],
  [dedupEntry('agency.goji/goji', '1.0.1', true, 'new-goji-1.0.1'), dedupEntry('dedup.example/three', '1.0.0', false, 'plain-three')],
  [dedupEntry('agency.ottobot/licensed-house-painters', '0.1.2', true, 'new-painters-0.1.2'), dedupEntry('dedup.example/four', '1.0.0', false, 'plain-four')],
];
function dedupRpc(endpoint, payload) {
  if (endpoint === 'list') return { ok: true, value: { servers: [], managedRoot: '/tmp/dedup' } };
  if (endpoint !== 'catalog') return { ok: true, value: { servers: [] } };
  const index = payload && payload.cursor !== null && payload.cursor !== undefined ? Number(payload.cursor) : 0;
  const entries = DEDUP_PAGES[index] || [];
  const next = index + 1;
  return {
    ok: true,
    value: {
      source: 'registry',
      entries,
      nextCursor: next < DEDUP_PAGES.length ? String(next) : null,
      total: null,
      hasMore: next < DEDUP_PAGES.length,
      degraded: false,
      fetchedAt: '2026-10-04T00:00:00.000Z',
    },
  };
}

const dedup = boot({ rpc: dedupRpc });
const dedupCycle = async () => {
  dedup.react.render(dedup.element);
  await settle();
  return dedup.react.render(dedup.element);
};
const dedupIds = () => dedup.react.findAllByClass('dshmcp-catalog-package').map((node) => String(node.props.children));
const dedupCards = () => dedup.react.findAllByClass('dshmcp-catalog-card').length;

let dedupHtml = await dedupCycle();
assert.deepEqual(dedupIds(), ['npm:agency.goji/goji', 'npm:dedup.example/one'], 'page 1 renders');

let previousCards = dedupCards();
for (let page = 2; page <= 4; page += 1) {
  const more = dedup.react.findByClass('dshmcp-load-more');
  assert.ok(more, 'page ' + (page - 1) + ' offers load more');
  dedup.react.click(more);
  dedupHtml = await dedupCycle();
  const ids = dedupIds();
  assert.equal(new Set(ids).size, ids.length, 'after page ' + page + ': no id appears on two cards');
  assert.ok(dedupCards() >= previousCards, 'after page ' + page + ': the list never shrinks');
  previousCards = dedupCards();
}
assert.equal(dedupCards(), 6, '8 rows across four pages collapse to 6 distinct servers');
assert.equal(dedup.react.findByClass('dshmcp-load-more'), undefined, 'the last page offers no load more');

// The surviving card is the newer publication of each server.
assert.ok(dedupHtml.includes('new-goji-1.0.1'), 'the latest goji version is the card that stays');
assert.ok(!dedupHtml.includes('old-goji-1.0.0'), 'the older goji version is gone');
assert.ok(dedupHtml.includes('new-painters-0.1.2'), 'the latest painters version is the card that stays');
assert.ok(!dedupHtml.includes('old-painters-0.1.1'), 'the older painters version is gone');
assert.equal(dedupHtml.split('dshmcp-catalog-badges').length - 1, 6, 'one card per surviving server');
dedup.react.unmountAll();
log('catalog paging: cross-page duplicate servers collapse to one card (t19/F1)');

// ---------------------------------------------------------------------------
// 8. Error mapping: dictionary first, Host message as the fallback
// ---------------------------------------------------------------------------

const mappedHost = createHost([]);
mappedHost.setFailure({ ok: false, error: { code: 'invalid-request', message: 'raw host text' } });
const mapped = boot({ rpc: mappedHost.rpc });
mapped.react.render(mapped.element);
await settle();
html = mapped.react.render(mapped.element);
assert.ok(html.includes('请求格式有误，请检查输入内容。'), 'a known error code is localized from the dictionary');
assert.ok(!html.includes('raw host text'), 'the Host message does not override a dictionary mapping');
mapped.react.unmountAll();
log('errors: known code → local dictionary text');

const fallbackHost = createHost([]);
fallbackHost.setFailure({ ok: false, error: { code: 'brand-new-code', message: 'raw host text' } });
const fallback = boot({ rpc: fallbackHost.rpc });
fallback.react.render(fallback.element);
await settle();
html = fallback.react.render(fallback.element);
assert.ok(html.includes('raw host text'), 'an unmapped code falls back to error.message');
fallback.react.unmountAll();
log('errors: unknown code → error.message fallback');

// A throwing rpc (transport failure) must not blank the tab either.
const throwing = boot({ rpc: () => { throw new Error('socket closed'); } });
throwing.react.render(throwing.element);
await settle();
html = throwing.react.render(throwing.element);
assert.ok(html.includes('无法连接到服务，请检查网络连接。'), 'a transport throw renders the localized network error');
throwing.react.unmountAll();
log('errors: rpc throw → localized network error');

// ---------------------------------------------------------------------------
// 9. Error boundary — a crashed subtree degrades instead of blanking the tab
// ---------------------------------------------------------------------------

const boundaryHarness = createMiniReact();
const Boundary = internals.ErrorBoundary;
function Boom() {
  throw new Error('render exploded');
}
// componentDidCatch intentionally logs; capture it so the suite output stays clean
// and the diagnostic itself becomes an assertion.
const reported = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  reported.push(args);
};
let boundaryHtml;
try {
  boundaryHtml = boundaryHarness.render(
    boundaryHarness.api.createElement(Boundary, { t: (key) => key }, boundaryHarness.api.createElement(Boom)),
  );
} finally {
  console.error = originalConsoleError;
}
assert.ok(boundaryHtml.includes('errorInternal'), 'the boundary renders its fallback');
assert.ok(boundaryHtml.includes('render exploded'), 'the fallback names the failure');
assert.equal(reported.length, 1, 'the boundary reports the crash exactly once');
// A recovered boundary keeps its caught state, so the healthy case needs a fresh mount.
const healthyHarness = createMiniReact();
const okHtml = healthyHarness.render(
  healthyHarness.api.createElement(Boundary, { t: (key) => key }, healthyHarness.api.createElement('span', null, 'healthy')),
);
assert.ok(okHtml.includes('healthy'), 'the boundary passes healthy children through');
log('error boundary: crashed subtree degrades to a localized message');

// ---------------------------------------------------------------------------
// 10. Slash source — `/serverName [task]` composes one MCP-scoped instruction
// ---------------------------------------------------------------------------

const slash = boot({ rpc: async () => ({ ok: true, value: { servers: [] } }) }).moduleExports.internals;

// The three spellings the trigger tokenizer can produce all normalize to the
// server name: it skips a `/` that follows a word char and treats `//` as dead.
assert.equal(slash.slashQueryName('frontend-code-skimmer'), 'frontend-code-skimmer', 'plain query');
assert.equal(slash.slashQueryName('/frontend-code-skimmer'), 'frontend-code-skimmer', 'a doubled slash still normalizes');
assert.equal(slash.slashQueryName('@jokeran/frontend-code-skimmer'), 'frontend-code-skimmer', 'an npm-scoped spelling normalizes');
assert.equal(slash.slashQueryName('  @scope/pkg  '), 'pkg', 'surrounding whitespace is ignored');
assert.equal(slash.slashQueryName(''), '', 'an empty query stays empty');
assert.equal(slash.toolPrefixOf('skimmer'), 'mcp__skimmer__', 'the tool prefix matches the mcp-client shape');
log('slash: the three accepted spellings normalize to the server name');

const SERVER_ROWS = [
  { id: 'a', name: 'frontend-code-skimmer', label: '前端代码罗盘', transport: 'stdio', status: 'connected' },
  { id: 'b', name: 'java-repo-skimmer', label: 'java-repo-skimmer', transport: 'stdio', status: 'disabled' },
  { id: 'c', name: 'obscura', label: 'obscura', transport: 'streamable-http', status: 'error' },
];
const rpcWith = (calls, servers = SERVER_ROWS, fail = false) => async (channel, endpoint) => {
  calls.push({ channel, endpoint });
  if (fail) throw new Error('boom');
  return { ok: true, value: { servers } };
};

// -- pure pieces -------------------------------------------------------------
const ranked = slash.rankSlashServers(SERVER_ROWS, 'java');
assert.equal(ranked.length, 1, 'ranking keeps only matches');
assert.equal(ranked[0].name, 'java-repo-skimmer', 'a prefix match wins');
assert.equal(slash.rankSlashServers(SERVER_ROWS, '').length, 3, 'an empty query keeps every server');
assert.equal(slash.rankSlashServers(SERVER_ROWS, 'fsk').length, 1, 'a subsequence still matches');
assert.equal(slash.rankSlashServers(SERVER_ROWS, 'fsk')[0].name, 'frontend-code-skimmer', 'the subsequence hit is the right server');
assert.equal(slash.rankSlashServers(SERVER_ROWS, 'nope').length, 0, 'a miss returns nothing');
assert.equal(slash.rankSlashServers(SERVER_ROWS, '前端').length, 1, 'the display name is searchable too');
assert.equal(slash.rankSlashServers(SERVER_ROWS, '前端')[0].name, 'frontend-code-skimmer', 'the label match returns its server');

const parsed = slash.parseSlashLine('/frontend-code-skimmer 分析一下 vue2click', SERVER_ROWS);
assert.equal(parsed.server.name, 'frontend-code-skimmer', 'the first token selects the server');
assert.equal(parsed.task, '分析一下 vue2click', 'the rest of the line is the task');
assert.equal(slash.parseSlashLine('/frontend-code-skimmer', SERVER_ROWS).task, '', 'a bare command carries no task');
assert.equal(slash.parseSlashLine('//frontend-code-skimmer 干活', SERVER_ROWS).task, '干活', 'the doubled-slash spelling parses');
assert.equal(slash.parseSlashLine('/@jokeran/frontend-code-skimmer 干活', SERVER_ROWS).task, '干活', 'the scoped spelling parses');
assert.equal(slash.parseSlashLine('/plan now', SERVER_ROWS), null, 'an unknown name is not claimed');
assert.equal(slash.parseSlashLine('hello', SERVER_ROWS), null, 'a line without a leading slash is not claimed');
assert.equal(slash.parseSlashLine('/frontend-code-skimmerX', SERVER_ROWS), null, 'a name prefix does not match');

// A server may legally be named after a built-in command. `order` only sorts the
// menu — Enter arbitration polls sources in registration order — so the line has
// to be yielded explicitly.
const COLLIDING_ROWS = SERVER_ROWS.concat([
  { id: 'd', name: 'plan', label: 'plan', transport: 'stdio', status: 'connected' },
]);
assert.equal(slash.parseSlashLine('/plan 排个计划', COLLIDING_ROWS).server.name, 'plan', 'without a guard the colliding name would be claimed');
assert.equal(slash.parseSlashLine('/plan 排个计划', COLLIDING_ROWS, new Set(['plan'])), null, 'a reserved name is left to its own source');
assert.equal(slash.parseSlashLine('/PLAN 排个计划', COLLIDING_ROWS, new Set(['plan'])), null, 'the reservation is case-insensitive');
assert.equal(slash.parseSlashLine('/frontend-code-skimmer x', COLLIDING_ROWS, new Set(['plan'])).server.name, 'frontend-code-skimmer', 'a non-reserved server still parses');
assert.equal(slash.parseSlashLine('/frontend-code-skimmer x', COLLIDING_ROWS, []).server.name, 'frontend-code-skimmer', 'a non-Set reservation is ignored');
log('slash: ranking and command-line parsing behave');

// -- reservation roster ------------------------------------------------------
assert.ok(slash.fallbackReservedCommands.includes('plan'), 'the shipped command names are the fallback');
assert.ok(slash.fallbackReservedCommands.includes('file'), 'the client-side /file contribution is covered too');
const reservedCalls = [];
const reservedCtx = {
  remote: {
    commands: {
      list: async (sessionId) => {
        reservedCalls.push(sessionId);
        return { ok: true, value: [{ name: 'git' }, { name: 'plan' }] };
      },
    },
  },
};
const reservedFor = slash.createSlashReservations(reservedCtx);
const reservedNames = await reservedFor('s1');
assert.ok(reservedNames.has('git'), 'a plugin-registered host command is reserved');
assert.ok(reservedNames.has('plan'), 'the fallback names survive the merge');
await reservedFor('s1');
assert.equal(reservedCalls.length, 1, 'the host roster is cached per session');
await reservedFor('s2');
assert.equal(reservedCalls.length, 2, 'a different session gets its own roster');
// A concurrent call must join the pending fetch, never read the fallback early.
const slowCalls = [];
const slowFor = slash.createSlashReservations({
  remote: {
    commands: {
      list: (sessionId) => {
        slowCalls.push(sessionId);
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: [{ name: 'git' }] }), 5));
      },
    },
  },
});
const [raceA, raceB] = await Promise.all([slowFor('s1'), slowFor('s1')]);
assert.equal(slowCalls.length, 1, 'concurrent rosters share one fetch');
assert.ok(raceA.has('git') && raceB.has('git'), 'neither concurrent caller sees the fallback instead of the live names');
const noRemote = slash.createSlashReservations({});
const degradedReserved = await noRemote('s1');
assert.ok(degradedReserved.has('plan'), 'a client without a command directory still reserves the shipped names');
const failingRemote = slash.createSlashReservations({
  remote: { commands: { list: async () => ({ ok: false, error: { code: 'internal', message: 'nope' } }) } },
});
assert.ok((await failingRemote('s1')).has('compact'), 'a failed roster call degrades to the fallback instead of throwing');
const throwingRemote = slash.createSlashReservations({
  remote: { commands: { list: async () => { throw new Error('offline'); } } },
});
assert.ok((await throwingRemote('s1')).has('plan'), 'a throwing roster call degrades to the fallback');
log('slash: the reserved-name roster merges the host directory with the fallback');

const zhDict = slash.dictionaries.zh;
const tSlash = (key, params) => {
  const value = zhDict[key];
  if (typeof value !== 'string') return key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
};
const promptWithTask = slash.buildSlashPrompt(tSlash, SERVER_ROWS[0], '分析 vue2click');
assert.ok(promptWithTask.includes('frontend-code-skimmer'), 'the prompt names the server');
assert.ok(promptWithTask.includes('mcp__frontend-code-skimmer__'), 'the prompt quotes the tool prefix');
assert.ok(promptWithTask.includes('分析 vue2click'), 'the prompt carries the task');
const promptBare = slash.buildSlashPrompt(tSlash, SERVER_ROWS[0], '');
assert.ok(!promptBare.includes('{task}'), 'the bare prompt has no placeholder left');
assert.ok(promptBare.includes('mcp__frontend-code-skimmer__'), 'the bare prompt still scopes the tool prefix');
log('slash: the composed instruction names the server and its tool prefix');

// -- directory cache ---------------------------------------------------------
const cacheCalls = [];
const directory = slash.createSlashDirectory({ list: rpcWith(cacheCalls) });
const firstLoad = await directory.load();
assert.equal(firstLoad.length, 3, 'the first load reads the host list');
assert.equal(firstLoad[0].name, 'frontend-code-skimmer', 'rows are normalized for the menu');
assert.equal(cacheCalls.length, 1, 'the first load issues one RPC');
await directory.load();
assert.equal(cacheCalls.length, 1, 'a second read inside the window is served from cache');
const concurrent = await Promise.all([directory.load(true), directory.load(true)]);
assert.equal(concurrent[1].length, 3, 'a concurrent forced reload still resolves');
assert.equal(cacheCalls.length, 2, 'a concurrent forced reload is de-duplicated into one RPC');
assert.equal(await directory.load(true) && cacheCalls.length, 3, 'a later forced reload does hit the host again');

const failing = slash.createSlashDirectory({ list: rpcWith([], [], true) });
assert.deepEqual(plain(await failing.load()), [], 'a failing first load yields an empty menu, not a throw');
assert.deepEqual(plain(await failing.load(true)), [], 'a failing first load never throws on a retry either');

// A failure after a good read must keep the last good list, so a transient
// host error cannot blank the menu.
let flaky = true;
const degradedDirectory = slash.createSlashDirectory({
  list: async (channel, endpoint) => {
    if (flaky) return { ok: true, value: { servers: SERVER_ROWS } };
    throw new Error('host went away');
  },
});
assert.equal((await degradedDirectory.load()).length, 3, 'the first read succeeds');
flaky = false;
assert.equal((await degradedDirectory.load(true)).length, 3, 'a failed refresh keeps the previous list');
log('slash: the server directory caches, de-duplicates and degrades quietly');

// -- registration + the full Enter path --------------------------------------
function createSlashHarness(options = {}) {
  const sources = [];
  const disposers = [];
  const services = new Map();
  let draft = null;
  const submitted = [];
  const inputFace = {
    setDraft(text) {
      draft = text;
    },
    submit() {
      submitted.push(draft);
    },
  };
  const actx = {
    get(name) {
      return name === 'conversation' ? { input: { for: () => inputFace } } : undefined;
    },
  };
  services.set('sessions', { scope: (id) => (id === 's1' ? actx : undefined) });
  services.set('inputTriggers', {
    registerSource(source) {
      sources.push(source);
      return () => {};
    },
  });
  const ctx = {
    get: (name) => services.get(name),
    effect(callback) {
      disposers.push(callback());
      return () => {};
    },
  };
  const calls = [];
  const client = { list: options.list || rpcWith(calls) };
  const ok = slash.registerMcpSlashSource(ctx, client, tSlash);
  return { ok, sources, disposers, submitted, calls, getDraft: () => draft };
}

const harness = createSlashHarness();
assert.equal(harness.ok, true, 'the source registers when the trigger service is present');
assert.equal(harness.sources.length, 1, 'exactly one source is registered');
const source = harness.sources[0];
assert.equal(source.trigger, '/', 'the source owns the slash trigger');
assert.equal(source.order, 3, 'it yields to host commands (0) and skills (2)');
assert.equal(source.name, 'mcp', 'the source is named for its group');
assert.equal(harness.disposers.length, 1, 'registration rides one effect');

const rows = await source.candidates({ sessionId: 's1' }, { query: '' });
assert.equal(rows.length, 3, 'a bare slash lists every installed server');
assert.equal(rows[0].name, 'frontend-code-skimmer', 'the row name is the typeable server name');
assert.equal(rows[0].label, '前端代码罗盘', 'a custom display name becomes the row title');
assert.equal(rows[1].label, undefined, 'an unchanged label is left out so the name is the title');
assert.equal(rows[0].section, zhDict.slashGroup, 'rows carry their own localized section title');
assert.ok(rows[0].description.includes('已连接'), 'the row reports the settled status');
assert.ok(rows[0].description.includes('STDIO'), 'the row reports the transport');
assert.ok(rows[2].description.includes('HTTP'), 'a remote server shows the HTTP transport');
const scopedRows = await source.candidates({ sessionId: 's1' }, { query: '@jokeran/frontend-code-skimmer' });
assert.equal(scopedRows.length, 1, 'the scoped spelling finds the server in the menu');
const aborted = new AbortController();
aborted.abort();
assert.deepEqual(plain(await source.candidates({ sessionId: 's1' }, { query: '', signal: aborted.signal })), [], 'an aborted fetch publishes no rows');

assert.deepEqual(plain(await source.onPick({ candidate: { name: 'obscura' }, action: 'pick' })), { text: '/obscura ' }, 'a bare pick completes the spelling');
assert.equal(source.onPick({ candidate: { name: 'obscura' }, action: 'drill' }), undefined, 'a drill is not ours');
assert.equal(source.onPick({ candidate: {}, action: 'pick' }), undefined, 'a nameless candidate is ignored');

assert.equal(await source.matchEnter({ sessionId: 's1' }, '/plan now'), undefined, 'a host command line is left alone');
assert.equal(await source.matchEnter({ sessionId: 's1' }, 'just text'), undefined, 'an ordinary line is left alone');

const handled = await source.matchEnter({ sessionId: 's1' }, '/frontend-code-skimmer 分析 vue2click');
assert.equal(handled, 'handled', 'a line naming a server is consumed');
await flushTimers();
assert.equal(harness.submitted.length, 1, 'the composed instruction is submitted once');
assert.ok(harness.submitted[0].includes('mcp__frontend-code-skimmer__'), 'the submitted turn scopes the tool prefix');
assert.ok(harness.submitted[0].includes('分析 vue2click'), 'the submitted turn carries the typed task');

const bareHarness = createSlashHarness();
const bareSource = bareHarness.sources[0];
assert.equal(await bareSource.matchEnter({ sessionId: 's1' }, '/obscura'), 'handled', 'a bare server line is consumed');
await flushTimers();
assert.equal(bareHarness.submitted.length, 1, 'a task-less command still submits one turn');
assert.ok(bareHarness.submitted[0].includes('mcp__obscura__'), 'the task-less turn still names the prefix');

const orphanHarness = createSlashHarness();
assert.equal(await orphanHarness.sources[0].matchEnter({ sessionId: 'gone' }, '/obscura x'), 'handled', 'an unknown session is still consumed');
await flushTimers();
assert.equal(orphanHarness.submitted.length, 0, 'an unresolvable session submits nothing instead of throwing');

// A server named exactly like a built-in command must not steal that line.
const collideHarness = createSlashHarness({ list: rpcWith([], COLLIDING_ROWS) });
assert.equal(await collideHarness.sources[0].matchEnter({ sessionId: 's1' }, '/plan 排个计划'), undefined, 'a server named /plan yields the line');
await flushTimers();
assert.equal(collideHarness.submitted.length, 0, 'no turn is submitted for a reserved name');
assert.equal(await collideHarness.sources[0].matchEnter({ sessionId: 's1' }, '/obscura x'), 'handled', 'a non-reserved server is still claimed in the same session');
await flushTimers();
assert.equal(collideHarness.submitted.length, 1, 'that turn is submitted exactly once');

// A client without the trigger pipeline (or without lazy services) must not throw.
assert.equal(slash.registerMcpSlashSource({}, { list: async () => ({ ok: true, value: {} }) }, tSlash), false, 'a context without get() is refused');
assert.equal(
  slash.registerMcpSlashSource({ get: () => undefined, effect: () => {} }, { list: async () => ({ ok: true, value: {} }) }, tSlash),
  false,
  'a client without the trigger service is refused',
);
log('slash: registration, menu rows and the Enter path all behave');

console.log('client tests passed');
