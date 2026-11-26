'use strict';

/**
 * 纯 Node 的解析核心（不依赖 vscode 模块，方便用 node 直接跑测试）。
 *
 * 目标：把路由文件里的这两种写法解析到「控制器文件 + 方法行号」
 *   Route::post('aiboxWaring', 'AiboxWaringController@getFile');
 *   Route::post('logout', [AuthController::class, 'logout']);
 *
 * 设计要点：
 *  - 不解析 namespace 分组，而是先按「类名 + 方法是否存在」建索引，再消歧；
 *  - Laravel 7 那套 RouteServiceProvider::$namespace / Route::group(['namespace' => 'Api'])
 *    只用来做消歧提示，不参与正确性判断，所以比正则拼命名空间稳。
 */

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.idea', 'storage', 'bootstrap']);
const MAX_FILE_BYTES = 512 * 1024;

function listPhpFiles(dir, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) listPhpFiles(full, out);
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.php')) {
      out.push(full);
    }
  }
  return out;
}

function parseControllerFile(file) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const nsMatch = /\bnamespace\s+([A-Za-z_][\w\\]*)\s*;/.exec(text);
  const clsMatch = /\b(?:class|trait)\s+([A-Za-z_]\w*)/.exec(text);
  if (!clsMatch) return null;

  const base = clsMatch[1];
  const ns = nsMatch ? nsMatch[1] : '';
  const fqcn = ns ? `${ns}\\${base}` : base;

  // 方法名 => 行号（PHP 方法名大小写不敏感，统一小写做 key）
  const methods = new Map();
  text.split(/\r?\n/).forEach((line, i) => {
    const re = /\bfunction\s+([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(line))) {
      const name = m[1].toLowerCase();
      if (!methods.has(name)) methods.set(name, i + 1);
    }
  });

  return { file, base, ns, fqcn, methods };
}

class ControllerIndex {
  constructor(root, controllersPath = 'app/Http/Controllers') {
    this.root = root;
    this.controllersPath = controllersPath;
    this.entries = [];
    this.lastBuild = 0;
  }

  get controllersDir() {
    return path.join(this.root, this.controllersPath);
  }

  /** 10s 内复用上次扫描结果，避免每次 Ctrl+点击都读盘。 */
  ensure(maxAgeMs = 10000) {
    if (!this.entries.length || Date.now() - this.lastBuild > maxAgeMs) this.rebuild();
    return this;
  }

  rebuild() {
    this.entries = listPhpFiles(this.controllersDir)
      .map(parseControllerFile)
      .filter(Boolean);
    this.lastBuild = Date.now();
    return this;
  }

  /**
   * @param {string} classRef  路由里写的控制器，可能是 CommonController / Api\CommonController / 全限定名
   * @param {string} method
   * @param {{useMap?: Map<string,string>, namespaces?: string[]}} ctx
   */
  resolve(classRef, method, ctx = {}) {
    const cls = String(classRef || '').replace(/^\\+/, '');
    const m = String(method || '').toLowerCase();
    if (!cls || !m) return null;

    const useMap = ctx.useMap || new Map();
    let candidates = [];

    const imported = useMap.get(cls);
    if (imported) {
      candidates = this.entries.filter((e) => e.fqcn.toLowerCase() === imported.toLowerCase());
    }
    if (!candidates.length) {
      const lower = cls.toLowerCase();
      candidates = this.entries.filter((e) => {
        if (cls.includes('\\')) {
          return (
            e.fqcn === cls ||
            e.fqcn.endsWith('\\' + cls) ||
            e.fqcn.toLowerCase().endsWith('\\' + lower)
          );
        }
        return e.base === cls || e.base.toLowerCase() === lower;
      });
    }
    if (!candidates.length) return null;

    const withMethod = candidates.filter((e) => e.methods.has(m));
    const pool = withMethod.length ? withMethod : candidates;
    const scored = pool
      .map((e) => ({ e, score: this.score(e, ctx) }))
      .sort((a, b) => a.score - b.score || a.e.file.localeCompare(b.e.file));

    const best = scored[0].e;
    return {
      file: best.file,
      line: best.methods.get(m) || 1,
      fqcn: best.fqcn,
      hasMethod: best.methods.has(m),
    };
  }

  /**
   * 越小越优：优先「文档里出现过对应 namespace 分组」的类，其次层级更浅的。
   */
  score(entry, ctx = {}) {
    const extra = entry.fqcn.replace(/^App\\Http\\Controllers\\?/i, '');
    const namespaces = ctx.namespaces || [];
    const hinted = namespaces.some((ns) => extra === ns || extra.startsWith(ns + '\\'));
    const depth = extra ? extra.split('\\').length : 0;
    return (hinted ? 0 : 100) + depth;
  }
}

/** 解析路由文件顶部的 use 语句，得到 别名 => 全限定类名。 */
function parseUseMap(text) {
  const map = new Map();
  const re = /^[ \t]*use[ \t]+(?!function\b|const\b)([A-Za-z_][\w\\]*)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*;/gm;
  let m;
  while ((m = re.exec(text))) {
    const fqcn = m[1];
    map.set(m[2] || fqcn.split('\\').pop(), fqcn);
  }
  return map;
}

/** 路由文件里出现过的 'namespace' => 'Api' 分组名，用于消歧。 */
function parseGroupNamespaces(text) {
  const out = new Set();
  const re = /['"]namespace['"]\s*=>\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    const ns = m[1].replace(/\\\\/g, '\\').replace(/^\\+/, '').trim();
    if (ns) out.add(ns);
  }
  return [...out];
}

function lineBounds(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  return [start, end];
}

/** 只认路由调用行，避免把 'user@example.com' 之类的字符串当路由。 */
function isRouteLine(text, index) {
  const [start, end] = lineBounds(text, index);
  const line = text.slice(start, end);
  return (
    /\bRoute\s*::/.test(line) ||
    /->\s*(get|post|put|patch|delete|options|any|match|fallback)\s*\(/i.test(line)
  );
}

/**
 * 扫描文档，返回所有可跳转的动作。
 * @returns {Array<{kind:'string'|'array', classRef:string, method:string, start:number, end:number}>}
 *          start/end 是字符偏移（指向需要变成链接的文本）
 */
function collectActions(text) {
  const actions = [];

  // 形式一：'FooController@method' / 'Api\FooController@method'
  const stringRe = /(['"])([A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*Controller)@([A-Za-z_]\w*)\1/g;
  let m;
  while ((m = stringRe.exec(text))) {
    if (!isRouteLine(text, m.index)) continue;
    const start = m.index + 1;
    const end = m.index + m[0].length - 1;
    actions.push({ kind: 'string', classRef: m[2], method: m[3], start, end });
  }

  // 形式二：[FooController::class, 'method']
  const arrayRe = /([A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)::class\s*,\s*(['"])([A-Za-z_]\w*)\2/g;
  while ((m = arrayRe.exec(text))) {
    if (!isRouteLine(text, m.index)) continue;
    const offset = m.index + m[0].lastIndexOf(m[3]);
    actions.push({
      kind: 'array',
      classRef: m[1],
      method: m[3],
      start: offset,
      end: offset + m[3].length,
    });
  }

  return actions.sort((a, b) => a.start - b.start);
}

module.exports = {
  ControllerIndex,
  collectActions,
  parseUseMap,
  parseGroupNamespaces,
  listPhpFiles,
  parseControllerFile,
};
