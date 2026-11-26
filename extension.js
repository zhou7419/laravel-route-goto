'use strict';

const vscode = require('vscode');
const {
  ControllerIndex,
  collectActions,
  parseUseMap,
  parseGroupNamespaces,
} = require('./lib/resolve');

/** workspaceFolderPath -> ControllerIndex */
const indexes = new Map();

/**
 * 只注册到 PHP 语言，再在代码里判断是不是路由文件。
 * 不用 documentSelector 的 pattern，是因为 glob 匹配规则在版本间有差异，
 * 一旦匹配不上就是「静默失效」，很难排查。
 */
const SELECTOR = { language: 'php' };

function isRouteFile(fsPath) {
  return /(^|[\\/])routes[\\/][^\\/]*\.php$/i.test(fsPath || '');
}

function config(uri) {
  return vscode.workspace.getConfiguration('laravelRouteGoto', uri);
}

function getIndex(folder) {
  const controllersPath = config().get('controllersPath', 'app/Http/Controllers');
  let index = indexes.get(folder.uri.fsPath);
  if (!index || index.controllersPath !== controllersPath) {
    index = new ControllerIndex(folder.uri.fsPath, controllersPath);
    indexes.set(folder.uri.fsPath, index);
  }
  return index.ensure();
}

/**
 * 解析一份文档里的所有动作，返回 [{ action, hit }]，hit 为 null 表示没解析到。
 */
function resolveDocument(document) {
  if (!config(document.uri).get('enabled', true)) return [];
  if (!isRouteFile(document.uri.fsPath)) return [];
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return [];

  const text = document.getText();
  const actions = collectActions(text);
  if (!actions.length) return [];

  let index;
  try {
    index = getIndex(folder);
  } catch {
    return [];
  }

  const ctx = {
    useMap: parseUseMap(text),
    namespaces: parseGroupNamespaces(text),
  };

  return actions.map((action) => ({
    action,
    hit: index.resolve(action.classRef, action.method, ctx),
  }));
}

function toLocation(hit) {
  return new vscode.Location(
    vscode.Uri.file(hit.file),
    new vscode.Position(Math.max(0, hit.line - 1), 0),
  );
}

class LaravelRouteDefinitionProvider {
  provideDefinition(document, position) {
    const offset = document.offsetAt(position);
    const results = [];
    for (const { action, hit } of resolveDocument(document)) {
      if (!hit) continue;
      if (offset >= action.start && offset <= action.end) results.push(toLocation(hit));
    }
    return results;
  }
}

class LaravelRouteLinkProvider {
  provideDocumentLinks(document) {
    if (!config(document.uri).get('showLinks', true)) return [];

    return resolveDocument(document)
      .filter(({ hit }) => hit && hit.hasMethod)
      .map(({ action, hit }) => {
        const range = new vscode.Range(
          document.positionAt(action.start),
          document.positionAt(action.end),
        );
        const target = vscode.Uri.parse(
          'command:laravelRouteGoto.open?' +
            encodeURIComponent(JSON.stringify([hit.file, hit.line])),
        );
        const link = new vscode.DocumentLink(range, target);
        link.tooltip = `${hit.fqcn}::${action.method}()`;
        return link;
      });
  }
}

async function openTarget(file, line) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function activate(context) {
  const definition = new LaravelRouteDefinitionProvider();
  const links = new LaravelRouteLinkProvider();

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(SELECTOR, definition),
    vscode.languages.registerDocumentLinkProvider(SELECTOR, links),
    vscode.commands.registerCommand('laravelRouteGoto.open', openTarget),
    vscode.commands.registerCommand('laravelRouteGoto.rebuildIndex', () => {
      indexes.clear();
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) {
        vscode.window.showWarningMessage('Laravel Route Goto: 没有打开的工作区');
        return;
      }
      const index = getIndex(folder);
      vscode.window.showInformationMessage(
        `Laravel Route Goto: 已索引 ${index.entries.length} 个控制器`,
      );
    }),
    // 控制器文件保存后让缓存尽快失效
    vscode.workspace.onDidSaveTextDocument(() => indexes.clear()),
  );
}

function deactivate() {
  indexes.clear();
}

module.exports = { activate, deactivate };
