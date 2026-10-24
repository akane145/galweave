import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile, getParseConf, buildExport } from '../src/parsers.js';
import { createRecordPack, readRecordPack, RECORD_PACK_MAX_BYTES } from '../src/record-pack.js';
import { parseFormat, formatParas, migrateV1ToV2, parseFormatAny } from '../src/offline-formats.js';

function fixture(){
  const rawText = '☆001☆花☆こんにちは\n★001☆花☆你好\n\n☆002☆☆今日は晴れです';
  const parsed = parseFile(rawText);
  parsed.paras[1].translation = '今天晴天';
  parsed.paras[0].pr = { status:'issue', annotations:[{id:'a1',type:'question',text:'语气？',resolved:false,created:1}] };
  return { document:{ name:'test.txt',rawText,paras:parsed.paras,parseConf:getParseConf(),encoding:'utf-8' }, glossary:{names:{花:'小花'},terms:{晴れ:'晴天'},personas:{}}, tm:{version:2,entries:[]}, changes:[], history:[], snippets:{}, settings:{apiKey:'MUST_NOT_EXPORT'}, filePath:'C:/private/test.txt' };
}

test('记录包往返保留原文、译文、批注与术语，不包含设备配置', () => {
  const input = fixture();
  const pack = createRecordPack(input);
  const serialized = JSON.stringify(pack);
  assert.doesNotMatch(serialized, /MUST_NOT_EXPORT|C:\/private/);
  const restored = readRecordPack(serialized);
  assert.equal(restored.parsed.paras[1].translation, '今天晴天');
  assert.equal(restored.parsed.paras[0].pr.annotations[0].text, '语气？');
  assert.equal(restored.pack.glossary.names.花, '小花');
  assert.equal(buildExport(restored.parsed.paras,restored.parsed.nl,restored.parsed.trailingBlank),buildExport(input.document.paras,restored.parsed.nl,restored.parsed.trailingBlank));
});

test('错误版本、原文错行和危险对象键明确拒绝，不改变当前解析配置', () => {
  const before = getParseConf();
  const pack = createRecordPack(fixture());
  assert.throws(() => readRecordPack(JSON.stringify({...pack,version:999})), /版本/);
  pack.document.rows[0].orig = 'wrong row';
  assert.throws(() => readRecordPack(JSON.stringify(pack)), /原文/);
  assert.throws(() => readRecordPack('{"__proto__":{}}'), /字段/);
  assert.deepEqual(getParseConf(), before);
  assert.equal(RECORD_PACK_MAX_BYTES, 64 * 1024 * 1024);
});

test('离线 v1/v2 档案携带完整规则，导出仍只改译文字段', () => {
  const rule = {version:1,name:'样例',source:'JP[{id}] {text}',target:'CN[{id}] {text}',pairing:'id',ignore:['#']};
  const raw = '#meta\nJP[1] 日本語\nCN[1] 旧译\n';
  for (const config of [rule,migrateV1ToV2(rule)]){
    const doc = config.version === 1 ? parseFormat(raw,config) : parseFormatAny(raw,config);
    const paras = formatParas(doc);
    paras[0].translation = '新译';
    const restored = readRecordPack(JSON.stringify(createRecordPack({document:{name:'custom.txt',rawText:raw,paras}})));
    assert.equal(buildExport(restored.parsed.paras,'\n',false),raw.replace('旧译','新译'));
  }
});

test('未通过格式门禁的草稿也能打包，恢复后仍由原导出门禁阻止破坏结构', () => {
  const rule = {version:1,name:'控制符',source:'JP[{id}] {text}',target:'CN[{id}] {text}',pairing:'id',ignore:[]};
  const raw = 'JP[1] 日本語[n]\nCN[1] 中文[n]';
  const paras = formatParas(parseFormat(raw,rule));
  paras[0].translation = '暂时缺少标签的草稿';
  const restored = readRecordPack(JSON.stringify(createRecordPack({document:{name:'draft.txt',rawText:raw,paras}})));
  assert.equal(restored.parsed.paras[0].translation,paras[0].translation);
  assert.throws(() => buildExport(restored.parsed.paras,'\n',false), /控制/);
});
