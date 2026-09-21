/**
 * 搭建波次交接：纯领域逻辑（不依赖 React/DOM，可直接测试）。
 *
 * 关键边界：
 * - 冻结（freezePlan）只对当前方案做深拷贝快照；之后方案怎么改都不会影响计划。
 * - 现场记录（arrive/stage/install/move/measure/remove）只追加事件并更新实测占地，
 *   每次都按【当时真实平面】重算检查，把结论快照进事件——计划与实际的差异证据。
 * - 临时改线（改几何、改波次、删未搭项、加临时堆放的计划位）只能动 status=pending
 *   且所在波次未关闭的对象；已完成波次与已到场对象不会被当前布局覆盖。
 * - 关闭后的波次只接受“迟到检查回执”，进入待核对区，不回写任何现场事实。
 */
import type {
  Booth,
  BuildEvent,
  BuildPlan,
  Handover,
  ItemDiff,
  ItemStatus,
  LateCheck,
  PlannedItem,
  Wave,
  WaveCheck,
  WaveCompareRow,
} from '../types';
import { analyzePlan } from './validation';
import { nextId } from './id';

/* ============================== 工具 ============================== */

export interface Clock {
  now(): string;
}

const iso: Clock = { now: () => new Date().toISOString() };

export interface OpResult {
  ok: boolean;
  plan: BuildPlan;
  error?: string;
}

function ok(plan: BuildPlan): OpResult {
  return { ok: true, plan };
}
function fail(plan: BuildPlan, error: string): OpResult {
  return { ok: false, plan, error };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 现场对象在平面上的真实占地：实测优先，否则按计划占位；id 统一为 item.id。 */
export function effectiveBooth(item: PlannedItem): Booth {
  const b = item.actual ?? item.plan;
  return { ...b, id: item.id };
}

/** 在场对象：已安装物 + 到场暂存物（撤场/未到场不在平面上）。 */
export function floorBooths(items: PlannedItem[]): {
  installed: Booth[];
  staging: Booth[];
  presentIds: string[];
} {
  const installed: Booth[] = [];
  const staging: Booth[] = [];
  const presentIds: string[] = [];
  for (const it of items) {
    if (it.status === 'installed') {
      installed.push(effectiveBooth(it));
      presentIds.push(it.id);
    } else if (it.status === 'staging') {
      staging.push(effectiveBooth(it));
      presentIds.push(it.id);
    }
  }
  return { installed, staging, presentIds };
}

/** 按当时真实平面重算检查（重叠/净空/出口封堵/疏散路径全部重算）。 */
export function checkFloor(
  items: PlannedItem[],
  crew: string,
  at: string = iso.now(),
): WaveCheck {
  const { installed, staging, presentIds } = floorBooths(items);
  const r = analyzePlan(installed, { extraObstacles: staging });
  return {
    at,
    crew,
    presentIds,
    alerts: r.alerts,
    paths: r.paths,
    blockedExitIds: r.blockedExitIds,
    alertCount: r.alerts.length,
    ok: r.alerts.length === 0,
  };
}

/**
 * 计划推演：假设第 upToWave 波（含）之前的对象都按【计划位】安装完毕，
 * 后续波次尚未进场。用于冻结后的分波预演（不修改任何现场事实）。
 */
export function plannedCheck(
  plan: BuildPlan,
  upToWave: number,
  crew: string,
  at: string = iso.now(),
): WaveCheck {
  const installed = plan.items
    .filter((it) => it.wave > 0 && it.wave <= upToWave)
    .map((it) => ({ ...it.plan, id: it.id }));
  const r = analyzePlan(installed);
  return {
    at,
    crew,
    presentIds: installed.map((b) => b.id),
    alerts: r.alerts,
    paths: r.paths,
    blockedExitIds: r.blockedExitIds,
    alertCount: r.alerts.length,
    ok: r.alerts.length === 0,
  };
}

/* ============================== 冻结 ============================== */

export interface FreezeOptions {
  name?: string;
  at?: string;
  crew?: string;
  /** 预建波次数（默认 2：围挡第 1 波、展位第 2 波） */
  waves?: number;
}

/**
 * 从当前方案冻结一份搭建计划：深拷贝全部展位/围挡，几何之后不再受方案编辑影响。
 * 默认围挡第 1 波、普通展位第 2 波；现场新增的临时堆放在记录时指定波次。
 */
export function freezePlan(booths: Booth[], opts: FreezeOptions = {}): BuildPlan {
  const at = opts.at ?? iso.now();
  const waveCount = Math.max(1, opts.waves ?? 2);
  const waves: Wave[] = [];
  for (let i = 1; i <= waveCount; i++) {
    waves.push({
      index: i,
      name: `第 ${i} 波`,
      status: 'open',
      createdAt: at,
    });
  }
  const items: PlannedItem[] = booths.map((b) => ({
    id: nextId('item'),
    sourceBoothId: b.id,
    plan: clone(b),
    status: 'pending' as ItemStatus,
    // 围挡先进场，普通展位第二波；只有一波时全部进第 1 波。
    wave: waveCount === 1 ? 1 : b.kind === 'partition' ? 1 : 2,
  }));
  return {
    id: nextId('build'),
    name: opts.name ?? `搭建计划 ${at.slice(0, 10)}`,
    frozenAt: at,
    frozenBooths: clone(booths),
    items,
    waves,
    events: [],
    handovers: [],
    lateChecks: [],
    crew: opts.crew ?? '甲班',
  };
}

/* ============================== 波次管理 ============================== */

export function addWave(
  plan: BuildPlan,
  name?: string,
  at: string = iso.now(),
): BuildPlan {
  const index = plan.waves.length + 1;
  return {
    ...plan,
    waves: [
      ...plan.waves,
      { index, name: name ?? `第 ${index} 波`, status: 'open', createdAt: at },
    ],
  };
}

export function renameWave(
  plan: BuildPlan,
  index: number,
  name: string,
): BuildPlan {
  return {
    ...plan,
    waves: plan.waves.map((w) =>
      w.index === index ? { ...w, name } : w,
    ),
  };
}

/** 提前关闭波次：按当时真实平面留下最终检查证据。未装完也允许关闭。 */
export function closeWave(
  plan: BuildPlan,
  index: number,
  at: string = iso.now(),
): OpResult {
  const wave = plan.waves.find((w) => w.index === index);
  if (!wave) return fail(plan, `没有第 ${index} 波`);
  if (wave.status === 'closed') return fail(plan, '该波次已关闭');
  const check = checkFloor(plan.items, plan.crew, at);
  const next: BuildPlan = {
    ...plan,
    waves: plan.waves.map((w) =>
      w.index === index
        ? { ...w, status: 'closed', closedAt: at, lastCheck: check }
        : w,
    ),
    events: [
      ...plan.events,
      makeEvent(plan, '', 'check', at, check, `第 ${index} 波关闭前检查`),
    ],
  };
  return ok(next);
}

/**
 * 局部重演 / 刷新检查：按当前真实平面给指定波次重新检查一遍。
 * - 波次开放：作为 check 事件留证并刷新该波 lastCheck；
 * - 波次已关闭：不回写事实，回执进入待核对区。
 */
export function rerunWaveCheck(
  plan: BuildPlan,
  index: number,
  at: string = iso.now(),
): OpResult {
  const wave = plan.waves.find((w) => w.index === index);
  if (!wave) return fail(plan, `没有第 ${index} 波`);
  const check = checkFloor(plan.items, plan.crew, at);
  if (wave.status === 'closed') {
    const receipt: LateCheck = {
      id: nextId('late'),
      waveIndex: index,
      at,
      crew: plan.crew,
      check,
      resolution: 'pending',
    };
    return ok({ ...plan, lateChecks: [...plan.lateChecks, receipt] });
  }
  return ok({
    ...plan,
    waves: plan.waves.map((w) =>
      w.index === index ? { ...w, lastCheck: check } : w,
    ),
    events: [
      ...plan.events,
      makeEvent(plan, '', 'check', at, check, `第 ${index} 波现场复查（重演）`),
    ],
  });
}

/* ============================== 班组交接 ============================== */

export function handover(
  plan: BuildPlan,
  to: string,
  note: string,
  at: string = iso.now(),
): OpResult {
  const toName = to.trim();
  if (!toName) return fail(plan, '接班班组不能为空');
  if (toName === plan.crew) return fail(plan, '接班班组与当前班组相同');
  const record: Handover = {
    id: nextId('hnd'),
    at,
    from: plan.crew,
    to: toName,
    note: note.trim(),
  };
  return ok({
    ...plan,
    crew: toName,
    handovers: [...plan.handovers, record],
  });
}

/* ============================== 计划改线（仅未执行） ============================== */

function pendingItem(plan: BuildPlan, itemId: string): PlannedItem | null {
  const it = plan.items.find((x) => x.id === itemId);
  return it ?? null;
}

/** 改线前置校验：对象必须仍是 pending 且所在波次仍开放。 */
function replanGuard(plan: BuildPlan, itemId: string): OpResult | null {
  const it = pendingItem(plan, itemId);
  if (!it) return fail(plan, '对象不存在');
  if (it.status !== 'pending')
    return fail(plan, `「${it.plan.label}」已到场/安装，临时改线只能调整尚未执行的安排`);
  if (it.wave <= 0) return fail(plan, '请先把该对象分配到波次');
  const wave = plan.waves.find((w) => w.index === it.wave);
  if (!wave || wave.status === 'closed')
    return fail(plan, `第 ${it.wave} 波已关闭，已完成波次不能被当前布局覆盖`);
  return null;
}

/** 修改计划几何（位置/尺寸）。只允许 pending + 开放波次。 */
export function replanItemGeometry(
  plan: BuildPlan,
  itemId: string,
  patch: Partial<Pick<Booth, 'x' | 'y' | 'w' | 'h' | 'rotation'>>,
): OpResult {
  const guarded = replanGuard(plan, itemId);
  if (guarded) return guarded;
  return {
    ok: true,
    plan: {
      ...plan,
      items: plan.items.map((it) =>
        it.id === itemId ? { ...it, plan: { ...it.plan, ...patch } } : it,
      ),
    },
  };
}

/** 调整波次归属：只有未执行的对象能改，且目标波次必须开放。 */
export function assignItemWave(
  plan: BuildPlan,
  itemId: string,
  wave: number,
): OpResult {
  const guarded = replanGuard(plan, itemId);
  if (guarded) return guarded;
  const target = plan.waves.find((w) => w.index === wave);
  if (!target) return fail(plan, `没有第 ${wave} 波`);
  if (target.status === 'closed')
    return fail(plan, `第 ${wave} 波已关闭，不能再并入对象`);
  return {
    ok: true,
    plan: {
      ...plan,
      items: plan.items.map((it) =>
        it.id === itemId ? { ...it, wave } : it,
      ),
    },
  };
}

/** 删除一个尚未执行的计划对象。 */
export function removePendingItem(plan: BuildPlan, itemId: string): OpResult {
  const guarded = replanGuard(plan, itemId);
  if (guarded) return guarded;
  return {
    ok: true,
    plan: { ...plan, items: plan.items.filter((it) => it.id !== itemId) },
  };
}

let storageSeq = 0;

/** 新建一块临时堆放的计划条目（pending，尚未进场）。 */
export function addStorageItem(
  plan: BuildPlan,
  wave: number,
  spot: Partial<Booth> & { x: number; y: number },
  at: string = iso.now(),
): OpResult {
  const target = plan.waves.find((w) => w.index === wave);
  if (!target) return fail(plan, `没有第 ${wave} 波`);
  if (target.status === 'closed')
    return fail(plan, `第 ${wave} 波已关闭，不能再加入临时堆放`);
  storageSeq += 1;
  const booth: Booth = {
    id: nextId('storage'),
    x: spot.x,
    y: spot.y,
    w: spot.w ?? 2,
    h: spot.h ?? 2,
    rotation: spot.rotation ?? 0,
    orientation: 'south',
    label: spot.label ?? `临时堆放 ${storageSeq}`,
    color: spot.color ?? '#d97706',
    kind: 'storage',
  };
  const item: PlannedItem = {
    id: nextId('item'),
    plan: booth,
    status: 'pending',
    wave,
  };
  void at;
  return ok({ ...plan, items: [...plan.items, item] });
}

/* ============================== 现场记录 ============================== */

export type RecordAction =
  | 'arrive'
  | 'stage'
  | 'install'
  | 'move'
  | 'measure'
  | 'remove';

export interface RecordParams {
  itemId: string;
  action: RecordAction;
  /** stage/move/measure 携带的实测或暂存占地 */
  footprint?: Booth;
  at?: string;
}

const ACTION_TEXT: Record<RecordAction, string> = {
  arrive: '到场',
  stage: '暂存',
  install: '安装',
  move: '移位',
  measure: '实测占地',
  remove: '撤场',
};

const STATUS_LABEL: Record<ItemStatus, string> = {
  pending: '未到场',
  arrived: '已到场',
  staging: '暂存中',
  installed: '已安装',
  removed: '已撤场',
};

export function statusLabel(s: ItemStatus): string {
  return STATUS_LABEL[s];
}

function makeEvent(
  plan: BuildPlan,
  itemId: string,
  type: BuildEvent['type'],
  at: string,
  snapshot: WaveCheck,
  note?: string,
): BuildEvent {
  return {
    id: nextId('evt'),
    at,
    crew: plan.crew,
    itemId,
    type,
    snapshot,
    ...(note ? { note } : {}),
  };
}

/**
 * 记录一条现场事件。返回新计划（不可变更新）；不满足状态/波次边界时返回错误。
 * 每次成功记录都会按记录后的真实平面重算检查，快照随事件留存。
 */
export function recordEvent(plan: BuildPlan, params: RecordParams): OpResult {
  const at = params.at ?? iso.now();
  const item = plan.items.find((x) => x.id === params.itemId);
  if (!item) return fail(plan, '对象不存在');
  const wave = plan.waves.find((w) => w.index === item.wave);
  if (!wave) return fail(plan, `「${item.plan.label}」尚未分配波次`);
  if (wave.status === 'closed')
    return fail(plan, `第 ${item.wave} 波已关闭，现场记录请走“迟到检查回执”`);

  const fp = params.footprint;
  let next = { ...item };
  const requireFp = (): string | null => {
    if (!fp) return `「${ACTION_TEXT[params.action]}」需要记录实测占地`;
    return null;
  };

  switch (params.action) {
    case 'arrive':
      if (item.status !== 'pending')
        return fail(plan, `「${item.plan.label}」已经到场，不能重复到场`);
      next.status = 'arrived';
      break;
    case 'stage':
      if (item.status !== 'pending' && item.status !== 'arrived')
        return fail(plan, `「${item.plan.label}」${STATUS_LABEL[item.status]}，不能再暂存`);
      if (fp) next.actual = { ...fp, id: item.id, kind: item.plan.kind };
      else if (!next.actual) next.actual = { ...item.plan, id: item.id };
      next.status = 'staging';
      break;
    case 'install':
      if (
        item.status !== 'staging' &&
        item.status !== 'arrived' &&
        item.status !== 'pending'
      )
        return fail(plan, `「${item.plan.label}」${STATUS_LABEL[item.status]}，不能安装`);
      if (fp) next.actual = { ...fp, id: item.id, kind: item.plan.kind };
      else if (!next.actual) next.actual = { ...item.plan, id: item.id };
      next.status = 'installed';
      break;
    case 'move':
      if (item.status !== 'staging' && item.status !== 'installed')
        return fail(plan, '只有暂存中或已安装的对象可以移位');
      {
        const err = requireFp();
        if (err) return fail(plan, err);
        next.actual = { ...fp!, id: item.id, kind: item.plan.kind };
      }
      break;
    case 'measure':
      if (item.status === 'pending' || item.status === 'removed')
        return fail(plan, '对象不在现场，无法实测占地');
      {
        const err = requireFp();
        if (err) return fail(plan, err);
        next.actual = { ...fp!, id: item.id, kind: item.plan.kind };
      }
      break;
    case 'remove':
      if (item.status !== 'staging' && item.status !== 'installed')
        return fail(plan, '只有在场对象可以撤场');
      next.status = 'removed';
      break;
  }

  const items = plan.items.map((it) => (it.id === item.id ? next : it));
  const withItems: BuildPlan = { ...plan, items };
  const snapshot = checkFloor(items, plan.crew, at);
  const event = makeEvent(withItems, item.id, params.action, at, snapshot);
  const finalPlan: BuildPlan = {
    ...withItems,
    events: [...withItems.events, event],
    waves: withItems.waves.map((w) =>
      w.index === item.wave ? { ...w, lastCheck: snapshot } : w,
    ),
  };
  return ok(finalPlan);
}

/* ============================== 待核对区 ============================== */

function alertSignature(check?: WaveCheck): string {
  if (!check) return '';
  return [...check.alerts]
    .map((a) => `${a.kind}|${a.boothId}|${a.relatedBoothId ?? ''}`)
    .sort()
    .join(';');
}

/** 两份检查结论是否一致（告警种类/对象 + 封堵出口）。 */
export function checksEqual(a?: WaveCheck, b?: WaveCheck): boolean {
  if (!a || !b) return false;
  return (
    alertSignature(a) === alertSignature(b) &&
    [...a.blockedExitIds].sort().join(',') ===
      [...b.blockedExitIds].sort().join(',') &&
    a.alertCount === b.alertCount
  );
}

/** 核对一条迟到回执：确认一致 / 标记冲突；记录核对时间与备注。 */
export function resolveLateCheck(
  plan: BuildPlan,
  lateId: string,
  resolution: 'confirmed' | 'conflict',
  note: string,
  at: string = iso.now(),
): OpResult {
  const target = plan.lateChecks.find((c) => c.id === lateId);
  if (!target) return fail(plan, '回执不存在');
  return ok({
    ...plan,
    lateChecks: plan.lateChecks.map((c) =>
      c.id === lateId
        ? { ...c, resolution, resolvedAt: at, note: note.trim() || c.note }
        : c,
    ),
  });
}

/* ============================== 差异证据 ============================== */

function geomKey(b: Booth): string {
  return [
    Math.round(b.x * 1000) / 1000,
    Math.round(b.y * 1000) / 1000,
    Math.round(b.w * 1000) / 1000,
    Math.round(b.h * 1000) / 1000,
    Math.round(b.rotation * 1000) / 1000,
  ].join(',');
}

/** 计划 vs 实测差异（仅对已有实测占地的对象）。 */
export function itemDiffs(plan: BuildPlan): ItemDiff[] {
  const out: ItemDiff[] = [];
  for (const it of plan.items) {
    if (!it.actual) continue;
    const p = it.plan;
    const a = it.actual;
    const shift = Math.hypot(a.x - p.x, a.y - p.y);
    out.push({
      itemId: it.id,
      label: p.label,
      geometryChanged: geomKey(p) !== geomKey(a),
      shift: Math.round(shift * 100) / 100,
      plan: p,
      actual: { ...a, id: it.id },
    });
  }
  return out;
}

/* ============================== 两次搭建对比 ============================== */

/**
 * 对比两份搭建计划：按波次并排最近检查结论。
 * 任一方缺该波次或检查时 same=false；delta 为告警数差（B - A）。
 */
export function compareBuilds(a: BuildPlan, b: BuildPlan): WaveCompareRow[] {
  const count = Math.max(a.waves.length, b.waves.length);
  const rows: WaveCompareRow[] = [];
  for (let i = 1; i <= count; i++) {
    const wa = a.waves.find((w) => w.index === i);
    const wb = b.waves.find((w) => w.index === i);
    const ca = wa?.lastCheck;
    const cb = wb?.lastCheck;
    const same = !!ca && !!cb && checksEqual(ca, cb);
    rows.push({
      index: i,
      name: wb?.name ?? wa?.name ?? `第 ${i} 波`,
      status: wb?.status ?? wa?.status ?? 'open',
      a: ca,
      b: cb,
      delta: ca && cb ? cb.alertCount - ca.alertCount : null,
      same: !!ca && !!cb && same,
    });
  }
  return rows;
}

/** 给 UI/测试用：构造一块临时堆放 Booth。 */
export function storageBooth(
  label: string,
  x: number,
  y: number,
  w = 2,
  h = 2,
): Booth {
  return {
    id: nextId('storage'),
    x,
    y,
    w,
    h,
    rotation: 0,
    orientation: 'south',
    label,
    color: '#d97706',
    kind: 'storage',
  };
}

/** 最近一次现场检查（任一波次的最新 lastCheck，按时间戳）。 */
export function latestCheck(plan: BuildPlan): WaveCheck | undefined {
  return plan.waves
    .filter((w) => w.lastCheck)
    .map((w) => w.lastCheck!)
    .sort((x, y) => (x.at < y.at ? 1 : -1))[0];
}
