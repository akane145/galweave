// eslint.config.mjs — 最小规范检查：只查错误，不做格式化。
//
// 目标单一：拦住「引用了但从未声明的标识符」这类只在运行时才炸的接线层 bug。
// src/main.js 是 DOM/接线层，没有单测覆盖，mtProjectPath 那种错误就是从这里漏出去的
// （单句机翻后弹 "mtProjectPath is not defined"）。
//
// 故意**不**启用任何风格 / 格式化规则（缩进、引号、分号、命名一律不管），
// 使命是零噪声、不和既有写法打架；想看风格请另配 Prettier。

import globals from 'globals';

const unusedVarsOptions = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  // 本仓库大量使用「空 catch 但保留形参」的写法（catch (e) { /* 忽略 */ }），不算问题
  caughtErrors: 'none',
  // const { a, ...rest } = obj —— 取出 a 只是为了让 rest 里没有它，这是惯用法
  ignoreRestSiblings: true,
  varsIgnorePattern: '^_',
};

export default [
  {
    ignores: [
      // 构建产物
      'dist/**',
      'dist-single/**',
      // 打包好的历史版本
      'release-v*/**',
      // 第三方 / 参考资料目录（非本项目代码）
      'LunaTranslator-main/**',
      'goldendict-master/**',
      'JPdict/**',
      // 设计过程产物
      '.superdesign/**',
      '.shots/**',
      '.workbuddy/**',
      'node_modules/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
    ],
  },
  // 前端源码：浏览器 + Web Worker（src/workers 用 self / postMessage）
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', unusedVarsOptions],
    },
  },
  // Node 侧：单测、构建/打包脚本、Vite 配置
  {
    files: [
      'tests/**/*.mjs',
      'scripts/**/*.mjs',
      'scripts/**/*.js',
      'vite.config.js',
      '*.config.mjs',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', unusedVarsOptions],
    },
  },
  // 说明：main.js 里 toggleStoryRail / toggleTheme 目前是「定义了但从未接线」的孤立函数
  // （分别是窄屏左侧故事栏的开启、以及工具栏快速切换主题循环）。它们代表真实的功能缺口，
  // 不删除、也不在配置里豁免 —— 保留为 warning，让每次 lint 都把这两笔"欠账"显示出来，
  // 待确认要接哪个按钮（或改文档）后再处理。
];
