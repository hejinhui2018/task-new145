/** 方案本地持久化：localStorage，带版本键与容错。无后端。 */
import type {
  Booth,
  BuildPlan,
  ItemStage,
  PlanState,
  WaveStatus,
} from '../types';
import { BUILD_ARCHIVE_KEY, BUILD_KEY, STORAGE_KEY } from '../constants';

export function savePlan(state: PlanState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式 / 配额不足时静默降级，不影响编辑。
  }
}

export function loadPlan(): PlanState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    if (!isValidPlan(data)) return null;
    // 迁移：旧版本没有 rotation 字段，补 0（轴对齐），尺寸保持未旋转原值。
    return {
      booths: data.booths.map((b) =>
        typeof b.rotation === 'number' && Number.isFinite(b.rotation)
          ? b
          : { ...b, rotation: 0 },
      ),
    };
  } catch {
    return null;
  }
}

export function clearSavedPlan(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ */
/* 搭建计划持久化（刷新恢复）                                             */
/* ------------------------------------------------------------------ */

const STAGES: ItemStage[] = [
  'pending',
  'arrived',
  'staging',
  'installed',
  'relocated',
  'removed',
];
const WAVE_STATUS: WaveStatus[] = ['planned', 'active', 'closed'];

function isBoothShape(o: unknown): o is Booth {
  if (typeof o !== 'object' || o === null) return false;
  const b = o as Record<string, unknown>;
  return (
    typeof b.id === 'string' &&
    typeof b.x === 'number' &&
    typeof b.y === 'number' &&
    typeof b.w === 'number' &&
    typeof b.h === 'number' &&
    typeof b.rotation === 'number' &&
    typeof b.label === 'string' &&
    typeof b.color === 'string' &&
    (b.orientation === 'north' ||
      b.orientation === 'east' ||
      b.orientation === 'south' ||
      b.orientation === 'west')
  );
}

function isPoint(o: unknown): boolean {
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof (o as { x?: unknown }).x === 'number' &&
    typeof (o as { y?: unknown }).y === 'number'
  );
}

/** 宽松校验：结构不符直接返回 null（刷新后回到无搭建状态，而不是崩溃）。 */
export function isValidBuildPlan(data: unknown): data is BuildPlan {
  if (typeof data !== 'object' || data === null) return false;
  const p = data as Record<string, unknown>;
  if (
    typeof p.id !== 'string' ||
    typeof p.frozenAt !== 'number' ||
    !Array.isArray(p.baseline) ||
    !p.baseline.every(isBoothShape) ||
    !Array.isArray(p.waves)
  ) {
    return false;
  }
  return p.waves.every((wRaw) => {
    if (typeof wRaw !== 'object' || wRaw === null) return false;
    const w = wRaw as Record<string, unknown>;
    if (
      typeof w.name !== 'string' ||
      !WAVE_STATUS.includes(w.status as WaveStatus) ||
      typeof w.order !== 'number' ||
      !Array.isArray(w.items) ||
      !Array.isArray(w.checkpoints) ||
      !Array.isArray(w.handovers)
    ) {
      return false;
    }
    return w.items.every((iRaw) => {
      if (typeof iRaw !== 'object' || iRaw === null) return false;
      const it = iRaw as Record<string, unknown>;
      return (
        typeof it.id === 'string' &&
        typeof it.boothId === 'string' &&
        isBoothShape(it.planBooth) &&
        (it.actualBooth === null || isBoothShape(it.actualBooth)) &&
        STAGES.includes(it.stage as ItemStage) &&
        (it.stagingAt === null || isPoint(it.stagingAt)) &&
        Array.isArray(it.measurements)
      );
    });
  });
}

function normalizeBuild(data: unknown): BuildPlan | null {
  if (!isValidBuildPlan(data)) return null;
  const p = data as BuildPlan;
  return {
    ...p,
    lateReceipts: Array.isArray(p.lateReceipts) ? p.lateReceipts : [],
    activeWaveId: typeof p.activeWaveId === 'string' ? p.activeWaveId : null,
  };
}

export function saveBuildPlan(plan: BuildPlan): void {
  try {
    localStorage.setItem(BUILD_KEY, JSON.stringify(plan));
  } catch {
    // 配额不足/隐私模式静默降级
  }
}

export function loadBuildPlan(): BuildPlan | null {
  try {
    const raw = localStorage.getItem(BUILD_KEY);
    if (!raw) return null;
    return normalizeBuild(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearBuildPlan(): void {
  try {
    localStorage.removeItem(BUILD_KEY);
  } catch {
    // ignore
  }
}

/** 归档列表（用于两次搭建对比）。 */
export function loadBuildArchive(): BuildPlan[] {
  try {
    const raw = localStorage.getItem(BUILD_ARCHIVE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map(normalizeBuild).filter((p): p is BuildPlan => p !== null);
  } catch {
    return [];
  }
}

export function saveBuildArchive(plans: BuildPlan[]): void {
  try {
    localStorage.setItem(BUILD_ARCHIVE_KEY, JSON.stringify(plans.slice(-20)));
  } catch {
    // ignore
  }
}

function isValidPlan(data: unknown): data is PlanState {
  if (typeof data !== 'object' || data === null) return false;
  const booths = (data as { booths?: unknown }).booths;
  if (!Array.isArray(booths)) return false;
  return booths.every((b) => {
    if (typeof b !== 'object' || b === null) return false;
    const o = b as Record<string, unknown>;
    return (
      typeof o.id === 'string' &&
      typeof o.x === 'number' &&
      typeof o.y === 'number' &&
      typeof o.w === 'number' &&
      typeof o.h === 'number' &&
      typeof o.label === 'string' &&
      (o.orientation === 'north' ||
        o.orientation === 'east' ||
        o.orientation === 'south' ||
        o.orientation === 'west') &&
        (o.rotation === undefined ||
          (typeof o.rotation === 'number' && Number.isFinite(o.rotation))) &&
        (o.kind === undefined || o.kind === 'booth' || o.kind === 'partition')
    );
  });
}
