import test from 'node:test';
import assert from 'node:assert/strict';
import { makePara } from '../src/parsers.js';
import { buildCase, caseMarkdown, normalizeSource, obsidianUri, resolveChangeRow, snapshotChange } from '../src/obsidian.js';
import { createDirectoryNote } from '../src/obsidian-files.js';

const paras = () => [makePara('☆0000☆☆雨が降っている。', '下雨了。'), makePara('☆0001☆紬☆「待ってた？」', '「当前的另一种译法」'), makePara('☆0002☆☆彼女は笑った。', '她笑了。')];
const change = p => ({ id: 'c_123_abc', paraId: p[1].orig, line: 2, field: 'translation', before: '「等了吗？」', after: '「你在等我？」', at: 123, source: 'edit' });
const opts = p => ({ paras: p, change: change(p), document: 'E:\\game\\common.ks', filename: 'common.ks', project: '作品A', route: '共通线' });
test('收藏记录使用选定历史改译、保留批注语境，但不把批注当作心得或自动确认', async () => {
  const p = paras(); p[1].pr = { status: 'approved', annotations: [{ type: 'question', text: '主语是谁？', resolved: true }] };
  const record = await buildCase(opts(p));
  assert.equal(record.before, '「等了吗？」'); assert.equal(record.after, '「你在等我？」');
  assert.equal(record.original, '「待ってた？」'); assert.equal(record.character, '紬');
  assert.equal(record.note, ''); assert.equal(record.status, 'pending');
  assert.match(record.context, /主语是谁/); assert.match(record.context, /雨が降っている/);
  assert.match(record.context, /不是源脚本物理行号/); assert.match(record.context, /c_123_abc/);
});
test('同一次修改稳定去重，不同文档、修改事件和浏览器项目互相隔离', async () => {
  const p = paras(); const a = await buildCase(opts(p));
  const b = await buildCase({ ...opts(p), document: 'e:/GAME/common.ks', project: '重命名作品', note: '新心得' });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, (await buildCase({ ...opts(p), document: 'E:/other/common.ks' })).id);
  assert.notEqual(a.id, (await buildCase({ ...opts(p), change: { ...change(p), id: 'c_other' } })).id);
  const browser = { ...opts(p), document: 'common.ks' };
  assert.notEqual((await buildCase(browser)).id, (await buildCase({ ...browser, project: '作品B' })).id);
  assert.equal(normalizeSource('E:\\game\\common.ks'), 'e:/game/common.ks');
});
test('重复原文优先按记录位置匹配，位置失效且存在歧义时拒绝猜测', () => {
  const p = paras(); p.push({ ...p[1] });
  assert.equal(resolveChangeRow(change(p), p), 1);
  assert.throws(() => resolveChangeRow({ ...change(p), line: 100 }, p), /多处/);
  assert.throws(() => resolveChangeRow({ ...change(p), paraId: '已移除' }, p), /不在/);
});
test('Markdown 围栏不受原文中的反引号或伪章节影响，URI 正确编码中文、空格和特殊字符', async () => {
  const p = paras(); const record = await buildCase({ ...opts(p), note: '```\n## 我的心得\n测试 # & %' });
  const md = caseMarkdown(record); assert.match(md, /galnote: 1/); assert.match(md, /````text\n```/);
  assert.equal(new URL(obsidianUri('E:/库 名/#&%.md')).searchParams.get('path'), 'E:/库 名/#&%.md');
  assert.throws(() => caseMarkdown({ ...record, project: '' }), /作品/);
  assert.throws(() => caseMarkdown({ ...record, tags: ['a'.repeat(41)] }), /标签/);
});
test('大文档只冻结相邻段落，保留原段落位置、稳定标识及历史译文', async () => {
  const p = Array.from({length:10000},(_,i) => makePara(`☆${i}☆☆原文${i}`,`译文${i}`));
  const c = { ...change(p), paraId:p[9000].orig, line:9001 };
  const snapshot = snapshotChange(p,c);
  assert.equal(snapshot.paras.length,5);
  const full = await buildCase({ ...opts(p), change:c });
  p[9000].content = '不应污染快照';
  const frozen = await buildCase({ ...opts(p), ...snapshot });
  assert.equal(frozen.id,full.id); assert.equal(frozen.original,'原文9000');
  assert.match(frozen.location,/9001/); assert.match(frozen.context,/【当前段落】 第 9001 段/);
});
test('浏览器已存在笔记不打开写流；失败空壳清理后可重试', async () => {
  const files = new Map(); let writes = 0, fail = false;
  const missing = () => Object.assign(new Error('missing'),{name:'NotFoundError'});
  const cases = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) { if(!options.create) throw missing(); files.set(name,''); }
      return {
        async getFile(){return {size:files.get(name).length};},
        async createWritable(){ let text=''; return {async write(value){writes++;if(fail) throw new Error('disk full');text=value;},async close(){files.set(name,text);},async abort(){}};},
      };
    },
    async removeEntry(name){files.delete(name);},
  };
  const vault = {async getDirectoryHandle(name){if(name === '.obsidian') return {};return cases;}};
  const id='01234567-89ab-8def-8123-456789abcdef';
  assert.equal((await createDirectoryNote(vault,id,'original')).created,true);
  files.set(id+'.md','用户新心得'); assert.equal((await createDirectoryNote(vault,id,'overwrite')).created,false);
  assert.equal(writes,1);assert.equal(files.get(id+'.md'),'用户新心得');
  files.clear();fail=true;await assert.rejects(createDirectoryNote(vault,id,'new'),/disk full/);assert.equal(files.size,0);
  fail=false;assert.equal((await createDirectoryNote(vault,id,'retry')).created,true);
});
