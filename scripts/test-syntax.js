'use strict';

/**
 * 语法识别的自检：用合成路由片段验证两种写法、use 别名、以及不该误报的字符串。
 * 用法: node scripts/test-syntax.js
 */

const assert = require('assert');
const { collectActions, parseUseMap } = require('../lib/resolve');

const src = `
<?php

use Illuminate\\Support\\Facades\\Route;
use App\\Http\\Controllers\\Api\\CommonController;

// 不该被抓：邮箱
$mail = 'someone@example.com';

// 不该被抓：非路由行
$thing = 'FooController@bar';

Route::group(['namespace' => 'Api'], function () {
    Route::get('/getConfigInfos', 'CommonController@getConfigInfos');
});

Route::post('aiboxWaring', "AiboxWaringController@getFile");
Route::post('logout', [AuthController::class, 'logout']);
Route::match(['get', 'post'], 'multi', 'Api\\UserController@store');
`;

const actions = collectActions(src);
const got = actions.map((a) => `${a.kind}:${a.classRef}@${a.method}`);
console.log('识别到:', got);

assert.deepStrictEqual(got, [
  'string:CommonController@getConfigInfos',
  'string:AiboxWaringController@getFile',
  'array:AuthController@logout',
  'string:Api\\UserController@store',
]);

const useMap = parseUseMap(src);
assert.strictEqual(useMap.get('CommonController'), 'App\\Http\\Controllers\\Api\\CommonController');
assert.strictEqual(useMap.get('Route'), 'Illuminate\\Support\\Facades\\Route');

// 链接范围必须只覆盖字符串内部（不含引号）
const first = actions[0];
assert.strictEqual(src.slice(first.start - 1, first.start), "'");
assert.strictEqual(src.slice(first.end, first.end + 1), "'");
assert.strictEqual(src.slice(first.start, first.end), 'CommonController@getConfigInfos');

console.log('\n全部通过 ✅');
