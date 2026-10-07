#!/usr/bin/env node
// Reproducibly vendors the MIT-licensed Copilot user-level statistics viewer as one
// self-contained, offline HTML file for a sandboxed (opaque-origin) iframe.
//
// The parent app stays dependency-free: this script uses only Node built-ins plus git/npm,
// and all third-party build tooling is installed with `npm ci` from the *upstream* lockfile
// inside a throwaway work directory outside this repository.
//
// Usage: node tools/vendor-copilot-usage-viewer.mjs --workdir <dir> [--skip-install]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const UPSTREAM = {
  repository: 'https://github.com/asizikov-demos/copilot-user-level-statistics-viewer',
  commit: 'c2b2324d8b5179280bb1a3b2634200885d68cfbc',
  license: 'MIT',
  copyright: 'Copyright (c) 2025 asizikov-demos',
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'src', 'vendor', 'copilot-usage-viewer');

export const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'worker-src blob:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function parseArgs(argv) {
  const args = { workdir: join(tmpdir(), 'copilot-usage-viewer-build'), skipInstall: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workdir') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--workdir requires a directory path argument');
      args.workdir = resolve(value);
    }
    else if (argv[i] === '--skip-install') args.skipInstall = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const OWNER_MARKER = '.vendor-copilot-usage-viewer-owner.json';
const ownerMarker = () => ({ tool: 'tools/vendor-copilot-usage-viewer.mjs', repository: UPSTREAM.repository, commit: UPSTREAM.commit });

const isInside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function realPathOf(path) {
  let probe = path;
  while (!existsSync(probe)) probe = dirname(probe);
  return resolve(realpathSync(probe), relative(probe, path));
}

// The build force-checks-out and `git clean`s <workdir>/src, so only operate on a directory outside this
// repository that is empty/new or carries this tool's ownership marker for the same upstream commit.
export function claimWorkdir(workdir) {
  const target = realPathOf(workdir);
  const repo = realpathSync(repoRoot);
  if (isInside(target, repo) || isInside(repo, target)) {
    throw new Error(`Refusing workdir ${target}: it must be outside (and not contain) this repository ${repo}`);
  }
  const markerPath = join(target, OWNER_MARKER);
  const expected = JSON.stringify(ownerMarker());
  if (existsSync(target) && readdirSync(target).length > 0) {
    if (!existsSync(markerPath)) {
      throw new Error(`Refusing non-empty workdir ${target} without ${OWNER_MARKER}; pass a new or empty directory`);
    }
    const actual = JSON.stringify(JSON.parse(readFileSync(markerPath, 'utf8')));
    if (actual !== expected) {
      throw new Error(`Refusing workdir ${target}: ${OWNER_MARKER} describes a different source (${actual}); use a fresh directory`);
    }
  } else {
    mkdirSync(target, { recursive: true });
    writeFileSync(markerPath, `${expected}\n`);
  }
  return target;
}

function checkout(src) {
  mkdirSync(src, { recursive: true });
  if (existsSync(join(src, '.git'))) {
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: src, encoding: 'utf8' }).trim();
    if (origin !== UPSTREAM.repository) throw new Error(`Refusing to reset ${src}: origin is ${origin}, expected ${UPSTREAM.repository}`);
  } else if (readdirSync(src).length > 0) {
    throw new Error(`Refusing to initialise non-empty ${src} that is not a git checkout`);
  } else {
    run('git', ['init', '-q'], src);
    run('git', ['remote', 'add', 'origin', UPSTREAM.repository], src);
  }
  run('git', ['fetch', '-q', '--depth', '1', 'origin', UPSTREAM.commit], src);
  run('git', ['checkout', '-q', '--force', '--detach', UPSTREAM.commit], src);
  // Drop previous integration patches and build output, but keep the installed node_modules.
  run('git', ['clean', '-q', '-fdx', '-e', 'node_modules'], src);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();
  if (head !== UPSTREAM.commit) throw new Error(`Checked out ${head}, expected ${UPSTREAM.commit}`);
}

const PRINT_DISABLED_TITLE = 'Printing unavailable in isolated dashboard; use executive summary download';

// New source files added to the upstream tree before bundling.
const ADDED_FILES = {
  'src/vendored/exportExecutiveSummary.ts': `
const EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'";
export const EXPORT_WARNING =
  'This download contains a summary of your organization\\'s GitHub Copilot usage metrics as shown in the Executive Summary. Share it only in line with your data-handling policy.';

function reportError(message: string): void {
  const report = (window as unknown as { __vendoredReportError?: (message: string) => void }).__vendoredReportError;
  if (typeof report !== 'function') throw new Error(message);
  report(message);
}

// Builds a script-free HTML document from the rendered Executive Summary DOM only (no source records).
export function buildExecutiveSummaryHtml(briefClassName: string): string {
  const article = document.querySelector<HTMLElement>('article[aria-label="Leadership Brief"]');
  if (!article) throw new Error('Executive summary is not rendered; nothing to export');

  const clone = article.cloneNode(true) as HTMLElement;
  const sourceCanvases = article.querySelectorAll('canvas');
  clone.querySelectorAll('canvas').forEach((canvas, index) => {
    const source = sourceCanvases[index];
    const img = document.createElement('img');
    img.src = source.toDataURL('image/png');
    img.alt = source.getAttribute('aria-label') ?? 'Chart';
    const rect = source.getBoundingClientRect();
    img.style.width = \`\${rect.width}px\`;
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    canvas.replaceWith(img);
  });
  clone.querySelectorAll('script, iframe, object, embed, link, meta, base, form').forEach((el) => el.remove());
  clone.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || (attr.name === 'href' && /^\\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
    }
  });

  const doc = document.implementation.createHTMLDocument(document.title || 'Executive Summary');
  doc.documentElement.lang = 'en';
  const head = doc.head;
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = EXPORT_CSP;
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  const style = doc.createElement('style');
  style.textContent = Array.from(document.querySelectorAll('head style')).map((s) => s.textContent ?? '').join('\\n')
    + '\\nbody{margin:0;padding:24px;background:#fff}.vendored-export-warning{max-width:900px;margin:0 auto 16px;padding:10px 14px;background:#fff8c5;color:#3b2300;border:1px solid #d4a72c;border-radius:6px;font:13px/1.4 system-ui,sans-serif}@media print{.vendored-export-warning{display:none}body{padding:0}}';
  head.prepend(charset, csp, viewport);
  head.append(style);

  const warning = doc.createElement('p');
  warning.className = 'vendored-export-warning';
  warning.setAttribute('role', 'note');
  warning.textContent = EXPORT_WARNING;
  const wrapper = doc.createElement('div');
  wrapper.className = briefClassName;
  wrapper.append(doc.importNode(clone, true));
  doc.body.append(warning, wrapper);
  return '<!DOCTYPE html>\\n' + doc.documentElement.outerHTML;
}

export function downloadExecutiveSummary(briefClassName: string): void {
  try {
    const html = buildExecutiveSummaryHtml(briefClassName);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = \`copilot-executive-summary-\${new Date().toISOString().slice(0, 10)}.html\`;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    reportError(\`Executive summary download failed: \${error instanceof Error ? error.message : String(error)}\`);
  }
}
`,
};

// Each patch replaces one exact upstream snippet; a missing anchor aborts the build.
const PATCHES = [
  {
    file: 'src/utils/basePath.ts',
    reason: 'Single-file build has no GitHub Pages base path.',
    find: "return process.env.NODE_ENV === 'production' ? '/copilot-user-level-statistics-viewer' : '';",
    replace: "return '';",
  },
  {
    file: 'src/workers/metricsWorkerClient.ts',
    reason: 'Opaque-origin iframe cannot load a same-origin worker script; start the pre-bundled worker from an inline Blob URL.',
    find: 'return new Worker(`${getBasePath()}/workers/metricsWorker.js`);',
    replace: [
      "if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {",
      "    throw new Error('Metrics worker requires Blob URL support, which this browser does not provide');",
      '  }',
      '  vendoredWorkerUrl ??= URL.createObjectURL(',
      "    new Blob([__VENDORED_METRICS_WORKER_SOURCE__], { type: 'text/javascript' })",
      '  );',
      '  return new Worker(vendoredWorkerUrl);',
    ].join('\n'),
  },
  {
    file: 'src/workers/metricsWorkerClient.ts',
    reason: 'Declare the build-time worker source constant.',
    find: "import { getBasePath } from '../utils/basePath';",
    replace: 'declare const __VENDORED_METRICS_WORKER_SOURCE__: string;\nlet vendoredWorkerUrl: string | undefined;',
  },
  {
    file: 'src/hooks/usePluginVersions.ts',
    reason: 'Use the pinned plugin-version JSON embedded at build time instead of fetch().',
    find: [
      "        const endpoint = type === 'jetbrains' ? '/data/jetbrains.json' : '/data/vscode.json';",
      "        const res = await fetch(`${getBasePath()}${endpoint}`, { cache: 'no-store' });",
      '',
      '        if (!res.ok) {',
      '          throw new Error(`HTTP ${res.status}`);',
      '        }',
      '',
      '        const data: unknown = await res.json();',
    ].join('\n'),
    replace: "        const data: unknown = type === 'jetbrains' ? __VENDORED_JETBRAINS_VERSIONS__ : __VENDORED_VSCODE_VERSIONS__;",
  },
  {
    file: 'src/hooks/usePluginVersions.ts',
    reason: 'Declare the embedded plugin-version constants.',
    find: "import { getBasePath } from '../utils/basePath';",
    replace: 'declare const __VENDORED_JETBRAINS_VERSIONS__: unknown;\ndeclare const __VENDORED_VSCODE_VERSIONS__: unknown;',
  },
  {
    file: 'src/hooks/useFileUpload.ts',
    reason: 'Load the sample report from a gzip+base64 block embedded in the HTML instead of fetch().',
    find: [
      '      const response = await fetch(`${getBasePath()}/data/sample-report.ndjson`);',
      '      if (!response.ok) {',
      "        throw new Error('Failed to load sample report');",
      '      }',
      '      ',
      '      const blob = await response.blob();',
    ].join('\n'),
    replace: [
      "      const embedded = document.getElementById('vendored-sample-report')?.textContent?.trim();",
      "      if (!embedded) throw new Error('Embedded sample report is missing from this build');",
      "      if (typeof DecompressionStream === 'undefined') {",
      "        throw new Error('This browser does not support DecompressionStream, required to unpack the sample report');",
      '      }',
      '      const gzipBytes = Uint8Array.from(atob(embedded), (char) => char.charCodeAt(0));',
      "      const stream = new Blob([gzipBytes]).stream().pipeThrough(new DecompressionStream('gzip'));",
      '      const blob = await new Response(stream).blob();',
    ].join('\n'),
  },
  {
    file: 'src/hooks/useFileUpload.ts',
    reason: 'getBasePath is no longer used here.',
    find: "import { getBasePath } from '../utils/basePath';\n",
    replace: '',
  },
  {
    file: 'src/state/NavigationContext.tsx',
    reason: 'Mirror the in-memory view state in location.hash (#/view, #/userDetails/<id>/<login>) so every page is hash-addressable and Back/Forward work.',
    find: [
      'export const NavigationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {',
      '  const [state, setState] = useState<NavigationState>(initialNavigationState);',
    ].join('\n'),
    replace: [
      'const KNOWN_VIEWS = new Set<string>(Object.values(VIEW_MODES));',
      '',
      'function reportNavigationError(message: string): void {',
      '  const report = (window as unknown as { __vendoredReportError?: (message: string) => void }).__vendoredReportError;',
      "  if (typeof report !== 'function') throw new Error(message);",
      '  report(message);',
      '}',
      '',
      'function navigationFromHash(hash: string): NavigationState | null {',
      "  if (!hash.startsWith('#/')) return null;",
      "  const [view, rawId, ...loginParts] = hash.slice(2).split('/');",
      '  if (!KNOWN_VIEWS.has(view)) {',
      "    reportNavigationError(`Unknown dashboard page link ${hash}; showing the overview instead`);",
      '    return null;',
      '  }',
      '  if (view === VIEW_MODES.USER_DETAILS) {',
      '    const id = Number(rawId);',
      '    let login: string;',
      '    try {',
      "      login = decodeURIComponent(loginParts.join('/'));",
      '    } catch (error) {',
      "      reportNavigationError(`Malformed user link ${hash}: ${error instanceof Error ? error.message : String(error)}`);",
      '      return null;',
      '    }',
      '    if (!Number.isSafeInteger(id) || !login) {',
      "      reportNavigationError(`Invalid user link ${hash}`);",
      '      return null;',
      '    }',
      '    return { currentView: VIEW_MODES.USER_DETAILS, selectedUser: { id, login } };',
      '  }',
      '  return { currentView: view as ViewMode, selectedUser: null };',
      '}',
      '',
      'function hashFromNavigation(state: NavigationState): string {',
      '  if (state.currentView === VIEW_MODES.USER_DETAILS && state.selectedUser) {',
      '    return `#/${VIEW_MODES.USER_DETAILS}/${state.selectedUser.id}/${encodeURIComponent(state.selectedUser.login)}`;',
      '  }',
      '  return `#/${state.currentView}`;',
      '}',
      '',
      'export const NavigationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {',
      '  const [state, setState] = useState<NavigationState>(',
      "    () => navigationFromHash(typeof window === 'undefined' ? '' : window.location.hash) ?? initialNavigationState",
      '  );',
      '',
      '  useEffect(() => {',
      '    const onHashChange = () => {',
      '      const next = navigationFromHash(window.location.hash);',
      '      // Non-route fragments (in-page section anchors such as #drift) leave the view unchanged.',
      '      if (!next) return;',
      '      setState((prev) =>',
      '        hashFromNavigation(prev) === hashFromNavigation(next) ? prev : next',
      '      );',
      '      scrollToPageTop();',
      '    };',
      "    window.addEventListener('hashchange', onHashChange);",
      "    return () => window.removeEventListener('hashchange', onHashChange);",
      '  }, []);',
      '',
      '  useEffect(() => {',
      '    const desired = hashFromNavigation(state);',
      '    const current = window.location.hash;',
      "    if (current === desired || (current === '' && desired === hashFromNavigation(initialNavigationState))) return;",
      '    window.location.hash = desired;',
      '  }, [state]);',
    ].join('\n'),
  },
  {
    file: 'src/state/NavigationContext.tsx',
    reason: 'Import useEffect for hash synchronisation.',
    find: "import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';",
    replace: "import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';",
  },
  {
    file: 'src/components/ExecutiveSummaryView.tsx',
    reason: 'window.print() is blocked without allow-modals: keep Print visibly disabled and add a standalone HTML download (summary DOM, inline styles, charts as data: images, no scripts) with a data-handling warning.',
    find: '<button type="button" onClick={() => window.print()}>Print / Save PDF</button>\n        </div>',
    replace: [
      '<button',
      '            type="button"',
      '            disabled',
      `            title="${PRINT_DISABLED_TITLE}"`,
      "            style={{ opacity: 0.5, cursor: 'not-allowed' }}",
      '          >Print / Save PDF</button>',
      '          <button',
      '            type="button"',
      '            onClick={() => downloadExecutiveSummary(styles.brief)}',
      '            title={EXPORT_WARNING}',
      '          >Download executive summary (HTML)</button>',
      '        </div>',
      '        <p role="note" style={{ flexBasis: \'100%\', fontSize: 12, color: \'#6e5600\', margin: 0 }}>{EXPORT_WARNING}</p>',
    ].join('\n'),
  },
  {
    file: 'src/components/ExecutiveSummaryView.tsx',
    reason: 'Import the vendored executive summary export helper.',
    find: "import styles from './features/executive-summary/ExecutiveSummary.module.css';",
    replace: "import styles from './features/executive-summary/ExecutiveSummary.module.css';\nimport { downloadExecutiveSummary, EXPORT_WARNING } from '../vendored/exportExecutiveSummary';",
  },
];

function applyPatches(src) {
  for (const [file, contents] of Object.entries(ADDED_FILES)) {
    const path = join(src, file);
    if (existsSync(path)) throw new Error(`Refusing to overwrite upstream file ${file}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents.trimStart());
  }
  for (const patch of PATCHES) {
    const file = join(src, patch.file);
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const count = text.split(patch.find).length - 1;
    if (count !== 1) throw new Error(`Patch anchor found ${count} times in ${patch.file}: ${patch.reason}`);
    writeFileSync(file, text.replace(patch.find, () => patch.replace));
  }
}

const ENTRY = `
import { createRoot } from 'react-dom/client';
import Providers from './app/providers';
import Home from './app/page';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container');
createRoot(container).render(<Providers><Home /></Providers>);
`;

const NEXT_LINK_SHIM = `
import React from 'react';
const Link = React.forwardRef(function Link({ href, prefetch, replace, scroll, ...props }, ref) {
  return <a ref={ref} href={typeof href === 'string' ? href : String(href)} {...props} />;
});
export default Link;
`;

const ERROR_OVERLAY = `
(function () {
  function show(message) {
    var box = document.getElementById('vendored-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'vendored-error';
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:40vh;overflow:auto;margin:0;padding:12px 16px;background:#ffebe9;color:#82071e;border-top:2px solid #cf222e;font:13px/1.4 ui-monospace,monospace;white-space:pre-wrap';
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent += (box.textContent ? '\\n' : '') + 'Dashboard error: ' + message;
  }
  Object.defineProperty(window, '__vendoredReportError', { value: show });
  // The sandbox grants no allow-popups or top navigation, so links leaving the page cannot open.
  // Cancel them with a visible notice instead of failing silently; in-page #anchors keep working.
  var notice;
  function isExternal(anchor) {
    var href = anchor.getAttribute('href') || '';
    return href !== '' && href.charAt(0) !== '#' && !/^(blob|data):/i.test(href);
  }
  function anchorOf(target) { return target && target.closest ? target.closest('a[href]') : null; }
  document.addEventListener('click', function (e) {
    var anchor = anchorOf(e.target);
    if (!anchor || !isExternal(anchor)) return;
    e.preventDefault();
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'vendored-link-notice';
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'position:fixed;right:16px;top:72px;z-index:2147483646;max-width:420px;padding:10px 14px;background:#fff8c5;color:#3b2300;border:1px solid #d4a72c;border-radius:6px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.15);overflow-wrap:anywhere';
      document.body.appendChild(notice);
    }
    notice.textContent = 'External links are unavailable in the isolated dashboard. Open manually if needed: ' + anchor.href;
  }, true);
  document.addEventListener('mouseover', function (e) {
    var anchor = anchorOf(e.target);
    if (anchor && isExternal(anchor) && !anchor.hasAttribute('data-vendored-titled')) {
      anchor.setAttribute('data-vendored-titled', '');
      anchor.title = 'External link unavailable in isolated dashboard: ' + anchor.href;
    }
  }, true);
  window.addEventListener('error', function (e) { show(e.error && e.error.stack ? e.error.stack : e.message); });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason; show(r && r.stack ? r.stack : String(r));
  });
  window.addEventListener('securitypolicyviolation', function (e) {
    show('Blocked by Content-Security-Policy: ' + e.violatedDirective + ' ' + (e.blockedURI || ''));
  });
})();
`;

// Lists every installed npm package whose files esbuild actually bundled (from the metafiles),
// plus packages that emit code without being imported (Tailwind's generated CSS), with full license text.
function thirdPartyNotices(src, metafiles, extraPackages) {
  const dirs = new Set(extraPackages.map((name) => join(src, 'node_modules', name)));
  for (const meta of metafiles) {
    for (const input of Object.keys(meta.inputs)) {
      // Metafile paths are relative to esbuild's working directory (process.cwd()).
      const abs = resolve(process.cwd(), input);
      const parts = abs.split(/[\\/]/);
      const idx = parts.lastIndexOf('node_modules');
      if (idx < 0) continue;
      const take = parts[idx + 1].startsWith('@') ? 2 : 1;
      dirs.add(parts.slice(0, idx + 1 + take).join('/'));
    }
  }
  const packages = [...dirs].map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const licenseFile = readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
    if (!licenseFile) throw new Error(`No license file found for bundled package ${pkg.name}`);
    return { name: pkg.name, version: pkg.version, license: pkg.license, licenseText: readFileSync(join(dir, licenseFile), 'utf8').trim() };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const text = [
    '# Third-party notices',
    '',
    `index.html bundles ${UPSTREAM.repository} @ ${UPSTREAM.commit} (${UPSTREAM.license}, see LICENSE)`,
    'and the following npm packages, installed from the upstream package-lock.json. Generated from esbuild metafiles',
    'by tools/vendor-copilot-usage-viewer.mjs; do not edit by hand.',
    '',
    ...packages.flatMap((p) => [`## ${p.name}@${p.version} (${p.license})`, '', '```text', p.licenseText, '```', '']),
  ].join('\n');
  return { text, packages: packages.map(({ name, version, license }) => ({ name, version, license })) };
}

async function build(src) {
  const req = createRequire(join(src, 'package.json'));
  const load = async (name) => {
    const mod = await import(pathToFileURL(req.resolve(name)).href);
    return mod.default ?? mod;
  };
  const esbuild = await load('esbuild');
  const postcss = await load('postcss');
  const tailwind = await load('@tailwindcss/postcss');
  const versionOf = (name) => JSON.parse(readFileSync(join(src, 'node_modules', name, 'package.json'), 'utf8')).version;

  const worker = await esbuild.build({
    entryPoints: [join(src, 'src/workers/metricsWorker.ts')],
    bundle: true, write: false, format: 'iife', target: 'es2020', minify: true, legalComments: 'inline', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const workerSource = worker.outputFiles[0].text;

  const readJson = (rel) => JSON.parse(readFileSync(join(src, rel), 'utf8'));
  const alias = {
    name: 'vendored-shims',
    setup(b) {
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'next-link', namespace: 'shim' }));
      b.onResolve({ filter: /^next(\/.*)?$/ }, (a) => ({ errors: [{ text: `Unsupported Next.js import in vendored build: ${a.path}` }] }));
      b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: NEXT_LINK_SHIM, loader: 'jsx', resolveDir: src }));
    },
  };
  const app = await esbuild.build({
    stdin: { contents: ENTRY, loader: 'tsx', resolveDir: join(src, 'src'), sourcefile: 'vendored-entry.tsx' },
    bundle: true, write: false, format: 'iife', target: 'es2020', minify: true, legalComments: 'inline', metafile: true,
    jsx: 'automatic', charset: 'utf8', plugins: [alias], logLevel: 'error',
    // Upstream CSS modules (executive summary) are compiled by esbuild's local-css loader.
    outdir: join(src, '.vendored-out'), loader: { '.module.css': 'local-css' },
    // Keep identifiers readable so CSS-module classes stay unique (e.g. ExecutiveSummary_brief), not .a/.b.
    minifyIdentifiers: false,
    tsconfig: join(src, 'tsconfig.json'),
    define: {
      'process.env.NODE_ENV': '"production"',
      __VENDORED_METRICS_WORKER_SOURCE__: JSON.stringify(workerSource),
      __VENDORED_JETBRAINS_VERSIONS__: JSON.stringify(readJson('public/data/jetbrains.json')),
      __VENDORED_VSCODE_VERSIONS__: JSON.stringify(readJson('public/data/vscode.json')),
    },
  });
  const appJs = app.outputFiles.find((f) => f.path.endsWith('.js')).text;
  const moduleCss = app.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n');

  const cssFrom = join(src, 'src/app/globals.css');
  const tailwindOut = await postcss([tailwind({ base: src, optimize: false })]).process(readFileSync(cssFrom, 'utf8'), { from: cssFrom });
  // esbuild keeps CSS-module class names unprefixed when unique; fail if one would collide with global/Tailwind CSS.
  for (const name of new Set([...moduleCss.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))) {
    if (new RegExp(`\\.${name}(?![\\w-])`).test(tailwindOut.css)) throw new Error(`CSS module class .${name} collides with global CSS`);
  }
  const css = (await esbuild.transform(`${tailwindOut.css}\n${moduleCss}`, { loader: 'css', minify: true, legalComments: 'inline' })).code;

  const sampleBytes = readFileSync(join(src, 'public/data/sample-report.ndjson'));
  const sampleGzipB64 = gzipSync(sampleBytes, { level: 9 }).toString('base64');

  for (const [label, text, closer] of [['app', appJs, /<\/script/i], ['worker', workerSource, /<\/script/i], ['css', css, /<\/style/i]]) {
    if (closer.test(text)) throw new Error(`${label} output contains a closing tag that would break inlining`);
  }
  const externalRef = /(?:url\(\s*['"]?(?!data:|#)[^)'"]+|@import\s|importScripts\s*\(|\bfetch\s*\()/;
  for (const [label, text] of [['css', css], ['worker', workerSource]]) {
    const hit = text.match(externalRef);
    if (hit) throw new Error(`${label} output still references an external resource: ${hit[0]}`);
  }
  if (/\beval\s*\(|new Function\s*\(/.test(appJs + workerSource)) {
    throw new Error("Bundle uses eval/new Function, which would require 'unsafe-eval'; refusing to vendor");
  }

  const favicon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📊</text></svg>');
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>GitHub Copilot User Level Metrics Viewer</title>',
    `<link rel="icon" type="image/svg+xml" href="${favicon}">`,
    `<!-- Vendored from ${UPSTREAM.repository} @ ${UPSTREAM.commit} (${UPSTREAM.license}, ${UPSTREAM.copyright}). See LICENSE, THIRD-PARTY-NOTICES.md and PROVENANCE.json. -->`,
    `<style>${css}</style>`,
    `<script>${ERROR_OVERLAY}</script>`,
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="application/octet-stream" id="vendored-sample-report">${sampleGzipB64}</script>`,
    `<script>${appJs}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const notices = thirdPartyNotices(src, [worker.metafile, app.metafile], ['tailwindcss']);
  return {
    html,
    notices,
    sizes: { appJs: appJs.length, workerJs: workerSource.length, css: css.length, sampleGzipBase64: sampleGzipB64.length },
    inputs: {
      'public/data/jetbrains.json': sha256(readFileSync(join(src, 'public/data/jetbrains.json'))),
      'public/data/vscode.json': sha256(readFileSync(join(src, 'public/data/vscode.json'))),
      'public/data/sample-report.ndjson': sha256(sampleBytes),
      'package-lock.json': sha256(readFileSync(join(src, 'package-lock.json'))),
    },
    toolVersions: {
      esbuild: versionOf('esbuild'), tailwindcss: versionOf('tailwindcss'), '@tailwindcss/postcss': versionOf('@tailwindcss/postcss'),
      postcss: versionOf('postcss'), react: versionOf('react'), 'react-dom': versionOf('react-dom'),
      'chart.js': versionOf('chart.js'), 'react-chartjs-2': versionOf('react-chartjs-2'),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = join(claimWorkdir(args.workdir), 'src');
  checkout(src);

  const license = readFileSync(join(src, 'LICENSE'), 'utf8');
  if (!license.startsWith('MIT License') || !license.includes(UPSTREAM.copyright)) {
    throw new Error('Upstream LICENSE is not the expected MIT license; refusing to vendor.');
  }

  if (!args.skipInstall) run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], src);
  applyPatches(src);
  const result = await build(src);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), result.html);
  writeFileSync(join(outDir, 'LICENSE'), license);
  writeFileSync(join(outDir, 'THIRD-PARTY-NOTICES.md'), result.notices.text);

  const toolPath = fileURLToPath(import.meta.url);
  const provenance = {
    name: 'copilot-user-level-statistics-viewer',
    sourceUrl: UPSTREAM.repository,
    sourceCommit: UPSTREAM.commit,
    sourceArchive: `${UPSTREAM.repository}/archive/${UPSTREAM.commit}.tar.gz`,
    license: UPSTREAM.license,
    copyright: UPSTREAM.copyright,
    licenseFile: 'LICENSE',
    generatedBy: 'tools/vendor-copilot-usage-viewer.mjs',
    generatorSha256: sha256(readFileSync(toolPath, 'utf8').replace(/\r\n/g, '\n')),
    build: {
      recipe: [
        `git fetch --depth 1 ${UPSTREAM.repository} ${UPSTREAM.commit} && git checkout --force ${UPSTREAM.commit}`,
        'npm ci --ignore-scripts --no-audit --no-fund   # upstream package-lock.json, in a throwaway work directory',
        'apply the integration patches listed below (exact-anchor string replacements)',
        'esbuild: src/workers/metricsWorker.ts -> minified IIFE string',
        'esbuild: React entry (Providers + app/page) -> minified IIFE, next/link shimmed, Next.js runtime not used',
        'postcss + @tailwindcss/postcss: src/app/globals.css -> minified CSS',
        'inline CSS, app JS, worker source, plugin-version JSON and gzip+base64 sample report into index.html',
      ],
      command: 'node tools/vendor-copilot-usage-viewer.mjs --workdir <throwaway-dir>',
      nodeVersion: process.version,
      toolVersions: result.toolVersions,
      upstreamInputsSha256: result.inputs,
    },
    integrationChanges: PATCHES.map(({ file, reason }) => ({ file, reason })).concat([
      { file: '(build)', reason: 'Next.js static export replaced by a direct esbuild bundle of the same client components; next/link aliased to a plain <a>.' },
      ...Object.keys(ADDED_FILES).map((file) => ({ file, reason: 'Added: standalone executive summary HTML export (Blob download).' })),
      { file: '(build)', reason: 'Inline error overlay surfaces uncaught errors, unhandled rejections, CSP violations and invalid hash routes visibly.' },
      { file: '(build)', reason: 'External (non-#) link clicks are cancelled with a visible notice because the sandbox grants no popups or top navigation.' },
      { file: '(build)', reason: "Build fails if the bundle needs eval/new Function ('unsafe-eval' is never granted)." },
      { file: '(build)', reason: 'Workdir must be outside this repository and new/empty or marked with ' + OWNER_MARKER + ' for this commit before any forced checkout/clean.' },
      { file: '(build)', reason: `Content-Security-Policy meta: ${CSP}` },
    ]),
    runtime: {
      networkAccess: 'none (connect-src none; no fetch, no external scripts, styles, fonts or images)',
      requiresEval: false,
      storage: 'upstream uses no localStorage/sessionStorage/IndexedDB/cookies',
      iframeSandbox: 'allow-scripts allow-downloads (no allow-same-origin)',
      navigation: 'hash routes #/<view> and #/userDetails/<id>/<login>; unknown or malformed routes show the error banner and fall back',
      disabledFeatures: ['Print / Save PDF (window.print needs allow-modals; replaced by standalone HTML download)', 'external links (need allow-popups / top navigation; cancelled with a visible notice)'],
      executiveSummaryExport: { format: 'standalone HTML via Blob download (allow-downloads)', contentSecurityPolicy: "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'", contents: 'rendered Executive Summary DOM, inline CSS, charts as PNG data: URLs; no scripts, no source records' },
    },
    bundledPackages: result.notices.packages,
    sizes: result.sizes,
    files: {
      'index.html': sha256(result.html),
      LICENSE: sha256(license),
      'THIRD-PARTY-NOTICES.md': sha256(result.notices.text),
    },
  };
  writeFileSync(join(outDir, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Wrote ${outDir} (index.html ${result.html.length} bytes, sha256 ${provenance.files['index.html']})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}