/**
 * 方案实时分析：出口封堵、越界、重叠、净空不足、接待点到出口不可达。
 * 纯函数：输入展位列表，输出告警与每个展位的疏散路径。
 *
 * extraObstacles：搭建现场的临时堆放（货箱/材料堆，kind='storage'）或
 * 尚未安装的到场物。它们是真实占地，必须参与重叠、出口封堵与寻路阻挡，
 * 但不适用展位净空规则、不做越界检查、也没有接待点需要疏散。
 */
import type { Alert, AnalysisResult, Booth, Point } from '../types';
import { CLEARANCE, EXITS } from '../constants';
import {
  boothsOverlap,
  clearanceViolation,
  outOfBounds,
  receptionPoint,
} from './geometry';
import { exitBlockingBooth, findExitPath } from './pathfinding';

export interface AnalyzeOptions {
  /** 额外障碍（临时堆放/到场暂存物）：阻挡寻路、可封出口、可重叠，不报净空/越界 */
  extraObstacles?: Booth[];
}

export function exitName(id: string): string {
  if (id.includes('south')) return '南出口';
  if (id.includes('north')) return '北出口';
  return id;
}

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

const AXIS_TEXT: Record<'x' | 'y', string> = {
  x: '左右间距',
  y: '前后间距',
};

/** 临时堆放在告警文案中的称呼。 */
function itemName(b: Booth): string {
  return b.kind === 'storage' ? `临时堆放「${b.label}」` : `展位 ${b.label}`;
}

export function analyzePlan(
  booths: Booth[],
  options: AnalyzeOptions = {},
): AnalysisResult {
  const alerts: Alert[] = [];
  const paths: Record<string, Point[]> = {};
  const blockedExitIds: string[] = [];
  const extra = options.extraObstacles ?? [];
  // 所有真实占地：已安装物 + 临时堆放，出口封堵/寻路/重叠都按这一份。
  const all = [...booths, ...extra];
  const labelOf = new Map(all.map((b) => [b.id, b.label]));
  const isStorage = (b: Booth) => b.kind === 'storage';

  // 0) 出口是否被直接封住（堆放同样可以封出口——这正是北出口被堵的场景）
  for (const exitDef of EXITS) {
    const blocker = exitBlockingBooth(all, exitDef);
    if (blocker) {
      blockedExitIds.push(exitDef.id);
      alerts.push({
        id: `exit-blocked:${exitDef.id}`,
        kind: 'exit-blocked',
        boothId: blocker.id,
        message: `${exitName(exitDef.id)}被${
          isStorage(blocker) ? '临时堆放' : '展位'
        } ${blocker.label} 封住，疏散出口不可用`,
      });
    }
  }

  // 1) 越界（只检查已安装的展位/围挡；临时堆放在场外暂存不算越界）
  for (const b of booths) {
    if (isStorage(b)) continue;
    const reason = outOfBounds(b);
    if (reason) {
      alerts.push({
        id: `out-of-bounds:${b.id}`,
        kind: 'out-of-bounds',
        boothId: b.id,
        message: `展位 ${b.label} 越界：${reason}`,
      });
    }
  }

  // 2) 两两：重叠 / 净空
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      // 围挡是设施隔断，允许彼此拼接（不互相检查重叠/净空）；仍作为寻路障碍。
      if (a.kind === 'partition' && b.kind === 'partition') continue;
      const [lo, hi] = pairKey(a.id, b.id);
      if (boothsOverlap(a, b)) {
        // 涉及临时堆放时文案点明“堆放/占地”，否则仍是展位间重叠。
        const storage = isStorage(a) ? a : isStorage(b) ? b : null;
        const other = storage === a ? b : a;
        alerts.push({
          id: `overlap:${lo}:${hi}`,
          kind: 'overlap',
          boothId: a.id,
          relatedBoothId: b.id,
          message: storage
            ? `${itemName(storage)} 与${
                other.kind === 'partition' ? '围挡' : '展位'
              } ${other.label} 占地重叠`
            : `展位 ${labelOf.get(a.id)} 与 ${labelOf.get(
                b.id,
              )} 区域重叠，请错开布置`,
        });
        continue; // 重叠时不再重复报净空
      }
      // 净空只在两个已安装展位/围挡之间检查；临时堆放不适用 1.5 m 规则
      // （它堵通道由 no-path / exit-blocked 体现）。
      if (isStorage(a) || isStorage(b)) continue;
      const violation = clearanceViolation(a, b, CLEARANCE);
      if (violation) {
        alerts.push({
          id: `clearance:${lo}:${hi}`,
          kind: 'clearance',
          boothId: a.id,
          relatedBoothId: b.id,
          message: `展位 ${labelOf.get(a.id)} 与 ${labelOf.get(
            b.id,
          )} ${AXIS_TEXT[violation.axis]}仅 ${
            Math.round(violation.gap * 100) / 100
          } m，不足 ${CLEARANCE} m 通道`,
        });
      }
    }
  }

  // 3) 接待点 -> 任一出口：只对已安装的普通展位检查；障碍是【全部真实占地】。
  for (const b of booths) {
    if (b.kind === 'partition' || isStorage(b)) continue;
    const start = receptionPoint(b);
    const result = findExitPath(all, start);
    if (result.reachable) {
      paths[b.id] = result.path;
    } else {
      paths[b.id] = [];
      alerts.push({
        id: `no-path:${b.id}`,
        kind: 'no-path',
        boothId: b.id,
        message: `展位 ${b.label} 正面接待点无法抵达任一出口，疏散通道被堵`,
      });
    }
  }

  return { alerts, paths, blockedExitIds };
}

export function alertsForBooth(
  analysis: AnalysisResult,
  boothId: string,
): Alert[] {
  return analysis.alerts.filter(
    (a) => a.boothId === boothId || a.relatedBoothId === boothId,
  );
}
