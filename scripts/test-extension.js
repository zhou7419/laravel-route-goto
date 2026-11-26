'use strict';

/**
 * 集成自检：用 mock 的 vscode 模块加载真实 extension.js，
 * 再拿真实项目路由文件驱动 providers，验证：
 *   - DocumentLink 的 range 覆盖的是 'Controller@method'
 *   - DefinitionProvider 返回的 Location 指向正确的文件与行
 *
 * 用法: node scripts/test-extension.js <项目根> <路由文件>
 */

const Module = require('module');
const path = require('path');

const root = process.argv[2];
const routeFile = process.argv[3];
if (!root || !routeFile) {
  console.error('usage: node scripts/test-extension.js <projectRoot> <routeFile>');
  process.exit(2);
}

const captured = { definition: null, links: null, commands: new Map() };

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range = rangeOrPosition;
  }
}
class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
}
class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = 'file';
  }
  static file(p) {
    return new Uri(p);
  }
  static parse(s) {
    return { raw: s, toString: () => s };
  }
}

const vscode = {
  Position,
  Range,
  Location,
  DocumentLink,
  Uri,
  Selection: class {},
  TextEditorRevealType: { InCenter: 1 },
  workspace: {
    getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
    getConfiguration: () => ({ get: (key, def) => def }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
  },
  window: {
    showTextDocument: async () => ({ selection: null, revealRange() {} }),
    showInformationMessage: () => {},
    showWarningMessage: () => {},
  },
  commands: {
    registerCommand: (name, fn) => {
      captured.commands.set(name, fn);
      return { dispose() {} };
    },
  },
  languages: {
    registerDefinitionProvider: (selector, provider) => {
      captured.definition = provider;
      return { dispose() {} };
    },
    registerDocumentLinkProvider: (selector, provider) => {
      captured.links = provider;
      return { dispose() {} };
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.apply(this, arguments);
};

const fs = require('fs');
const text = fs.readFileSync(routeFile, 'utf8');
const starts = [0];
for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);

const document = {
  uri: { scheme: 'file', fsPath: routeFile },
  getText: () => text,
  positionAt(offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return new Position(lo, offset - starts[lo]);
  },
  offsetAt(position) {
    return starts[position.line] + position.character;
  },
  lineAt(line) {
    return { text: text.slice(starts[line], text.indexOf('\n', starts[line]) >>> 0) };
  },
  lineCount: starts.length,
};

const extension = require('../extension.js');
extension.activate({ subscriptions: [] });

const links = captured.links.provideDocumentLinks(document);
console.log(`DocumentLink 数量: ${links.length}`);

// 1) 第一条链接应当指向 Api\CommonController@getConfigInfos
const first = links[0];
const firstText = text.slice(document.offsetAt(first.range.start), document.offsetAt(first.range.end));
console.log(`首条链接文本: ${firstText}`);
console.log(`首条链接 tooltip: ${first.tooltip}`);
console.log(`首条链接目标: ${decodeURIComponent(String(first.target.raw)).slice(0, 140)}`);

if (firstText !== 'CommonController@getConfigInfos') throw new Error('首条链接范围不对');
if (!String(first.tooltip).includes('Api\\CommonController::getConfigInfos')) throw new Error('tooltip 不对');

const payload = JSON.parse(decodeURIComponent(String(first.target.raw).split('?')[1]));
console.log(`解析后的载荷: ${payload[0]}:${payload[1]}`);
if (!payload[0].endsWith(path.join('Controllers', 'Api', 'CommonController.php'))) throw new Error('目标文件不对');
if (payload[1] !== 850) throw new Error(`目标行号不对: ${payload[1]}`);

// 2) DefinitionProvider：把光标放到 aiboxWaring 那个字符串上
const target = "'AiboxWaringController@getFile'";
const pos = text.indexOf(target) + 1 + 3; // 指向 Controller 内部
const loc = captured.definition.provideDefinition(document, document.positionAt(pos));
console.log(`\nCtrl+点击 AiboxWaringController@getFile -> ${path.basename(loc[0].uri.fsPath)}:${loc[0].range.line + 1}`);
if (!loc.length) throw new Error('Definition 为空');
if (!loc[0].uri.fsPath.endsWith(path.join('Controllers', 'AiboxWaringController.php'))) throw new Error('文件不对');
if (loc[0].range.line + 1 !== 15) throw new Error(`行号不对: ${loc[0].range.line + 1}`);

// 3) 光标在无关位置时不应返回结果
const none = captured.definition.provideDefinition(document, new Position(0, 0));
if (none.length) throw new Error('无关位置不应有跳转');

console.log('\n集成自检通过 ✅');
