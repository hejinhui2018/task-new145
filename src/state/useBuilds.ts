/**
 * 搭建波次工作台状态：计划列表 + 当前计划/波次 + 撤销重做 + 本地持久化。
 *
 * 与 usePlanner 同样的纪律：对可变 History 的读写只发生在事件处理里，
 * 基于 plansRef 取最新值，不放进 setState updater（StrictMode 双调用会重复提交）。
 * 现场事实（事件、实测占地、关闭结论、交接、待核对回执）全部走历史，
 * 刷新页面后可从 localStorage 完整恢复（中断续作）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Booth,
  BuildPlan,
  ItemDiff,
  PlannedItem,
  WaveCheck,
  WaveCompareRow,
} from '../types';
import { History } from '../lib/history';
import { loadBuilds, saveBuilds } from '../lib/persistence';
import {
  addStorageItem,
  addWave,
  assignItemWave,
  checkFloor,
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
  renameWave,
  replanItemGeometry,
  rerunWaveCheck,
  resolveLateCheck,
  type OpResult,
  type RecordAction,
} from '../lib/builds';

function plansEqual(a: BuildPlan[], b: BuildPlan[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface LiveFloor {
  installed: Booth[];
  staging: Booth[];
  check: WaveCheck;
}

export function useBuilds() {
  const [plans, setPlans] = useState<BuildPlan[]>(() => loadBuilds());
  const [activeId, setActiveId] = useState<string | null>(
    () => loadBuilds()[0]?.id ?? null,
  );
  const [activeWaveIndex, setActiveWaveIndex] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);

  const plansRef = useRef(plans);
  const historyRef = useRef<History<BuildPlan[]> | null>(null);
  if (historyRef.current === null) {
    historyRef.current = new History<BuildPlan[]>(plans, 100, plansEqual);
  }
  const history = historyRef.current;

  const [, setHistoryVersion] = useState(0);
  const bumpHistory = () => setHistoryVersion((v) => v + 1);

  const applyPlans = useCallback((next: BuildPlan[]) => {
    plansRef.current = next;
    setPlans(next);
  }, []);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // 刷新恢复：现场状态持久化到 localStorage
  useEffect(() => {
    saveBuilds(plans);
  }, [plans]);

  const activePlan = useMemo(
    () => plans.find((p) => p.id === activeId) ?? plans[0] ?? null,
    [plans, activeId],
  );

  useEffect(() => {
    if (!plans.some((p) => p.id === activeId)) {
      setActiveId(plans[0]?.id ?? null);
    }
  }, [plans, activeId]);

  /** 所有修改的唯一入口：提交一条历史并清错。 */
  const commitPlans = useCallback(
    (updater: (prev: BuildPlan[]) => BuildPlan[]) => {
      applyPlans(history.commit(updater(plansRef.current)));
      bumpHistory();
      setError(null);
    },
    [history, applyPlans],
  );

  /** 执行一个返回 OpResult 的领域操作；失败时保留现状并提示。 */
  const runOp = useCallback(
    (result: OpResult): boolean => {
      if (!result.ok) {
        setError(result.error ?? '操作被拒绝');
        return false;
      }
      commitPlans((prev) =>
        prev.map((p) => (p.id === result.plan.id ? result.plan : p)),
      );
      return true;
    },
    [commitPlans],
  );

  /** 对当前计划做纯函数变换（返回 BuildPlan 的便捷封装）。 */
  const mutateActive = useCallback(
    (fn: (p: BuildPlan) => BuildPlan) => {
      const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
      if (!cur) return;
      commitPlans((prev) =>
        prev.map((p) => (p.id === cur.id ? fn(p) : p)),
      );
    },
    [commitPlans],
  );

  /* ------------------------- 冻结 / 选择 / 删除 ------------------------- */

  const freeze = useCallback(
    (booths: Booth[], name?: string, crew?: string) => {
      const plan = freezePlan(booths, name ? { name, crew } : { crew });
      commitPlans((prev) => [plan, ...prev]);
      setActiveId(plan.id);
      setActiveWaveIndex(1);
      return plan.id;
    },
    [commitPlans],
  );

  const selectPlan = useCallback((id: string) => {
    setActiveId(id);
    setActiveWaveIndex(1);
    setError(null);
  }, []);

  const deletePlan = useCallback(
    (id: string) => {
      commitPlans((prev) => prev.filter((p) => p.id !== id));
    },
    [commitPlans],
  );

  /* ----------------------------- 波次管理 ----------------------------- */

  const addNewWave = useCallback(() => {
    mutateActive((p) => addWave(p));
  }, [mutateActive]);

  const renameActiveWave = useCallback(
    (name: string) => {
      mutateActive((p) => renameWave(p, activeWaveIndex, name));
    },
    [mutateActive, activeWaveIndex],
  );

  const closeActiveWave = useCallback(() => {
    const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
    if (cur) runOp(closeWave(cur, activeWaveIndex));
  }, [runOp, activeWaveIndex]);

  const rerunActiveWave = useCallback(() => {
    const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
    if (cur) runOp(rerunWaveCheck(cur, activeWaveIndex));
  }, [runOp, activeWaveIndex]);

  /* ----------------------------- 班组交接 ----------------------------- */

  const handoverTo = useCallback(
    (to: string, note: string) => {
      const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
      if (cur) return runOp(handover(cur, to, note));
      return false;
    },
    [runOp],
  );

  /* ----------------------------- 现场记录 ----------------------------- */

  const record = useCallback(
    (itemId: string, action: RecordAction, footprint?: Booth) => {
      const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
      if (!cur) return false;
      const item = cur.items.find((it) => it.id === itemId);
      if (item) setActiveWaveIndex(item.wave);
      return runOp(recordEvent(cur, { itemId, action, footprint }));
    },
    [runOp],
  );

  /* ----------------------------- 临时改线 ----------------------------- */

  const changeGeometry = useCallback(
    (itemId: string, patch: Partial<Pick<Booth, 'x' | 'y' | 'w' | 'h' | 'rotation'>>) => {
      const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
      if (cur) return runOp(replanItemGeometry(cur, itemId, patch));
      return false;
    },
    [runOp],
  );

  const changeWave = useCallback(
    (itemId: string, wave: number) => {
      const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
      if (cur) return runOp(assignItemWave(cur, itemId, wave));
      return false;
    },
    [runOp],
  );

  const dropPending = useCallback(
    (itemId: string) => {
      const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
      if (cur) return runOp(removePendingItem(cur, itemId));
      return false;
    },
    [runOp],
  );

  const addStorage = useCallback(
    (wave: number, spot: { x: number; y: number; w?: number; h?: number; label?: string }) => {
      const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
      if (cur) return runOp(addStorageItem(cur, wave, spot));
      return false;
    },
    [runOp],
  );

  const resolveLate = useCallback(
    (lateId: string, resolution: 'confirmed' | 'conflict', note: string) => {
      const cur = plansRef.current.find((p) => p.id === activeIdRef.current);
      if (cur) return runOp(resolveLateCheck(cur, lateId, resolution, note));
      return false;
    },
    [runOp],
  );

  /* ----------------------------- 撤销/重做 ----------------------------- */

  const undo = useCallback(() => {
    applyPlans(history.undo());
    bumpHistory();
  }, [history, applyPlans]);

  const redo = useCallback(() => {
    applyPlans(history.redo());
    bumpHistory();
  }, [history, applyPlans]);

  /* ----------------------------- 派生数据 ----------------------------- */

  /** 当前真实楼层（每次状态变化都按最新实测占地重算，路径/告警联动）。 */
  const liveFloor: LiveFloor | null = useMemo(() => {
    if (!activePlan) return null;
    const { installed, staging } = floorBooths(activePlan.items);
    return {
      installed,
      staging,
      check: checkFloor(activePlan.items, activePlan.crew),
    };
  }, [activePlan]);

  /** 计划预演：假设某波（含）之前全部按计划位装完。 */
  const previewCheck = useCallback(
    (upToWave: number): WaveCheck | null => {
      if (!activePlan) return null;
      return plannedCheck(activePlan, upToWave, activePlan.crew);
    },
    [activePlan],
  );

  const itemsByWave = useMemo(() => {
    const map = new Map<number, PlannedItem[]>();
    if (!activePlan) return map;
    for (const it of activePlan.items) {
      const list = map.get(it.wave) ?? [];
      list.push(it);
      map.set(it.wave, list);
    }
    return map;
  }, [activePlan]);

  const diffs: ItemDiff[] = useMemo(
    () => (activePlan ? itemDiffs(activePlan) : []),
    [activePlan],
  );

  const compareWith = useCallback(
    (otherId: string): WaveCompareRow[] | null => {
      if (!activePlan) return null;
      const other = plans.find((p) => p.id === otherId);
      if (!other) return null;
      return compareBuilds(activePlan, other);
    },
    [activePlan, plans],
  );

  const activeWave =
    activePlan?.waves.find((w) => w.index === activeWaveIndex) ?? null;

  return {
    // 列表与选择
    plans,
    activePlan,
    activeWave,
    activeWaveIndex,
    setActiveWaveIndex,
    selectPlan,
    freeze,
    deletePlan,
    // 波次
    addNewWave,
    renameActiveWave,
    closeActiveWave,
    rerunActiveWave,
    // 班组
    handoverTo,
    // 现场
    record,
    // 改线
    changeGeometry,
    changeWave,
    dropPending,
    addStorage,
    // 待核对
    resolveLate,
    // 撤销重做
    undo,
    redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    // 派生
    liveFloor,
    previewCheck,
    itemsByWave,
    diffs,
    compareWith,
    effectiveBooth,
    // 错误提示
    error,
    clearError: () => setError(null),
  };
}

export type BuildsApi = ReturnType<typeof useBuilds>;
