// fonts.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/fonts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FONT_EXTS, FONT_ACCEPT, MAX_LIBRARY,
  fontExt, isFontFile, normalizeFamily, parseFontName,
  entryKey, normalizeEntry, mergeFontLibrary, addEntries,
  removeBySource, removeFamily, isImportedFamily,
  weightLabel, faceLabel, formatBytes, groupFonts, cssFamilyValue,
} from '../src/fonts.js';

test('fontExt / isFontFile: 扩展名识别', () => {
  assert.equal(fontExt('a/b/Font.TTF'), 'ttf');
  assert.equal(fontExt('Font.woff2'), 'woff2');
  assert.equal(fontExt('NoExt'), '');
  assert.equal(fontExt('trailing.'), '');
  assert.equal(fontExt(''), '');
  assert.equal(isFontFile('x.otf'), true);
  assert.equal(isFontFile('x.txt'), false);
  assert.equal(isFontFile('x'), false);
  assert.equal(FONT_EXTS.every(e => FONT_ACCEPT.includes(e)), true);
});

test('normalizeFamily: 清掉会破坏 CSS 值的字符并压平空白', () => {
  assert.equal(normalizeFamily('  思源黑体  '), '思源黑体');
  assert.equal(normalizeFamily('My "Font"'), 'My Font');
  assert.equal(normalizeFamily("a'b"), 'a b');
  assert.equal(normalizeFamily('A,B;C{D}'), 'A B C D');
  assert.equal(normalizeFamily('a\\b'), 'a b');
  assert.equal(normalizeFamily('a\n\tb'), 'a b');
  assert.equal(normalizeFamily(undefined), '');
  assert.equal(normalizeFamily(123), '');
});

test('parseFontName: 字重/字形后缀剥离', () => {
  assert.deepEqual(parseFontName('SourceHanSerifSC-Bold.otf'),
    { family: 'SourceHanSerifSC', weight: 700, style: 'normal', ext: 'otf' });
  assert.deepEqual(parseFontName('NotoSansJP-Regular.ttf'),
    { family: 'NotoSansJP', weight: 400, style: 'normal', ext: 'ttf' });
  assert.deepEqual(parseFontName('MyFont_LightItalic.woff2'),
    { family: 'MyFont', weight: 300, style: 'italic', ext: 'woff2' });
  assert.deepEqual(parseFontName('MyFont-SemiBold.woff'),
    { family: 'MyFont', weight: 600, style: 'normal', ext: 'woff' });
  assert.deepEqual(parseFontName('MyFont-ExtraLight.ttf'),
    { family: 'MyFont', weight: 200, style: 'normal', ext: 'ttf' });
  assert.deepEqual(parseFontName('MyFont-BoldIt.ttf'),
    { family: 'MyFont', weight: 700, style: 'italic', ext: 'ttf' });
});

test('parseFontName: 空格分隔与无后缀', () => {
  assert.deepEqual(parseFontName('Sarasa Mono SC Regular.ttf'),
    { family: 'Sarasa Mono SC', weight: 400, style: 'normal', ext: 'ttf' });
  // 尾段不是关键字 → 原样保留(JP 不是字重)
  assert.deepEqual(parseFontName('Noto Sans JP.ttf'),
    { family: 'Noto Sans JP', weight: 400, style: 'normal', ext: 'ttf' });
  // 目录路径只取文件名
  assert.deepEqual(parseFontName('D:/fonts/CJK/思源宋体.otf'),
    { family: '思源宋体', weight: 400, style: 'normal', ext: 'otf' });
  // 全是字重关键字时不能把族名剥空
  const only = parseFontName('Bold.ttf');
  assert.equal(only.family, 'Bold');
});

test('parseFontName: 相似但不匹配的词不做剥离', () => {
  assert.equal(parseFontName('Suisse-Regular.ttf').family, 'Suisse');
  assert.equal(parseFontName('Credit.ttf').family, 'Credit');
  assert.equal(parseFontName('Legal-Book.ttf').family, 'Legal'); // Book 是关键字,确实该剥
  // 连续两个字重段都会被剥掉(X-Bold-Italic 这类写法要能识别出斜体)
  assert.deepEqual(parseFontName('Font-Bold-Italic.ttf'),
    { family: 'Font', weight: 700, style: 'italic', ext: 'ttf' });
  assert.equal(parseFontName('Font-Bold-Book.ttf').family, 'Font');
  // 剥到只剩一个字重词时,它留在族名里(不会产出空族名)
  assert.equal(parseFontName('Regular-Bold.ttf').family, 'Regular');
});

test('entryKey: 三种来源各自的去重键', () => {
  assert.equal(entryKey({ path: 'C:\\Fonts\\A.ttf' }), 'p:c:\\fonts\\a.ttf');
  assert.equal(entryKey({ relPath: ['sub', 'A.ttf'] }), 'h:sub/a.ttf');
  assert.equal(entryKey({ name: 'A.ttf', size: 10, mtime: 5 }), 'f:a.ttf|10|5');
  // 同路径大小写不同视为同一文件
  assert.equal(entryKey({ path: 'C:/F/A.TTF' }), entryKey({ path: 'c:/f/a.ttf' }));
});

test('normalizeEntry: 字段回填与非法输入', () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({ size: 1 }), null);            // 无族名也无文件名
  const e = normalizeEntry({ name: 'MyFont-Bold.otf', src: 'folder', path: 'C:/f/MyFont-Bold.otf' });
  assert.equal(e.family, 'MyFont');
  assert.equal(e.weight, 700);
  assert.equal(e.src, 'folder');
  assert.equal(e.path, 'C:/f/MyFont-Bold.otf');
  assert.equal(e.id, 'p:c:/f/myfont-bold.otf');
  // 显式 family 优先于文件名推导
  assert.equal(normalizeEntry({ name: 'x.ttf', family: '自定义族' }).family, '自定义族');
  // 字重越界钳位 / 非数字回退
  assert.equal(normalizeEntry({ name: 'x.ttf', weight: 5000 }).weight, 900);
  assert.equal(normalizeEntry({ name: 'x.ttf', weight: 1 }).weight, 100);
  assert.equal(normalizeEntry({ name: 'MyFont-Bold.ttf', weight: 'abc' }).weight, 700);
  // style 只认 italic
  assert.equal(normalizeEntry({ name: 'x.ttf', style: 'oblique' }).style, 'normal');
});

test('mergeFontLibrary: 归一化 / 去重 / 截断', () => {
  assert.deepEqual(mergeFontLibrary(null), { folder: '', folderName: '', files: [] });
  const lib = mergeFontLibrary({
    folder: 'C:/Fonts',
    folderName: 'Fonts',
    files: [
      { name: 'A.ttf', path: 'C:/Fonts/A.ttf' },
      { name: 'A.ttf', path: 'C:/Fonts/A.ttf' },  // 同 id,去重
      { garbage: true },                          // 丢弃
    ],
  });
  assert.equal(lib.folder, 'C:/Fonts');
  assert.equal(lib.folderName, 'Fonts');
  assert.equal(lib.files.length, 1);
  const many = mergeFontLibrary({ files: Array.from({ length: MAX_LIBRARY + 20 }, (_, i) => ({ name: `F${i}.ttf` })) });
  assert.equal(many.files.length, MAX_LIBRARY);
});

test('addEntries / removeBySource / removeFamily / isImportedFamily', () => {
  let lib = mergeFontLibrary(null);
  lib = addEntries(lib, [{ name: 'A-Regular.ttf' }, { name: 'A-Bold.ttf' }]);
  assert.equal(lib.files.length, 2);
  lib = addEntries(lib, [{ name: 'B.otf', src: 'folder', path: 'C:/f/B.otf' }]);
  assert.equal(groupFonts(lib.files).length, 2);
  assert.equal(isImportedFamily(lib, 'a'), true);      // 大小写不敏感
  assert.equal(isImportedFamily(lib, 'A'), true);
  assert.equal(isImportedFamily(lib, 'C'), false);
  assert.equal(isImportedFamily(lib, ''), false);

  assert.equal(removeFamily(lib, 'a').files.length, 1);
  assert.equal(removeFamily(lib, 'A').files[0].name, 'B.otf');
  assert.equal(removeBySource(lib, 'folder').files.length, 2);
  // 不修改原对象
  assert.equal(lib.files.length, 3);
});

test('weightLabel / faceLabel', () => {
  assert.equal(weightLabel(400), '常规');
  assert.equal(weightLabel(700), '粗体');
  assert.equal(weightLabel(900), '黑体');
  assert.equal(weightLabel('x'), '常规');
  assert.equal(faceLabel({ weight: 300, style: 'italic' }), '细体 斜体');
  assert.equal(faceLabel({ weight: 400 }), '常规');
  assert.equal(faceLabel(null), '常规');
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(-1), '');
  assert.equal(formatBytes('x'), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 12), '12 MB');
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
});

test('groupFonts: 按族归并、组内按字重排序', () => {
  const groups = groupFonts([
    { name: 'MyFont-Bold.ttf', size: 100 },
    { name: 'MyFont-Regular.ttf', size: 50 },
    { name: 'Other.otf', size: 200 },
  ]);
  assert.deepEqual(groups.map(g => g.family), ['MyFont', 'Other']);
  assert.deepEqual(groups[0].faces.map(f => f.weight), [400, 700]);
  assert.equal(groups[0].totalSize, 150);
  assert.equal(groups[0].weightText, '常规 / 粗体');
  assert.equal(groups[1].weightText, '常规');
  assert.deepEqual(groupFonts(null), []);
});

test('cssFamilyValue: 引号包裹 + 回退栈', () => {
  assert.equal(cssFamilyValue('', 'var(--font-serif-jp)'), '');
  assert.equal(cssFamilyValue('  ', 'x'), '');
  assert.equal(cssFamilyValue('MyFont', ''), '"MyFont"');
  assert.equal(cssFamilyValue('思源宋体', 'var(--font-serif-jp)'), '"思源宋体", var(--font-serif-jp)');
  // 含空格的族名仍然是一个带引号的整体
  assert.equal(cssFamilyValue('Noto Sans JP', 'serif'), '"Noto Sans JP", serif');
  // 引号被清掉,不会提前闭合字符串
  assert.equal(cssFamilyValue('Bad"A', ''), '"Bad A"');
});
