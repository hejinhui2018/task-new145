/**
 * 搭建波次交接：领域核心（纯函数 + 注入时间戳，便于测试）。
 *
 * 设计要点：
 * - 冻结（{@link createBuildPlan}）把当前平面复制成不可变计划快照；之后平面编辑
 *   不再影响搭建计划。
 * - “真实平面”由各件的【实测占地】推导（{@link floorForWave}）：
 *   已关闭波次中已安装的非临时件延续到后续波次；当前波次的安装件 + 暂存件
 *   （暂存货箱也是寻路障碍——北出口旁堆料堵通道正源于此）。
 * - 每次现场记录都在当时真实平面上重跑全套检查（重叠/净空/出口/疏散），
 *   结果作为检查点（WaveCheckpoint）追加保存，永不覆盖——第三波堵过通道
 *   的证据因此保留到最终方案变绿之后。
 * - 改线边界：只有 planned 波次与当前 active 波次中未完成的件可调整；
 *   已关闭波次冻结，任何迟到上报只能进待核对区（LateReceipt）。
 */
import type {
  Booth,
  BuildComparison,
  BuildPlan,
  BuildItem,
  ItemDiff,
  ItemStage,
  LateReceipt,
  MeasurementRecord,
  Point,
  Wave,
  WaveCheckpoint,
  WaveHandover,
} from '../types';
import { nextId } from './id';
import { analyzePlan } from './validation';

export const STAGE_LABEL: Record<ItemStage, string> = {
  pending: '未到场',
  arrived: '到场',
  staging: '暂存',
  installed: '安装',
  relocated: '移位',
  removed: '撤场',
};

export const STAGE_ORDER: ItemStage[] = [
  'pending',
  'arrived',
  'staging',
  'installed',
  'relocated',
  'removed',
];

const EPS = 1e-6;

/* ------------------------------------------------------------------ */
/* 冻结与分波                                                           */
/* ------------------------------------------------------------------ */

export interface CreatePlanOptions {
  name?: string;
  /** boothId -> 波次序号（从 1 起）；未给出的件按围挡=1、展位=2 默认分配 */
  assignments?: Record<string, number>;
  waveNames?: Record<number, string>;
  now?: number;
}

/** 默认分波：围挡先进第一波，普通展位第二波；临时堆放冻结后再单独加入。 */
export function defaultAssignments(booths: Booth[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of booths) {
    out[b.id] = b.kind === 'partition' ? 1 : 2;
  }
  return out;
}

function cloneBooth(b: Booth): Booth {
  return { ...b };
}

export function makeItem(booth: Booth, transient = false): BuildItem {
  return {
    id: transient ? nextId('item') : `item-${booth.id}`,
    boothId: booth.id,
    planBooth: cloneBooth(booth),
    actualBooth: null,
    stage: 'pending',
    stagingAt: null,
    note: '',
    transient,
    measurements: [],
  };
}

/** 从当前方案冻结一份搭建计划。 */
export function createBuildPlan(
  booths: Booth[],
  opts: CreatePlanOptions = {},
): BuildPlan {
  const now = opts.now ?? Date.now();
  const assignments = opts.assignments ?? defaultAssignments(booths);
  const orderSet = new Set<number>();
  for (const b of booths) orderSet.add(assignments[b.id] ?? 1);
  const orders = [...orderSet].sort((a, b) => a - b);
  // 压缩序号：分配为 1/3 也会重排成连续的 1/2。
  const remap = new Map(orders.map((o, i) => [o, i + 1]));

  const defaultNames: Record<number, string> = {
    1: '第一波 · 围挡进场',
    2: '第二波 · 展位搭建',
    3: '第三波 · 临时堆放与收尾',
  };

  const waves: Wave[] = orders.map((o) => {
    const order = remap.get(o)!;
    return {
      id: nextId('wave'),
      name: opts.waveNames?.[o] ?? defaultNames[order] ?? `第${order}波`,
      order,
      status: 'planned',
      items: booths
        .filter((b) => (assignments[b.id] ?? 1) === o)
        .map((b) => makeItem(b)),
      crewFrom: '',
      crewTo: '',
      startedAt: null,
      closedAt: null,
      earlyClosed: false,
      closeNote: '',
      handovers: [],
      checkpoints: [],
    };
  });

  return {
    id: nextId('plan'),
    name: opts.name ?? `搭建计划 ${new Date(now).toLocaleString()}`,
    frozenAt: now,
    baseline: booths.map(cloneBooth),
    waves,
    lateReceipts: [],
    activeWaveId: null,
  };
}

export function waveById(plan: BuildPlan, waveId: string): Wave {
  const w = plan.waves.find((x) => x.id === waveId);
  if (!w) throw new Error('波次不存在');
  return w;
}

export function findItem(
  plan: BuildPlan,
  itemId: string,
): { wave: Wave; item: BuildItem } {
  for (const wave of plan.waves) {
    const item = wave.items.find((i) => i.id === itemId);
    if (item) return { wave, item };
  }
  throw new Error('搭建件不存在');
}

/** 按冻结时引用的 boothId 查找件（真实平面上的占地用的是 boothId）。 */
export function findItemByBoothId(
  plan: BuildPlan,
  boothId: string,
): { wave: Wave; item: BuildItem } {
  for (const wave of plan.waves) {
    const item = wave.items.find((i) => i.boothId === boothId);
    if (item) return { wave, item };
  }
  throw new Error('搭建件不存在');
}

/** 波次按 order 排序的副本。 */
export function orderedWaves(plan: BuildPlan): Wave[] {
  return [...plan.waves].sort((a, b) => a.order - b.order);
}

/* ------------------------------------------------------------------ */
/* 计划改线（只能动未执行的安排）                                         */
/* ------------------------------------------------------------------ */

function assertRewirable(wave: Wave): void {
  if (wave.status === 'closed') {
    throw new Error(`「${wave.name}」已关闭，已完成波次不能改线`);
  }
}

function mapWaves(plan: BuildPlan, fn: (w: Wave) => Wave): BuildPlan {
  return { ...plan, waves: plan.waves.map(fn) };
}

export function renameWave(plan: BuildPlan, waveId: string, name: string): BuildPlan {
  return mapWaves(plan, (w) => (w.id === waveId ? { ...w, name } : w));
}

/** 新增一个空波次（追加到末尾）。 */
export function addWave(plan: BuildPlan, name?: string): BuildPlan {
  if (plan.waves.some((w) => w.status !== 'planned' && w.status !== 'closed')) {
    throw new Error('已有进行中的波次，不能新增波次');
  }
  const order = plan.waves.length + 1;
  const wave: Wave = {
    id: nextId('wave'),
    name: name ?? `第${order}波`,
    order,
    status: 'planned',
    items: [],
    crewFrom: '',
    crewTo: '',
    startedAt: null,
    closedAt: null,
    earlyClosed: false,
    closeNote: '',
    handovers: [],
    checkpoints: [],
  };
  return { ...plan, waves: [...plan.waves, wave] };
}

/**
 * 把某件改派到另一波次（改线）。
 * 只能调整尚未执行的安排：已关闭波次的件不能动；目标波次也不能已关闭。
 */
export function setItemWave(
  plan: BuildPlan,
  itemId: string,
  targetWaveId: string,
): BuildPlan {
  const { wave: from, item } = findItem(plan, itemId);
  const to = waveById(plan, targetWaveId);
  assertRewirable(from);
  assertRewirable(to);
  if (item.stage !== 'pending') {
    throw new Error(`「${item.planBooth.label}」已开始执行，不能改派波次`);
  }
  if (from.id === to.id) return plan;
  return mapWaves(plan, (w) => {
    if (w.id === from.id) {
      return { ...w, items: w.items.filter((i) => i.id !== itemId) };
    }
    if (w.id === to.id) {
      return { ...w, items: [...w.items, item] };
    }
    return w;
  });
}

/** 在指定波次加入临时堆放/货箱（计划当波撤场，不延续到后续波次）。 */
export function addTransientPile(
  plan: BuildPlan,
  waveId: string,
  pile: Pick<Booth, 'x' | 'y' | 'w' | 'h'> & Partial<Booth>,
  now: number = Date.now(),
): BuildPlan {
  const wave = waveById(plan, waveId);
  assertRewirable(wave);
  const booth: Booth = {
    id: nextId('pile'),
    x: pile.x,
    y: pile.y,
    w: pile.w ?? 2,
    h: pile.h ?? 1.5,
    rotation: pile.rotation ?? 0,
    orientation: pile.orientation ?? 'south',
    label: pile.label ?? `临时堆放-${wave.items.filter((i) => i.transient).length + 1}`,
    color: pile.color ?? '#d97706',
    kind: pile.kind ?? 'booth',
  };
  const item = makeItem(booth, true);
  // 临时堆放默认已到场暂存，位置即占地，立即出现在真实平面上。
  item.stage = 'staging';
  item.stagingAt = { x: booth.x, y: booth.y };
  item.actualBooth = cloneBooth(booth);
  item.measurements.push({ at: now, booth: cloneBooth(booth), stage: 'staging' });
  return mapWaves(plan, (w) =>
    w.id === waveId ? { ...w, items: [...w.items, item] } : w,
  );
}

/** 删除一件（仅限未开始的件）。 */
export function removeItem(plan: BuildPlan, itemId: string): BuildPlan {
  const { wave, item } = findItem(plan, itemId);
  assertRewirable(wave);
  if (item.stage !== 'pending' && !item.transient) {
    throw new Error('已开始执行的件不能删除');
  }
  return mapWaves(plan, (w) =>
    w.id === wave.id ? { ...w, items: w.items.filter((i) => i.id !== itemId) } : w,
  );
}

/* ------------------------------------------------------------------ */
/* 开工 / 交接 / 状态记录                                                */
/* ------------------------------------------------------------------ */

export function startWave(plan: BuildPlan, waveId: string, now: number = Date.now()): BuildPlan {
  const wave = waveById(plan, waveId);
  if (plan.activeWaveId && plan.activeWaveId !== waveId) {
    throw new Error('请先关闭当前进行中的波次');
  }
  if (wave.status === 'closed') throw new Error('该波次已关闭，请使用“局部重演”');
  if (wave.status === 'active') return plan;
  const next = mapWaves(plan, (w) =>
    w.id === waveId
      ? {
          ...w,
          status: 'active',
          startedAt: w.startedAt ?? now,
          crewFrom: w.crewFrom || crewDefault(),
        }
      : w,
  );
  return { ...next, activeWaveId: waveId };
}

function crewDefault(): string {
  return '当班班组';
}

export interface HandoverInput {
  fromCrew: string;
  toCrew: string;
  note?: string;
}

/** 班组交接：记录交接链，并在当时真实平面上留一个检查点。 */
export function addHandover(
  plan: BuildPlan,
  waveId: string,
  input: HandoverInput,
  now: number = Date.now(),
): BuildPlan {
  const wave = waveById(plan, waveId);
  if (wave.status !== 'active') throw new Error('只有进行中的波次可以交接');
  const handover: WaveHandover = {
    id: nextId('handover'),
    at: now,
    fromCrew: input.fromCrew,
    toCrew: input.toCrew,
    note: input.note ?? '',
  };
  let next = mapWaves(plan, (w) =>
    w.id === waveId
      ? {
          ...w,
          crewFrom: input.fromCrew,
          crewTo: input.toCrew,
          handovers: [...w.handovers, handover],
        }
      : w,
  );
  const cp = evaluateAt(next, waveId, now, 'handover', input.toCrew);
  next = mapWaves(next, (w) =>
    w.id === waveId ? { ...w, checkpoints: [...w.checkpoints, cp] } : w,
  );
  return next;
}

export interface RecordInput {
  stage: ItemStage;
  /** 实测占地（安装/移位时给出；不给则沿用计划占地或上一次实测） */
  actualBooth?: Booth | null;
  stagingAt?: Point | null;
  note?: string;
  crew?: string;
}

export interface RecordResult {
  plan: BuildPlan;
  /** 波次已关闭时，上报不直接入账，生成待核对回执 */
  late: LateReceipt | null;
}

/**
 * 现场记录一次状态变化（到场/暂存/安装/移位/撤场 + 实测占地）。
 * 已关闭波次 → 生成迟到回执（待核对区）；进行中波次 → 改写状态并立刻重算检查。
 */
export function recordEvent(
  plan: BuildPlan,
  itemId: string,
  input: RecordInput,
  now: number = Date.now(),
): RecordResult {
  const found = plan.waves
    .map((w) => ({ wave: w, item: w.items.find((i) => i.id === itemId) }))
    .find((x) => x.item);
  if (!found || !found.item) throw new Error('搭建件不存在');
  const { wave, item } = found;

  if (wave.status === 'closed') {
    const receipt: LateReceipt = {
      id: nextId('receipt'),
      waveId: wave.id,
      waveName: wave.name,
      itemId: item.id,
      boothLabel: item.planBooth.label,
      attemptedStage: input.stage,
      actualBooth: input.actualBooth ?? item.actualBooth,
      note: input.note ?? '',
      receivedAt: now,
      resolution: 'pending',
    };
    return { plan: { ...plan, lateReceipts: [receipt, ...plan.lateReceipts] }, late: receipt };
  }

  if (wave.status !== 'active') throw new Error('波次尚未开工');

  const measurement: MeasurementRecord | null =
    input.actualBooth !== undefined
      ? {
          at: now,
          booth: cloneBooth(input.actualBooth ?? item.planBooth),
          stage: input.stage,
          note: input.note,
        }
      : null;

  // 暂存但未指定位置：默认把计划占地平移到计划位（现场可随后在图上拖走）。
  let stagingAt = item.stagingAt;
  if (input.stagingAt !== undefined) {
    stagingAt = input.stagingAt === null ? null : { ...input.stagingAt };
  } else if (input.stage === 'staging' && !stagingAt) {
    stagingAt = { x: item.planBooth.x, y: item.planBooth.y };
  }

  const nextItem: BuildItem = {
    ...item,
    stage: input.stage,
    stagingAt,
    note: input.note !== undefined ? input.note : item.note,
    actualBooth: resolveActual(item, input),
    measurements: measurement
      ? [...item.measurements, measurement]
      : item.measurements,
  };

  let next = mapWaves(plan, (w) =>
    w.id === wave.id
      ? { ...w, items: w.items.map((i) => (i.id === item.id ? nextItem : i)) }
      : w,
  );
  const cp = evaluateAt(next, wave.id, now, 'record', input.crew ?? wave.crewTo);
  next = mapWaves(next, (w) =>
    w.id === wave.id ? { ...w, checkpoints: [...w.checkpoints, cp] } : w,
  );
  return { plan: next, late: null };
}

function resolveActual(item: BuildItem, input: RecordInput): Booth | null {
  if (input.actualBooth !== undefined) {
    return input.actualBooth === null ? null : cloneBooth(input.actualBooth);
  }
  // 安装/移位但未单独测量：沿用计划占地（首次）或上一次实测。
  if (input.stage === 'installed' || input.stage === 'relocated') {
    return cloneBooth(item.actualBooth ?? item.planBooth);
  }
  if (input.stage === 'removed' || input.stage === 'pending') return item.actualBooth;
  return item.actualBooth;
}

/* ------------------------------------------------------------------ */
/* 关闭 / 重演 / 迟到回执                                                */
/* ------------------------------------------------------------------ */

export interface CloseOptions {
  note?: string;
  /** 声明提前关闭；不传则按“是否仍有未完成件”自动判定 */
  early?: boolean;
  crew?: string;
}

export function unfinishedItems(wave: Wave): BuildItem[] {
  return wave.items.filter(
    (i) => i.stage === 'pending' || i.stage === 'arrived' || i.stage === 'staging',
  );
}

/** 关闭波次：留存关闭检查点；临时堆放不延续到后续波次。 */
export function closeWave(
  plan: BuildPlan,
  waveId: string,
  now: number = Date.now(),
  opts: CloseOptions = {},
): BuildPlan {
  const wave = waveById(plan, waveId);
  if (wave.status === 'closed') throw new Error('波次已关闭');
  const unfinished = unfinishedItems(wave);
  const earlyClosed = opts.early ?? unfinished.length > 0;
  const cp = evaluateAt(plan, waveId, now, 'close', opts.crew ?? wave.crewTo);
  return {
    ...mapWaves(plan, (w) =>
      w.id === waveId
        ? {
            ...w,
            status: 'closed',
            closedAt: now,
            earlyClosed,
            closeNote: opts.note ?? (earlyClosed ? `仍有 ${unfinished.length} 件未完成，提前关闭` : ''),
            checkpoints: [...w.checkpoints, cp],
          }
        : w,
    ),
    activeWaveId: null,
  };
}

/**
 * 局部重演：重新打开已关闭波次补录/纠正。
 * 不删除任何既有检查点，重演期间的新记录只做追加，证据链完整保留。
 */
export function reopenWave(
  plan: BuildPlan,
  waveId: string,
  now: number = Date.now(),
): BuildPlan {
  const wave = waveById(plan, waveId);
  if (wave.status !== 'closed') throw new Error('只能重演已关闭的波次');
  if (plan.activeWaveId) throw new Error('请先关闭当前进行中的波次');
  void now;
  return {
    ...mapWaves(plan, (w) =>
      w.id === waveId
        ? { ...w, status: 'active', closedAt: null, earlyClosed: false }
        : w,
    ),
    activeWaveId: waveId,
  };
}

/** 处置待核对区的迟到回执；接受则作为补录追加到原波次（amend 检查点）。 */
export function resolveReceipt(
  plan: BuildPlan,
  receiptId: string,
  resolution: 'accepted' | 'rejected',
  now: number = Date.now(),
): BuildPlan {
  const receipt = plan.lateReceipts.find((r) => r.id === receiptId);
  if (!receipt) throw new Error('回执不存在');
  if (receipt.resolution !== 'pending') throw new Error('该回执已核对');

  let next: BuildPlan = {
    ...plan,
    lateReceipts: plan.lateReceipts.map((r) =>
      r.id === receiptId ? { ...r, resolution } : r,
    ),
  };
  if (resolution === 'rejected') return next;

  const wave = waveById(next, receipt.waveId);
  const item = wave.items.find((i) => i.id === receipt.itemId);
  if (!item) return next;
  const booth = receipt.actualBooth ?? item.actualBooth ?? item.planBooth;
  const measured: MeasurementRecord = {
    at: now,
    booth: cloneBooth(booth),
    stage: receipt.attemptedStage,
    note: `关闭后迟到回执核对补录：${receipt.note}`,
  };
  const patched: BuildItem = {
    ...item,
    stage: receipt.attemptedStage === 'removed' ? item.stage : receipt.attemptedStage,
    actualBooth: cloneBooth(booth),
    measurements: [...item.measurements, measured],
  };
  next = mapWaves(next, (w) =>
    w.id === wave.id ? { ...w, items: w.items.map((i) => (i.id === item.id ? patched : i)) } : w,
  );
  const cp = evaluateAt(next, wave.id, now, 'amend', wave.crewTo);
  return mapWaves(next, (w) =>
    w.id === wave.id ? { ...w, checkpoints: [...w.checkpoints, cp] } : w,
  );
}

/* ------------------------------------------------------------------ */
/* 真实平面与按波次重算                                                   */
/* ------------------------------------------------------------------ */

/** 暂存件在真实平面上的障碍占地：优先实测，否则把计划占地平移到暂存点。 */
function stagingObstacle(item: BuildItem): Booth | null {
  const at = item.stagingAt;
  if (!at && !item.actualBooth) return null;
  const base = item.actualBooth ?? item.planBooth;
  const b: Booth = item.actualBooth
    ? cloneBooth(item.actualBooth)
    : { ...cloneBooth(item.planBooth), x: at!.x, y: at!.y };
  return {
    ...b,
    id: `${item.id}:staging`,
    label: `${base.label}（暂存）`,
  };
}

export interface WaveFloor {
  /** 已安装/移位件的实测占地（含前序已关闭波次遗留） */
  installed: Booth[];
  /** 当前波次暂存到场的货箱/围挡占地（障碍，检查后撤场不遗留） */
  staging: Booth[];
  /** 参与检查的全部障碍（installed + staging） */
  all: Booth[];
  /** 每个障碍的来源与可写性（画布渲染/交互用） */
  entries: FloorEntry[];
}

/** 真实平面上单个障碍的来源元数据。 */
export interface FloorEntry {
  /** 真实平面障碍 id（暂存件为 `${itemId}:staging`） */
  obstacleId: string;
  itemId: string;
  booth: Booth;
  /** legacy=前序已关闭波次遗留（锁定不可改）；installed=本波已装；staging=本波暂存 */
  kind: 'legacy' | 'installed' | 'staging';
  /** 是否属于已关闭波次：画布不可拖动/缩放 */
  locked: boolean;
  transient: boolean;
}

/**
 * 某波次【当时】的真实平面：
 * - 所有已关闭波次中已安装的非临时件，延续为现场遗留；
 * - 目标波次中已安装/移位件的实测占地；
 * - 目标波次的暂存件（即使最终方案里没有，也堵住当下的通道）。
 */
export function floorForWave(plan: BuildPlan, waveId: string): WaveFloor {
  const target = waveById(plan, waveId);
  const installed: Booth[] = [];
  const staging: Booth[] = [];
  const entries: FloorEntry[] = [];
  for (const w of plan.waves) {
    for (const it of w.items) {
      const onFloor =
        (it.stage === 'installed' || it.stage === 'relocated') && it.actualBooth;
      if (w.id === target.id) {
        if (onFloor) {
          const b = cloneBooth(it.actualBooth!);
          installed.push(b);
          entries.push({
            obstacleId: b.id,
            itemId: it.id,
            booth: b,
            kind: 'installed',
            locked: false,
            transient: !!it.transient,
          });
        }
        if (it.stage === 'staging' || (it.stage === 'arrived' && it.stagingAt)) {
          const obs = stagingObstacle(it);
          if (obs) {
            staging.push(obs);
            entries.push({
              obstacleId: obs.id,
              itemId: it.id,
              booth: obs,
              kind: 'staging',
              locked: false,
              transient: !!it.transient,
            });
          }
        }
      } else if (w.status === 'closed' && !it.transient && onFloor) {
        const b = cloneBooth(it.actualBooth!);
        installed.push(b);
        entries.push({
          obstacleId: b.id,
          itemId: it.id,
          booth: b,
          kind: 'legacy',
          locked: true,
          transient: false,
        });
      }
    }
  }
  return { installed, staging, all: [...installed, ...staging], entries };
}

/**
 * 按当时真实平面重算全套检查，并生成差异证据。
 * 检查对象只包含真实平面上的障碍；计划里尚未安装的件不参与。
 */
export function evaluateAt(
  plan: BuildPlan,
  waveId: string,
  now: number,
  reason: WaveCheckpoint['reason'],
  crew: string,
): WaveCheckpoint {
  const wave = waveById(plan, waveId);
  const floor = floorForWave(plan, waveId);
  const skipPathIds = new Set(floor.staging.map((b) => b.id));
  const analysis = analyzePlan(floor.all, { skipPathIds });
  const diffs = diffsForWave(wave, floor.all, reason);
  return {
    id: nextId('cp'),
    at: now,
    reason,
    actualBooths: floor.installed.map(cloneBooth),
    stagingBooths: floor.staging.map(cloneBooth),
    alerts: analysis.alerts,
    paths: analysis.paths,
    blockedExitIds: analysis.blockedExitIds,
    diffs,
    crew,
  };
}

export function latestCheckpoint(wave: Wave): WaveCheckpoint | null {
  return wave.checkpoints.length ? wave.checkpoints[wave.checkpoints.length - 1] : null;
}

/* ------------------------------------------------------------------ */
/* 计划 vs 实际差异                                                      */
/* ------------------------------------------------------------------ */

/** 两块占地是否几何一致（位置/尺寸/旋转；颜色标签等不比较）。 */
export function boothSameFootprint(a: Booth, b: Booth): boolean {
  return (
    Math.abs(a.x - b.x) < EPS &&
    Math.abs(a.y - b.y) < EPS &&
    Math.abs(a.w - b.w) < EPS &&
    Math.abs(a.h - b.h) < EPS &&
    Math.abs(a.rotation - b.rotation) < EPS
  );
}

function footprintDetail(plan: Booth, actual: Booth): string {
  const parts: string[] = [];
  if (Math.abs(plan.x - actual.x) > EPS || Math.abs(plan.y - actual.y) > EPS) {
    parts.push(
      `位置 (${r(plan.x)},${r(plan.y)})→(${r(actual.x)},${r(actual.y)})，偏移 ${r(
        Math.hypot(actual.x - plan.x, actual.y - plan.y),
      )} m`,
    );
  }
  if (Math.abs(plan.w - actual.w) > EPS || Math.abs(plan.h - actual.h) > EPS) {
    parts.push(`尺寸 ${r(plan.w)}×${r(plan.h)}→${r(actual.w)}×${r(actual.h)} m`);
  }
  const deg = Math.round(((actual.rotation - plan.rotation) * 180) / Math.PI);
  if (Math.abs(deg) > 0) parts.push(`旋转 ${deg}°`);
  return parts.join('；') || '占地一致';
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 计算波次自身各件相对计划的差异。
 * record 检查点只记录已发生的偏差（撤场/占地变化）；close/amend 时
 * 尚未完成的件也列为缺失，形成关闭时的完整差异清单。
 */
export function diffsForWave(
  wave: Wave,
  floorBooths: Booth[],
  reason: WaveCheckpoint['reason'] = 'record',
): ItemDiff[] {
  const floorIds = new Set(floorBooths.map((b) => b.id));
  const diffs: ItemDiff[] = [];
  for (const it of wave.items) {
    const label = it.planBooth.label;
    const onFloor =
      (it.stage === 'installed' || it.stage === 'relocated') &&
      it.actualBooth &&
      floorIds.has(it.actualBooth.id);
    if (onFloor && it.actualBooth) {
      const changed = !boothSameFootprint(it.planBooth, it.actualBooth);
      if (changed || it.stage === 'relocated') {
        diffs.push({
          itemId: it.id,
          boothId: it.boothId,
          label,
          missing: false,
          footprintChanged: changed,
          unexpected: false,
          detail: changed
            ? footprintDetail(it.planBooth, it.actualBooth)
            : `${STAGE_LABEL[it.stage]}记录，占地与计划一致`,
          planBooth: cloneBooth(it.planBooth),
          actualBooth: cloneBooth(it.actualBooth),
        });
      }
      continue;
    }
    // 不在真实平面上
    if (it.stage === 'removed') {
      diffs.push({
        itemId: it.id,
        boothId: it.boothId,
        label,
        missing: true,
        footprintChanged: false,
        unexpected: false,
        detail: it.transient ? '临时堆放已撤场（计划内）' : '已撤场，真实平面缺失该件',
        planBooth: cloneBooth(it.planBooth),
        actualBooth: null,
      });
    } else if (reason === 'close' || reason === 'amend') {
      diffs.push({
        itemId: it.id,
        boothId: it.boothId,
        label,
        missing: true,
        footprintChanged: false,
        unexpected: false,
        detail: `关闭时仍为「${STAGE_LABEL[it.stage]}」，计划占地未落地`,
        planBooth: cloneBooth(it.planBooth),
        actualBooth: it.actualBooth ? cloneBooth(it.actualBooth) : null,
      });
    }
  }
  return diffs;
}

/* ------------------------------------------------------------------ */
/* 两次搭建对比                                                          */
/* ------------------------------------------------------------------ */

/** 一份计划的“竣工实测”：每件取最后一次安装/移位实测占地（临时堆放不参与对比）。 */
export function asBuilt(plan: BuildPlan): Map<string, Booth> {
  const out = new Map<string, Booth>();
  for (const w of plan.waves) {
    for (const it of w.items) {
      if (it.transient) continue;
      if (
        (it.stage === 'installed' || it.stage === 'relocated') &&
        it.actualBooth
      ) {
        out.set(it.boothId, cloneBooth(it.actualBooth));
      }
    }
  }
  return out;
}

/** 两次搭建对比：按展位 id 匹配，列出仅一次搭建有、以及占地变化的件。 */
export function comparePlans(a: BuildPlan, b: BuildPlan): BuildComparison {
  const ma = asBuilt(a);
  const mb = asBuilt(b);
  const onlyInA: ItemDiff[] = [];
  const onlyInB: ItemDiff[] = [];
  const changed: BuildComparison['changed'] = [];
  let same = 0;

  for (const [id, ba] of ma) {
    const bb = mb.get(id);
    if (!bb) {
      onlyInA.push({
        itemId: id,
        boothId: id,
        label: ba.label,
        missing: true,
        footprintChanged: false,
        unexpected: false,
        detail: `仅在「${a.name}」中搭建`,
        planBooth: ba,
        actualBooth: null,
      });
    } else if (!boothSameFootprint(ba, bb)) {
      changed.push({
        boothId: id,
        label: ba.label,
        a: ba,
        b: bb,
        detail: footprintDetail(ba, bb),
      });
    } else {
      same++;
    }
  }
  for (const [id, bb] of mb) {
    if (!ma.has(id)) {
      onlyInB.push({
        itemId: id,
        boothId: id,
        label: bb.label,
        missing: true,
        footprintChanged: false,
        unexpected: false,
        detail: `仅在「${b.name}」中搭建`,
        planBooth: bb,
        actualBooth: null,
      });
    }
  }
  return { onlyInA, onlyInB, changed, same };
}

/* ------------------------------------------------------------------ */
/* 实测占地就地编辑（画布拖动 / 尺寸修改）                                */
/* ------------------------------------------------------------------ */

/**
 * 拖拽过程中的临时写入：只更新实测占地（与暂存点），不追加测量记录/检查点。
 * 松手时由 {@link finalizeLivePatch} 一次性留证，避免一次拖动产生上百条检查点。
 */
export function livePatchActualBooth(
  plan: BuildPlan,
  boothOrStagingId: string,
  patch: Partial<Booth>,
): BuildPlan {
  const { wave, item, staging } = locateFloorItem(plan, boothOrStagingId);
  if (wave.status !== 'active') {
    throw new Error('只能修改进行中波次的现场占地；已关闭波次已冻结');
  }
  const base = item.actualBooth ?? item.planBooth;
  const merged: Booth = { ...base, ...patch, id: base.id };
  return mapWaves(plan, (w) =>
    w.id === wave.id
      ? {
          ...w,
          items: w.items.map((i) =>
            i.id === item.id
              ? {
                  ...i,
                  actualBooth: cloneBooth(merged),
                  stagingAt: staging ? { x: merged.x, y: merged.y } : i.stagingAt,
                }
              : i,
          ),
        }
      : w,
  );
}

/**
 * 拖拽松手时留证：若实测占地相对上一次测量确有变化，追加一条测量记录
 * 与检查点（移位）；没有变化则原样返回（撤销栈也不会产生空记录）。
 */
export function finalizeLivePatch(
  plan: BuildPlan,
  boothOrStagingId: string,
  now: number = Date.now(),
  crew?: string,
): BuildPlan {
  const { wave, item, staging } = locateFloorItem(plan, boothOrStagingId);
  if (wave.status !== 'active' || !item.actualBooth) return plan;
  const lastMeasured = item.measurements[item.measurements.length - 1];
  if (lastMeasured && boothSameFootprint(lastMeasured.booth, item.actualBooth)) {
    return plan;
  }
  const stage: ItemStage = staging
    ? 'staging'
    : item.measurements.some((m) => m.stage === 'installed' || m.stage === 'relocated')
      ? 'relocated'
      : 'installed';
  const measured: MeasurementRecord = {
    at: now,
    booth: cloneBooth(item.actualBooth),
    stage,
    note: staging ? '暂存位置实测更新' : '现场移位/实测占地更新',
  };
  const nextItem: BuildItem = {
    ...item,
    stage: item.stage === 'pending' || item.stage === 'arrived' ? item.stage : stage,
    measurements: [...item.measurements, measured],
  };
  let next = mapWaves(plan, (w) =>
    w.id === wave.id
      ? { ...w, items: w.items.map((i) => (i.id === item.id ? nextItem : i)) }
      : w,
  );
  const cp = evaluateAt(next, wave.id, now, 'record', crew ?? wave.crewTo);
  next = mapWaves(next, (w) =>
    w.id === wave.id ? { ...w, checkpoints: [...w.checkpoints, cp] } : w,
  );
  return next;
}

function locateFloorItem(
  plan: BuildPlan,
  boothOrStagingId: string,
): { wave: Wave; item: BuildItem; staging: boolean } {
  const staging = boothOrStagingId.endsWith(':staging');
  const rawId = staging ? boothOrStagingId.slice(0, -':staging'.length) : boothOrStagingId;
  try {
    return { ...findItem(plan, rawId), staging };
  } catch {
    return { ...findItemByBoothId(plan, rawId), staging };
  }
}

/**
 * 修改进行中波次里某件的实测占地（离散操作：旋钮/按钮），立即留证。
 * 已关闭波次不可写——保证“已完成波次不能被当前布局覆盖”。
 * 支持暂存障碍 id（`item-id:staging`）与安装占地 id。
 */
export function patchActualBooth(
  plan: BuildPlan,
  boothOrStagingId: string,
  patch: Partial<Booth>,
  now: number = Date.now(),
  crew?: string,
): BuildPlan {
  const next = livePatchActualBooth(plan, boothOrStagingId, patch);
  return finalizeLivePatch(next, boothOrStagingId, now, crew);
}
