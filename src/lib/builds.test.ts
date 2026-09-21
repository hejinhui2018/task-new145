/**
 * 搭建波次交接的领域逻辑测试：
 * 冻结快照、实际占地、按真实平面重算路径、改线边界、
 * 重复搭建防护、关闭与迟到回执、班组交接、两次搭建对比、持久化往返。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Booth, BuildPlan } from '../types';
import { blockedExitScenario } from './scenarios';
import {
  addStorageItem,
  addWave,
  assignItemWave,
  checkFloor,
  checksEqual,
  closeWave,
  compareBuilds,
  effectiveBooth,
  floorBooths,
  freezePlan,
  handover,
  itemDiffs,
  plannedCheck,
  recordEvent,
  removePendingItem,
  replanItemGeometry,
  rerunWaveCheck,
  resolveLateCheck,
  storageBooth,
} from './builds';
import { loadBuilds, saveBuilds } from './persistence';

/** node 测试环境没有 localStorage，用内存 Map 打桩（与 persistence.test 一致）。 */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: unknown }).localStorage =
    new MemoryStorage();
});

const T0 = '2026-09-21T08:00:00.000Z';
const T1 = '2026-09-21T09:00:00.000Z';
const T2 = '2026-09-21T10:00:00.000Z';
const T3 = '2026-09-21T11:00:00.000Z';
const T4 = '2026-09-21T12:00:00.000Z';

function scenarioPlan(): { booths: Booth[]; plan: BuildPlan } {
  const booths = blockedExitScenario().booths;
  const plan = freezePlan(booths, { at: T0, name: '演练搭建' });
  return { booths, plan };
}

/** 按来源展位标签找到计划条目。 */
function itemByLabel(plan: BuildPlan, label: string) {
  const booth = plan.frozenBooths.find((b) => b.label === label)!;
  return plan.items.find((it) => it.sourceBoothId === booth.id)!;
}

/** 便捷：暂存+安装一条龙（默认按计划位）。 */
function install(plan: BuildPlan, itemId: string, at: string, footprint?: Booth) {
  const staged = recordEvent(plan, {
    itemId, action: 'stage',
    ...(footprint ? { footprint } : {}),
    at,
  });
  expect(staged.ok).toBe(true);
  return recordEvent(staged.plan, { itemId, action: 'install', at });
}

describe('波次冻结', () => {
  it('冻结生成计划：围挡第 1 波、展位第 2 波，几何为深拷贝快照', () => {
    const { booths, plan } = scenarioPlan();
    expect(plan.waves.map((w) => w.index)).toEqual([1, 2]);
    expect(plan.items.length).toBe(booths.length);
    const parts = plan.items.filter((it) => it.plan.kind === 'partition');
    expect(parts.every((it) => it.wave === 1)).toBe(true);
    expect(
      plan.items
        .filter((it) => it.plan.kind !== 'partition')
        .every((it) => it.wave === 2),
    ).toBe(true);
    expect(plan.items.every((it) => it.status === 'pending')).toBe(true);

    // 冻结后再改源方案，计划快照不受影响
    booths[0].x = 999;
    booths[0].label = '被改过';
    const frozen = plan.frozenBooths[0];
    expect(frozen.x).not.toBe(999);
    expect(frozen.label).not.toBe('被改过');
  });

  it('单波模式全部进第 1 波', () => {
    const plan = freezePlan(blockedExitScenario().booths, { waves: 1 });
    expect(plan.items.every((it) => it.wave === 1)).toBe(true);
  });
});

describe('楼层重建与波次预演', () => {
  it('未进场对象不在平面；安装后按实测占地出现', () => {
    let { plan } = scenarioPlan();
    expect(floorBooths(plan.items).installed).toHaveLength(0);
    const b09 = itemByLabel(plan, 'B09');
    const r = install(plan, b09.id, T1);
    expect(r.ok).toBe(true);
    plan = r.plan;
    const floor = floorBooths(plan.items);
    expect(floor.installed.map((b) => b.id)).toContain(b09.id);
    // 实测缺省按计划占位，且 booth.id 被统一为 item.id
    expect(effectiveBooth(plan.items.find((it) => it.id === b09.id)!))
      .toEqual(expect.objectContaining({ x: 2.5, y: 12, id: b09.id }));
  });

  it('计划预演：只摆放第 1 波围挡时，南出口未封、无告警', () => {
    const { plan } = scenarioPlan();
    const c1 = plannedCheck(plan, 1, '甲班', T0);
    expect(c1.ok).toBe(true);
    expect(c1.blockedExitIds).toEqual([]);
    // 预演不写回现场事实
    expect(plan.events).toHaveLength(0);
    expect(floorBooths(plan.items).installed).toHaveLength(0);
  });

  it('计划预演：全部两波装完后，南出口被 B09 封住、A01 不可达（与最终方案一致）', () => {
    const { plan } = scenarioPlan();
    const c2 = plannedCheck(plan, 2, '甲班', T0);
    expect(c2.blockedExitIds).toEqual(['exit-south']);
    const a01 = itemByLabel(plan, 'A01');
    expect(c2.alerts.some((a) => a.kind === 'no-path' && a.boothId === a01.id)).toBe(true);
  });
});

describe('现场记录：实际占地与路径重算', () => {
  it('暂存堆在北出口旁：第 3 波临时堆放把北出口封住，已安装展位全部不可达', () => {
    let { plan } = scenarioPlan();
    // 第 1 波：两个围挡
    for (const label of ['围挡-横', '围挡-竖']) {
      const r = install(plan, itemByLabel(plan, label).id, T1);
      expect(r.ok).toBe(true);
      plan = r.plan;
    }
    // 第 2 波：所有展位（B09 在最终方案里就堵着南出口）
    for (const label of ['A01', 'B09', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08']) {
      const r = install(plan, itemByLabel(plan, label).id, T2);
      expect(r.ok).toBe(true);
      plan = r.plan;
    }
    // 第 3 波：材料堆计划放在北出口旁（开口 14~16 m；堆宽略大于开口，
    // 与寻路网格的出口端点格对齐，参照示例里 B09 整块盖住南出口的做法）
    plan = addWave(plan, '第 3 波', T3);
    const added = addStorageItem(
      plan,
      3,
      { x: 14, y: 0, w: 2.5, h: 1, label: '北出口材料堆' },
      T3,
    );
    expect(added.ok).toBe(true);
    plan = added.plan;
    const pile = plan.items.find((it) => it.plan.label === '北出口材料堆')!;
    const a02 = itemByLabel(plan, 'A02');

    // 材料尚未进场：北出口仍然可用，A02 能走到北出口（南出口被 B09 封着）
    const before = checkFloor(plan.items, '甲班', T3);
    expect(before.blockedExitIds).toEqual(['exit-south']);
    expect(before.paths[a02.id].length).toBeGreaterThan(0);

    // 材料堆进场（暂存位即北出口前）：北出口被堵
    const staged = recordEvent(plan, {
      itemId: pile.id,
      action: 'stage',
      footprint: storageBooth('北出口材料堆', 14, 0, 2.5, 1),
      at: T3,
    });
    expect(staged.ok).toBe(true);
    plan = staged.plan;
    const blocked = plan.waves.find((w) => w.index === 3)!.lastCheck!;
    expect(blocked.blockedExitIds).toContain('exit-north');
    // 两个出口都不可用：原本能绕去北出口的 A02 现在也不可达
    expect(blocked.paths[a02.id]).toEqual([]);
    expect(
      blocked.alerts.some((a) => a.kind === 'no-path' && a.boothId === a02.id),
    ).toBe(true);
    // 事件快照即为证据：事后再改现场，事件里的结论不变
    expect(staged.plan.events[staged.plan.events.length - 1]!.snapshot.blockedExitIds).toContain(
      'exit-north',
    );

    // 移位：把材料堆挪到空地上，路径立即重算恢复
    const moved = recordEvent(plan, {
      itemId: pile.id,
      action: 'move',
      footprint: storageBooth('北出口材料堆', 17.5, 10.5, 2, 2),
      at: T4,
    });
    expect(moved.ok).toBe(true);
    plan = moved.plan;
    const cleared = plan.waves.find((w) => w.index === 3)!.lastCheck!;
    expect(cleared.blockedExitIds).not.toContain('exit-north');
    expect(cleared.paths[a02.id].length).toBeGreaterThan(0);
  });

  it('撤场后对象离开平面，障碍随之消失', () => {
    let { plan } = scenarioPlan();
    const b09 = itemByLabel(plan, 'B09');
    plan = install(plan, b09.id, T1).plan;
    expect(checkFloor(plan.items, '甲班').blockedExitIds).toContain('exit-south');
    const removed = recordEvent(plan, {
      itemId: b09.id,
      action: 'remove',
      at: T2,
    });
    expect(removed.ok).toBe(true);
    expect(checkFloor(removed.plan.items, '甲班').blockedExitIds).toEqual([]);
    expect(
      removed.plan.items.find((it) => it.id === b09.id)!.status,
    ).toBe('removed');
  });

  it('实测占地与计划不同：保留差异证据（位移与几何变化）', () => {
    let { plan } = scenarioPlan();
    const b09 = itemByLabel(plan, 'B09');
    plan = install(plan, b09.id, T1).plan;
    // 现场实测 B09 实际落在 (0,12)，而不是计划的 (2.5,12)
    const measured = recordEvent(plan, {
      itemId: b09.id,
      action: 'measure',
      footprint: { ...b09.plan, x: 0, y: 12 },
      at: T2,
    });
    expect(measured.ok).toBe(true);
    plan = measured.plan;
    const diffs = itemDiffs(plan);
    const d = diffs.find((x) => x.itemId === b09.id)!;
    expect(d.geometryChanged).toBe(true);
    expect(d.shift).toBeCloseTo(2.5, 2);
    expect(d.actual.x).toBe(0);
    // 平面使用的是实测占地：南出口因此解封
    expect(checkFloor(plan.items, '甲班').blockedExitIds).toEqual([]);
  });
});

describe('临时改线边界', () => {
  it('pending 对象在开放波次可改几何/改波次/删除', () => {
    let { plan } = scenarioPlan();
    plan = addWave(plan, '第 3 波', T1);
    const a02 = itemByLabel(plan, 'A02');
    const moved = replanItemGeometry(plan, a02.id, { x: 10, y: 6 });
    expect(moved.ok).toBe(true);
    expect(moved.plan.items.find((it) => it.id === a02.id)!.plan.x).toBe(10);

    const reassigned = assignItemWave(moved.plan, a02.id, 3);
    expect(reassigned.ok).toBe(true);
    expect(reassigned.plan.items.find((it) => it.id === a02.id)!.wave).toBe(3);

    const removed = removePendingItem(reassigned.plan, a02.id);
    expect(removed.ok).toBe(true);
    expect(removed.plan.items.some((it) => it.id === a02.id)).toBe(false);
  });

  it('已到场/已安装的对象拒绝改线（已完成的安排不能被当前布局覆盖）', () => {
    let { plan } = scenarioPlan();
    const a02 = itemByLabel(plan, 'A02');
    plan = install(plan, a02.id, T1).plan;
    const g = replanItemGeometry(plan, a02.id, { x: 0 });
    expect(g.ok).toBe(false);
    expect(g.error).toContain('尚未执行');
    expect(assignItemWave(plan, a02.id, 1).ok).toBe(false);
    expect(removePendingItem(plan, a02.id).ok).toBe(false);
  });

  it('波次关闭后：该波对象不能改线，也不能并入新对象', () => {
    let { plan } = scenarioPlan();
    const hp = itemByLabel(plan, '围挡-横');
    plan = install(plan, hp.id, T1).plan;
    const closed = closeWave(plan, 1, T2);
    expect(closed.ok).toBe(true);
    plan = closed.plan;
    expect(replanItemGeometry(plan, hp.id, { x: 1 }).ok).toBe(false);
    expect(assignItemWave(plan, hp.id, 2).ok).toBe(false);
    const a02 = itemByLabel(plan, 'A02');
    expect(assignItemWave(plan, a02.id, 1).ok).toBe(false);
    expect(addStorageItem(plan, 1, { x: 1, y: 1 }).ok).toBe(false);
    // 关闭的波次也不再接受现场记录
    expect(recordEvent(plan, { itemId: hp.id, action: 'remove' }).ok).toBe(false);
  });
});

describe('重复搭建防护', () => {
  it('不能重复到场、重复安装；撤场后不能直接再装', () => {
    let { plan } = scenarioPlan();
    const b09 = itemByLabel(plan, 'B09');
    const arrived = recordEvent(plan, { itemId: b09.id, action: 'arrive', at: T1 });
    expect(arrived.ok).toBe(true);
    plan = arrived.plan;
    const again = recordEvent(plan, { itemId: b09.id, action: 'arrive', at: T1 });
    expect(again.ok).toBe(false);
    expect(again.error).toContain('重复到场');

    plan = recordEvent(plan, { itemId: b09.id, action: 'install', at: T2 }).plan;
    const twice = recordEvent(plan, { itemId: b09.id, action: 'install', at: T2 });
    expect(twice.ok).toBe(false);
    expect(twice.error).toContain('已安装');

    plan = twice.plan;
    plan = recordEvent(plan, { itemId: b09.id, action: 'remove', at: T3 }).plan;
    const rebuild = recordEvent(plan, { itemId: b09.id, action: 'install', at: T4 });
    expect(rebuild.ok).toBe(false);
  });

  it('移位/实测必须带占地，且不在现场的对象不能实测', () => {
    let { plan } = scenarioPlan();
    const b09 = itemByLabel(plan, 'B09');
    expect(
      recordEvent(plan, { itemId: b09.id, action: 'measure' }).ok,
    ).toBe(false);
    plan = install(plan, b09.id, T1).plan;
    expect(
      recordEvent(plan, { itemId: b09.id, action: 'move' }).ok,
    ).toBe(false);
    expect(
      recordEvent(plan, {
        itemId: b09.id,
        action: 'move',
        footprint: { ...b09.plan, x: 4 },
      }).ok,
    ).toBe(true);
  });
});

describe('波次关闭、复查与迟到回执', () => {
  it('关闭留下最终检查证据；关闭后的复查进入待核对区', () => {
    let { plan } = scenarioPlan();
    const b09 = itemByLabel(plan, 'B09');
    plan = install(plan, b09.id, T1).plan;
    const closed = closeWave(plan, 2, T2);
    expect(closed.ok).toBe(true);
    plan = closed.plan;
    const wave2 = plan.waves.find((w) => w.index === 2)!;
    expect(wave2.status).toBe('closed');
    expect(wave2.closedAt).toBe(T2);
    expect(wave2.lastCheck?.blockedExitIds).toContain('exit-south');
    // 关闭事件留痕
    expect(plan.events.some((e) => e.type === 'check')).toBe(true);

    // 关闭后刷新/重演检查 → 不回写，回执进入待核对区
    const rerun = rerunWaveCheck(plan, 2, T3);
    expect(rerun.ok).toBe(true);
    plan = rerun.plan;
    expect(plan.lateChecks).toHaveLength(1);
    const receipt = plan.lateChecks[0];
    expect(receipt.waveIndex).toBe(2);
    expect(receipt.resolution).toBe('pending');
    // 波次事实没有被覆盖
    expect(plan.waves.find((w) => w.index === 2)!.lastCheck?.at).toBe(T2);

    // 核对一致（当前平面未变，结论一致）
    const resolved = resolveLateCheck(plan, receipt.id, 'confirmed', '交班后复查一致', T4);
    expect(resolved.ok).toBe(true);
    expect(resolved.plan.lateChecks[0].resolution).toBe('confirmed');
    expect(checksEqual(receipt.check, wave2.lastCheck)).toBe(true);
  });

  it('开放波次的局部重演：刷新 lastCheck 并留 check 事件', () => {
    let { plan } = scenarioPlan();
    const b09 = itemByLabel(plan, 'B09');
    plan = install(plan, b09.id, T1).plan;
    const eventsBefore = plan.events.length;
    const rerun = rerunWaveCheck(plan, 2, T2);
    expect(rerun.ok).toBe(true);
    expect(rerun.plan.lateChecks).toHaveLength(0);
    expect(rerun.plan.events.length).toBe(eventsBefore + 1);
  });
});

describe('班组交接（波次中断续作）', () => {
  it('交接切换当班班组，后续事件与检查盖接班班组章', () => {
    let { plan } = scenarioPlan();
    const h = handover(plan, '乙班', '北出口材料由下班跟进', T1);
    expect(h.ok).toBe(true);
    plan = h.plan;
    expect(plan.crew).toBe('乙班');
    expect(plan.handovers[0]).toMatchObject({ from: '甲班', to: '乙班' });

    expect(handover(plan, '乙班', '').ok).toBe(false);
    const b09 = itemByLabel(plan, 'B09');
    const installed = recordEvent(plan, {
      itemId: b09.id,
      action: 'install',
      at: T2,
    });
    expect(installed.plan.events[installed.plan.events.length - 1]!.crew).toBe('乙班');
    expect(installed.plan.waves.find((w) => w.index === 2)!.lastCheck?.crew).toBe('乙班');
  });
});

describe('两次搭建对比', () => {
  it('按波次并排检查结论，给出告警数差异与一致性', () => {
    const a = scenarioPlan().plan;
    let b = freezePlan(blockedExitScenario().booths, {
      at: T0,
      name: '第二次搭建',
    });
    // A：第 2 波装 B09（南出口封）后关闭
    let w = install(a, itemByLabel(a, 'B09').id, T1).plan;
    const aClosed = closeWave(w, 2, T2);
    expect(aClosed.ok).toBe(true);
    const planA = aClosed.plan;

    // B：空展厅关闭第 2 波
    const bClosed = closeWave(b, 2, T2);
    expect(bClosed.ok).toBe(true);
    b = bClosed.plan;

    const rows = compareBuilds(planA, b);
    expect(rows.length).toBe(2);
    const row2 = rows.find((r) => r.index === 2)!;
    expect(row2.same).toBe(false);
    expect(row2.a?.alertCount).toBeGreaterThan(0);
    expect(row2.b?.alertCount).toBe(0);
    expect(row2.delta).toBe(-row2.a!.alertCount);
  });
});

describe('搭建计划本地持久化', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('save/load 往返保留现场状态、实测占地、事件与待核对回执', () => {
    let plan = scenarioPlan().plan;
    const b09 = itemByLabel(plan, 'B09');
    plan = install(
      plan,
      b09.id,
      T1,
      storageBooth('B09', 0, 12, 3, 2),
    ).plan;
    plan = closeWave(plan, 2, T2).plan;
    plan = rerunWaveCheck(plan, 2, T3).plan;
    saveBuilds([plan]);
    const [restored] = loadBuilds();
    expect(restored.id).toBe(plan.id);
    const item = restored.items.find((it) => it.id === b09.id)!;
    expect(item.status).toBe('installed');
    expect(item.actual).toMatchObject({ x: 0, y: 12 });
    expect(restored.events.length).toBe(plan.events.length);
    expect(restored.lateChecks).toHaveLength(1);
    expect(restored.waves.find((w) => w.index === 2)!.status).toBe('closed');
  });

  it('损坏数据被过滤，不拖垮其他计划', () => {
    localStorage.setItem(
      'booth-planner:builds:v1',
      JSON.stringify([{ bogus: true }, scenarioPlan().plan]),
    );
    expect(loadBuilds()).toHaveLength(1);
  });
});
