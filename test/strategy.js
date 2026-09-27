'use strict';

// 结局保证到达（策略求解）自检（node test/strategy.js）
// 覆盖：线性链可保证与推荐层级、环境状态全部后继获胜才可保证、环境可选死局则
//       无法保证、玩家抉择避开死局、环境自环无限停留不算成功、玩家自环可选出口、
//       变量状态并入图（同场景多状态不同层级）、推荐边必进入更低层级、
//       选项权重不参与判断、起点即目标、起点受阻、状态上限截断、目标不可达、
//       参数校验（400）、条件语法错误容错、确定性、HTTP API。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { solveStrategy } = require('../src/strategy');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name, actual, expected) => {
  assert.strictEqual(actual, expected, `${name}（实际 ${JSON.stringify(actual)}）`);
  passed++; console.log(`  ✓ ${name}`);
};
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};
// 校验推荐策略的通用不变量：只含玩家状态、层级非负、推荐边必进入更低层级
const checkStrategyInvariants = (name, r) => {
  for (const entry of r.strategy) {
    ok(`${name}：条目带完整变量状态`, entry.state && typeof entry.state === 'object');
    ok(`${name}：推荐边进入更低层级（${entry.sceneId} 层级 ${entry.rank} -> ${entry.recommendation.targetRank}）`,
      entry.recommendation.targetRank === entry.rank - 1);
    ok(`${name}：推荐带选项 UID`, typeof entry.recommendation.uid === 'string' && entry.recommendation.uid.length > 0);
  }
};

// ---------- 线性链：全玩家场景，可保证到达 ----------
console.log('线性链：可保证到达，层级逐步下降');
const st1 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '前往 b', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', text: '前往结局', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r1 = solveStrategy(st1, { targetScene: 'c', environmentScenes: [] });
eq('结论为可保证', r1.status, 'guaranteed');
ok('ok=true 且未截断', r1.ok === true && r1.truncated === false);
eq('起点层级 = 2（至多 2 步）', r1.start.rank, 2);
eq('完整探索 3 个具体状态', r1.counts.states, 3);
eq('全部状态获胜', r1.counts.winningStates, 3);
eq('目标状态 1 个', r1.counts.targetStates, 1);
eq('获胜玩家状态 2 个', r1.counts.winningPlayerStates, 2);
eq('策略列出全部获胜玩家状态', r1.strategyTotal, 2);
eq('策略按层级排序：b(1) 在前 a(2) 在后',
  r1.strategy.map((e) => `${e.sceneId}:${e.rank}`).join(','), 'b:1,a:2');
eq('b 的推荐选项为 o2', r1.strategy[0].recommendation.uid, 'o2');
eq('a 的推荐选项为 o1', r1.strategy[1].recommendation.uid, 'o1');
eq('a 的推荐目标层级为 1', r1.strategy[1].recommendation.targetRank, 1);
checkStrategyInvariants('线性链', r1);

// ---------- 环境状态：全部后继获胜才可保证 ----------
console.log('环境状态：全部合法后继都获胜 => 仍可保证');
const st2 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'e' }] },
    { id: 'e', options: [ // 环境控制：两个合法选项都最终通向结局
      { uid: 'o2', text: '环境走 b', target: 'b' },
      { uid: 'o3', text: '环境直奔结局', target: 'c' },
    ] },
    { id: 'b', options: [{ uid: 'o4', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r2 = solveStrategy(st2, { targetScene: 'c', environmentScenes: ['e'] });
eq('结论为可保证', r2.status, 'guaranteed');
eq('环境状态层级 = 1 + 后继最大层级（max(1,0)+1=2）', r2.counts.winningEnvStates, 1);
eq('起点层级 = 3', r2.start.rank, 3);
eq('策略只含玩家状态（b 与 a）', r2.strategyTotal, 2);
ok('策略不含环境场景 e', r2.strategy.every((e) => e.sceneId !== 'e'));
checkStrategyInvariants('环境全获胜', r2);

// ---------- 环境可选死局：无法保证 ----------
console.log('环境状态：存在一个通向死局的合法选项 => 无法保证');
const st3 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'e' }] },
    { id: 'e', options: [ // 环境控制：可以选结局，也可以选死局
      { uid: 'o2', text: '环境放行', target: 'c' },
      { uid: 'o3', text: '环境使坏', target: 'd' },
    ] },
    { id: 'd', options: [{ uid: 'o4', condition: 'x', target: 'c' }] }, // x 恒 false：死局
    { id: 'c', options: [] },
  ],
};
const r3 = solveStrategy(st3, { targetScene: 'c', environmentScenes: ['e'] });
eq('结论为无法保证', r3.status, 'not-guaranteed');
ok('ok=false', r3.ok === false);
eq('起点未获胜', r3.start.winning, false);
eq('起点层级为 null', r3.start.rank, null);
ok('非目标死局状态被统计（d）', r3.counts.deadendStates >= 1);
ok('未获胜状态 = 死局 + 仅通向未获胜的环境/起点状态', r3.counts.losingStates >= 3);
ok('失败文案明确', /无法保证/.test(r3.message) && /非目标死局/.test(r3.message));
eq('失败时不给策略', r3.strategyTotal, 0);

// ---------- 玩家抉择：避开死局选活路 => 可保证，推荐活路 ----------
console.log('玩家状态：至少一个后继获胜即可，推荐进入更低层级');
const st4 = {
  startScene: 'a',
  variables: ['x'],
  scenes: [
    { id: 'a', options: [
      { uid: 'oBad', text: '走向死局', target: 'd' },
      { uid: 'oGood', text: '走向活路', target: 'b' },
    ] },
    { id: 'd', options: [{ uid: 'oD', condition: 'x', target: 'c' }] }, // 死局
    { id: 'b', options: [{ uid: 'o2', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r4 = solveStrategy(st4, { targetScene: 'c', environmentScenes: [] });
eq('结论为可保证', r4.status, 'guaranteed');
eq('起点层级 = 2', r4.start.rank, 2);
const recA = r4.strategy.find((e) => e.sceneId === 'a');
eq('起点推荐避开死局的选项', recA.recommendation.uid, 'oGood');
eq('推荐目标层级 = 1', recA.recommendation.targetRank, 1);
ok('死局状态不计入获胜（d 未获胜）', r4.counts.deadendStates === 1 && r4.counts.losingStates === 1);
checkStrategyInvariants('玩家抉择', r4);

// ---------- 环境自环：可无限停留 => 无法保证 ----------
console.log('环境自环：可无限停留的循环不算成功');
const st5 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'e' }] },
    { id: 'e', options: [ // 环境控制：可以永远打转，也可以放行
      { uid: 'oLoop', text: '原地打转', target: 'e' },
      { uid: 'oExit', text: '放行到结局', target: 'c' },
    ] },
    { id: 'c', options: [] },
  ],
};
const r5 = solveStrategy(st5, { targetScene: 'c', environmentScenes: ['e'] });
eq('环境可无限停留 => 无法保证', r5.status, 'not-guaranteed');
ok('可无限停留状态被统计', r5.counts.loopStates >= 1);
ok('失败文案提到无限停留', /无限停留/.test(r5.message));

// 对照：同样的自环在玩家手里 => 可保证（玩家选出口），推荐出口
const r5b = solveStrategy(st5, { targetScene: 'c', environmentScenes: [] });
eq('玩家控制自环 => 可保证', r5b.status, 'guaranteed');
const recE = r5b.strategy.find((e) => e.sceneId === 'e');
eq('玩家自环状态推荐出口选项', recE.recommendation.uid, 'oExit');
eq('自环状态层级 = 1', recE.rank, 1);
checkStrategyInvariants('玩家自环', r5b);

// ---------- 变量状态并入图：同场景多状态、层级不同 ----------
console.log('变量状态并入图：同场景多状态分别求解');
const st6 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', options: [
      { uid: 'oTake', text: '带上钥匙', target: 'b', assigns: [{ variable: 'k', value: true }] },
      { uid: 'oSkip', text: '空手上路', target: 'b' },
    ] },
    { id: 'b', options: [
      { uid: 'oOpen', text: '开门进结局', condition: 'k', target: 'c' },
      { uid: 'oBack', text: '返回村口', condition: '!k', target: 'a' },
    ] },
    { id: 'c', options: [] },
  ],
};
const r6 = solveStrategy(st6, { targetScene: 'c', environmentScenes: [] });
eq('结论为可保证', r6.status, 'guaranteed');
eq('起点层级 = 2（带钥匙 -> 开门）', r6.start.rank, 2);
eq('探索 4 个具体状态（a/b 各两种变量取值中可达的 3 个 + 结局）', r6.counts.states, 4);
const recA6 = r6.strategy.find((e) => e.sceneId === 'a');
eq('起点推荐带钥匙', recA6.recommendation.uid, 'oTake');
const bFalse = r6.strategy.find((e) => e.sceneId === 'b' && e.state.k === false);
ok('b 的 k=false 状态也被列出', !!bFalse);
eq('k=false 时推荐返回村口', bFalse.recommendation.uid, 'oBack');
eq('k=false 状态层级 = 3（绕一圈再带钥匙）', bFalse.rank, 3);
const bTrue = r6.strategy.find((e) => e.sceneId === 'b' && e.state.k === true);
eq('k=true 时推荐开门', bTrue.recommendation.uid, 'oOpen');
eq('k=true 状态层级 = 1', bTrue.rank, 1);
checkStrategyInvariants('变量状态', r6);

// ---------- 环境 + 变量：环境状态按最坏情况 ----------
console.log('环境状态与变量条件：环境可挑当前合法的任意选项');
const st7 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'e', assigns: [{ variable: 'k', value: true }] }] },
    { id: 'e', options: [ // 环境控制：k=true 时两个都合法
      { uid: 'o2', condition: 'k', target: 'c' },
      { uid: 'o3', condition: 'k', target: 'd' },
    ] },
    { id: 'd', options: [{ uid: 'o4', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r7 = solveStrategy(st7, { targetScene: 'c', environmentScenes: ['e'] });
eq('两条路都通 => 可保证', r7.status, 'guaranteed');
eq('起点层级 = 3（环境最坏走 d）', r7.start.rank, 3);
// 把 o3 的目标换成死局 => 环境可置败
const st7b = JSON.parse(JSON.stringify(st7));
st7b.scenes.find((s) => s.id === 'd').options = [];
const r7b = solveStrategy(st7b, { targetScene: 'c', environmentScenes: ['e'] });
eq('环境有一条死路 => 无法保证', r7b.status, 'not-guaranteed');

// ---------- 起点即目标：层级 0 直接可保证 ----------
console.log('起点即目标结局');
const st8 = { startScene: 'c', scenes: [{ id: 'c', options: [] }] };
const r8 = solveStrategy(st8, { targetScene: 'c', environmentScenes: [] });
eq('起点即目标 => 可保证', r8.status, 'guaranteed');
eq('起点层级 = 0', r8.start.rank, 0);
eq('无获胜玩家状态需要推荐', r8.strategyTotal, 0);

// ---------- 起点受阻：无法判定 ----------
console.log('起点受阻');
const st9 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', precondition: 'k', options: [{ uid: 'o1', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const r9 = solveStrategy(st9, { targetScene: 'c', environmentScenes: [] });
eq('起点受阻状态', r9.status, 'start-blocked');
ok('startBlocked 标记且不通过', r9.startBlocked === true && r9.ok === false);
ok('文案为无法判定', /无法判定/.test(r9.message));

// ---------- 状态上限截断：无法判定 ----------
console.log('状态上限截断');
const r10 = solveStrategy(st6, { targetScene: 'c', environmentScenes: [] }, { maxStates: 2 });
eq('截断状态', r10.status, 'truncated');
ok('截断标记且不通过', r10.truncated === true && r10.ok === false);
ok('截断后不下结论（获胜计数为 null）', r10.counts.winningStates === null);
ok('截断文案明确', /截断/.test(r10.message) && /不能判定/.test(r10.message));

// ---------- 目标不可达：完整探索后明确无法保证 ----------
console.log('目标不可达');
const st11 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'a' }] }, // 原地自环
    { id: 'c', options: [] },                            // 孤岛结局
  ],
};
const r11 = solveStrategy(st11, { targetScene: 'c', environmentScenes: [] });
eq('目标不可达 => 无法保证', r11.status, 'not-guaranteed');
eq('目标状态 0 个', r11.counts.targetStates, 0);
eq('获胜状态 0 个', r11.counts.winningStates, 0);

// ---------- 选项权重不参与判断 ----------
console.log('选项权重不参与判断');
const st12a = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [
      { uid: 'o1', target: 'c', weight: 1 },
      { uid: 'o2', target: 'b', weight: 99 },
    ] },
    { id: 'b', options: [{ uid: 'o3', target: 'c', weight: 7 }] },
    { id: 'c', options: [] },
  ],
};
const st12b = JSON.parse(JSON.stringify(st12a));
st12b.scenes[0].options[0].weight = 50;
st12b.scenes[0].options[1].weight = 1;
st12b.scenes[1].options[0].weight = 3;
const r12a = solveStrategy(st12a, { targetScene: 'c', environmentScenes: ['b'] });
const r12b = solveStrategy(st12b, { targetScene: 'c', environmentScenes: ['b'] });
eq('权重不同结果完全一致', JSON.stringify(r12a), JSON.stringify(r12b));
eq('带权重的剧情同样可求解', r12a.status, 'guaranteed');

// ---------- 参数校验 ----------
console.log('参数校验');
ok('缺 query => 400', throws400(() => solveStrategy(st1), /目标结局/));
ok('空 query => 400', throws400(() => solveStrategy(st1, {}), /目标结局/));
ok('目标场景不存在 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 'ghost' }), /不存在/));
ok('目标场景含选项 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 'a' }), /无选项/));
ok('环境列表非数组 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 'c', environmentScenes: 'e' }), /数组/));
ok('环境场景不存在 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 'c', environmentScenes: ['ghost'] }), /不存在/));
ok('环境场景重复 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 'c', environmentScenes: ['a', 'a'] }), /重复/));
ok('环境场景空行 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 'c', environmentScenes: [''] }), /空行/));
ok('目标同时列为环境场景 => 400',
  throws400(() => solveStrategy(st1, { targetScene: 'c', environmentScenes: ['c'] }), /不能同时/));
ok('环境列表可省略（默认全玩家）',
  solveStrategy(st1, { targetScene: 'c' }).status === 'guaranteed');
ok('缺起点 => 400',
  throws400(() => solveStrategy({ scenes: [{ id: 'a' }] }, { targetScene: 'a' }), /起点/));
ok('起点不存在 => 400',
  throws400(() => solveStrategy({ startScene: 'ghost', scenes: [{ id: 'a', options: [] }] },
    { targetScene: 'a' }), /起点/));

// ---------- 条件语法错误容错（按恒真处理） ----------
console.log('条件语法错误容错');
const stBad = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', condition: 'x &&', target: 'c' }] },
    { id: 'c', options: [] },
  ],
};
const rBad = solveStrategy(stBad, { targetScene: 'c', environmentScenes: [] });
eq('语法错误按恒真处理：路线可走并可保证', rBad.status, 'guaranteed');
eq('记录 1 处条件语法错误', rBad.conditionErrors.length, 1);

// ---------- 确定性：同一剧情两次结果完全一致 ----------
console.log('确定性');
eq('同一剧情两次求解结果一致',
  JSON.stringify(solveStrategy(st6, { targetScene: 'c', environmentScenes: [] })),
  JSON.stringify(solveStrategy(st6, { targetScene: 'c', environmentScenes: [] })));

// ---------- 示例剧情：可正常运行并返回结构化结果 ----------
console.log('示例剧情');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rDemo = solveStrategy(demo, { targetScene: 'dungeon', environmentScenes: ['forest'] });
eq('示例中不可达的无选项场景 => 无法保证', rDemo.status, 'not-guaranteed');
ok('示例剧情求解返回结构化计数', rDemo.counts.states > 0 && rDemo.counts.transitions > 0);
ok('示例中含选项的场景不能作为目标（400）',
  throws400(() => solveStrategy(demo, { targetScene: 'ending' }), /无选项/));

// ---------- HTTP API ----------
(async () => {
  console.log('HTTP API：');
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const req = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let data = '';
      res.on('data', (x) => { data += x; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    // 草稿求解（不落盘）
    const p1 = await req('POST', '/api/strategy', { story: st1, query: { targetScene: 'c', environmentScenes: [] } });
    ok('POST /api/strategy 返回 200 且可保证',
      p1.status === 200 && p1.body.status === 'guaranteed' && p1.body.start.rank === 2);

    const p1b = await req('POST', '/api/strategy', { story: st3, query: { targetScene: 'c', environmentScenes: ['e'] } });
    ok('无法保证剧情返回 not-guaranteed',
      p1b.status === 200 && p1b.body.status === 'not-guaranteed' && p1b.body.ok === false);

    const p1c = await req('POST', '/api/strategy', { story: st1, query: { targetScene: 'a' } });
    ok('目标含选项返回 400', p1c.status === 400 && /无选项/.test(p1c.body.error || ''));

    const p1d = await req('POST', '/api/strategy', { story: st1, query: { targetScene: 'ghost' } });
    ok('目标不存在返回 400', p1d.status === 400);

    const p1e = await req('POST', '/api/strategy', { story: st1 });
    ok('缺查询条件返回 400', p1e.status === 400 && /目标结局/.test(p1e.body.error || ''));

    const p1f = await req('POST', '/api/strategy', { story: st1, query: { targetScene: 'c', environmentScenes: ['c'] } });
    ok('目标同时列为环境场景返回 400', p1f.status === 400 && /不能同时/.test(p1f.body.error || ''));

    // 截断参数注入
    const p1t = await req('POST', '/api/strategy', { story: st6, query: { targetScene: 'c' }, maxStates: 2 });
    ok('maxStates 注入生效：截断且无法判定',
      p1t.status === 200 && p1t.body.status === 'truncated' && p1t.body.truncated === true);

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', st2);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const p2 = await req('POST', `/api/stories/${sid}/strategy`, { targetScene: 'c', environmentScenes: ['e'] });
    ok('POST /api/stories/:id/strategy（query 直接作请求体）可保证',
      p2.status === 200 && p2.body.status === 'guaranteed');
    const p2b = await req('POST', `/api/stories/${sid}/strategy`, { query: { targetScene: 'c', environmentScenes: ['e'] } });
    ok('POST /api/stories/:id/strategy 接受 { query } 包装',
      p2b.status === 200 && p2b.body.status === 'guaranteed');
    const p3 = await req('POST', '/api/stories/no-such-id/strategy', { targetScene: 'c' });
    ok('剧情不存在返回 404', p3.status === 404);

    // 草稿求解不落盘：已保存剧情内容不因求解而改变
    const after = await req('GET', `/api/stories/${sid}`);
    ok('求解后剧情内容未被修改',
      JSON.stringify(after.body.scenes) === JSON.stringify(created.body.scenes));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项结局保证到达断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
