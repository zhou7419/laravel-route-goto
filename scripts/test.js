'use strict';

/**
 * 用法: node scripts/test.js <项目根目录> <路由文件>
 * 例:   node scripts/test.js D:\code\zhonganbang\safety_api D:\code\zhonganbang\safety_api\routes\api.php
 */

const fs = require('fs');
const path = require('path');
const {
  ControllerIndex,
  collectActions,
  parseUseMap,
  parseGroupNamespaces,
} = require('../lib/resolve');

const root = process.argv[2];
const routeFile = process.argv[3];
if (!root || !routeFile) {
  console.error('usage: node scripts/test.js <projectRoot> <routeFile>');
  process.exit(2);
}

const text = fs.readFileSync(routeFile, 'utf8');

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
const starts = lineStarts(text);
function lineAt(offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const index = new ControllerIndex(root, 'app/Http/Controllers').rebuild();
const actions = collectActions(text);
const ctx = { useMap: parseUseMap(text), namespaces: parseGroupNamespaces(text) };

console.log(`控制器索引: ${index.entries.length} 个类`);
console.log(`检测到动作: ${actions.length} 条 (string=${actions.filter((a) => a.kind === 'string').length}, array=${actions.filter((a) => a.kind === 'array').length})`);
console.log(`文档内 namespace 分组: ${JSON.stringify(ctx.namespaces)}`);

let resolved = 0;
let wrongLine = 0;
const unresolved = [];
const cache = new Map();

function readLines(file) {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, 'utf8').split(/\r?\n/));
  return cache.get(file);
}

for (const action of actions) {
  const hit = index.resolve(action.classRef, action.method, ctx);
  const routeLine = lineAt(action.start);
  if (!hit) {
    unresolved.push({ routeLine, ...action });
    continue;
  }
  resolved++;
  if (hit.hasMethod) {
    const line = readLines(hit.file)[hit.line - 1] || '';
    if (!new RegExp(`function\\s+${action.method}\\s*\\(`, 'i').test(line)) {
      wrongLine++;
      console.log(`[行号不符] 路由 ${routeLine} -> ${path.relative(root, hit.file)}:${hit.line} 内容: ${line.trim()}`);
    }
  } else {
    console.log(`[方法缺失] 路由 ${routeLine} '${action.classRef}@${action.method}' -> ${path.relative(root, hit.file)} (退回到类声明行)`);
  }
}

console.log(`\n解析成功: ${resolved}/${actions.length}`);
console.log(`行号校验失败: ${wrongLine}`);
console.log(`未解析: ${unresolved.length}`);
for (const item of unresolved.slice(0, 15)) {
  console.log(`  - 路由第 ${item.routeLine} 行: ${item.classRef}@${item.method}`);
}

// 代表性样例，便于人工核对
const samples = [
  ['CommonController', 'getConfigInfos'],
  ['AiboxWaringController', 'getFile'],
];
for (const [cls, method] of samples) {
  const action = actions.find((a) => a.classRef === cls && a.method === method);
  if (!action) {
    console.log(`\n样例缺失: ${cls}@${method}`);
    continue;
  }
  const hit = index.resolve(cls, method, ctx);
  console.log(
    `\n样例 ${cls}@${method} (路由第 ${lineAt(action.start)} 行) -> ` +
      (hit ? `${path.relative(root, hit.file)}:${hit.line} [${hit.fqcn}]` : '未解析'),
  );
}

process.exit(unresolved.length || wrongLine ? 1 : 0);
