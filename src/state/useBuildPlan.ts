/**
 * 搭建波次工作台状态：当前搭建计划 + 归档 + 撤销/重做 + 本地持久化。
 *
 * 与平面编辑（usePlanner）平行：冻结后平面编辑不再影响计划；
 * 已关闭波次的现场占地在领域层（waves.ts）即不可写，本钩子只做转发与留痕。
 *
 * 时间戳一律在此注入 Date.now()，纯函数 waves.ts 不直接取当前时间，便于测试。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Booth,
  BuildComparison,
  BuildPlan,
  ItemStage,
  Point,
  Wave,
} from '../types';
import { History } from '../lib/history';
import {
  addHandover as addHandoverFn,
  addTransientPile as addTransientPileFn,
  addWave as addWaveFn,
  closeWave as closeWaveFn,
  comparePlans,
  createBuildPlan,
  evaluateAt,
  finalizeLivePatch,
  floorForWave,
  livePatchActualBooth,
  patchActualBooth,
  recordEvent,
  removeItem as removeItemFn,
  renameWave as renameWaveFn,
  reopenWave,
  resolveReceipt as resolveReceiptFn,
  setItemWave,
  startWave as startWaveFn,
  waveById,
  type HandoverInput,
} from '../lib/waves';
import { rotate90 } from '../lib/geometry';
import { analyzePlan } from '../lib/validation';
import {
  clearBuildPlan,
  loadBuildArchive,
  loadBuildPlan,
  saveBuildArchive,
  saveBuildPlan,
} from '../lib/persistence';

function planEquals(a: BuildPlan, b: BuildPlan): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useBuildPlan() {
  const [plan, setPlanState] = useState<BuildPlan | null>(() => loadBuildPlan());
  const [archive, setArchive] = useState<BuildPlan[]>(() => loadBuildArchive());
  const [comparison, setComparison] = useState<BuildComparison | null>(null);
  const [compareName, setCompareName] = useState<{ a: string; b: string } | null>(null);
  const planRef = useRef(plan);
  const historyRef = useRef<History<BuildPlan> | null>(null);
  if (historyRef.current === null && plan) {
    historyRef.current = new History<BuildPlan>(plan, 200, planEquals);
  }
  const history = historyRef.current;

  const [, setHistoryVersion] = useState(0);
  const bumpHistory = () => setHistoryVersion((v) => v + 1);

  // 持久化（刷新恢复）
  useEffect(() => {
    if (plan) saveBuildPlan(plan);
  }, [plan]);
  useEffect(() => {
    saveBuildArchive(archive);
  }, [archive]);

  /** 统一的计划变更入口：同步 ref、入一条撤销历史、触发渲染。 */
  const commitToHistory = useCallback((updater: (prev: BuildPlan) => BuildPlan) => {
    const prev = planRef.current;
    if (!prev) return;
    const next = updater(prev);
    if (planEquals(next, prev)) return;
    if (!historyRef.current) {
      historyRef.current = new History<BuildPlan>(prev, 200, planEquals);
    }
    historyRef.current.commit(next);
    planRef.current = next;
    setPlanState(next);
    bumpHistory();
  }, []);

  /* ---------------- 冻结 / 退出 ---------------- */

  const freeze = useCallback(
    (booths: Booth[], name?: string, assignments?: Record<string, number>) => {
      const next = createBuildPlan(booths, { name, assignments });
      const h = new History<BuildPlan>(next, 200, planEquals);
      historyRef.current = h;
      planRef.current = next;
      setPlanState(next);
      setComparison(null);
      bumpHistory();
    },
    [],
  );

  const discard = useCallback(() => {
    historyRef.current = null;
    planRef.current = null;
    setPlanState(null);
    setComparison(null);
    clearBuildPlan();
  }, []);

  /** 归档当前计划（进入对比库）并退出搭建模式。 */
  const archiveAndExit = useCallback(() => {
    const cur = planRef.current;
    if (cur) setArchive((prev) => [...prev.filter((p) => p.id !== cur.id), cur]);
    discard();
  }, [discard]);

  /* ---------------- 波次操作 ---------------- */

  const startWave = useCallback(
    (waveId: string) =>
      commitToHistory((p) => startWaveFn(p, waveId)),
    [commitToHistory],
  );

  const handover = useCallback(
    (waveId: string, input: HandoverInput) =>
      commitToHistory((p) => addHandoverFn(p, waveId, input)),
    [commitToHistory],
  );

  const record = useCallback(
    (
      itemId: string,
      stage: ItemStage,
      opts: { actualBooth?: Booth | null; stagingAt?: Point | null; note?: string } = {},
    ) => {
      let late = null;
      commitToHistory((p) => {
        const res = recordEvent(p, itemId, {
          stage,
          actualBooth: opts.actualBooth,
          stagingAt: opts.stagingAt,
          note: opts.note,
        });
        late = res.late;
        return res.plan;
      });
      return late;
    },
    [commitToHistory],
  );

  const closeWave = useCallback(
    (waveId: string, note?: string, early?: boolean) =>
      commitToHistory((p) => closeWaveFn(p, waveId, undefined, { note, early })),
    [commitToHistory],
  );

  const reopen = useCallback(
    (waveId: string) => commitToHistory((p) => reopenWave(p, waveId)),
    [commitToHistory],
  );

  const resolveLateReceipt = useCallback(
    (receiptId: string, resolution: 'accepted' | 'rejected') =>
      commitToHistory((p) => resolveReceiptFn(p, receiptId, resolution)),
    [commitToHistory],
  );

  const renameWave = useCallback(
    (waveId: string, name: string) =>
      commitToHistory((p) => renameWaveFn(p, waveId, name)),
    [commitToHistory],
  );

  const addWave = useCallback(
    (name?: string) => commitToHistory((p) => addWaveFn(p, name)),
    [commitToHistory],
  );

  const reassignItem = useCallback(
    (itemId: string, waveId: string) =>
      commitToHistory((p) => setItemWave(p, itemId, waveId)),
    [commitToHistory],
  );

  const removeItem = useCallback(
    (itemId: string) => commitToHistory((p) => removeItemFn(p, itemId)),
    [commitToHistory],
  );

  const addPile = useCallback(
    (waveId: string, pile: Parameters<typeof addTransientPileFn>[2]) =>
      commitToHistory((p) => addTransientPileFn(p, waveId, pile)),
    [commitToHistory],
  );

  /* ---------------- 现场实测占地（画布拖拽） ---------------- */

  /** 拖拽过程中：只刷新画面与即时分析，不入历史、不留证（松手时一次提交）。 */
  const dragIdRef = useRef<string | null>(null);
  const livePatchActual = useCallback((boothId: string, patch: Partial<Booth>) => {
    const prev = planRef.current;
    if (!prev || !prev.activeWaveId) return;
    try {
      const next = livePatchActualBooth(prev, boothId, patch);
      dragIdRef.current = boothId;
      planRef.current = next;
      setPlanState(next);
    } catch {
      // 已关闭波次等非法写入：领域层拒绝，画面不动
    }
  }, []);

  const commitBuildInteraction = useCallback(() => {
    const cur = planRef.current;
    const h = historyRef.current;
    const dragId = dragIdRef.current;
    dragIdRef.current = null;
    if (!cur || !h || !dragId) return;
    try {
      const next = finalizeLivePatch(cur, dragId);
      if (planEquals(next, cur)) return; // 松手时占地没变：不留空证据
      h.commit(next);
      planRef.current = next;
      setPlanState(next);
      bumpHistory();
    } catch {
      // ignore
    }
  }, []);

  /** 旋转某件的现场实测占地 90°（沿用平面编辑同一旋转几何）。 */
  const rotateActual = useCallback(
    (obstacleId: string) => {
      const prev = planRef.current;
      if (!prev) return;
      const found = prev.activeWaveId
        ? floorForWave(prev, prev.activeWaveId).entries.find(
            (e) => e.obstacleId === obstacleId,
          )
        : null;
      if (!found || found.locked) return;
      const rb = rotate90(found.booth);
      commitToHistory((p) =>
        patchActualBooth(p, obstacleId, {
          x: rb.x,
          y: rb.y,
          rotation: rb.rotation,
        }),
      );
    },
    [commitToHistory],
  );

  /* ---------------- 撤销 / 重做 ---------------- */

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h || !h.canUndo) return;
    const next = h.undo();
    planRef.current = next;
    setPlanState(next);
    bumpHistory();
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h || !h.canRedo) return;
    const next = h.redo();
    planRef.current = next;
    setPlanState(next);
    bumpHistory();
  }, []);

  /* ---------------- 两次搭建对比 ---------------- */

  const compareWith = useCallback(
    (archivedId: string) => {
      const cur = planRef.current;
      const other = archive.find((p) => p.id === archivedId);
      if (!cur || !other) return;
      setComparison(comparePlans(cur, other));
      setCompareName({ a: cur.name, b: other.name });
    },
    [archive],
  );

  /** 对比两份归档计划（不依赖当前计划）。 */
  const compareArchive = useCallback((idA: string, idB: string) => {
    const a = loadBuildArchive().find((p) => p.id === idA);
    const b = loadBuildArchive().find((p) => p.id === idB);
    if (!a || !b) return;
    setComparison(comparePlans(a, b));
    setCompareName({ a: a.name, b: b.name });
  }, []);

  const clearComparison = useCallback(() => {
    setComparison(null);
    setCompareName(null);
  }, []);

  /* ---------------- 派生：当前波次真实平面与即时分析 ---------------- */

  const activeWave: Wave | null = useMemo(() => {
    if (!plan || !plan.activeWaveId) return null;
    return waveById(plan, plan.activeWaveId);
  }, [plan]);

  /** 当前波次真实平面（拖动时实时变化）。 */
  const liveFloor = useMemo(() => {
    if (!plan || !plan.activeWaveId) return null;
    return floorForWave(plan, plan.activeWaveId);
  }, [plan]);

  /** 真实平面上的即时检查（与最新检查点同源；用于画布/侧栏实时联动）。 */
  const liveAnalysis = useMemo(() => {
    if (!liveFloor) return null;
    return analyzePlan(liveFloor.all, {
      skipPathIds: new Set(liveFloor.staging.map((b) => b.id)),
    });
  }, [liveFloor]);

  /** 强制对当前波次补一个检查点（“路径重算/留证”按钮）。 */
  const checkpointNow = useCallback(
    (reason: 'record' | 'replay' = 'record') => {
      commitToHistory((p) => {
        if (!p.activeWaveId) return p;
        const wid = p.activeWaveId;
        const wave = waveById(p, wid);
        const cp = evaluateAt(p, wid, Date.now(), reason, wave.crewTo);
        return {
          ...p,
          waves: p.waves.map((w) =>
            w.id === wid ? { ...w, checkpoints: [...w.checkpoints, cp] } : w,
          ),
        };
      });
    },
    [commitToHistory],
  );

  return {
    plan,
    archive,
    activeWave,
    liveFloor,
    liveAnalysis,
    comparison,
    compareName,
    // 冻结/退出
    freeze,
    discard,
    archiveAndExit,
    // 波次
    startWave,
    handover,
    record,
    closeWave,
    reopen,
    resolveLateReceipt,
    renameWave,
    addWave,
    reassignItem,
    removeItem,
    addPile,
    checkpointNow,
    // 实测占地
    livePatchActual,
    commitBuildInteraction,
    rotateActual,
    // 历史
    undo,
    redo,
    canUndo: history?.canUndo ?? false,
    canRedo: history?.canRedo ?? false,
    // 对比
    compareWith,
    compareArchive,
    clearComparison,
  };
}

export type BuildPlanApi = ReturnType<typeof useBuildPlan>;
