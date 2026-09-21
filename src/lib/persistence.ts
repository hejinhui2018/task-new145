/** 方案本地持久化：localStorage，带版本键与容错。无后端。 */
import type { BuildPlan, ItemStatus, PlanState, Booth } from '../types';
import { STORAGE_KEY } from '../constants';

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

function isValidBoothShape(o: Record<string, unknown>): boolean {
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
    (o.kind === undefined ||
      o.kind === 'booth' ||
      o.kind === 'partition' ||
      o.kind === 'storage')
  );
}

function isValidPlan(data: unknown): data is PlanState {
  if (typeof data !== 'object' || data === null) return false;
  const booths = (data as { booths?: unknown }).booths;
  if (!Array.isArray(booths)) return false;
  return booths.every((b) => {
    if (typeof b !== 'object' || b === null) return false;
    return isValidBoothShape(b as Record<string, unknown>);
  });
}

/* ========================= 搭建计划持久化 ========================= */

const BUILDS_KEY = 'booth-planner:builds:v1';

const STATUSES: ItemStatus[] = [
  'pending',
  'arrived',
  'staging',
  'installed',
  'removed',
];

function isValidBoothOrUndef(v: unknown): v is Booth | undefined {
  if (v === undefined) return true;
  return typeof v === 'object' && v !== null &&
    isValidBoothShape(v as Record<string, unknown>);
}

function isValidBuild(data: unknown): data is BuildPlan {
  if (typeof data !== 'object' || data === null) return false;
  const p = data as Record<string, unknown>;
  if (
    typeof p.id !== 'string' ||
    typeof p.frozenAt !== 'string' ||
    !Array.isArray(p.frozenBooths) ||
    !Array.isArray(p.items) ||
    !Array.isArray(p.waves) ||
    !Array.isArray(p.events) ||
    !Array.isArray(p.handovers) ||
    !Array.isArray(p.lateChecks) ||
    typeof p.crew !== 'string'
  )
    return false;
  if (!(p.frozenBooths as unknown[]).every((b) =>
    typeof b === 'object' && b !== null &&
    isValidBoothShape(b as Record<string, unknown>),
  ))
    return false;
  return (p.items as unknown[]).every((raw) => {
    if (typeof raw !== 'object' || raw === null) return false;
    const it = raw as Record<string, unknown>;
    return (
      typeof it.id === 'string' &&
      (it.sourceBoothId === undefined ||
        typeof it.sourceBoothId === 'string') &&
      typeof it.plan === 'object' &&
      it.plan !== null &&
      isValidBoothShape(it.plan as Record<string, unknown>) &&
      isValidBoothOrUndef(it.actual) &&
      typeof it.wave === 'number' &&
      typeof it.status === 'string' &&
      STATUSES.includes(it.status as ItemStatus)
    );
  });
}

export function saveBuilds(builds: BuildPlan[]): void {
  try {
    localStorage.setItem(BUILDS_KEY, JSON.stringify(builds));
  } catch {
    // 配额不足时静默降级
  }
}

export function loadBuilds(): BuildPlan[] {
  try {
    const raw = localStorage.getItem(BUILDS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    // 单份损坏不影响其他计划
    return data.filter(isValidBuild);
  } catch {
    return [];
  }
}

export function clearSavedBuilds(): void {
  try {
    localStorage.removeItem(BUILDS_KEY);
  } catch {
    // ignore
  }
}

/** 供测试/调试：一个计划条目是否通过结构校验。 */
export function isValidBuildPlan(data: unknown): boolean {
  return isValidBuild(data);
}
