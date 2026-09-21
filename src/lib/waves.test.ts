/**
 * 搭建波次交接领域测试：
 * 波次冻结、实际占地、按真实平面路径重算、改线边界、迟到回执、局部重演、两次搭建对比。
 */
import { describe, it, expect } from 'vitest';
import type { Booth, BuildPlan, WaveCheckpoint } from '../types';
import { analyzePlan } from './validation';
import {
  addTransientPile,
  addWave,
  asBuilt,
  boothSameFootprint,
  closeWave,
  comparePlans,
  createBuildPlan,
  defaultAssignments,
  diffsForWave,
  evaluateAt,
  floorForWave,
  livePatchActualBooth,
  finalizeLivePatch,
  orderedWaves,
  patchActualBooth,
  recordEvent,
  reopenWave,
  resolveReceipt,
  setItemWave,
  startWave,
  waveById,
} from './waves';

function booth(p: Partial<Booth> & { id: string; label: string }): Booth {
  return {
    x: p.x ?? 0,
    y: p.y ?? 0,
    w: p.w ?? 3,
    h: p.h ?? 2,
    rotation: p.rotation ?? 0,
    orientation: p.orientation ?? 'south',
    color: p.color ?? '#4f86c6',
    kind: p.kind ?? 'booth',
    ...p,
  };
}

const T0 = new Date('2026-09-20T08:00:00').getTime();

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

/** 关闭某波次：全部件先安装到位（实测默认按计划占地）。 */
function installAndClose(plan: BuildPlan, waveId: string, now: number): BuildPlan {
  let p = startWave(plan, waveId, now);
  const w = waveById(p, waveId);
  for (const it of w.items) {
    p = recordEvent(p, it.id, { stage: 'installed' }, now).plan;
  }
  return closeWave(p, waveId, now + 1);
}

function appendCheckpoint(
  plan: BuildPlan,
  waveId: string,
  cp: WaveCheckpoint,
): BuildPlan {
  return {
    ...plan,
    waves: plan.waves.map((w) =>
      w.id === waveId ? { ...w, checkpoints: [...w.checkpoints, cp] } : w,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* 1. 波次冻结                                                           */
/* ------------------------------------------------------------------ */

describe('冻结搭建计划', () => {
  it('默认围挡第一波、展位第二波，序号连续', () => {
    const part = booth({ id: 'p1', label: '围挡-横', kind: 'partition', x: 8, y: 0.5, w: 4, h: 0.8 });
    const a01 = booth({ id: 'a01', label: 'A01', x: 9, y: 6 });
    const plan = createBuildPlan([part, a01], { now: T0 });
    const waves = orderedWaves(plan);
    expect(waves).toHaveLength(2);
    expect(waves[0].items.map((i) => i.boothId)).toEqual(['p1']);
    expect(waves[1].items.map((i) => i.boothId)).toEqual(['a01']);
    expect(defaultAssignments([part, a01])).toEqual({ p1: 1, a01: 2 });
    expect(plan.frozenAt).toBe(T0);
  });

  it('冻结是深拷贝快照：之后改动当前平面不影响计划', () => {
    const src = [booth({ id: 'a', label: 'A', x: 1, y: 1 })];
    const plan = createBuildPlan(src, { now: T0 });
    src[0].x = 9;
    src.push(booth({ id: 'b', label: 'B' }));
    expect(plan.baseline[0].x).toBe(1);
    expect(plan.baseline).toHaveLength(1);
    expect(plan.waves[0].items[0].planBooth.x).toBe(1);
  });

  it('自定义分波把同类型件分到不同波次', () => {
    const a = booth({ id: 'a', label: 'A' });
    const b = booth({ id: 'b', label: 'B' });
    const c = booth({ id: 'c', label: 'C' });
    const plan = createBuildPlan([a, b, c], {
      assignments: { a: 1, b: 3, c: 3 },
      now: T0,
    });
    const waves = orderedWaves(plan);
    expect(waves.map((w) => w.order)).toEqual([1, 2]); // 1/3 压缩为 1/2
    expect(waves[0].items.map((i) => i.boothId)).toEqual(['a']);
    expect(waves[1].items.map((i) => i.boothId).sort()).toEqual(['b', 'c']);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 实际占地与计划/实际差异                                             */
/* ------------------------------------------------------------------ */

describe('实测占地与差异证据', () => {
  it('安装时记录实测偏移：差异为 footprintChanged，测量历史保留', () => {
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1, w: 3, h: 2 });
    let plan = createBuildPlan([a], { now: T0 });
    const wid = plan.waves[0].id;
    plan = startWave(plan, wid, T0 + 1);
    const itemId = plan.waves[0].items[0].id;
    const actual = booth({ id: 'a', label: 'A', x: 2, y: 1.5, w: 3, h: 2 });

    plan = recordEvent(plan, itemId, { stage: 'installed', actualBooth: actual }, T0 + 2).plan;

    const item = waveById(plan, wid).items[0];
    expect(item.actualBooth!.x).toBe(2);
    expect(item.measurements).toHaveLength(1);
    const cp = item.measurements[0];
    expect(cp.booth.x).toBe(2);

    // 检查点差异：占地变化
    const wave = waveById(plan, wid);
    const cpWave = wave.checkpoints[wave.checkpoints.length - 1];
    expect(cpWave.diffs).toHaveLength(1);
    expect(cpWave.diffs[0].footprintChanged).toBe(true);
    expect(cpWave.diffs[0].detail).toContain('偏移');

    // 真实平面占地是实测值而不是计划值
    const floor = floorForWave(plan, wid);
    expect(floor.installed[0].x).toBe(2);
  });

  it('安装时未实测：默认按计划占地落地，无差异', () => {
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1 });
    let plan = createBuildPlan([a], { now: T0 });
    const wid = plan.waves[0].id;
    plan = startWave(plan, wid, T0 + 1);
    const itemId = plan.waves[0].items[0].id;
    plan = recordEvent(plan, itemId, { stage: 'installed' }, T0 + 2).plan;
    const cp = last(waveById(plan, wid).checkpoints);
    expect(cp.diffs).toHaveLength(0);
    expect(boothSameFootprint(plan.baseline[0], floorForWave(plan, wid).installed[0])).toBe(true);
  });

  it('撤场在差异中标记缺失；关闭时未完成件也列入差异', () => {
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1 });
    let plan = createBuildPlan([a], { now: T0 });
    const wid = plan.waves[0].id;
    plan = startWave(plan, wid, T0 + 1);
    const itemId = plan.waves[0].items[0].id;
    plan = recordEvent(plan, itemId, { stage: 'installed' }, T0 + 2).plan;
    plan = recordEvent(plan, itemId, { stage: 'removed' }, T0 + 3).plan;
    const removedCp = last(waveById(plan, wid).checkpoints);
    expect(removedCp.diffs[0].missing).toBe(true);
    expect(floorForWave(plan, wid).all).toHaveLength(0);
  });

  it('diffsForWave 在 close 时把 pending 件列为未落地', () => {
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1 });
    const plan = createBuildPlan([a], { now: T0 });
    const wave = plan.waves[0];
    const diffs = diffsForWave(wave, [], 'close');
    expect(diffs[0].missing).toBe(true);
    expect(diffs[0].detail).toContain('未落地');
  });
});

/* ------------------------------------------------------------------ */
/* 3. 按当时真实平面重算：第三波北出口堆料堵通道，撤掉后最终变绿            */
/* ------------------------------------------------------------------ */

describe('真实平面路径重算与证据留存', () => {
  it('完整叙事：堆料堵过北出口 → 撤场 → 关闭时绿色，堵路证据仍保留', () => {
    const part = booth({ id: 'p1', label: '围挡-横', kind: 'partition', x: 8, y: 0.5, w: 4, h: 0.8 });
    const a01 = booth({ id: 'a01', label: 'A01', x: 9, y: 6, w: 3, h: 2 });
    let plan = createBuildPlan([part, a01], {
      now: T0,
      assignments: { p1: 1, a01: 2 },
    });
    plan = addWave(plan, '第三波 · 临时堆放');
    const [w1, w2, w3] = orderedWaves(plan);
    expect(w3.items).toHaveLength(0);

    // 前两波正常安装并关闭
    plan = installAndClose(plan, w1.id, T0 + 10);
    plan = installAndClose(plan, w2.id, T0 + 20);

    // 前序波次遗留进入后续真实平面，且锁定（第三波未开工，两件都是 legacy）
    const floor3 = floorForWave(plan, w3.id);
    expect(floor3.entries.map((e) => e.kind)).toEqual(['legacy', 'legacy']);
    expect(floor3.entries.every((e) => e.locked)).toBe(true);

    // 第三波：货箱临时堆在北出口（x 14~16）旁
    plan = startWave(plan, w3.id, T0 + 30);
    plan = addTransientPile(
      plan,
      w3.id,
      { x: 14, y: 0.25, w: 2, h: 1.5, label: '北出口货箱' },
      T0 + 31,
    );
    const pileItem = waveById(plan, w3.id).items.find((i) => i.transient)!;
    expect(pileItem.stage).toBe('staging');

    // 班组在堆料状态下路径重算留证
    const blockedCp = evaluateAt(plan, w3.id, T0 + 32, 'record', '丙班');
    plan = appendCheckpoint(plan, w3.id, blockedCp);
    expect(blockedCp.blockedExitIds).toContain('exit-north');
    expect(blockedCp.alerts.some((a) => a.kind === 'exit-blocked')).toBe(true);
    // 南出口仍通：A01 依旧可达
    expect(blockedCp.paths['a01'].length).toBeGreaterThan(1);
    // 真实平面里确有暂存障碍
    expect(blockedCp.stagingBooths).toHaveLength(1);

    // 货箱撤场后再记录：真实平面恢复
    plan = recordEvent(plan, pileItem.id, { stage: 'removed' }, T0 + 40).plan;
    const cleanCp = last(waveById(plan, w3.id).checkpoints);
    expect(cleanCp.alerts).toHaveLength(0);
    expect(cleanCp.blockedExitIds).toEqual([]);

    // 关闭：最终检查也是绿色
    plan = closeWave(plan, w3.id, T0 + 50);
    const closeCp = last(waveById(plan, w3.id).checkpoints);
    expect(closeCp.alerts).toHaveLength(0);

    // 冻结基线（最终方案）本身也通过消防检查
    expect(analyzePlan(plan.baseline).alerts).toHaveLength(0);

    // 关键：堵路的那条检查点没有被覆盖，证据保留到最后
    const w3Final = waveById(plan, w3.id);
    expect(w3Final.checkpoints).toHaveLength(3);
    expect(w3Final.checkpoints[0].alerts.some((a) => a.kind === 'exit-blocked')).toBe(true);
    expect(w3Final.checkpoints[2].alerts).toHaveLength(0);
  });

  it('暂存件是障碍但不是疏散起点（skipPathIds）', () => {
    const pile = booth({ id: 'pile-1', label: '货箱', x: 1, y: 1, w: 2, h: 2 });
    // 直接验证 analyzePlan 的 skipPathIds 语义：暂存货箱不产生 no-path 起点
    const r = analyzePlan([pile], { skipPathIds: new Set(['pile-1']) });
    expect(r.paths['pile-1']).toBeUndefined();
    expect(r.alerts.some((a) => a.kind === 'no-path')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 改线边界：已完成波次不能被当前布局覆盖                               */
/* ------------------------------------------------------------------ */

describe('改线边界与迟到回执', () => {
  it('已关闭波次：改派、现场写入都被拒绝；迟到上报进待核对区', () => {
    const part = booth({ id: 'p1', label: '围挡', kind: 'partition', x: 8, y: 0.5, w: 2, h: 1 });
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1 });
    let plan = createBuildPlan([part, a], {
      now: T0,
      assignments: { p1: 1, a: 2 },
    });
    const [w1Init, w2Init] = orderedWaves(plan);
    // 提前建好第三波（有进行中波次时不允许新增）
    plan = addWave(plan, '第三波 · 改线目标');
    const allWaves = orderedWaves(plan);
    const w1 = allWaves[0];
    const w2 = allWaves[1];
    const w3 = allWaves[2];
    void w1Init;
    void w2Init;
    plan = installAndClose(plan, w1.id, T0 + 10);

    // 已关闭波次的件不能改派
    const partItem = waveById(plan, w1.id).items[0];
    expect(() => setItemWave(plan, partItem.id, w2.id)).toThrow(/已关闭/);
    // 不能把别的件改派进已关闭波次
    plan = startWave(plan, w2.id, T0 + 20);
    const aItem = waveById(plan, w2.id).items[0];
    expect(() => setItemWave(plan, aItem.id, w1.id)).toThrow(/已关闭/);

    // 已关闭波次的占地不能被画布拖拽覆盖
    expect(() =>
      patchActualBooth(plan, partItem.boothId, { x: 0 }),
    ).toThrow(/冻结/);

    // 已开始执行的件不能改派
    plan = recordEvent(plan, aItem.id, { stage: 'arrived' }, T0 + 21).plan;
    expect(() => setItemWave(plan, aItem.id, w3.id)).toThrow(/已开始执行/);

    // 已关闭波次的迟到上报 → 待核对区，不动账面
    const res = recordEvent(plan, partItem.id, { stage: 'staging' }, T0 + 90);
    expect(res.late).not.toBeNull();
    expect(res.plan.lateReceipts).toHaveLength(1);
    expect(res.plan.lateReceipts[0].resolution).toBe('pending');
    expect(waveById(res.plan, w1.id).items[0].stage).toBe('installed');
    plan = res.plan;

    // 接受回执：追加 amend 检查点补录；原检查点仍在
    const before = waveById(plan, w1.id).checkpoints.length;
    plan = resolveReceipt(plan, plan.lateReceipts[0].id, 'accepted', T0 + 95);
    const w1After = waveById(plan, w1.id);
    expect(w1After.checkpoints).toHaveLength(before + 1);
    expect(last(w1After.checkpoints).reason).toBe('amend');
    expect(plan.lateReceipts[0].resolution).toBe('accepted');
    // 已核对的回执不能重复处置
    expect(() =>
      resolveReceipt(plan, plan.lateReceipts[0].id, 'rejected'),
    ).toThrow(/已核对/);
  });

  it('未开工的件可以在计划波次间改线', () => {
    const a = booth({ id: 'a', label: 'A' });
    const b = booth({ id: 'b', label: 'B' });
    let plan = createBuildPlan([a, b], {
      assignments: { a: 1, b: 1 },
      now: T0,
    });
    plan = addWave(plan, '第二波');
    const [w1, w2] = orderedWaves(plan);
    const itemA = w1.items.find((i) => i.boothId === 'a')!;
    plan = setItemWave(plan, itemA.id, w2.id);
    expect(waveById(plan, w1.id).items.map((i) => i.boothId)).toEqual(['b']);
    expect(waveById(plan, w2.id).items.map((i) => i.boothId)).toEqual(['a']);
  });

  it('提前关闭与局部重演：旧证据不删除，新记录只追加', () => {
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1 });
    let plan = createBuildPlan([a], { now: T0 });
    const wid = plan.waves[0].id;
    plan = startWave(plan, wid, T0 + 1);
    const itemId = plan.waves[0].items[0].id;
    plan = recordEvent(plan, itemId, { stage: 'arrived' }, T0 + 2).plan;
    // 未安装完就提前关闭
    plan = closeWave(plan, wid, T0 + 3, { note: '材料不足，明早续' });
    expect(waveById(plan, wid).earlyClosed).toBe(true);
    expect(waveById(plan, wid).closeNote).toContain('材料不足');
    expect(plan.activeWaveId).toBeNull();

    // 局部重演
    plan = reopenWave(plan, wid, T0 + 4);
    expect(waveById(plan, wid).status).toBe('active');
    const preserved = waveById(plan, wid).checkpoints.length;
    plan = recordEvent(plan, itemId, { stage: 'installed' }, T0 + 5).plan;
    const w = waveById(plan, wid);
    expect(w.checkpoints.length).toBe(preserved + 1);
    expect(w.checkpoints.some((c) => c.reason === 'close')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 现场实测占地的画布式改写                                            */
/* ------------------------------------------------------------------ */

describe('patchActualBooth 现场移位', () => {
  it('进行中波次可改写并立即重算；再次移动记为移位', () => {
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1, w: 3, h: 2 });
    let plan = createBuildPlan([a], { now: T0 });
    const wid = plan.waves[0].id;
    plan = startWave(plan, wid, T0 + 1);
    const itemId = plan.waves[0].items[0].id;
    plan = recordEvent(plan, itemId, {
      stage: 'installed',
      actualBooth: booth({ id: 'a', label: 'A', x: 1, y: 1 }),
    }, T0 + 2).plan;

    plan = patchActualBooth(plan, 'a', { x: 3, y: 1 }, T0 + 3);
    const item = waveById(plan, wid).items[0];
    expect(item.actualBooth!.x).toBe(3);
    expect(item.stage).toBe('relocated');
    expect(last(item.measurements).note).toContain('移位');
    // 每次改写都追加检查点
    expect(last(waveById(plan, wid).checkpoints).diffs[0].footprintChanged).toBe(true);
  });

  it('暂存货箱按 staging 障碍 id 拖动，更新暂存点', () => {
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1 });
    let plan = createBuildPlan([a], { now: T0 });
    const wid = plan.waves[0].id;
    plan = startWave(plan, wid, T0 + 1);
    plan = addTransientPile(plan, wid, { x: 14, y: 1, w: 2, h: 1.5 }, T0 + 2);
    const pile = waveById(plan, wid).items.find((i) => i.transient)!;
    plan = patchActualBooth(plan, `${pile.id}:staging`, { x: 13, y: 2 }, T0 + 3);
    const updated = waveById(plan, wid).items.find((i) => i.id === pile.id)!;
    expect(updated.stagingAt).toEqual({ x: 13, y: 2 });
    expect(updated.stage).toBe('staging');
  });

  it('拖拽两阶段：过程中不留证，松手只追加一条检查点；没拖动则不留空证据', () => {
    const a = booth({ id: 'a', label: 'A', x: 1, y: 1, w: 3, h: 2 });
    let plan = createBuildPlan([a], { now: T0 });
    const wid = plan.waves[0].id;
    plan = startWave(plan, wid, T0 + 1);
    const itemId = plan.waves[0].items[0].id;
    plan = recordEvent(plan, itemId, {
      stage: 'installed',
      actualBooth: booth({ id: 'a', label: 'A', x: 1, y: 1 }),
    }, T0 + 2).plan;
    const cpsAfterInstall = waveById(plan, wid).checkpoints.length;

    // 模拟连续 10 次 pointermove：只改画面，不产生证据
    for (let i = 1; i <= 10; i++) {
      plan = livePatchActualBooth(plan, 'a', { x: 1 + i * 0.1, y: 1 });
    }
    expect(waveById(plan, wid).checkpoints).toHaveLength(cpsAfterInstall);
    expect(waveById(plan, wid).items[0].measurements).toHaveLength(1);

    // 松手：最终落在 x=2，只追加一次
    plan = livePatchActualBooth(plan, 'a', { x: 2, y: 1 });
    plan = finalizeLivePatch(plan, 'a', T0 + 5);
    const w = waveById(plan, wid);
    expect(w.checkpoints).toHaveLength(cpsAfterInstall + 1);
    expect(w.items[0].measurements).toHaveLength(2);
    expect(w.items[0].stage).toBe('relocated');

    // 原地松手（占地与上次测量一致）：不追加
    const cpsNow = w.checkpoints.length;
    plan = finalizeLivePatch(plan, 'a', T0 + 6);
    expect(waveById(plan, wid).checkpoints).toHaveLength(cpsNow);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 两次搭建对比                                                        */
/* ------------------------------------------------------------------ */

describe('两次搭建对比', () => {
  it('按展位 id 匹配：占地变化、单边搭建、一致', () => {
    // 搭建 A：b1、b2 按计划落地
    let a = createBuildPlan(
      [
        booth({ id: 'b1', label: 'B1', x: 1, y: 1 }),
        booth({ id: 'b2', label: 'B2', x: 5, y: 5 }),
      ],
      { name: '九月场', now: T0 },
    );
    a = startWave(a, a.waves[0].id, T0);
    for (const it of a.waves[0].items) {
      a = recordEvent(a, it.id, { stage: 'installed' }, T0).plan;
    }

    // 搭建 B：b1 移位、b2 没来、b3 新增
    let b = createBuildPlan(
      [
        booth({ id: 'b1', label: 'B1', x: 1, y: 1 }),
        booth({ id: 'b3', label: 'B3', x: 9, y: 9 }),
      ],
      { name: '十月场', now: T0 + 1000 },
    );
    b = startWave(b, b.waves[0].id, T0 + 1000);
    const [b1Item, b3Item] = b.waves[0].items;
    b = recordEvent(b, b1Item.id, {
      stage: 'installed',
      actualBooth: booth({ id: 'b1', label: 'B1', x: 2.5, y: 1 }),
    }, T0 + 1001).plan;
    b = recordEvent(b, b3Item.id, { stage: 'installed' }, T0 + 1002).plan;

    const cmp = comparePlans(a, b);
    expect(cmp.onlyInA.map((d) => d.boothId)).toEqual(['b2']);
    expect(cmp.onlyInB.map((d) => d.boothId)).toEqual(['b3']);
    expect(cmp.changed.map((d) => d.boothId)).toEqual(['b1']);
    expect(cmp.changed[0].detail).toContain('位置');
    expect(cmp.same).toBe(0);
  });

  it('占地一致计入 same；临时堆放不参与对比', () => {
    let p = createBuildPlan([booth({ id: 'b1', label: 'B1', x: 1, y: 1 })], {
      now: T0,
    });
    p = startWave(p, p.waves[0].id, T0);
    const item = p.waves[0].items[0];
    p = recordEvent(p, item.id, { stage: 'installed' }, T0 + 1).plan;
    p = addTransientPile(p, p.waves[0].id, { x: 10, y: 10, w: 1, h: 1 }, T0 + 2);
    expect(asBuilt(p).has('b1')).toBe(true);
    expect([...asBuilt(p).keys()].some((id) => id.startsWith('pile'))).toBe(false);
    expect(comparePlans(p, p).same).toBe(1);
  });
});
