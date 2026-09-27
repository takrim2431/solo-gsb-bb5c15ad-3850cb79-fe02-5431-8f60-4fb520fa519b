'use strict';

/**
 * 结局保证到达（策略求解 / Guaranteed-Reachability Strategy Synthesis）
 *
 * 作者在编辑页选定一个**无选项的目标结局场景**，并指定一组**环境控制场景**
 * （其余场景由玩家控制），对编辑中的未保存草稿（不落盘）求解：
 * “是否存在玩家策略，使得无论环境如何选择合法选项，都能在有限步内到达目标结局？”
 *
 * 沿用分析器的「场景 + 完整变量状态」具体状态图（选项条件、状态赋值、场景前置
 * 条件语义完全一致；**选项权重不参与判断**），把每个具体状态按所在场景标记为
 * 玩家 / 环境状态，然后用**最小不动点反向扩展**（attractor）求获胜状态集：
 *   - 目标结局的具体状态：直接获胜，层级 0；
 *   - 玩家状态：至少一个后继已获胜 => 获胜，层级 = 1 + 获胜后继的最小层级；
 *   - 环境状态：必须有合法后继、且**全部**后继已获胜 => 获胜，
 *     层级 = 1 + 后继的最大层级（环境可任选合法选项，按最坏情况计）。
 * 非目标死局（没有任何合法选项的状态）永远不胜；只能在循环里无限停留、
 * 无法保证到达目标的状态也不会被纳入获胜集——最小不动点从目标反向生长，
 * 只有“有限步内必达目标”的状态才会进入。
 *
 * 层级（rank）即“保证到达目标所需的步数上界”：从获胜状态出发，玩家每步选择
 * 进入更低层级的推荐选项、环境无论怎么走都进入更低层级，层级严格下降，
 * 因此必然在有限步（不超过起点层级）内到达层级 0 的目标状态。
 *
 * 结论：
 *   - 起点状态获胜 => guaranteed（可以保证）：列出每个获胜玩家状态的变量取值、
 *     推荐选项 UID 与层级（推荐边必然进入更低层级）；
 *   - 起点状态未获胜（完整探索）=> not-guaranteed（无法保证）：附未获胜 /
 *     非目标死局 / 可无限停留状态的计数诊断；
 *   - 起点前置条件不成立 => start-blocked（无法判定）；
 *   - 状态上限截断 => truncated（无法判定：环境状态的“全部后继已获胜”在
 *     未探索区域无法确认，不下任何结论）。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

const STRATEGY_LIST_LIMIT = 500; // 响应中列出的获胜玩家状态条数上限（完整计数仍在 counts 中）

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * 校验查询条件：目标结局必须存在且为无选项场景；
 * 环境控制场景列表必须是数组、无空行、不重复、必须存在，且不得包含目标结局
 */
function normalizeQuery(queryInput, sceneMap) {
  const q = queryInput || {};
  const targetScene = String(q.targetScene == null ? '' : q.targetScene).trim();
  if (!targetScene) throw badRequest('缺少目标结局场景：请选择一个无选项的终止场景作为目标');
  if (!sceneMap.has(targetScene)) throw badRequest(`目标结局场景 "${targetScene}" 不存在`);
  const targetOptions = (sceneMap.get(targetScene).options || []).length;
  if (targetOptions > 0) {
    throw badRequest(`目标结局场景 "${targetScene}" 含有 ${targetOptions} 个选项：目标必须是无选项的终止场景`);
  }
  const raw = q.environmentScenes === undefined ? [] : q.environmentScenes;
  if (!Array.isArray(raw)) throw badRequest('环境控制场景列表必须是场景 ID 数组');
  const environmentScenes = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item == null ? '' : item).trim();
    if (!id) throw badRequest('环境控制场景中存在未选择的空行');
    if (seen.has(id)) throw badRequest(`环境控制场景重复："${id}"`);
    seen.add(id);
    if (!sceneMap.has(id)) throw badRequest(`环境控制场景 "${id}" 不存在`);
    if (id === targetScene) throw badRequest(`目标结局场景 "${id}" 不能同时列为环境控制场景`);
    environmentScenes.push(id);
  }
  return { targetScene, environmentScenes };
}

/**
 * 对剧情（草稿或已保存）求解结局保证到达策略。
 *
 * @param storyInput 剧情对象
 * @param queryInput { targetScene, environmentScenes: [场景ID...] }
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function solveStrategy(storyInput, queryInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法求解保证策略');
  }
  const { targetScene, environmentScenes } = normalizeQuery(queryInput, sceneMap);
  const envSet = new Set(environmentScenes);

  // 编译条件；语法错误按恒真处理（与其余模块一致），记录到 conditionErrors
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const optionCompiled = new Map(); // `${sceneId}#${idx}` -> { cond, assigns }
  for (const scene of sceneMap.values()) {
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      optionCompiled.set(`${scene.id}#${idx}`, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((opt && opt.assigns) || []).filter((a) => a && a.variable),
      });
    });
  }

  const knownVars = collectStateVars({ ...story, scenes });

  // ---- BFS 展开「场景 + 完整变量状态」图（选项权重不参与） ----
  const stateList = [];   // id -> { sceneId, code }
  const idOf = new Map(); // `${sceneId}\x00${code}` -> id
  const succ = [];        // id -> [{ to, optionIndex, optionUid, optionText, target }]
  const queue = [];
  let truncated = false;
  let transitionCount = 0;

  // 返回状态 id；新状态入队（超过上限时置截断且不再入队）
  const offer = (sceneId, code) => {
    const key = `${sceneId}\x00${code}`;
    const known = idOf.get(key);
    if (known !== undefined) return known;
    const id = stateList.length;
    idOf.set(key, id);
    stateList.push({ sceneId, code });
    succ.push([]);
    if (stateList.length > maxStates) { truncated = true; return id; }
    queue.push(id);
    return id;
  };

  // 起点：初始状态 = 起点场景的进入赋值
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  const base = {
    query: {
      targetScene,
      targetTitle: (sceneMap.get(targetScene) || {}).title || '',
      environmentScenes: environmentScenes.map((id) => ({
        sceneId: id,
        title: (sceneMap.get(id) || {}).title || '',
      })),
    },
    startScene: story.startScene,
    knownVars,
    conditionErrors,
    maxStates,
  };
  if (startBlocked) {
    return {
      ...base,
      ok: false,
      status: 'start-blocked',
      startBlocked: true,
      truncated: false,
      start: null,
      counts: {
        states: 0, transitions: 0, variables: knownVars.length,
        playerStates: 0, envStates: 0,
        winningStates: null, winningPlayerStates: null, winningEnvStates: null,
        targetStates: null, losingStates: null, deadendStates: null, loopStates: null,
      },
      strategy: [],
      strategyTotal: 0,
      strategyListed: 0,
      statesExplored: 0,
      message: '无法判定：起点场景的前置条件在初始状态下不成立，剧情无法开始，无法求解保证到达策略。',
    };
  }
  const startId = offer(story.startScene, encodeState(startState, knownVars));

  let head = 0;
  while (head < queue.length && !truncated) {
    const cur = queue[head++];
    const { sceneId, code } = stateList[cur];
    const scene = sceneMap.get(sceneId);
    const state = decodeState(code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated) return;
      const oc = optionCompiled.get(`${sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return; // 条件不成立：此状态下不可走
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;      // 悬空跳转：不构成边
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return;             // 入口前置不成立：不构成边

      const to = offer(targetId, encodeState(nextState, knownVars));
      if (truncated) return;
      succ[cur].push({
        to,
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionText: (option && option.text) || '',
        target: targetId,
      });
      transitionCount++;
    });
  }

  const statesExplored = stateList.length;
  const envStates = stateList.reduce((acc, s) => acc + (envSet.has(s.sceneId) ? 1 : 0), 0);
  const playerStates = statesExplored - envStates;

  // ---- 截断：未探索区域可能改变环境状态的“全部后继已获胜”判定，不下任何结论 ----
  if (truncated) {
    return {
      ...base,
      ok: false,
      status: 'truncated',
      startBlocked: false,
      truncated: true,
      start: null,
      counts: {
        states: statesExplored, transitions: transitionCount, variables: knownVars.length,
        playerStates, envStates,
        winningStates: null, winningPlayerStates: null, winningEnvStates: null,
        targetStates: null, losingStates: null, deadendStates: null, loopStates: null,
      },
      strategy: [],
      strategyTotal: 0,
      strategyListed: 0,
      statesExplored,
      message: `无法判定：具体状态数量超过安全上限（${maxStates}），探索被截断。`
        + '截断后环境状态的“全部后继已获胜”在未探索区域无法确认，不能判定是否可保证到达；请减少变量数量后重试。',
    };
  }

  // ---- 最小不动点反向扩展（attractor）：从目标状态反向生长获胜集 ----
  const n = stateList.length;
  const isEnv = stateList.map((s) => envSet.has(s.sceneId));
  const isTarget = stateList.map((s) => s.sceneId === targetScene);
  // 去重的后继状态集合与前驱表（同一对状态间的多条选项边只计一次）
  const succStates = new Array(n);
  const pred = new Array(n);
  for (let v = 0; v < n; v++) { succStates[v] = []; pred[v] = []; }
  for (let v = 0; v < n; v++) {
    const seen = new Set();
    for (const e of succ[v]) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      succStates[v].push(e.to);
      pred[e.to].push(v);
    }
  }

  const rank = new Array(n).fill(-1);        // -1 = 未获胜；否则为层级（0 = 目标）
  const envRemaining = new Array(n);         // 环境状态尚未确认获胜的后继数
  const envMaxRank = new Array(n).fill(0);   // 环境状态已确认后继中的最大层级
  const worklist = [];
  let targetStates = 0;
  for (let v = 0; v < n; v++) {
    envRemaining[v] = succStates[v].length;
    if (isTarget[v]) {
      rank[v] = 0;
      targetStates++;
      worklist.push(v);
    }
  }
  let whead = 0;
  while (whead < worklist.length) {
    const u = worklist[whead++];
    const ru = rank[u];
    for (const v of pred[u]) {
      if (rank[v] !== -1) continue;
      if (!isEnv[v]) {
        // 玩家状态：存在一个已获胜后继即获胜；按发现顺序层级即最小（队列按层级非减处理）
        rank[v] = ru + 1;
        worklist.push(v);
      } else {
        // 环境状态：全部后继都已获胜才获胜，层级取后继最大层级 + 1
        if (ru > envMaxRank[v]) envMaxRank[v] = ru;
        envRemaining[v]--;
        if (envRemaining[v] === 0) {
          rank[v] = envMaxRank[v] + 1;
          worklist.push(v);
        }
      }
    }
  }

  // ---- 汇总获胜集与推荐策略 ----
  let winningPlayerStates = 0;
  let winningEnvStates = 0;
  let deadendStates = 0; // 非目标且没有任何合法后继的状态（进入即卡死，永远不胜）
  let loopStates = 0;    // 未获胜但有后继的状态（可无限停留 / 仅通向未获胜状态）
  const winning = [];
  for (let v = 0; v < n; v++) {
    if (rank[v] === -1) {
      if (succStates[v].length === 0) deadendStates++;
      else loopStates++;
      continue;
    }
    winning.push(v);
    if (isTarget[v]) continue;
    if (isEnv[v]) winningEnvStates++;
    else winningPlayerStates++;
  }
  const winningStates = winning.length;
  const losingStates = n - winningStates;

  // 获胜玩家状态的推荐：进入最低层级获胜后继的首个选项（层级必然 = 当前层级 - 1）
  const strategyAll = [];
  for (const v of winning) {
    if (isTarget[v] || isEnv[v]) continue;
    let best = null;
    for (const e of succ[v]) {
      if (rank[e.to] === -1) continue;
      if (!best || rank[e.to] < rank[best.to]) best = e;
    }
    if (!best) continue; // 防御：获胜玩家状态必有获胜后继
    const { sceneId, code } = stateList[v];
    strategyAll.push({
      sceneId,
      title: (sceneMap.get(sceneId) || {}).title || '',
      state: decodeState(code, knownVars),
      rank: rank[v],
      recommendation: {
        uid: best.optionUid || `idx:${sceneId}#${best.optionIndex}`,
        optionIndex: best.optionIndex,
        text: best.optionText,
        target: best.target,
        targetTitle: (sceneMap.get(best.target) || {}).title || '',
        targetRank: rank[best.to],
      },
      _code: code, // 仅排序用，输出前删除
    });
  }
  strategyAll.sort((a, b) =>
    (a.rank - b.rank) ||
    (a.sceneId < b.sceneId ? -1 : a.sceneId > b.sceneId ? 1 : 0) ||
    (a._code < b._code ? -1 : a._code > b._code ? 1 : 0));
  const strategyTotal = strategyAll.length;
  const strategy = strategyAll.slice(0, STRATEGY_LIST_LIMIT).map(({ _code, ...rest }) => rest);

  const startWinning = rank[startId] !== -1;
  const status = startWinning ? 'guaranteed' : 'not-guaranteed';
  const start = {
    sceneId: story.startScene,
    state: decodeState(stateList[startId].code, knownVars),
    winning: startWinning,
    rank: startWinning ? rank[startId] : null,
  };

  const counts = {
    states: statesExplored,
    transitions: transitionCount,
    variables: knownVars.length,
    playerStates,
    envStates,
    winningStates,
    winningPlayerStates,
    winningEnvStates,
    targetStates,
    losingStates,
    deadendStates,
    loopStates,
  };

  let message;
  if (status === 'guaranteed') {
    message = `可以保证到达：从起点出发，无论环境如何选择合法选项，玩家按推荐策略都能在有限步内到达目标结局 `
      + `「${base.query.targetTitle || targetScene}」（起点层级 ${start.rank}，即至多 ${start.rank} 步）。`
      + `完整探索 ${statesExplored} 个具体状态，其中 ${winningStates} 个已获胜；`
      + `下列 ${strategyTotal} 个获胜玩家状态的推荐选项均进入更低层级，层级严格下降，不会陷入死局或无限循环。`;
  } else {
    message = `无法保证到达目标结局「${base.query.targetTitle || targetScene}」：从起点状态出发，`
      + '环境存在合法选择使剧情无法在有限步内到达目标（可能进入非目标死局，或在循环中无限停留）。'
      + `已完整探索 ${statesExplored} 个具体状态：获胜 ${winningStates} 个、未获胜 ${losingStates} 个`
      + `（其中非目标死局 ${deadendStates} 个、可无限停留或仅通向未获胜状态 ${loopStates} 个）。`;
  }

  return {
    ...base,
    ok: status === 'guaranteed',
    status,
    startBlocked: false,
    truncated: false,
    start,
    counts,
    strategy,
    strategyTotal,
    strategyListed: strategy.length,
    statesExplored,
    message,
  };
}

module.exports = { solveStrategy, STRATEGY_LIST_LIMIT };
