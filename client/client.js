/**
 * @local/dsh-mcp-manager — browser half (frozen contract §2, §5–§8).
 *
 * One self-contained module: it may `require` only `react` (and
 * `react/jsx-runtime`), never a `@deepseek-ai/*` package, and it reads no file
 * at runtime. The public MCP catalog and both UI dictionaries are embedded as
 * plain constants below. The only network path is
 * `ctx.connection.rpc.call('/dsh-mcp-rpc', endpoint, payload)`.
 *
 * Registration: one `settings.plugins.tab` entry with the fresh id
 * `mcp-manager` (never the shipped `all` id) at order 20.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mcp-manager',
  factory(require) {
    const module = { exports: {} };
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dshMcpManager';
    /** Connection channel served by the Host half. */
    const RPC_CHANNEL = '/dsh-mcp-rpc';
    /** The mcp-client's own serverName constraint. */
    const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
    /** Display-name ceiling, matching the Host's manager.json cap (contract §3a). */
    const DISPLAY_NAME_MAX = 120;
    /** Header/env keys whose values are masked in the read-only detail view. */
    const SECRET_KEY_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
    /** Catalog browser (contract §6): page size and search debounce (t15). */
    const CATALOG_PAGE_SIZE = 24;
    const CATALOG_DEBOUNCE_MS = 350;
    /** The two live catalog sources; `registry` is the default. */
    const CATALOG_SOURCES = ['registry', 'npm'];
    const DEFAULT_CATALOG_SOURCE = 'registry';

    /** `error.code` → dictionary key. Unknown codes fall back to `error.message`. */
    const ERROR_KEYS = Object.freeze({
      'invalid-request': 'errorInvalidRequest',
      'name-conflict': 'errorNameConflict',
      'unknown-server': 'errorUnknownServer',
      'read-only': 'errorReadOnly',
      'install-failed': 'errorInstallFailed',
      'not-manager': 'errorNotManager',
      internal: 'errorInternal',
      network: 'errorNetwork',
    });

    /**
     * `value.notice.code` → dictionary key (t6/O4). A success value may carry a
     * notice when the Plugin Manager reported `application: "overridden"`: the
     * change was saved but is not live. Unknown codes fall back to the Host text.
     */
    const NOTICE_KEYS = Object.freeze({
      overridden: 'noticeOverridden',
    });

    // ---------------------------------------------------------------------
    // Dictionaries (embedded; `locale/*.json` is only pre-activation metadata)
    // ---------------------------------------------------------------------

    /** Simplified Chinese copy. */
    const zh = {
      tab: 'MCP',
      title: 'MCP 服务器',
      intro: '管理本地与远程 MCP 服务器，或从公共目录一键安装。',
      refresh: '刷新',
      retry: '重试',
      loadFailed: '加载服务器列表失败',
      empty: '还没有 MCP 服务器',
      emptyHint: '点击「添加」接入一个 stdio 或流式 HTTP 服务器，或从上面的公共目录一键安装。',
      searchServers: '搜索服务器',
      searchPlaceholder: '按名称或命令搜索…',
      add: '添加',
      addStdio: 'STDIO 服务器',
      addStdioHint: '本地进程：npx / uvx / 可执行文件',
      addHttp: '流式 HTTP 服务器',
      addHttpHint: '远程 Streamable HTTP 端点',
      serversTitle: '我的服务器',
      catalogTitle: '公共 MCP 目录',
      catalogIntro: '精选官方与主流 MCP 服务器，一键安装到当前 profile。',
      catalogSearch: '搜索目录…',
      catalogSearching: '正在搜索…',
      catalogEmpty: '没有匹配的服务器。',
      allCategories: '全部',
      sourceLabel: '目录来源',
      sourceRegistry: 'Registry',
      sourceNpm: 'npm',
      catalogRefresh: '刷新目录',
      refreshing: '刷新中…',
      catalogTotal: '共 {total} 个结果',
      catalogFiltered: '本页筛选出 {shown} 条',
      catalogLoadMore: '加载更多',
      catalogLoadingMore: '加载中…',
      catalogEnd: '已经到底了',
      catalogOfficial: '官方',
      originRegistry: 'Registry',
      originNpm: 'npm',
      originSeed: '离线种子',
      catalogDownloads: '月下载 {count}',
      catalogScore: '评分',
      install: '安装',
      installing: '安装中…',
      installed: '已安装',
      needsToken: '需要令牌',
      tokenOptional: '令牌可选',
      docs: '文档',
      transportStdio: 'STDIO',
      transportHttp: '流式 HTTP',
      statusConnected: '已连接',
      statusError: '错误',
      statusDisabled: '已停用',
      statusLoading: '连接中',
      enable: '启用',
      disable: '停用',
      edit: '编辑',
      remove: '删除',
      removeConfirm: '确定删除该服务器？',
      removeConfirmYes: '删除',
      readOnly: '只读',
      external: '外部配置',
      saving: '保存中…',
      cancel: '取消',
      close: '关闭',
      detailTitle: '服务器详情',
      detailTransport: '传输方式',
      detailStatus: '状态',
      detailBundle: '来源 bundle',
      detailManaged: '由本插件管理',
      detailExternal: '由配置文件手工添加，只能查看',
      detailStatusDetail: '错误详情',
      detailConfig: '连接配置',
      fieldName: '服务器名称',
      fieldLabel: '显示名称',
      fieldCommand: '命令',
      fieldArgs: '参数',
      fieldEnv: '环境变量',
      fieldCwd: '工作目录',
      fieldUrl: '端点 URL',
      fieldHeaders: '请求头',
      fieldNameHint: '仅字母、数字、下划线和连字符，最多 32 个字符；重命名请删除后重新添加。',
      fieldLabelHint: '仅用于界面展示，可输入中文；不影响模型看到的服务器名称。',
      fieldArgsHint: '每行一个参数',
      fieldEnvHint: '每行一条 KEY=VALUE',
      fieldHeadersHint: '每行一条 Header=Value',
      addTitle: '添加服务器',
      addSubmit: '添加',
      editSubmit: '保存修改',
      installTitle: '安装 {name}',
      installIntro: '该服务器需要以下凭据，只会写入本机的服务器配置。',
      installSubmit: '安装',
      errorNameRequired: '请填写服务器名称。',
      errorNameFormat: '服务器名称只能包含字母、数字、下划线和连字符，长度 1-32。',
      errorCommandRequired: 'stdio 服务器必须填写命令。',
      errorUrlRequired: '流式 HTTP 服务器必须填写 URL。',
      errorEnvRequired: '请填写「{key}」。',
      errorDisplayNameLong: '显示名称最多 120 个字符。',
      errorInvalidRequest: '请求格式有误，请检查输入内容。',
      errorNameConflict: '该服务器名称已被占用，请使用其他名称。',
      errorUnknownServer: '找不到该服务器，可能已被删除。',
      errorReadOnly: '该服务器为外部配置，无法修改。',
      errorInstallFailed: '安装失败，请检查网络连接和配置后重试。',
      errorNotManager: '当前环境不支持插件管理功能。',
      errorInternal: '系统内部错误，请稍后重试或联系管理员。',
      errorNetwork: '无法连接到服务，请检查网络连接。',
      errorUnknown: '发生未知错误，请重试。',
      noticeSaved: '已保存',
      noticeCreated: '已添加',
      noticeRemoved: '已删除',
      noticeEnabled: '已启用',
      noticeDisabled: '已停用',
      noticeInstalled: '已安装 {name}',
      noticeOverridden: '配置已保存，但由于存在更高优先级的配置，当前更改尚未生效。',
      managedRoot: '托管目录',
      optionalMark: '可选',
      oneClick: '一键安装',
      catalogOffline: '目录服务不可用，显示离线种子。',
      directInstallTitle: '直接安装 {name}',
      directInstallHint: '如果搜索结果里没有你要的服务器，可以直接按包名安装这个 npm 包（stdio，无需凭据）。',
      directInstall: '安装',
      argSuggestionHint: '建议参数：-y {name}',
      argSuggestion: '填入 -y {name}',
      argSuggestionGuide: '每行一个参数：`-y` 一行、包名一行，例如 @jokeran/frontend-code-skimmer',
      category_all: '全部',
      category_files: '文件',
      category_dev: '开发',
      category_web: '网络',
      category_data: '数据',
      category_browser: '浏览器',
      category_docs: '文档',
      category_productivity: '效率',
      category_reasoning: '推理',
      category_search: '搜索',
      category_automation: '自动化',
      category_database: '数据库',
      category_storage: '存储',
      category_communication: '通讯',
      category_ai: 'AI',
      category_tools: '工具',
      category_integration: '集成',
      category_monitoring: '监控',
      category_security: '安全',
    };

    /** English copy — identical key set to {@link zh}. */
    const en = {
      tab: 'MCP',
      title: 'MCP servers',
      intro: 'Manage local and remote MCP servers, or install one from the public catalog.',
      refresh: 'Refresh',
      retry: 'Retry',
      loadFailed: 'Could not load the server list',
      empty: 'No MCP servers yet',
      emptyHint: 'Use “Add” for a stdio or Streamable HTTP server, or install one from the public catalog above.',
      searchServers: 'Search servers',
      searchPlaceholder: 'Search by name or command…',
      add: 'Add',
      addStdio: 'STDIO server',
      addStdioHint: 'Local process: npx / uvx / executable',
      addHttp: 'Streamable HTTP server',
      addHttpHint: 'Remote Streamable HTTP endpoint',
      serversTitle: 'My servers',
      catalogTitle: 'Public MCP catalog',
      catalogIntro: 'Verified official and mainstream MCP servers, installed into the current profile.',
      catalogSearch: 'Search the catalog…',
      catalogSearching: 'Searching…',
      catalogEmpty: 'No matching servers.',
      allCategories: 'All',
      sourceLabel: 'Catalog source',
      sourceRegistry: 'Registry',
      sourceNpm: 'npm',
      catalogRefresh: 'Refresh',
      refreshing: 'Refreshing…',
      catalogTotal: '{total} results',
      catalogFiltered: '{shown} matching on this page',
      catalogLoadMore: 'Load more',
      catalogLoadingMore: 'Loading…',
      catalogEnd: 'End of results',
      catalogOfficial: 'Official',
      originRegistry: 'Registry',
      originNpm: 'npm',
      originSeed: 'Offline seed',
      catalogDownloads: '{count}/mo',
      catalogScore: 'Score',
      install: 'Install',
      installing: 'Installing…',
      installed: 'Installed',
      needsToken: 'Token required',
      tokenOptional: 'Token optional',
      docs: 'Docs',
      transportStdio: 'STDIO',
      transportHttp: 'Streamable HTTP',
      statusConnected: 'Connected',
      statusError: 'Error',
      statusDisabled: 'Disabled',
      statusLoading: 'Connecting',
      enable: 'Enable',
      disable: 'Disable',
      edit: 'Edit',
      remove: 'Remove',
      removeConfirm: 'Remove this server?',
      removeConfirmYes: 'Remove',
      readOnly: 'Read-only',
      external: 'External',
      saving: 'Saving…',
      cancel: 'Cancel',
      close: 'Close',
      detailTitle: 'Server details',
      detailTransport: 'Transport',
      detailStatus: 'Status',
      detailBundle: 'Source bundle',
      detailManaged: 'Managed by this plugin',
      detailExternal: 'Authored by hand in a config file; read-only',
      detailStatusDetail: 'Error detail',
      detailConfig: 'Connection',
      fieldName: 'Server name',
      fieldLabel: 'Display name',
      fieldCommand: 'Command',
      fieldArgs: 'Arguments',
      fieldEnv: 'Environment',
      fieldCwd: 'Working directory',
      fieldUrl: 'Endpoint URL',
      fieldHeaders: 'Headers',
      fieldNameHint: 'Letters, digits, underscore and hyphen only, 1–32 characters. To rename, remove and re-add.',
      fieldLabelHint: 'Display only — any language works; it does not change the server name the model sees.',
      fieldArgsHint: 'One argument per line',
      fieldEnvHint: 'One KEY=VALUE per line',
      fieldHeadersHint: 'One Header=Value per line',
      addTitle: 'Add a server',
      addSubmit: 'Add',
      editSubmit: 'Save changes',
      installTitle: 'Install {name}',
      installIntro: 'This server needs the credentials below; they are stored only in the local server config.',
      installSubmit: 'Install',
      errorNameRequired: 'Enter a server name.',
      errorNameFormat: 'A server name allows only letters, digits, underscore and hyphen, length 1–32.',
      errorCommandRequired: 'A stdio server needs a command.',
      errorUrlRequired: 'A Streamable HTTP server needs a URL.',
      errorEnvRequired: 'Enter a value for “{key}”.',
      errorDisplayNameLong: 'Display name must be at most 120 characters.',
      errorInvalidRequest: 'Invalid request format. Please check your input.',
      errorNameConflict: 'That server name is already in use. Please choose another one.',
      errorUnknownServer: 'Server not found. It may have been removed.',
      errorReadOnly: 'This server is externally configured and cannot be modified.',
      errorInstallFailed: 'Installation failed. Please check your network connection and configuration, then retry.',
      errorNotManager: 'Plugin management is not supported in this environment.',
      errorInternal: 'Internal system error. Please try again later or contact your administrator.',
      errorNetwork: 'Cannot connect to the service. Please check your network connection.',
      errorUnknown: 'An unknown error occurred. Please try again.',
      noticeSaved: 'Saved',
      noticeCreated: 'Added',
      noticeRemoved: 'Removed',
      noticeEnabled: 'Enabled',
      noticeDisabled: 'Disabled',
      noticeInstalled: 'Installed {name}',
      noticeOverridden: 'Configuration saved, but a higher-priority configuration exists. Current changes are not yet in effect.',
      managedRoot: 'Managed root',
      optionalMark: 'optional',
      oneClick: 'One-click install',
      catalogOffline: 'The catalog service is unavailable; showing the offline seed.',
      directInstallTitle: 'Install {name} directly',
      directInstallHint: 'If the search does not list the server you want, install this npm package by name (stdio, no credentials).',
      directInstall: 'Install',
      argSuggestionHint: 'Suggested arguments: -y {name}',
      argSuggestion: 'Fill in -y {name}',
      argSuggestionGuide: 'One argument per line: `-y` on one, the package name on the next (for example @jokeran/frontend-code-skimmer)',
      category_all: 'All',
      category_files: 'Files',
      category_dev: 'Development',
      category_web: 'Web',
      category_data: 'Data',
      category_browser: 'Browser',
      category_docs: 'Docs',
      category_productivity: 'Productivity',
      category_reasoning: 'Reasoning',
      category_search: 'Search',
      category_automation: 'Automation',
      category_database: 'Database',
      category_storage: 'Storage',
      category_communication: 'Communication',
      category_ai: 'AI',
      category_tools: 'Tools',
      category_integration: 'Integration',
      category_monitoring: 'Monitoring',
      category_security: 'Security',
    };

    // ---------------------------------------------------------------------
    // Public MCP catalog
    //
    // The authoritative catalog is `client/catalog.json` (CatalogEntry per
    // contract §7); the Host serves it through the `catalog` endpoint. What
    // lives here is a deliberately small offline seed used ONLY when that
    // endpoint fails, so the catalog section still renders without a Host. A
    // successful endpoint response is never overridden by it.
    // ---------------------------------------------------------------------

    const CATALOG_SEED = Object.freeze([
      {
        id: 'everything',
        title: { zh: 'Everything 测试服务器', en: 'Everything (test server)' },
        description: {
          zh: '官方参考实现，暴露 prompt、resource 与 tool，无需任何凭据即可安装和联通。',
          en: 'Official reference implementation exposing prompts, resources and tools; installs and connects with no credentials at all.',
        },
        category: 'dev',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
        origin: 'seed',
        packageId: 'npm:@modelcontextprotocol/server-everything',
        docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
      },
      {
        id: 'filesystem',
        title: { zh: '文件系统', en: 'Filesystem' },
        description: {
          zh: '读写允许目录下的文件（官方参考服务器）。安装后请把参数里的目录改成你自己的路径。',
          en: 'Read and write files under allowed directories (official reference server). Point the directory argument at your own path after install.',
        },
        category: 'files',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/directory'],
        origin: 'seed',
        packageId: 'npm:@modelcontextprotocol/server-filesystem',
        docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
      },
      {
        id: 'memory',
        title: { zh: '记忆', en: 'Memory' },
        description: {
          zh: '基于知识图谱的持久记忆服务器（官方参考服务器）。',
          en: 'Knowledge-graph based persistent memory server (official reference server).',
        },
        category: 'data',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        origin: 'seed',
        packageId: 'npm:@modelcontextprotocol/server-memory',
        envKeys: [
          {
            key: 'MEMORY_FILE_PATH',
            label: { zh: '记忆文件路径', en: 'Memory file path' },
            required: false,
            placeholder: '~/.dsh/mcp-memory.json',
          },
        ],
        docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
      },
      {
        id: 'sequential-thinking',
        title: { zh: '顺序思考', en: 'Sequential thinking' },
        description: {
          zh: '把复杂问题拆成可修订的思考步骤（官方参考服务器）。',
          en: 'Break a complex problem into revisable reasoning steps (official reference server).',
        },
        category: 'reasoning',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        origin: 'seed',
        packageId: 'npm:@modelcontextprotocol/server-sequential-thinking',
        docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
      },
      {
        id: 'deepwiki',
        title: { zh: 'DeepWiki 远程', en: 'DeepWiki (remote)' },
        description: {
          zh: '对任意 GitHub 仓库提问，无需安装任何本地进程。',
          en: 'Ask questions about any GitHub repository; nothing to install locally.',
        },
        category: 'docs',
        transport: 'streamable-http',
        url: 'https://mcp.deepwiki.com/mcp',
        origin: 'seed',
        docs: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
      },
    ]);

    // ---------------------------------------------------------------------
    // Theme tokens (contract §8: only --dsw-* tokens, never a literal color)
    // ---------------------------------------------------------------------

    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary)',
      foreground: 'var(--dsw-alias-label-primary-foreground)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)',
      bgLayer3: 'var(--dsw-alias-bg-layer-3)',
      bgSkeleton: 'var(--dsw-alias-bg-skeleton)',
      borderL1: 'var(--dsw-alias-border-l1)',
      borderL2: 'var(--dsw-alias-border-l2)',
      borderL3: 'var(--dsw-alias-border-l3)',
      borderL4: 'var(--dsw-alias-border-l4)',
      radiusSm: 'var(--dsw-radius-sm)',
      radiusMd: 'var(--dsw-radius-md)',
      radiusLg: 'var(--dsw-radius-lg)',
      radiusPanel: 'var(--dsw-radius-panel)',
      elevationProminent: 'var(--dsw-elevation-prominent)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      business: 'var(--dsw-alias-state-business-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
      buttonPrimaryFill: 'var(--dsw-alias-button-primary-fill)',
      buttonGhostActiveFill: 'var(--dsw-alias-button-ghost-active-fill)',
      switchThumb: 'var(--dsw-alias-switch-thumb)',
      mask: 'var(--dsw-alias-bg-mask-1)',
      menuSurface: 'var(--dsw-menu-surface-fill)',
      // `--dsw-font-mono` is not guaranteed in every host build, so the stack
      // carries the same fallbacks the shipped plugin manager uses (t6/O5).
      mono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    };

    /** Component-local stylesheet: hover/focus states inline styles cannot express. */
    const CSS = [
      '.dshmcp-root{display:flex;flex-direction:column;gap:18px;',
      'color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;max-width:920px;min-width:0}',
      '.dshmcp-card{transition:border-color 120ms ease}',
      '.dshmcp-card:hover{border-color:var(--dsw-alias-border-l3)}',
      '.dshmcp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshmcp-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshmcp-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dshmcp-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshmcp-icon-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dshmcp-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshmcp-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshmcp-title-btn:hover{color:var(--dsw-alias-state-business-primary)}',
      '.dshmcp-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dshmcp-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.dshmcp-btn:focus-visible,.dshmcp-icon-btn:focus-visible,.dshmcp-chip:focus-visible,',
      '.dshmcp-switch:focus-visible,.dshmcp-menu-item:focus-visible,.dshmcp-input:focus-visible,',
      '.dshmcp-title-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dshmcp-skeleton{animation:dshmcp-pulse 1.4s ease-in-out infinite}',
      '@keyframes dshmcp-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '@media (prefers-reduced-motion: reduce){.dshmcp-skeleton{animation:none}}',
      '.dshmcp-scroll{scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}',
    ].join('');

    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', gap: '18px', minWidth: '0',
        color: T.labelPrimary, fontSize: '13px', lineHeight: '20px',
      },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
      title: { margin: '0', fontSize: '18px', fontWeight: 600, lineHeight: '26px', color: T.labelPrimary },
      intro: { margin: '4px 0 0', fontSize: '13px', lineHeight: '20px', color: T.labelTertiary, maxWidth: '640px' },
      section: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '0' },
      sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      sectionTitle: { margin: '0', fontSize: '15px', fontWeight: 600, lineHeight: '22px', color: T.labelPrimary },
      sectionIntro: { margin: '0', fontSize: '12px', lineHeight: '18px', color: T.labelTertiary },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: '0' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(248px,1fr))', gap: '10px' },
      card: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', minWidth: '0',
        border: '0.5px solid ' + T.borderL2, borderRadius: T.radiusLg, background: T.bgLayer1,
      },
      cardList: { display: 'flex', flexDirection: 'column', gap: '10px' },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' },
      cardTitleBtn: {
        display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 auto', minWidth: '0',
        padding: '2px 0', border: 'none', background: 'transparent', cursor: 'pointer',
        font: 'inherit', color: T.labelPrimary, textAlign: 'left',
      },
      cardName: { fontSize: '14px', fontWeight: 600, lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      cardActions: { display: 'flex', alignItems: 'center', gap: '2px', flex: '0 0 auto' },
      muted: { color: T.labelTertiary, margin: '0', fontSize: '12px', lineHeight: '18px' },
      mono: { fontFamily: T.mono, fontSize: '12px', lineHeight: '18px', color: T.labelSecondary, wordBreak: 'break-all' },
      input: {
        boxSizing: 'border-box', width: '100%', minWidth: '0', height: '28px', padding: '0 8px',
        border: '0.5px solid ' + T.borderL4, borderRadius: T.radiusMd, background: T.bgLayer1,
        color: T.labelPrimary, font: 'inherit', fontSize: '13px', outline: 'none',
      },
      textarea: {
        boxSizing: 'border-box', width: '100%', minWidth: '0', minHeight: '52px', padding: '6px 8px',
        border: '0.5px solid ' + T.borderL4, borderRadius: T.radiusMd, background: T.bgLayer1,
        color: T.labelPrimary, font: 'inherit', fontSize: '12px', lineHeight: '18px', outline: 'none',
        resize: 'vertical', fontFamily: T.mono,
      },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '0' },
      label: { fontSize: '12px', lineHeight: '18px', color: T.labelSecondary },
      hint: { fontSize: '11px', lineHeight: '16px', color: T.labelCaption },
      fieldError: { fontSize: '11px', lineHeight: '16px', color: T.error },
      row2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '10px' },
      detail: {
        display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '10px',
        borderTop: '0.5px solid ' + T.borderL2,
      },
      kv: { display: 'grid', gridTemplateColumns: 'minmax(96px,140px) 1fr', gap: '4px 10px', alignItems: 'baseline' },
      kvKey: { fontSize: '12px', lineHeight: '18px', color: T.labelTertiary },
      kvValue: { fontSize: '12px', lineHeight: '18px', color: T.labelSecondary, minWidth: '0', wordBreak: 'break-word' },
      skeletonCard: { minHeight: '76px', justifyContent: 'center' },
      skeletonBar: { height: '10px', borderRadius: T.radiusSm, background: T.bgSkeleton },
      empty: {
        display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center', justifyContent: 'center',
        padding: '28px 16px', border: '0.5px dashed ' + T.borderL3, borderRadius: T.radiusLg,
        background: T.bgLayer1, textAlign: 'center',
      },
      overlay: {
        position: 'fixed', inset: '0', zIndex: 1000, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: '24px', background: T.mask,
      },
      modal: {
        boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '14px', width: 'min(520px,100%)',
        maxHeight: '100%', overflowY: 'auto', padding: '20px 22px', border: '0.5px solid ' + T.borderL2,
        borderRadius: T.radiusPanel, background: T.bgLayer2, boxShadow: T.elevationProminent,
      },
      modalHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
      modalTitle: { margin: '0', fontSize: '16px', fontWeight: 600, lineHeight: '24px', color: T.labelPrimary },
      modalFoot: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' },
      menuRoot: { position: 'relative', display: 'inline-flex' },
      menu: {
        position: 'absolute', top: 'calc(100% + 4px)', right: '0', zIndex: 100, minWidth: '228px',
        display: 'flex', flexDirection: 'column', padding: '4px', border: '0.5px solid ' + T.borderL1,
        borderRadius: T.radiusLg, background: T.menuSurface, boxShadow: T.elevationProminent,
      },
      menuItem: {
        display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', padding: '7px 9px',
        border: 'none', borderRadius: T.radiusMd, background: 'transparent', cursor: 'pointer',
        font: 'inherit', color: T.labelPrimary, textAlign: 'left',
      },
      menuItemHint: { fontSize: '11px', lineHeight: '16px', color: T.labelTertiary },
      notice: {
        display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '8px 10px',
        border: '0.5px solid ' + T.borderL2, borderRadius: T.radiusMd, background: T.bgLayer2,
      },
      chips: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      segment: {
        display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '2px',
        borderRadius: T.radiusMd, background: T.bgLayer3,
      },
      badges: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      meta: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: '0' },
      degraded: {
        margin: '0', padding: '8px 10px', fontSize: '12px', lineHeight: '18px', color: T.warn,
        border: '0.5px solid ' + T.borderL2, borderRadius: T.radiusMd, background: T.bgLayer2,
      },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto' },
      spinner: {
        width: '12px', height: '12px', borderRadius: '50%', flex: '0 0 auto',
        border: '1.5px solid ' + T.borderL4, borderTopColor: T.business,
      },
    };

    // ---------------------------------------------------------------------
    // Defensive readers — the component must never throw during render (§8)
    // ---------------------------------------------------------------------

    function asString(value) {
      return typeof value === 'string' ? value : '';
    }

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function asRecord(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function textOf(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (value instanceof Error) return asString(value.message) || String(value.name || 'Error');
      try {
        return String(value);
      } catch (error) {
        return '';
      }
    }

    /** Pick one side of a `{zh, en}` text pair, falling back to the other. */
    function pickText(pair, locale) {
      const record = asRecord(pair);
      const primary = asString(locale).toLowerCase().startsWith('zh') ? 'zh' : 'en';
      const secondary = primary === 'zh' ? 'en' : 'zh';
      return asString(record[primary]) || asString(record[secondary]);
    }

    /** `category` → localized label, falling back to the raw value. */
    function categoryLabel(t, value) {
      const raw = asString(value);
      if (!raw) return '';
      const key = 'category_' + raw.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const text = t(key);
      return text && text !== key ? text : raw;
    }

    /** Map one RPC failure to user-facing text, preferring the local dictionary. */
    function errorText(t, error) {
      const code = asString(asRecord(error).code);
      const key = ERROR_KEYS[code];
      if (key) {
        const mapped = t(key);
        if (mapped && mapped !== key) return mapped;
      }
      const message = asString(asRecord(error).message);
      return message || t('errorUnknown');
    }

    /** `{ text, detail }` — the detail line shows the Host message when it adds information. */
    function errorParts(t, error) {
      const text = errorText(t, error);
      const message = asString(asRecord(error).message);
      return { text, detail: message && message !== text ? message : '' };
    }

    function parseLines(value) {
      return asString(value)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    function parsePairs(value) {
      const result = {};
      for (const line of parseLines(value)) {
        const index = line.indexOf('=');
        if (index === -1) result[line] = '';
        else {
          const key = line.slice(0, index).trim();
          if (key) result[key] = line.slice(index + 1).trim();
        }
      }
      return result;
    }

    function formatPairs(value) {
      const record = asRecord(value);
      return Object.keys(record)
        .map((key) => key + '=' + asString(record[key]))
        .join('\n');
    }

    function maskPairs(value) {
      const record = asRecord(value);
      return Object.keys(record).map((key) => ({
        key,
        value: SECRET_KEY_PATTERN.test(key) ? '••••••' : asString(record[key]),
      }));
    }

    function entriesOf(record) {
      const safe = asRecord(record);
      return Object.keys(safe).map((key) => ({ key, value: asString(safe[key]) }));
    }

    /**
     * Human-readable counts for catalog cards (t15): `73万` / `1.2k`. Chinese
     * scales by 亿/万, other locales by B/M/k. Missing or invalid → "" so the
     * card renders no empty placeholder.
     */
    function formatCount(value, locale) {
      const number = typeof value === 'number' && isFinite(value) ? value : null;
      if (number === null || number < 0) return '';
      // Chinese scales by 亿/万 and keeps `k` below 万 (73万 / 1.2k); other
      // locales use the B/M/k ladder.
      const units = asString(locale).toLowerCase().startsWith('zh')
        ? [[1e8, '亿'], [1e4, '万'], [1e3, 'k']]
        : [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
      for (const unit of units) {
        if (number >= unit[0]) {
          const scaled = number / unit[0];
          const text = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1);
          return text.replace(/\.0$/, '') + unit[1];
        }
      }
      return String(Math.round(number));
    }

    /** npm `score.final` → two decimals; "" when the source reports no score. */
    function formatScore(value) {
      const number = typeof value === 'number' && isFinite(value) ? value : null;
      return number === null ? '' : number.toFixed(2);
    }

    /**
     * Where a catalog card came from (t15). `origin` may be missing on an
     * older/partial payload: fall back to the source that served the page.
     */
    function originInfo(entry, source) {
      const raw = asString(asRecord(entry).origin);
      const origin = raw === 'npm' || raw === 'registry' || raw === 'seed'
        ? raw
        : (asString(source) === 'npm' ? 'npm' : 'registry');
      if (origin === 'seed') return { origin, key: 'originSeed', tone: 'warn' };
      if (origin === 'npm') return { origin, key: 'originNpm', tone: 'info' };
      return { origin, key: 'originRegistry', tone: 'outline' };
    }

    /**
     * A readable `serverName` seed for an install: the live `packageId` tail
     * when present (`npm:@scope/name` → `name`), otherwise the entry id.
     */
    function installNameBase(entry) {
      const source = asRecord(entry);
      const packageId = asString(source.packageId);
      if (packageId) {
        const tail = packageId.slice(packageId.lastIndexOf(':') + 1);
        const unscoped = tail.slice(tail.lastIndexOf('/') + 1);
        if (unscoped) return unscoped;
      }
      return asString(source.id);
    }

    // ---------------------------------------------------------------------
    // View model normalization (contract §5) — tolerant of a partial payload
    // ---------------------------------------------------------------------

    /**
     * Stable, unique identity for one rendered row (t6/O1). External rows carry
     * `id: ''` (contract §5), so keying expansion state on `id` alone would tie
     * every external card together. `serverName` is unique among all rows
     * (contract §2), and the list index is the last resort for a row that has
     * neither — never an empty string.
     */
    function serverKey(server, index) {
      const id = asString(asRecord(server).id);
      if (id) return id;
      const name = asString(asRecord(server).name);
      if (name) return 'name:' + name;
      return 'row:' + String(Number.isFinite(index) ? index : 0);
    }

    /** A card offers edit/delete/toggle only when the Host says it is writable (t6/O3). */
    function isWritable(server) {
      const source = asRecord(server);
      return source.managed !== false && !asString(source.readOnlyReason);
    }

    function normalizeServer(raw) {
      const source = asRecord(raw);
      const config = asRecord(source.config);
      const enabled = source.enabled !== false;
      const phase = typeof source.phase === 'string' ? source.phase : null;
      const transport = source.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
      let status = asString(source.status);
      if (status !== 'connected' && status !== 'error' && status !== 'disabled' && status !== 'loading') {
        if (!enabled) status = 'disabled';
        else if (phase === 'active') status = 'connected';
        else if (phase === 'failed') status = 'error';
        else status = 'loading';
      }
      const name = asString(source.name) || asString(source.id);
      return {
        id: asString(source.id),
        name,
        label: asString(source.label) || name,
        transport,
        enabled,
        phase,
        managed: source.managed !== false,
        readOnlyReason: asString(source.readOnlyReason) || null,
        status,
        statusDetail: asString(source.statusDetail) || null,
        bundle: asString(source.bundle) || null,
        config: {
          command: asString(config.command) || null,
          args: asArray(config.args).map(asString).filter((arg) => arg.length > 0),
          env: asRecord(config.env),
          cwd: asString(config.cwd) || null,
          url: asString(config.url) || null,
          headers: asRecord(config.headers),
          failOnStartupError: config.failOnStartupError === true,
        },
      };
    }

    function statusTone(status) {
      if (status === 'connected') return 'success';
      if (status === 'error') return 'error';
      if (status === 'disabled') return 'idle';
      return 'warn';
    }

    function statusColor(status) {
      if (status === 'connected') return T.success;
      if (status === 'error') return T.error;
      if (status === 'disabled') return T.idle;
      return T.warn;
    }

    function statusKey(status) {
      if (status === 'connected') return 'statusConnected';
      if (status === 'error') return 'statusError';
      if (status === 'disabled') return 'statusDisabled';
      return 'statusLoading';
    }

    // ---------------------------------------------------------------------
    // Filters and install-input builders
    // ---------------------------------------------------------------------

    function filterServers(rawServers, query) {
      const list = asArray(rawServers).map(normalizeServer);
      const needle = asString(query).trim().toLowerCase();
      if (!needle) return list;
      return list.filter((server) =>
        [server.name, server.label, server.id, server.config.command, server.config.url]
          .map(asString)
          .join(' ')
          .toLowerCase()
          .includes(needle));
    }

    /**
     * Grouping chips for the loaded page. A registry entry's category is its
     * own namespace, so a raw list would be one chip per card (t15): only
     * groups with at least two members are offered, most populated first, and
     * the active filter is always kept so it can be cleared again.
     */
    function catalogCategories(entries, active) {
      const counts = new Map();
      for (const raw of asArray(entries)) {
        const category = asString(asRecord(raw).category);
        if (category) counts.set(category, (counts.get(category) || 0) + 1);
      }
      const groups = [];
      for (const pair of counts.entries()) {
        if (pair[1] >= 2 || pair[0] === active) groups.push(pair);
      }
      groups.sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
      const names = groups.slice(0, 8).map((pair) => pair[0]);
      if (active && active !== 'all' && names.indexOf(active) === -1) names.push(active);
      return names;
    }

    // ---------------------------------------------------------------------
    // Direct package install (t17)
    // ---------------------------------------------------------------------

    /** An exact npm package spec: `name`, `@scope/name`, either with `@version`. */
    const PACKAGE_SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[\w.+-]+)?$/i;

    /**
     * Read a catalog query as an exact package name (t17), or null when it is a
     * plain search phrase. Only word-free specs qualify, so "github server"
     * never becomes a package.
     */
    function readPackageQuery(query) {
      const trimmed = asString(query).trim();
      if (trimmed === '' || /\s/.test(trimmed) || !PACKAGE_SPEC_PATTERN.test(trimmed)) return null;
      return trimmed;
    }

    /** True for an unambiguous npm package (a scope), which any tab may install. */
    function isScopedPackageSpec(query) {
      const spec = readPackageQuery(query);
      return spec !== null && spec.startsWith('@') && spec.includes('/');
    }

    /**
     * The card a user gets when they type a package name instead of keywords:
     * the same shape as a live npm card, so the existing install path (zero
     * envKeys, one click) handles it unchanged.
     * @param spec - an exact package spec.
     * @param t - the bound translator.
     * @returns a `CatalogEntry`-shaped object.
     */
    function directInstallEntry(spec, t) {
      return {
        id: spec,
        title: { zh: spec, en: spec },
        description: { zh: t('directInstallHint'), en: t('directInstallHint') },
        category: 'npm',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', spec],
        origin: 'npm',
        packageId: 'npm:' + spec,
      };
    }

    /**
     * A package name a user already typed into the custom-add form (t17), so the
     * args field can offer `-y <pkg>` instead of making them guess `npx`.
     */
    function suggestPackageArg(name, displayName, args) {
      if (asString(args).trim() !== '') return null;
      return readPackageQuery(displayName) || readPackageQuery(name) || null;
    }

    /**
     * Merge a newly fetched catalog page into the rows already on screen (t19/F1).
     *
     * The registry pages by `name:version`, so a server's *other* version can
     * land on the next page: appending blindly shows the same server twice
     * (measured: `agency.goji/goji` 1.0.0→1.0.1 and
     * `agency.ottobot/licensed-house-painters` 0.1.1→0.1.2 across four pages).
     * `entry.id` is the merge key, and the rule is deterministic:
     *
     * 1. a card marked `official` (the registry's own "this is the latest
     *    publication") replaces one that is not, whichever page it came from;
     * 2. otherwise the first card seen for that id wins, so paging never makes an
     *    existing card jump or change under the user;
     * 3. entries without an id never collapse into each other.
     *
     * The result keeps every distinct id that was on screen, so "load more" can
     * only ever grow (minus the true duplicates it removes) — never shrink.
     */
    function mergeCatalogEntries(current, page) {
      const merged = new Map();
      const rows = asArray(current).concat(asArray(page));
      for (let index = 0; index < rows.length; index += 1) {
        const raw = rows[index];
        const entry = asRecord(raw);
        const id = asString(entry.id);
        const key = id || 'entry:' + index;
        const existing = merged.get(key);
        if (existing === undefined) {
          merged.set(key, raw);
          continue;
        }
        if (asRecord(existing).official !== true && entry.official === true) merged.set(key, raw);
      }
      const result = [];
      for (const value of merged.values()) result.push(value);
      return result;
    }

    function filterCatalog(entries, category, query, locale) {
      const needle = asString(query).trim().toLowerCase();
      return asArray(entries).filter((raw) => {
        const entry = asRecord(raw);
        if (category && category !== 'all' && asString(entry.category) !== category) return false;
        if (!needle) return true;
        return [
          asString(entry.id),
          pickText(entry.title, locale),
          pickText(entry.description, locale),
          asString(entry.category),
          asString(entry.command),
          asArray(entry.args).map(asString).join(' '),
          asString(entry.url),
        ].join(' ').toLowerCase().includes(needle);
      });
    }

    function entryNeedsToken(entry) {
      return asArray(asRecord(entry).envKeys).some((raw) => asRecord(raw).required === true);
    }

    function isCatalogEntryInstalled(entry, servers) {
      const source = asRecord(entry);
      const id = asString(source.id);
      const command = asString(source.command);
      const args = asArray(source.args).map(asString).join(' ');
      const url = asString(source.url);
      // Derive the base name that would be used during installation
      const nameBase = installNameBase(source);

      for (const raw of asArray(servers)) {
        const server = normalizeServer(raw);

        // For stdio servers, prioritize command + args comparison (most reliable)
        if (source.transport === 'stdio' && server.transport === 'stdio') {
          const serverArgs = server.config.args.join(' ');
          if (command && server.config.command === command && serverArgs === args) {
            return true;
          }
        }

        // For HTTP servers, prioritize URL comparison (most reliable)
        if (source.transport === 'streamable-http' && server.transport === 'streamable-http') {
          if (url && server.config.url === url) {
            return true;
          }
        }

        // Check by exact id match
        if (id && server.name === id) {
          return true;
        }

        // Check if server name matches the pattern that uniqueName would generate
        // This handles cases like @scope/package-name -> package-name
        if (nameBase) {
          const normalizedBase = nameBase.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
          // Check base name and potential suffixed versions (name-2, name-3, etc)
          if (server.name === normalizedBase) {
            return true;
          }
          if (server.name.startsWith(normalizedBase + '-')) {
            const suffix = server.name.slice(normalizedBase.length + 1);
            if (/^\d+$/.test(suffix)) {
              return true;
            }
          }
        }
      }

      return false;
    }

    /** Sanitize a catalog id into a free `serverName`, suffixing on collision. */
    function uniqueName(base, servers) {
      let name = asString(base).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!name) name = 'mcp';
      name = name.slice(0, 32);
      const taken = {};
      for (const raw of asArray(servers)) {
        const existing = asString(asRecord(raw).name);
        if (existing) taken[existing] = true;
      }
      if (!taken[name]) return name;
      for (let index = 2; index < 100; index += 1) {
        const candidate = name.slice(0, 30) + '-' + index;
        if (!taken[candidate]) return candidate;
      }
      return name;
    }

    /** Catalog entry + collected credentials → `ServerInput` (contract §6/§7). */
    function buildInstallInput(entry, values, servers, locale) {
      const source = asRecord(entry);
      const transport = source.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
      // The catalog title is the natural display name (contract §3a), so an
      // install from the catalog arrives already titled.
      const input = {
        name: uniqueName(installNameBase(source), servers),
        displayName: pickText(source.title, locale),
        transport,
      };
      if (transport === 'stdio') {
        input.command = asString(source.command);
        const args = asArray(source.args).map(asString).filter((arg) => arg.length > 0);
        if (args.length) input.args = args;
      } else {
        input.url = asString(source.url);
      }
      // `envKeys` are folded into `input.env` (contract §7).
      const env = {};
      for (const raw of asArray(source.envKeys)) {
        const key = asString(asRecord(raw).key);
        const value = asString(asRecord(values)[key]).trim();
        if (key && value) env[key] = value;
      }
      if (Object.keys(env).length) input.env = env;
      return input;
    }

    function formValue(server) {
      const value = {
        name: server.name,
        // The form carries the user-facing title; it may be any UTF-8 text.
        displayName: server.label && server.label !== server.name ? server.label : '',
        command: server.config.command || '',
        args: server.config.args.join('\n'),
        env: formatPairs(server.config.env),
        cwd: server.config.cwd || '',
        url: server.config.url || '',
        headers: formatPairs(server.config.headers),
      };
      if (!value.name && server.id) value.name = server.id;
      return value;
    }

    function emptyForm(transport) {
      return {
        name: '',
        displayName: '',
        command: transport === 'stdio' ? 'npx' : '',
        args: '',
        env: '',
        cwd: '',
        url: '',
        headers: '',
      };
    }

    function buildInput(transport, value) {
      const form = asRecord(value);
      const input = { name: asString(form.name).trim(), transport };
      // Always sent, even when empty: an explicit empty display name is how the
      // user clears a stored label (contract §3a).
      input.displayName = asString(form.displayName).trim();
      if (transport === 'stdio') {
        input.command = asString(form.command).trim();
        const args = parseLines(form.args);
        if (args.length) input.args = args;
        const env = parsePairs(form.env);
        if (Object.keys(env).length) input.env = env;
        const cwd = asString(form.cwd).trim();
        if (cwd) input.cwd = cwd;
      } else {
        input.url = asString(form.url).trim();
        const headers = parsePairs(form.headers);
        if (Object.keys(headers).length) input.headers = headers;
      }
      return input;
    }

    function validateInput(t, transport, value) {
      const form = asRecord(value);
      const errors = {};
      const name = asString(form.name).trim();
      if (!name) errors.name = t('errorNameRequired');
      else if (!NAME_PATTERN.test(name)) errors.name = t('errorNameFormat');
      // The Host enforces the same ceiling (contract §3a); this keeps the form
      // from round-tripping an obviously invalid title.
      if (asString(form.displayName).trim().length > DISPLAY_NAME_MAX) errors.displayName = t('errorDisplayNameLong');
      if (transport === 'stdio' && !asString(form.command).trim()) errors.command = t('errorCommandRequired');
      if (transport !== 'stdio' && !asString(form.url).trim()) errors.url = t('errorUrlRequired');
      return errors;
    }

    // ---------------------------------------------------------------------
    // Client — the only network path (contract §6)
    // ---------------------------------------------------------------------

    function createClient(ctx) {
      const connection = asRecord(ctx).connection;
      const rpc = asRecord(connection).rpc;
      const localeService = asRecord(ctx).locale;

      async function call(endpoint, payload) {
        if (typeof rpc.call !== 'function') {
          return { ok: false, error: { code: 'network', message: 'connection.rpc is unavailable' } };
        }
        let result;
        try {
          result = await rpc.call(RPC_CHANNEL, endpoint, payload);
        } catch (error) {
          return { ok: false, error: { code: 'network', message: textOf(error) } };
        }
        if (result && result.ok === true) return { ok: true, value: result.value };
        const raw = asRecord(result && result.error);
        return {
          ok: false,
          error: {
            code: asString(raw.code) || 'internal',
            message: asString(raw.message),
            details: raw.details,
          },
        };
      }

      return {
        call,
        list() {
          return call('list', {});
        },
        add(input) {
          return call('add', { input });
        },
        update(id, input) {
          return call('update', { id, input });
        },
        toggle(id, enabled) {
          return call('update', { id, toggle: enabled ? 'enable' : 'disable' });
        },
        remove(id) {
          return call('remove', { id });
        },
        /**
         * One catalog page (contract §6). `{ source, query, cursor, limit }` →
         * `{ source, entries, nextCursor, total, hasMore, degraded, fetchedAt }`.
         */
        catalog(params) {
          const input = asRecord(params);
          const source = input.source === 'npm' ? 'npm' : DEFAULT_CATALOG_SOURCE;
          const limit = typeof input.limit === 'number' && isFinite(input.limit)
            ? input.limit
            : CATALOG_PAGE_SIZE;
          return call('catalog', {
            source,
            query: asString(input.query),
            cursor: asString(input.cursor) || null,
            limit,
          });
        },
        locale() {
          try {
            const snapshot = typeof localeService.getSnapshot === 'function' ? asRecord(localeService.getSnapshot()) : {};
            return asString(snapshot.active) || 'zh';
          } catch (error) {
            return 'zh';
          }
        },
      };
    }

    // ---------------------------------------------------------------------
    // Small building blocks
    // ---------------------------------------------------------------------

    function Button(props) {
      const kind = props.kind || 'ghost';
      const style = {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: '5px', height: props.small ? '26px' : '32px', padding: props.small ? '0 10px' : '0 14px',
        border: 'none', borderRadius: props.small ? T.radiusSm : T.radiusMd, cursor: props.disabled ? 'not-allowed' : 'pointer',
        font: 'inherit', fontSize: props.small ? '12px' : '13px',
        color: T.labelPrimary, background: 'transparent', opacity: props.disabled ? 0.45 : 1,
      };
      if (kind === 'primary') {
        style.background = T.buttonPrimaryFill;
        style.color = T.foreground;
      }
      if (kind === 'outline') style.border = '0.5px solid ' + T.borderL3;
      if (kind === 'danger') style.color = T.error;
      return h('button', {
        type: 'button',
        className: 'dshmcp-btn' + (kind === 'primary' ? ' dshmcp-btn-primary' : '') + (kind === 'danger' ? ' dshmcp-btn-danger' : '')
          + (props.extraClass ? ' ' + props.extraClass : ''),
        style,
        disabled: props.disabled === true,
        title: props.title,
        'aria-label': props.ariaLabel,
        'aria-haspopup': props['aria-haspopup'],
        'aria-expanded': props['aria-expanded'],
        onClick: props.onClick,
      }, props.children);
    }

    function IconButton(props) {
      const kind = props.danger ? 'danger' : 'plain';
      return h('button', {
        type: 'button',
        className: 'dshmcp-icon-btn' + (props.danger ? ' dshmcp-icon-btn-danger' : ''),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '26px',
          border: 'none', borderRadius: T.radiusSm, background: 'transparent', cursor: props.disabled ? 'not-allowed' : 'pointer',
          color: props.danger ? T.error : T.labelSecondary, opacity: props.disabled ? 0.45 : 1, padding: '0',
        },
        disabled: props.disabled === true,
        title: props.title,
        'aria-label': props.ariaLabel,
        onClick: props.onClick,
      }, props.children);
    }

    function Switch(props) {
      const checked = props.checked === true;
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'dshmcp-switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': props.ariaLabel,
        title: props.title,
        disabled: props.disabled === true,
        style: {
          boxSizing: 'border-box', position: 'relative', flex: '0 0 auto', width: '36px', height: '20px',
          padding: '2px', border: 'none', borderRadius: '999px',
          background: checked ? T.brand : T.borderL3, cursor: props.disabled ? 'not-allowed' : 'pointer',
          opacity: props.disabled ? 0.5 : 1,
        },
        onClick: props.onClick,
      }, h('span', {
        'aria-hidden': true,
        style: {
          display: 'block', width: '16px', height: '16px', borderRadius: '50%',
          background: checked ? T.foreground : T.switchThumb,
          transform: checked ? 'translateX(16px)' : 'none', transition: 'transform 120ms ease',
        },
      }));
    }

    function Tag(props) {
      const tone = props.tone || 'outline';
      const style = {
        display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', borderRadius: '999px',
        padding: '1px 8px', fontSize: '11px', lineHeight: '17px', fontWeight: 500, whiteSpace: 'nowrap',
      };
      if (tone === 'outline') {
        style.border = '0.5px solid ' + T.borderL4;
        style.color = T.labelTertiary;
      } else if (tone === 'success') {
        style.color = T.success;
        style.background = 'color-mix(in srgb, ' + T.success + ' 10%, transparent)';
      } else if (tone === 'error') {
        style.color = T.error;
        style.background = 'color-mix(in srgb, ' + T.error + ' 10%, transparent)';
      } else if (tone === 'warn') {
        style.color = T.warn;
        style.background = 'color-mix(in srgb, ' + T.warn + ' 12%, transparent)';
      } else if (tone === 'info') {
        style.color = T.business;
        style.background = 'color-mix(in srgb, ' + T.business + ' 10%, transparent)';
      }
      return h('span', { className: 'dshmcp-tag', style }, props.children);
    }

    function Field(props) {
      return h('label', { className: 'dshmcp-field', style: styles.field },
        h('span', { style: styles.label }, props.label,
          props.required ? h('span', { style: { color: T.error } }, ' *') : null,
          props.optional ? h('span', { style: styles.hint }, ' (' + props.optional + ')') : null),
        props.children,
        props.hint ? h('span', { style: styles.hint }, props.hint) : null,
        props.error ? h('span', { className: 'dshmcp-field-error', style: styles.fieldError }, props.error) : null);
    }

    function TextInput(props) {
      return h('input', {
        className: 'dshmcp-input',
        type: props.type || 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        maxLength: typeof props.maxLength === 'number' ? props.maxLength : undefined,
        spellCheck: false,
        autoComplete: props.autoComplete || 'off',
        style: props.mono ? Object.assign({}, styles.input, { fontFamily: T.mono, fontSize: '12px' }) : styles.input,
        onChange: (event) => {
          if (typeof props.onChange === 'function') props.onChange(event && event.target ? event.target.value : '');
        },
      });
    }

    function TextArea(props) {
      return h('textarea', {
        className: 'dshmcp-input',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        rows: props.rows || 3,
        spellCheck: false,
        style: styles.textarea,
        onChange: (event) => {
          if (typeof props.onChange === 'function') props.onChange(event && event.target ? event.target.value : '');
        },
      });
    }

    function KeyValueList(props) {
      const pairs = maskPairs(props.value);
      if (!pairs.length) return h('span', { style: styles.kvValue }, '—');
      return h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' } },
        pairs.map((pair) => h('span', { key: pair.key, style: styles.mono }, pair.key + '=' + pair.value)));
    }

    function DetailRow(props) {
      return h(Fragment, null,
        h('span', { style: styles.kvKey }, props.label),
        h('span', { style: styles.kvValue }, props.children));
    }

    function IconGear() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z',
          stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('path', {
          d: 'M13 8c0-.3 0-.6-.1-.9l1.2-.9-1.2-2.1-1.4.5c-.5-.4-1-.7-1.6-.9L9.7 2H7.3l-.2 1.7c-.6.2-1.1.5-1.6.9l-1.4-.5-1.2 2.1 1.2.9a5.4 5.4 0 0 0 0 1.8l-1.2.9 1.2 2.1 1.4-.5c.5.4 1 .7 1.6.9l.2 1.7h2.4l.2-1.7c.6-.2 1.1-.5 1.6-.9l1.4.5 1.2-2.1-1.2-.9c.1-.3.1-.6.1-.9Z',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
        }));
    }

    function IconTrash() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M3.5 4.5h9M6.5 4.5V3.2h3v1.3M5 4.5l.6 8.1h4.8L11 4.5M6.8 6.6v4M9.2 6.6v4',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    function IconPlus() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M8 3.2v9.6M3.2 8h9.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }));
    }

    function IconRefresh() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    // ---------------------------------------------------------------------
    // Error boundary — a render crash degrades to a message, never a blank tab
    // ---------------------------------------------------------------------

    class DshmcpErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error || new Error('unknown render error') };
      }

      componentDidCatch(error) {
        try {
          if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
            console.error('[dsh-mcp-manager] settings tab render failed:', error);
          }
        } catch (ignored) {
          // Diagnostics must never escalate.
        }
      }

      render() {
        if (this.state && this.state.error) {
          const t = typeof this.props.t === 'function' ? this.props.t : (key) => key;
          return h('div', { className: 'dshmcp-root', style: styles.root },
            h('p', { style: { margin: '0', color: T.error } }, t('errorInternal')),
            h('p', { style: styles.muted }, textOf(this.state.error)));
        }
        return this.props.children;
      }
    }

    // ---------------------------------------------------------------------
    // Presentational pieces
    // ---------------------------------------------------------------------

    function ServerView(props) {
      const t = props.t;
      const server = props.server;
      const writable = props.writable === true;
      const rows = [];
      if (server.transport === 'stdio') {
        rows.push(h(DetailRow, { key: 'command', label: t('fieldCommand') }, h('span', { style: styles.mono }, server.config.command || '—')));
        rows.push(h(DetailRow, { key: 'args', label: t('fieldArgs') }, h('span', { style: styles.mono }, server.config.args.length ? server.config.args.join(' ') : '—')));
        rows.push(h(DetailRow, { key: 'env', label: t('fieldEnv') }, h(KeyValueList, { value: server.config.env })));
        rows.push(h(DetailRow, { key: 'cwd', label: t('fieldCwd') }, h('span', { style: styles.mono }, server.config.cwd || '—')));
      } else {
        rows.push(h(DetailRow, { key: 'url', label: t('fieldUrl') }, h('span', { style: styles.mono }, server.config.url || '—')));
        rows.push(h(DetailRow, { key: 'headers', label: t('fieldHeaders') }, h(KeyValueList, { value: server.config.headers })));
      }
      return h('div', { className: 'dshmcp-detail', style: styles.detail },
        h('div', { style: styles.kv },
          h(DetailRow, { label: t('detailTransport') }, server.transport === 'stdio' ? t('transportStdio') : t('transportHttp')),
          h(DetailRow, { label: t('detailStatus') }, t(statusKey(server.status))),
          h(DetailRow, { label: t('fieldName') }, h('span', { style: styles.mono }, server.name || '—')),
          server.label && server.label !== server.name
            ? h(DetailRow, { label: t('fieldLabel') }, server.label)
            : null,
          h(DetailRow, { label: t('detailBundle') }, h('span', { style: styles.mono }, server.bundle || '—')),
          h(DetailRow, { label: t('detailTitle') }, server.managed ? t('detailManaged') : t('detailExternal')),
          server.statusDetail ? h(DetailRow, { label: t('detailStatusDetail') }, h('span', { style: { color: T.error, wordBreak: 'break-word' } }, server.statusDetail)) : null),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('span', { style: styles.hint }, t('detailConfig')),
          h('div', { style: styles.kv }, rows)),
        writable
          ? h('div', { style: { display: 'flex', gap: '8px' } },
            h(Button, { small: true, kind: 'outline', onClick: () => props.onEdit(server) }, t('edit')))
          : h('p', { style: styles.muted }, t('readOnly') + ' · ' + (server.readOnlyReason || t('detailExternal'))));
    }

    function ServerFields(props) {
      const t = props.t;
      const transport = props.transport;
      const value = props.value;
      const errors = props.errors || {};
      const packageArg = suggestPackageArg(value.name, value.displayName, value.args);
      const nameField = h(Field, {
        key: 'name',
        label: t('fieldName'),
        required: true,
        hint: t('fieldNameHint'),
        error: errors.name,
      }, h(TextInput, {
        value: value.name,
        mono: true,
        disabled: props.nameLocked === true,
        placeholder: 'my-server',
        onChange: (next) => props.onChange('name', next),
      }));
      const labelField = h(Field, {
        key: 'displayName',
        label: t('fieldLabel'),
        hint: t('fieldLabelHint'),
        error: errors.displayName,
      }, h(TextInput, {
        value: value.displayName,
        maxLength: DISPLAY_NAME_MAX,
        placeholder: t('fieldLabel'),
        onChange: (next) => props.onChange('displayName', next),
      }));
      if (transport === 'stdio') {
        return h(Fragment, null,
          h('div', { style: styles.row2 }, nameField, labelField),
          h(Field, { key: 'command', label: t('fieldCommand'), required: true, error: errors.command },
            h(TextInput, { value: value.command, mono: true, placeholder: 'npx', onChange: (next) => props.onChange('command', next) })),
          h(Field, { key: 'args', label: t('fieldArgs'), hint: t('fieldArgsHint') },
            h(TextArea, { value: value.args, rows: 3, placeholder: '-y\n@modelcontextprotocol/server-memory', onChange: (next) => props.onChange('args', next) }),
            // t17: a user who knows the package name should not have to guess
            // `npx -y <pkg>`; offer the exact arguments, or at least the shape.
            packageArg !== null
              ? h('div', { style: styles.toolbar },
                h('span', { style: styles.hint }, t('argSuggestionHint', { name: packageArg })),
                h(Button, {
                  small: true,
                  kind: 'outline',
                  extraClass: 'dshmcp-arg-suggest',
                  // One argument per line (see `fieldArgsHint`), so `-y` and the
                  // package are two lines — not one argument containing a space.
                  onClick: () => props.onChange('args', '-y\n' + packageArg),
                }, t('argSuggestion', { name: packageArg })))
              : (asString(value.args).trim() === ''
                ? h('span', { className: 'dshmcp-arg-guide', style: styles.hint }, t('argSuggestionGuide'))
                : null)),
          h(Field, { key: 'env', label: t('fieldEnv'), hint: t('fieldEnvHint') },
            h(TextArea, { value: value.env, rows: 3, placeholder: 'MEMORY_FILE_PATH=~/.dsh/mcp-memory.json', onChange: (next) => props.onChange('env', next) })),
          h(Field, { key: 'cwd', label: t('fieldCwd') },
            h(TextInput, { value: value.cwd, mono: true, placeholder: '/path/to/project', onChange: (next) => props.onChange('cwd', next) })));
      }
      return h(Fragment, null,
        h('div', { style: styles.row2 }, nameField, labelField),
        h(Field, { key: 'url', label: t('fieldUrl'), required: true, error: errors.url },
          h(TextInput, { value: value.url, mono: true, placeholder: 'https://example.com/mcp', onChange: (next) => props.onChange('url', next) })),
        h(Field, { key: 'headers', label: t('fieldHeaders'), hint: t('fieldHeadersHint') },
          h(TextArea, { value: value.headers, rows: 3, placeholder: 'Authorization=Bearer …', onChange: (next) => props.onChange('headers', next) })));
    }

    function ServerForm(props) {
      const t = props.t;
      const server = props.server;
      const [value, setValue] = React.useState(() => formValue(server));
      const [errors, setErrors] = React.useState({});
      const update = (key, next) => setValue((previous) => Object.assign({}, previous, { [key]: next }));
      const submit = () => {
        const found = validateInput(t, server.transport, value);
        setErrors(found);
        if (Object.keys(found).length) return;
        props.onSubmit(server, buildInput(server.transport, value));
      };
      return h('div', { className: 'dshmcp-detail', style: styles.detail },
        h(ServerFields, { t, transport: server.transport, value, errors, nameLocked: true, onChange: update }),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
          h(Button, { small: true, onClick: () => props.onCancel() }, t('cancel')),
          h(Button, { small: true, kind: 'primary', disabled: props.busy === true, onClick: submit },
            props.busy === true ? t('saving') : t('editSubmit'))));
    }

    function ServerCard(props) {
      const t = props.t;
      const server = props.server;
      const open = props.open === true;
      const busy = props.busy === true;
      const confirming = props.confirming === true;
      // A managed row the Plugin Manager marked read-only (e.g. `unaddressable`)
      // must not offer controls that the Host would refuse (t6/O3).
      const writable = props.writable === true;
      return h('div', { className: 'dshmcp-card', style: styles.card },
        h('div', { style: styles.cardHead },
          h('button', {
            type: 'button',
            className: 'dshmcp-title-btn',
            'aria-expanded': open ? 'true' : 'false',
            style: styles.cardTitleBtn,
            onClick: () => props.onToggleOpen(props.rowKey),
          },
            server.status === 'loading'
              ? h('span', { className: 'dshmcp-spinner', 'aria-hidden': true, style: styles.spinner })
              : h('span', { className: 'dshmcp-dot', 'aria-hidden': true, style: Object.assign({}, styles.dot, { background: statusColor(server.status) }) }),
            h('span', { style: styles.cardName, title: server.label }, server.label),
            h(Tag, { tone: 'outline' }, server.transport === 'stdio' ? t('transportStdio') : t('transportHttp')),
            h(Tag, { tone: statusTone(server.status) }, t(statusKey(server.status))),
            writable ? null : h(Tag, { tone: 'quiet' }, server.managed ? t('readOnly') : t('external'))),
          h('div', { style: styles.cardActions },
            confirming
              ? h(Fragment, null,
                h('span', { className: 'dshmcp-confirm', style: Object.assign({}, styles.hint, { alignSelf: 'center' }) }, t('removeConfirm')),
                h(Button, { small: true, kind: 'danger', disabled: busy, onClick: () => props.onRemove(server) }, t('removeConfirmYes')),
                h(Button, { small: true, onClick: () => props.onCancelRemove() }, t('cancel')))
              : h(Fragment, null,
                writable
                  ? h(IconButton, {
                    title: t('edit'),
                    ariaLabel: t('edit'),
                    disabled: busy,
                    onClick: () => props.onEdit(server),
                  }, h(IconGear))
                  : null,
                h(Switch, {
                  checked: server.enabled,
                  disabled: busy || !writable,
                  title: server.enabled ? t('disable') : t('enable'),
                  ariaLabel: server.enabled ? t('disable') : t('enable'),
                  onClick: () => props.onToggleEnabled(server),
                }),
                writable
                  ? h(IconButton, { danger: true, title: t('remove'), ariaLabel: t('remove'), disabled: busy, onClick: () => props.onRequestRemove(server) }, h(IconTrash))
                  : null))),
        open
          ? (props.editing
            ? h(ServerForm, { t, server, busy, onSubmit: props.onSubmit, onCancel: () => props.onCancelEdit(server) })
            : h(ServerView, { t, server, writable, onEdit: props.onEdit }))
          : null);
    }

    function CatalogCard(props) {
      const t = props.t;
      const entry = asRecord(props.entry);
      const busy = props.busy === true;
      const installed = props.installed === true;
      const token = entryNeedsToken(entry);
      const hasKeys = asArray(entry.envKeys).length > 0;
      const origin = originInfo(entry, props.source);
      const packageId = asString(entry.packageId);
      const downloads = formatCount(entry.downloadsMonthly, props.locale);
      const score = formatScore(entry.score);
      return h('div', { className: 'dshmcp-card dshmcp-catalog-card', style: styles.card },
        h('div', { style: styles.cardHead },
          h('span', { style: styles.cardName, title: props.title }, props.title),
          h(Tag, { tone: 'outline' }, entry.transport === 'stdio' ? t('transportStdio') : t('transportHttp'))),
        h('div', { className: 'dshmcp-catalog-badges', style: styles.badges },
          // Provenance: where this card came from, so a live result is never
          // confused with the offline seed (t15).
          h(Tag, { tone: origin.tone }, t(origin.key)),
          entry.official === true ? h(Tag, { tone: 'success' }, t('catalogOfficial')) : null,
          // Zero-configuration entries install in one click; entries that need
          // credentials open the env form instead.
          token ? h(Tag, { tone: 'warn' }, t('needsToken'))
            : hasKeys ? h(Tag, { tone: 'outline' }, t('tokenOptional'))
              : h(Tag, { tone: 'success' }, t('oneClick')),
          asString(entry.category) ? h(Tag, { tone: 'info' }, categoryLabel(t, entry.category)) : null),
        asString(props.description) ? h('p', { style: styles.muted }, props.description) : null,
        packageId || downloads || score
          ? h('div', { className: 'dshmcp-catalog-meta', style: styles.meta },
            packageId
              ? h('span', { className: 'dshmcp-catalog-package', style: styles.mono, title: packageId }, packageId)
              : null,
            downloads ? h('span', { style: styles.hint }, t('catalogDownloads', { count: downloads })) : null,
            score ? h('span', { style: styles.hint }, t('catalogScore') + ' ' + score) : null)
          : null,
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: 'auto' } },
          entry.docs
            ? h('a', {
              href: entry.docs,
              target: '_blank',
              rel: 'noreferrer noopener',
              style: { fontSize: '12px', color: T.labelTertiary, textDecoration: 'none' },
            }, t('docs'))
            : h('span', null),
          h(Button, {
            small: true,
            kind: installed ? 'outline' : 'primary',
            extraClass: 'dshmcp-install-btn',
            disabled: busy || installed,
            onClick: () => props.onInstall(entry),
          }, busy ? t('installing') : installed ? t('installed') : t('install'))));
    }

    function InstallModal(props) {
      const t = props.t;
      const entry = props.entry;
      const values = props.values;
      const errors = props.errors || {};
      const busy = props.busy === true;
      const title = pickText(entry.title, props.locale);
      const keys = asArray(entry.envKeys);
      return h('div', { className: 'dshmcp-overlay', style: styles.overlay, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('installTitle', { name: title }) },
        h('div', { className: 'dshmcp-modal dshmcp-scroll', style: styles.modal },
          h('div', { style: styles.modalHead },
            h('h3', { style: styles.modalTitle }, t('installTitle', { name: title })),
            h(IconButton, { title: t('close'), ariaLabel: t('close'), onClick: () => props.onCancel() }, '×')),
          h('p', { style: styles.muted }, t('installIntro')),
          h('p', { style: styles.mono }, entry.transport === 'stdio'
            ? [entry.command].concat(asArray(entry.args)).join(' ')
            : asString(entry.url)),
          keys.map((raw) => {
            const key = asString(asRecord(raw).key);
            return h(Field, {
              key,
              label: pickText(asRecord(raw).label, props.locale) || key,
              required: asRecord(raw).required === true,
              optional: asRecord(raw).required === true ? '' : t('optionalMark'),
              error: errors[key],
            }, h(TextInput, {
              value: values[key],
              mono: true,
              type: asRecord(raw).secret === true ? 'password' : 'text',
              placeholder: asString(asRecord(raw).placeholder),
              autoComplete: 'off',
              onChange: (next) => props.onValueChange(key, next),
            }));
          }),
          h('div', { style: styles.modalFoot },
            h(Button, { small: true, disabled: busy, onClick: () => props.onCancel() }, t('cancel')),
            h(Button, { small: true, kind: 'primary', disabled: busy, onClick: () => props.onSubmit() },
              busy ? t('installing') : t('installSubmit')))));
    }

    function AddServerModal(props) {
      const t = props.t;
      const transport = props.transport;
      const [value, setValue] = React.useState(() => emptyForm(transport));
      const [errors, setErrors] = React.useState({});
      const update = (key, next) => setValue((previous) => Object.assign({}, previous, { [key]: next }));
      const submit = () => {
        const found = validateInput(t, transport, value);
        setErrors(found);
        if (Object.keys(found).length) return;
        props.onSubmit(buildInput(transport, value));
      };
      return h('div', { className: 'dshmcp-overlay', style: styles.overlay, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('addTitle') },
        h('div', { className: 'dshmcp-modal dshmcp-scroll', style: styles.modal },
          h('div', { style: styles.modalHead },
            h('h3', { style: styles.modalTitle }, t('addTitle')),
            h('span', null,
              h(Tag, { tone: 'info' }, transport === 'stdio' ? t('transportStdio') : t('transportHttp')),
              ' ',
              h(IconButton, { title: t('close'), ariaLabel: t('close'), onClick: () => props.onCancel() }, '×'))),
          h(ServerFields, { t, transport, value, errors, onChange: update }),
          h('div', { style: styles.modalFoot },
            h(Button, { small: true, disabled: props.busy === true, onClick: () => props.onCancel() }, t('cancel')),
            h(Button, { small: true, kind: 'primary', disabled: props.busy === true, onClick: submit },
              props.busy === true ? t('saving') : t('addSubmit')))));
    }

    function SkeletonList() {
      return h('div', { className: 'dshmcp-card-list', style: styles.cardList },
        [0, 1, 2].map((index) => h('div', {
          key: 'dshmcp-skeleton-' + index,
          className: 'dshmcp-card dshmcp-skeleton',
          'aria-hidden': true,
          style: Object.assign({}, styles.card, styles.skeletonCard),
        },
          h('div', { style: Object.assign({}, styles.skeletonBar, { width: '42%' }) }),
          h('div', { style: Object.assign({}, styles.skeletonBar, { width: '68%', opacity: 0.6 }) }))));
    }

    function Notice(props) {
      // `warn` carries the "saved but not applied" notice (t6/O4).
      const tone = props.tone === 'error' ? T.error
        : props.tone === 'success' ? T.success
          : props.tone === 'warn' ? T.warn
            : T.labelSecondary;
      return h('div', { className: 'dshmcp-notice', role: 'status', style: Object.assign({}, styles.notice, { borderColor: tone }) },
        h('span', { 'aria-hidden': true, style: Object.assign({}, styles.dot, { background: tone, marginTop: '6px' }) }),
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0', flex: '1 1 auto' } },
          h('span', { style: { color: T.labelPrimary } }, props.text),
          props.detail ? h('span', { style: Object.assign({}, styles.mono, { color: T.labelTertiary }) }, props.detail) : null),
        h(IconButton, { title: props.closeLabel, ariaLabel: props.closeLabel, onClick: props.onClose }, '×'));
    }

    function CatalogSection(props) {
      const t = props.t;
      const entries = asArray(props.entries);
      const loading = props.loading === 'first';
      const busy = props.loading !== 'idle';
      const total = typeof props.total === 'number' && isFinite(props.total) ? props.total : null;
      const filtered = props.category !== 'all';
      return h('div', { className: 'dshmcp-section', style: styles.section },
        h('div', { style: styles.sectionHead },
          h('div', null,
            h('h3', { className: 'dshmcp-section-title', style: styles.sectionTitle }, t('catalogTitle')),
            h('p', { style: styles.sectionIntro }, t('catalogIntro'))),
          h('div', { style: styles.toolbar },
            h('div', { className: 'dshmcp-segment', role: 'tablist', 'aria-label': t('sourceLabel'), style: styles.segment },
              CATALOG_SOURCES.map((value) => h('button', {
                key: value,
                type: 'button',
                role: 'tab',
                className: 'dshmcp-segment-item',
                'aria-selected': props.source === value ? 'true' : 'false',
                style: segmentStyle(props.source === value),
                onClick: () => props.onSourceChange(value),
              }, value === 'npm' ? t('sourceNpm') : t('sourceRegistry')))),
            h('input', {
              className: 'dshmcp-input',
              type: 'search',
              value: props.query,
              placeholder: t(props.loading === 'first' && props.query ? 'catalogSearching' : 'catalogSearch'),
              'aria-label': t('catalogSearch'),
              spellCheck: false,
              style: Object.assign({}, styles.input, { width: '200px' }),
              onChange: (event) => props.onQueryChange(event && event.target ? event.target.value : ''),
            }),
            h(Button, {
              small: true,
              kind: 'outline',
              extraClass: 'dshmcp-catalog-refresh',
              disabled: busy,
              onClick: () => props.onRefresh(),
            }, h(IconRefresh), props.loading === 'refresh' ? t('refreshing') : t('catalogRefresh')))),
        total !== null || filtered
          ? h('p', { className: 'dshmcp-catalog-count', style: styles.hint },
            total !== null ? t('catalogTotal', { total }) : '',
            filtered ? (total !== null ? ' · ' : '') + t('catalogFiltered', { shown: entries.length }) : '')
          : null,
        props.degraded === true
          ? h('p', { className: 'dshmcp-catalog-degraded', style: styles.degraded, role: 'status' }, t('catalogOffline'))
          : null,
        props.directEntry !== null && props.directEntry !== undefined
          ? h('div', { className: 'dshmcp-card dshmcp-direct-install', style: styles.card },
            h('div', { style: styles.cardHead },
              h('span', { style: styles.cardName, title: props.directEntry.id }, t('directInstallTitle', { name: props.directEntry.id })),
              h(Tag, { tone: 'outline' }, t('originNpm'))),
            h('p', { className: 'dshmcp-direct-hint', style: styles.muted }, t('directInstallHint')),
            h('div', { style: styles.toolbar },
              h('span', { style: styles.mono }, 'npx -y ' + props.directEntry.id),
              h(Button, {
                small: true,
                kind: 'primary',
                extraClass: 'dshmcp-direct-install-btn',
                disabled: props.busyId === 'catalog:' + props.directEntry.id,
                onClick: () => props.onInstall(props.directEntry),
              }, t('directInstall'))))
          : null,
        h('div', { className: 'dshmcp-chips', style: styles.chips },
          [h('button', {
            key: 'all',
            type: 'button',
            className: 'dshmcp-chip',
            'aria-pressed': props.category === 'all' ? 'true' : 'false',
            style: chipStyle(props.category === 'all'),
            onClick: () => props.onCategoryChange('all'),
          }, t('allCategories'))].concat(props.categories.map((category) => h('button', {
            key: category,
            type: 'button',
            className: 'dshmcp-chip',
            'aria-pressed': props.category === category ? 'true' : 'false',
            style: chipStyle(props.category === category),
            onClick: () => props.onCategoryChange(category),
          }, categoryLabel(t, category))))),
        loading
          ? h('div', { className: 'dshmcp-grid', style: styles.grid },
            [0, 1, 2, 3].map((index) => h('div', {
              key: 'dshmcp-catalog-skeleton-' + index,
              className: 'dshmcp-card dshmcp-catalog-card dshmcp-skeleton',
              'aria-hidden': true,
              style: Object.assign({}, styles.card, styles.skeletonCard),
            },
              h('div', { style: Object.assign({}, styles.skeletonBar, { width: '38%' }) }),
              h('div', { style: Object.assign({}, styles.skeletonBar, { width: '72%', opacity: 0.6 }) }))))
          : entries.length === 0
            ? h('p', { className: 'dshmcp-catalog-empty', style: styles.muted }, t('catalogEmpty'))
            : h('div', { className: 'dshmcp-grid', style: styles.grid },
              entries.map((entry, index) => h(CatalogCard, {
                // The registry can repeat a package id across versions, so the
                // row index keeps React keys unique while staying stable on append.
                key: (asString(asRecord(entry).id) || 'catalog-entry') + ':' + index,
                t,
                locale: props.locale,
                source: props.source,
                entry,
                busy: props.busyId === 'catalog:' + asString(asRecord(entry).id),
                installed: props.isInstalled(entry),
                title: pickText(asRecord(entry).title, props.locale),
                description: pickText(asRecord(entry).description, props.locale),
                onInstall: props.onInstall,
              }))),
        loading || entries.length === 0
          ? null
          : h('div', { className: 'dshmcp-catalog-foot', style: styles.toolbar },
            props.hasMore === true && asString(props.cursor)
              ? h(Button, {
                small: true,
                kind: 'outline',
                extraClass: 'dshmcp-load-more',
                disabled: busy,
                onClick: () => props.onLoadMore(),
              }, props.loading === 'more' ? t('catalogLoadingMore') : t('catalogLoadMore'))
              : h('span', { className: 'dshmcp-catalog-end', style: styles.hint }, t('catalogEnd'))));
    }

    /** Registry/npm segmented control (t15). */
    function segmentStyle(active) {
      const style = {
        display: 'inline-flex', alignItems: 'center', height: '26px', padding: '0 12px', border: 'none',
        borderRadius: T.radiusSm, cursor: 'pointer', font: 'inherit', fontSize: '12px',
        color: T.labelSecondary, background: 'transparent',
      };
      if (active) {
        style.color = T.labelPrimary;
        style.background = T.bgLayer1;
        style.boxShadow = '0 0 0 0.5px ' + T.borderL2;
      }
      return style;
    }

    function chipStyle(active) {
      const style = {
        display: 'inline-flex', alignItems: 'center', height: '24px', padding: '0 10px', border: 'none',
        borderRadius: '999px', cursor: 'pointer', font: 'inherit', fontSize: '12px',
        color: T.labelSecondary, background: T.bgLayer3,
      };
      if (active) {
        style.color = T.labelPrimary;
        style.background = T.buttonGhostActiveFill;
      }
      return style;
    }

    // ---------------------------------------------------------------------
    // The tab
    // ---------------------------------------------------------------------

    function McpManagerTab(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const client = props.client;
      const fallbackResult = () => Promise.resolve({ ok: false, error: { code: 'network', message: '' } });
      const request = (name, ...args) => {
        try {
          if (client && typeof client[name] === 'function') return Promise.resolve(client[name](...args));
        } catch (error) {
          return Promise.reject(error);
        }
        return fallbackResult();
      };

      const [servers, setServers] = React.useState(null);
      const [managedRoot, setManagedRoot] = React.useState('');
      const [loadError, setLoadError] = React.useState(null);
      const [catalogSource, setCatalogSource] = React.useState(DEFAULT_CATALOG_SOURCE);
      const [catalogEntries, setCatalogEntries] = React.useState(null);
      const [catalogCursor, setCatalogCursor] = React.useState(null);
      const [catalogHasMore, setCatalogHasMore] = React.useState(false);
      const [catalogTotal, setCatalogTotal] = React.useState(null);
      const [catalogDegraded, setCatalogDegraded] = React.useState(false);
      const [catalogLoading, setCatalogLoading] = React.useState('first');
      const [catalogDebounced, setCatalogDebounced] = React.useState('');
      const [catalogRefreshToken, setCatalogRefreshToken] = React.useState(0);
      // Request bookkeeping: `catalogSessionRef` drops superseded responses and
      // `catalogCursorRef` makes the same cursor unrequestable twice (t15).
      const catalogSessionRef = React.useRef(0);
      const catalogCursorRef = React.useRef(null);
      const catalogKeyRef = React.useRef(null);
      const [reload, setReload] = React.useState(0);
      const [query, setQuery] = React.useState('');
      const [catalogQuery, setCatalogQuery] = React.useState('');
      const [category, setCategory] = React.useState('all');
      const [openId, setOpenId] = React.useState(null);
      const [editingId, setEditingId] = React.useState(null);
      const [adding, setAdding] = React.useState(null);
      const [install, setInstall] = React.useState(null);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [busyId, setBusyId] = React.useState(null);
      const [confirmId, setConfirmId] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const menuRef = React.useRef(null);

      React.useEffect(() => {
        let cancelled = false;
        setLoadError(null);
        request('list').then((result) => {
          if (cancelled) return;
          const value = asRecord(result && result.value);
          if (result && result.ok) {
            setServers(asArray(value.servers));
            setManagedRoot(asString(value.managedRoot));
          } else {
            setServers([]);
            setLoadError(asRecord(result && result.error));
          }
        }, (error) => {
          if (cancelled) return;
          setServers([]);
          setLoadError({ code: 'network', message: textOf(error) });
        });
        return () => {
          cancelled = true;
        };
      }, [reload]);

      // The catalog is a live registry browser (contract §6, t15). Search is
      // debounced so a fast typist issues one request, not one per keystroke.
      React.useEffect(() => {
        if (typeof setTimeout !== 'function') {
          setCatalogDebounced(catalogQuery);
          return undefined;
        }
        const timer = setTimeout(() => setCatalogDebounced(catalogQuery), CATALOG_DEBOUNCE_MS);
        return () => {
          if (typeof clearTimeout === 'function') clearTimeout(timer);
        };
      }, [catalogQuery]);

      React.useEffect(() => {
        if (!menuOpen || typeof document === 'undefined') return undefined;
        const onPointerDown = (event) => {
          const root = menuRef.current;
          if (root && typeof root.contains === 'function' && event && root.contains(event.target)) return;
          setMenuOpen(false);
        };
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape') setMenuOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [menuOpen]);

      React.useEffect(() => {
        if (!notice || typeof setTimeout !== 'function') return undefined;
        const timer = setTimeout(() => setNotice(null), 6000);
        return () => {
          if (typeof clearTimeout === 'function') clearTimeout(timer);
        };
      }, [notice]);

      /**
       * The offline seed, served only when the live sources fail: it never
       * shadows a successful response, and the degraded banner says so (t15).
       */
      const serveCatalogSeed = () => {
        setCatalogEntries(CATALOG_SEED.map((entry) => Object.assign({}, entry, { origin: 'seed' })));
        setCatalogCursor(null);
        setCatalogHasMore(false);
        setCatalogTotal(null);
        setCatalogDegraded(true);
        setCatalogLoading('idle');
      };

      /**
       * Load one catalog page. `first` replaces the list behind a skeleton,
       * `refresh` replaces it in place, `more` appends the next page. A
       * superseded response is dropped, so switching source or query mid-flight
       * can never paint a stale page.
       */
      const runCatalogPage = (mode, params) => {
        const sessionId = catalogSessionRef.current + 1;
        catalogSessionRef.current = sessionId;
        const cursor = mode === 'more' ? asString(params.cursor) : '';
        catalogCursorRef.current = cursor || null;
        setCatalogLoading(mode);
        if (mode === 'first') {
          setCatalogEntries(null);
          setCategory('all');
        }
        request('catalog', {
          source: params.source,
          query: params.query,
          cursor: cursor || null,
          limit: CATALOG_PAGE_SIZE,
        }).then((result) => {
          if (catalogSessionRef.current !== sessionId) return;
          if (result && result.ok) {
            const value = asRecord(result.value);
            const page = asArray(value.entries);
            const nextCursor = asString(value.nextCursor);
            // t19/F1: a page boundary can split one server's versions, so append
            // through the id-keyed merge instead of a plain concat.
            setCatalogEntries((current) => (mode === 'more' && Array.isArray(current) ? mergeCatalogEntries(current, page) : page));
            setCatalogCursor(nextCursor || null);
            setCatalogHasMore(value.hasMore === true || nextCursor !== '');
            setCatalogTotal(typeof value.total === 'number' && isFinite(value.total) ? value.total : null);
            setCatalogDegraded(value.degraded === true);
            setCatalogLoading('idle');
            return;
          }
          if (mode === 'more') {
            setCatalogLoading('idle');
            failWith(result && result.error);
            return;
          }
          serveCatalogSeed();
        }, (error) => {
          if (catalogSessionRef.current !== sessionId) return;
          if (mode === 'more') {
            setCatalogLoading('idle');
            failWith({ code: 'network', message: textOf(error) });
            return;
          }
          serveCatalogSeed();
        });
      };

      // First page for the current (source, query). An unchanged key is an
      // explicit refresh (list kept, spinner in the button); a changed key is a
      // new browse (list reset). Switching source keeps the search term.
      React.useEffect(() => {
        const key = catalogSource + '\u0000' + catalogDebounced;
        const mode = catalogKeyRef.current === key ? 'refresh' : 'first';
        catalogKeyRef.current = key;
        runCatalogPage(mode, { source: catalogSource, query: catalogDebounced, cursor: null });
      }, [catalogSource, catalogDebounced, catalogRefreshToken]);

      const showNotice = (tone, text, detail) => setNotice({ tone, text: asString(text), detail: asString(detail) });
      const failWith = (error) => {
        const parts = errorParts(t, error);
        showNotice('error', parts.text, parts.detail);
      };
      /**
       * A success value may carry a `notice` (t6/O4): `overridden` means the
       * change was saved but a higher-priority layer still wins, so the result
       * must not be presented as a plain success. Returns true when it was shown.
       */
      const showValueNotice = (value) => {
        const raw = asRecord(asRecord(value).notice);
        const code = asString(raw.code);
        if (!code) return false;
        const key = NOTICE_KEYS[code];
        const text = key ? t(key) : asString(raw.message) || t('errorUnknown');
        const message = asString(raw.message);
        showNotice('warn', text, message && message !== text ? message : '');
        return true;
      };
      const applyServers = (value) => {
        const record = asRecord(value);
        if (Array.isArray(record.servers)) {
          // Force React to detect the change by creating a new array reference
          setServers([...record.servers]);
        }
      };

      const handleRefresh = () => {
        setReload((previous) => previous + 1);
        setCatalogRefreshToken((previous) => previous + 1);
      };

      /** Append the next page; the same cursor is never fetched twice (t15). */
      const handleCatalogLoadMore = () => {
        if (catalogLoading !== 'idle' || catalogHasMore !== true || !catalogCursor) return;
        if (catalogCursorRef.current === catalogCursor) return;
        runCatalogPage('more', { source: catalogSource, query: catalogDebounced, cursor: catalogCursor });
      };

      /** Re-fetch the current (source, query) first page and replace the list. */
      const handleCatalogRefresh = () => {
        if (catalogLoading !== 'idle') return;
        setCatalogRefreshToken((previous) => previous + 1);
      };

      /** Switch registry/npm: reset cursor and list, keep the search term. */
      const handleCatalogSourceChange = (next) => {
        const source = next === 'npm' ? 'npm' : DEFAULT_CATALOG_SOURCE;
        if (source === catalogSource) return;
        setCatalogSource(source);
      };

      const handleToggleEnabled = (server) => {
        setBusyId(serverKey(server));
        request('toggle', server.id, !server.enabled).then((result) => {
          setBusyId(null);
          if (result && result.ok) {
            applyServers(result.value);
            if (!showValueNotice(result.value)) showNotice('success', t(server.enabled ? 'noticeDisabled' : 'noticeEnabled'));
          } else {
            failWith(result && result.error);
          }
        }, (error) => {
          setBusyId(null);
          failWith({ code: 'network', message: textOf(error) });
        });
      };

      const handleRemove = (server) => {
        const key = serverKey(server);
        setBusyId(key);
        setConfirmId(null);
        request('remove', server.id).then((result) => {
          setBusyId(null);
          if (result && result.ok) {
            applyServers(result.value);
            setOpenId((current) => (current === key ? null : current));
            setEditingId((current) => (current === server.id ? null : current));
            if (!showValueNotice(result.value)) showNotice('success', t('noticeRemoved'));
          } else {
            failWith(result && result.error);
          }
        }, (error) => {
          setBusyId(null);
          failWith({ code: 'network', message: textOf(error) });
        });
      };

      const handleSave = (server, input) => {
        setBusyId(serverKey(server));
        request('update', server.id, input).then((result) => {
          setBusyId(null);
          if (result && result.ok) {
            applyServers(result.value);
            setEditingId(null);
            if (!showValueNotice(result.value)) showNotice('success', t('noticeSaved'));
          } else {
            failWith(result && result.error);
          }
        }, (error) => {
          setBusyId(null);
          failWith({ code: 'network', message: textOf(error) });
        });
      };

      const handleAdd = (input) => {
        setBusyId('add');
        request('add', input).then((result) => {
          setBusyId(null);
          if (result && result.ok) {
            applyServers(result.value);
            setAdding(null);
            if (!showValueNotice(result.value)) showNotice('success', t('noticeCreated'));
          } else {
            failWith(result && result.error);
          }
        }, (error) => {
          setBusyId(null);
          failWith({ code: 'network', message: textOf(error) });
        });
      };

      const runInstall = (entry, values) => {
        const input = buildInstallInput(entry, values, servers, client && typeof client.locale === 'function' ? client.locale() : 'zh');
        setBusyId('catalog:' + asString(entry.id));
        request('add', input).then((result) => {
          setBusyId(null);
          if (result && result.ok) {
            applyServers(result.value);
            setInstall(null);
            if (!showValueNotice(result.value)) showNotice('success', t('noticeInstalled', { name: input.name }));
          } else {
            setInstall((current) => (current ? Object.assign({}, current, { busy: false }) : current));
            failWith(result && result.error);
          }
        }, (error) => {
          setBusyId(null);
          setInstall((current) => (current ? Object.assign({}, current, { busy: false }) : current));
          failWith({ code: 'network', message: textOf(error) });
        });
      };

      const openInstall = (entry) => {
        const keys = asArray(asRecord(entry).envKeys);
        if (keys.length === 0) {
          runInstall(entry, {});
          return;
        }
        const values = {};
        for (const raw of keys) values[asString(asRecord(raw).key)] = '';
        setInstall({ entry, values, errors: {}, busy: false });
      };

      const submitInstall = () => {
        if (!install) return;
        const errors = {};
        for (const raw of asArray(asRecord(install.entry).envKeys)) {
          const key = asString(asRecord(raw).key);
          if (asRecord(raw).required === true && !asString(install.values[key]).trim()) {
            errors[key] = t('errorEnvRequired', { key });
          }
        }
        if (Object.keys(errors).length) {
          setInstall(Object.assign({}, install, { errors }));
          return;
        }
        setInstall(Object.assign({}, install, { errors: {}, busy: true }));
        runInstall(install.entry, install.values);
      };

      const locale = client && typeof client.locale === 'function' ? client.locale() : 'zh';
      const list = filterServers(servers, query);
      // The endpoint owns search/paging; the category chips filter the loaded
      // page locally, so they never fight the server-side query.
      const catalogList = catalogEntries === null ? null : filterCatalog(catalogEntries, category, '', locale);
      const loading = servers === null;

      const addMenu = h('div', { className: 'dshmcp-menu-root', style: styles.menuRoot, ref: menuRef },
        h(Button, {
        kind: 'primary',
        'aria-haspopup': 'menu',
        'aria-expanded': menuOpen ? 'true' : 'false',
        onClick: () => setMenuOpen((open) => !open),
        }, h(IconPlus), t('add')),
        menuOpen
        ? h('div', { className: 'dshmcp-menu', role: 'menu', style: styles.menu },
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dshmcp-menu-item',
            style: styles.menuItem,
            onClick: () => {
              setMenuOpen(false);
              setEditingId(null);
              setAdding({ transport: 'stdio' });
            },
          },
            h('span', null, t('addStdio')),
            h('span', { style: styles.menuItemHint }, t('addStdioHint'))),
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dshmcp-menu-item',
            style: styles.menuItem,
            onClick: () => {
              setMenuOpen(false);
              setEditingId(null);
              setAdding({ transport: 'streamable-http' });
            },
          },
            h('span', null, t('addHttp')),
            h('span', { style: styles.menuItemHint }, t('addHttpHint'))))
          : null);

      return h('div', { className: 'dshmcp-root', style: styles.root },
        h('style', { key: 'dshmcp-style' }, CSS),
        h('div', { className: 'dshmcp-header', style: styles.header },
          h('div', null,
            h('h2', { className: 'dshmcp-title', style: styles.title }, t('title')),
            h('p', { style: styles.intro }, t('intro'))),
          h('div', { style: styles.toolbar },
            managedRoot ? h('span', { style: styles.hint, title: managedRoot }, t('managedRoot') + ': ' + managedRoot) : null,
            h(Button, { small: true, kind: 'outline', onClick: handleRefresh }, h(IconRefresh), t('refresh')),
            addMenu)),
        notice ? h(Notice, {
          key: 'notice',
          tone: notice.tone,
          text: notice.text,
          detail: notice.detail,
          closeLabel: t('close'),
          onClose: () => setNotice(null),
        }) : null,
        h(CatalogSection, {
          t,
          locale,
          source: catalogSource,
          entries: catalogList,
          loading: catalogLoading,
          total: catalogTotal,
          hasMore: catalogHasMore,
          cursor: catalogCursor,
          degraded: catalogDegraded,
          categories: catalogCategories(catalogEntries || [], category),
          category,
          query: catalogQuery,
          busyId,
          // t17: typing an exact package name (or a scoped one anywhere) offers a
          // one-click direct install, because npm search cannot surface every
          // real MCP server (empty keywords, no "MCP" in the description).
          directEntry: (catalogSource === 'npm' && readPackageQuery(catalogQuery) !== null)
            || isScopedPackageSpec(catalogQuery)
            ? directInstallEntry(readPackageQuery(catalogQuery), t)
            : null,
          isInstalled: (entry) => isCatalogEntryInstalled(entry, servers),
          onCategoryChange: setCategory,
          onQueryChange: setCatalogQuery,
          onSourceChange: handleCatalogSourceChange,
          onRefresh: handleCatalogRefresh,
          onLoadMore: handleCatalogLoadMore,
          onInstall: openInstall,
        }),
        h('div', { className: 'dshmcp-section', style: styles.section },
          h('div', { style: styles.sectionHead },
            h('h3', { className: 'dshmcp-section-title', style: styles.sectionTitle }, t('serversTitle')),
            h('div', { style: styles.toolbar },
              h('input', {
                className: 'dshmcp-input',
                type: 'search',
                value: query,
                placeholder: t('searchPlaceholder'),
                'aria-label': t('searchServers'),
                spellCheck: false,
                style: Object.assign({}, styles.input, { width: '200px' }),
                onChange: (event) => setQuery(event && event.target ? event.target.value : ''),
              })),
          loading
            ? h(SkeletonList, { key: 'skeleton' })
            : loadError
              ? h('div', { className: 'dshmcp-notice', style: styles.notice },
                h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  h('span', { style: { color: T.labelPrimary } }, t('loadFailed')),
                  h('span', { style: Object.assign({}, styles.mono, { color: T.labelTertiary }) }, errorText(t, loadError))),
                h(Button, { small: true, kind: 'outline', onClick: handleRefresh }, t('retry')))
              : list.length === 0
                ? h('div', { className: 'dshmcp-empty', style: styles.empty },
                  h('p', { style: { margin: '0', fontSize: '14px', fontWeight: 600 } }, t('empty')),
                  h('p', { style: styles.muted }, t('emptyHint')))
                : h('div', { className: 'dshmcp-card-list', style: styles.cardList },
                  list.map((server, index) => {
                    // External rows share `id: ''`, so expansion state is keyed by
                    // a stable per-row identity instead (t6/O1).
                    const rowKey = serverKey(server, index);
                    const writable = isWritable(server);
                    return h(ServerCard, {
                      key: rowKey,
                      rowKey,
                      t,
                      server,
                      writable,
                      open: openId === rowKey,
                      editing: editingId === serverKey(server),
                      busy: busyId === serverKey(server),
                      confirming: confirmId === serverKey(server),
                      onToggleOpen: (key) => {
                        setOpenId((current) => (current === key ? null : key));
                        setEditingId(null);
                        setConfirmId(null);
                      },
                      onEdit: (target) => {
                        setOpenId(serverKey(target));
                        setConfirmId(null);
                        setEditingId(isWritable(target) ? serverKey(target) : null);
                      },
                      onCancelEdit: () => setEditingId(null),
                      onSubmit: handleSave,
                      onToggleEnabled: handleToggleEnabled,
                      onRequestRemove: (target) => setConfirmId(serverKey(target)),
                      onCancelRemove: () => setConfirmId(null),
                      onRemove: handleRemove,
                    });
                  })))),
        adding
          ? h(AddServerModal, {
            key: 'add-server',
            t,
            transport: adding.transport,
            busy: busyId === 'add',
            onSubmit: handleAdd,
            onCancel: () => setAdding(null),
          })
          : null,
        install
          ? h(InstallModal, {
            key: 'install-' + asString(asRecord(install.entry).id),
            t,
            locale,
            entry: install.entry,
            values: install.values,
            errors: install.errors,
            busy: install.busy === true || busyId === 'catalog:' + asString(asRecord(install.entry).id),
            onValueChange: (key, next) => setInstall((current) => {
              if (!current) return current;
              const values = Object.assign({}, current.values, { [key]: next });
              const errors = Object.assign({}, current.errors);
              delete errors[key];
              return Object.assign({}, current, { values, errors });
            }),
            onSubmit: submitInstall,
            onCancel: () => setInstall(null),
          })
          : null);
    }

    // ---------------------------------------------------------------------
    // Plugin face
    // ---------------------------------------------------------------------

    /** Required services (the activation gate, contract §8). */
    const inject = ['slots', 'connection', 'locale'];

    /**
     * Mount the MCP management tab.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp-manager: dictionaries');
      const client = createClient(ctx);
      function DshmcpMcpManagerTab(props) {
        const copy = props && typeof props.t === 'function' ? props.t : t;
        return h(DshmcpErrorBoundary, { t: copy }, h(McpManagerTab, { t: copy, client }));
      }
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'mcp-manager',
        order: 20,
        label: () => t('tab'),
        locale: NS,
      }, DshmcpMcpManagerTab));
    }

    module.exports.name = '@local/dsh-mcp-manager';
    module.exports.inject = inject;
    module.exports.apply = apply;
    /**
     * Read-only surface for the client-half tests: the embedded offline seed
     * and the dictionaries are otherwise unreachable from outside the factory.
     * The authoritative catalog is `client/catalog.json`, served by the Host's
     * `catalog` endpoint — never this seed.
     */
    module.exports.internals = Object.freeze({
      NS,
      RPC_CHANNEL,
      catalogSeed: CATALOG_SEED,
      // t19: the cross-page merge rule, so a harness can exercise it directly.
      mergeCatalogEntries,
      dictionaries: { zh, en },
      errorKeys: ERROR_KEYS,
      ErrorBoundary: DshmcpErrorBoundary,
    });
    return module.exports;
  },
});
