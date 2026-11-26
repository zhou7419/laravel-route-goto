# Laravel Route Goto

> 一个 VS Code 扩展：在 `routes/*.php` 里 **Ctrl+点击** `'Controller@method'` 字符串，直接跳到控制器方法。
> 专治 Laravel 7/8 老项目里 `Controller/Method [...] not found.` 误报、以及字符串路由点不动的问题。

[English](#english) · [为什么不用现成的](#为什么不用现成的) · [已知限制](#已知限制)

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.75-007ACC?logo=visualstudiocode&logoColor=white)](#安装)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

## 问题

Laravel 7/8 项目里很常见这种写法：

```php
Route::group(['namespace' => 'Api'], function () {
    Route::get('/getConfigInfos', 'CommonController@getConfigInfos');
});

Route::post('aiboxWaring', 'AiboxWaringController@getFile');
```

官方扩展 `laravel.vscode-laravel`（内置 Laravel LSP）会在每一行下面画黄色波浪线：

```
Controller/Method [CommonController@getConfigInfos] not found.    Laravel Extension(controllerAction)
```

但项目跑得好好的。原因在 LSP 的实现（[`laravel/lsp`](https://github.com/laravel/lsp) 的
`ControllerActionDocumentMapper`）——它是拿**字面量**去和**运行时 action** 做精确比对：

```php
$route = $this->routes()->firstWhere('action', $value);   // 字符串完全相等才算命中
```

而 `RouteServiceProvider::$namespace` 加上 `Route::group(['namespace' => 'Api'])` 会在**运行时**
把 `'CommonController@getConfigInfos'` 补全成
`App\Http\Controllers\Api\CommonController@getConfigInfos`。

两边永远不相等 → 诊断误报，附带地跳转链接也一起失效。这属于工具的静态推断不准，不是代码问题。

## 这个扩展怎么解决

不猜命名空间（那正是容易错的地方），改成「**按类名 + 方法是否存在**」解析：

1. 扫描 `app/Http/Controllers/**/*.php`，记录每个类的 FQCN 和每个方法的行号；
2. 路由文件里的 `use` 别名优先命中；
3. 否则按类名匹配（大小写不敏感，符合 PHP 语义）；
4. **用「方法确实存在」消歧**——这是关键一步：
   `App\Http\Controllers\CommonController` 和 `App\Http\Controllers\Api\CommonController` 同名时，
   只有后者存在 `getConfigInfos`，于是能选对；
5. 仍有多个候选时，优先路由文件里出现过对应 `'namespace' => '...'` 分组的那个；
6. 方法不存在（死路由 / `__call` 魔术方法）→ 不画下划线，Ctrl+点击退回到类声明行，不给你假跳转。

## 功能

| 路由写法 | Ctrl+点击 | 说明 |
| --- | --- | --- |
| `Route::post('x', 'FooController@bar');` | ✅ | 整个字符串可点 |
| `Route::post('x', "FooController@bar");` | ✅ | 双引号同效 |
| `Route::post('x', 'Api\FooController@bar');` | ✅ | 带子命名空间 |
| `Route::post('x', [FooController::class, 'bar']);` | ✅ | 只让 `'bar'` 可点，`FooController::class` 交回给 PHP 语言服务 |
| `Route::apiResource(...)` / 闭包路由 | ❌ | 没有 `Class@method` 可解析 |

其他行为：

- `F12` / `Ctrl+点击` 跳到方法声明行，`Alt+F12` 可 peek；
- 按住 `Ctrl` 悬停时显示下划线和 tooltip（`App\...\FooController::bar()`）；
- 命令面板：`Laravel Route Goto: 重建控制器索引`（会提示索引到多少个类，排查用）；
- 控制器文件保存后索引自动失效重建。

## 安装

没有发布到 Marketplace，本地安装即可：

```powershell
git clone https://github.com/zhou7419/laravel-route-goto.git
$dst = "$env:USERPROFILE\.vscode\extensions\local.laravel-route-goto-0.1.0"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "laravel-route-goto\*" $dst -Recurse -Force
```

然后 `Ctrl+Shift+P` → `Developer: Reload Window`。

也可以打包成 vsix：

```powershell
npx @vscode/vsce package
code --install-extension laravel-route-goto-0.1.0.vsix
```

**卸载**：删除 `%USERPROFILE%\.vscode\extensions\local.laravel-route-goto-0.1.0` 目录，重载窗口。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `laravelRouteGoto.enabled` | `true` | 总开关 |
| `laravelRouteGoto.showLinks` | `true` | 是否画下划线；关掉后 `F12` / Ctrl+点击 仍然有效 |
| `laravelRouteGoto.controllersPath` | `app/Http/Controllers` | 控制器目录（相对工作区根目录） |

## 自检

仓库自带三个零依赖的 Node 脚本，改代码前后都能跑：

```powershell
# 1. 语法识别：两种写法、use 别名、不该误报的邮箱字符串
node scripts/test-syntax.js

# 2. 真实项目全量解析：逐条回读目标行，确认内容确实是 function <method>(
node scripts/test.js D:\code\some-project D:\code\some-project\routes\api.php

# 3. 集成：mock 掉 vscode 模块，驱动真实的 Definition / DocumentLink provider
node scripts/test-extension.js D:\code\some-project D:\code\some-project\routes\api.php
```

在一个 2049 行、863 条动作的 Laravel 7 项目上的实际输出：

```
控制器索引: 319 个类
检测到动作: 863 条
解析成功: 860/863
行号校验失败: 0
DocumentLink: 844 条
```

未解析的 3 条是类真的不存在（`aiBoxPushController`），另有 16 条是类里没有该方法
（死路由或 `__call`）——扩展选择「不给假跳转」。

## 已知限制

- 只对路径含 `routes/` 的 PHP 文件生效；
- 方法定义在 **trait / 父类** 里时识别不到（索引只扫类所在文件里的字面 `function`）；
- `__call` 转发、`Route::resource`、闭包路由不处理；
- 不做类自动加载推断，纯静态扫描文件内容（PSR-4 目录结构不是前提，但文件名需与类名一致才符合惯例）。

## 为什么不用现成的

| 方案 | 结论 |
| --- | --- |
| 官方 `laravel.vscode-laravel` | 只认「字面量 == 运行时 action」。`"Laravel.controllerAction.diagnostics": false` 能消掉误报，但跳转依然没有；写成全限定字符串可以跳，可读性代价太大 |
| `ctf0.laravel-goto-controller` | 只对 `Route::controller(X::class)->group(...)` 的写法生成链接，字符串路由不支持（翻它的编译产物确认过） |
| `stef-k.laravel-goto-controller` | 思路正确（`'X@y'` → 类 + 方法行），但作者已声明停止维护，且只向下找一层子目录 |
| PhpStorm + Laravel Idea | 体验最好，但收费，而且不是 VS Code |

## 开发

```
extension.js        # providers（Definition / DocumentLink）+ 命令注册
lib/resolve.js      # 控制器索引 + 动作解析（纯 Node，不依赖 vscode，可直接单测）
scripts/test*.js    # 三个自检脚本
```

改完源码后重新拷贝到扩展目录并重载窗口即可（见上文「安装」）。

## English

A tiny VS Code extension that makes `Ctrl+Click` work on legacy Laravel route strings
(`Route::post('x', 'FooController@bar')`) and jumps straight to the controller method.

The official Laravel extension resolves a route action by comparing the literal string with the
runtime action name (`App\Http\Controllers\...\FooController@bar`). Laravel 7-style shorthand
combined with `RouteServiceProvider::$namespace` / `Route::group(['namespace' => ...])` never
matches that, so every line is flagged as `Controller/Method [...] not found.` and no link is
produced — even though the application runs fine.

This extension indexes controllers and resolves by **class name + method existence**, so legacy
strings work without touching the project. It also links the method name inside
`[FooController::class, 'bar']`, which the official extension does not.

Install by copying the folder into `~/.vscode/extensions/` (see above) and reloading the window.
Settings: `laravelRouteGoto.enabled`, `laravelRouteGoto.showLinks`, `laravelRouteGoto.controllersPath`.

## License

[MIT](LICENSE) © zhou7419

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
