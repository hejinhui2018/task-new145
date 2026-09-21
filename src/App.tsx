import { useEffect, useMemo, useState } from 'react';
import { usePlanner } from './state/usePlanner';
import { useBuildPlan } from './state/useBuildPlan';
import { Toolbar } from './components/Toolbar';
import { FloorPlan, type FloorView } from './components/FloorPlan';
import { AlertPanel } from './components/AlertPanel';
import { Inspector } from './components/Inspector';
import { WavePanel, LateReceiptPanel, ComparisonPanel } from './components/WavePanel';
import { FreezeDialog } from './components/FreezeDialog';
import type { Alert, AnalysisResult, Booth, Point } from './types';
import { orderedWaves } from './lib/waves';
import { snapToGrid } from './lib/grid';
import { GRID_SIZE } from './constants';

export default function App() {
  const build = useBuildPlan();
  const inBuild = build.plan !== null;
  const planner = usePlanner(!inBuild);

  const [activeAlertId, setActiveAlertId] = useState<string | null>(null);
  const [showPaths, setShowPaths] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [showFreeze, setShowFreeze] = useState(false);

  // 搭建模式下的侧栏选中波次 / 历史检查点
  const [selectedWaveId, setSelectedWaveId] = useState<string>('');
  const [historyCpId, setHistoryCpId] = useState<string | null>(null);

  // 进入/恢复搭建模式时，默认选中进行中波次，否则第一波
  useEffect(() => {
    if (build.plan) {
      const first =
        build.plan.activeWaveId ?? orderedWaves(build.plan)[0]?.id ?? '';
      setSelectedWaveId((cur) =>
        cur && build.plan!.waves.some((w) => w.id === cur) ? cur : first,
      );
    } else {
      setHistoryCpId(null);
    }
  }, [build.plan]);

  // 开工后自动切到该波次
  useEffect(() => {
    if (build.plan?.activeWaveId) setSelectedWaveId(build.plan.activeWaveId);
  }, [build.plan?.activeWaveId]);

  const focusAlert = (alert: Alert) => {
    setActiveAlertId(alert.id);
    planner.selectBooth(alert.boothId);
  };

  /* ---------------- 搭建模式画布数据 ---------------- */

  const selectedWave = build.plan?.waves.find((w) => w.id === selectedWaveId) ?? null;
  const historyCp =
    historyCpId && selectedWave
      ? selectedWave.checkpoints.find((c) => c.id === historyCpId) ?? null
      : null;

  const buildView: FloorView | null = useMemo(() => {
    if (!build.plan || !selectedWave) return null;

    // 回看历史检查点：只读，画面还原当时真实平面
    if (historyCp) {
      const cpAnalysis: AnalysisResult = {
        alerts: historyCp.alerts,
        paths: historyCp.paths,
        blockedExitIds: historyCp.blockedExitIds,
      };
      return {
        booths: [...historyCp.actualBooths, ...historyCp.stagingBooths],
        analysis: cpAnalysis,
        readOnly: true,
        ghosts: selectedWave.items
          .filter((it) => !it.transient)
          .map((it) => it.planBooth),
      };
    }

    // 进行中波次：实时真实平面
    if (build.liveFloor && build.liveAnalysis && build.activeWave?.id === selectedWave.id) {
      const entryById = new Map(build.liveFloor.entries.map((e) => [e.obstacleId, e]));
      const onFloorIds = new Set(build.liveFloor.all.map((b) => b.id));
      const ghosts: Booth[] = [];
      for (const it of selectedWave.items) {
        const onFloor =
          (it.stage === 'installed' || it.stage === 'relocated') &&
          it.actualBooth &&
          onFloorIds.has(it.actualBooth.id);
        if (it.stage === 'pending' || it.stage === 'arrived') {
          if (!it.transient) ghosts.push(it.planBooth);
        } else if (onFloor && it.actualBooth) {
          const p = it.planBooth;
          const a = it.actualBooth;
          if (
            p.x !== a.x ||
            p.y !== a.y ||
            p.w !== a.w ||
            p.h !== a.h ||
            p.rotation !== a.rotation
          ) {
            ghosts.push(p);
          }
        }
      }
      return {
        booths: build.liveFloor.all,
        analysis: build.liveAnalysis,
        readOnly: false,
        locked: (b) => entryById.get(b.id)?.locked ?? true,
        flagOf: (b) => entryById.get(b.id)?.kind,
        ghosts,
        livePatch: build.livePatchActual,
        commit: build.commitBuildInteraction,
        rotate: build.rotateActual,
        onDoubleClickEmpty: (p: Point) => {
          // 双击空白：快速登记一个暂存货箱（仅进行中波次）
          if (build.activeWave?.id !== selectedWave.id) return;
          build.addPile(selectedWave.id, {
            x: snapToGrid(p.x - 1, GRID_SIZE),
            y: snapToGrid(p.y - 0.75, GRID_SIZE),
            w: 2,
            h: 1.5,
          });
        },
      };
    }

    // 计划中/已关闭波次（非回看）：已关闭的展示遗留快照，计划中的展示计划虚影
    const floorItems: Booth[] = [];
    const ghostsClosed: Booth[] = [];
    if (selectedWave.status === 'closed') {
      const last = selectedWave.checkpoints[selectedWave.checkpoints.length - 1];
      if (last) floorItems.push(...last.actualBooths, ...last.stagingBooths);
      const cpAnalysis: AnalysisResult = last
        ? { alerts: last.alerts, paths: last.paths, blockedExitIds: last.blockedExitIds }
        : { alerts: [], paths: {}, blockedExitIds: [] };
      return {
        booths: floorItems,
        analysis: cpAnalysis,
        readOnly: true,
        ghosts: ghostsClosed,
      };
    }
    // 计划中波次：显示当前已落地的真实平面作为上下文（只读）+ 本波计划虚影
    const contextBooths = build.liveFloor ? build.liveFloor.all : [];
    const contextFlags = build.liveFloor
      ? new Map(build.liveFloor.entries.map((e) => [e.obstacleId, e.kind]))
      : new Map();
    const contextAnalysis: AnalysisResult = build.liveAnalysis ?? {
      alerts: [],
      paths: {},
      blockedExitIds: [],
    };
    return {
      booths: contextBooths,
      analysis: contextAnalysis,
      readOnly: true,
      flagOf: (b) => contextFlags.get(b.id),
      ghosts: selectedWave.items.map((it) => it.planBooth),
    };
  }, [build, selectedWave, historyCp]);

  // 搭建模式的撤销/重做快捷键（与平面编辑互斥）
  useEffect(() => {
    if (!inBuild) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        build.undo();
      } else if (
        (mod && e.key.toLowerCase() === 'y') ||
        (mod && e.shiftKey && e.key.toLowerCase() === 'z')
      ) {
        e.preventDefault();
        build.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inBuild, build]);

  const buildAlerts = historyCp
    ? historyCp.alerts
    : buildView && build.activeWave?.id === selectedWaveId
      ? build.liveAnalysis?.alerts ?? []
      : buildView?.analysis.alerts ?? [];
  const alertCount = inBuild ? buildAlerts.length : planner.analysis.alerts.length;

  return (
    <div className={`app ${inBuild ? 'build-app' : ''}`}>
      {inBuild ? (
        <BuildToolbar build={build} onExit={() => {
          if (window.confirm('退出搭建模式？现场记录保留在本机，可稍后继续。')) {
            build.discard();
          }
        }} />
      ) : (
        <Toolbar
          canUndo={planner.canUndo}
          canRedo={planner.canRedo}
          onUndo={planner.undo}
          onRedo={planner.redo}
          onAddBooth={planner.addBooth}
          onReset={planner.resetPlan}
          showPaths={showPaths}
          onTogglePaths={() => setShowPaths((v) => !v)}
          onFreeze={() => setShowFreeze(true)}
        />
      )}

      {inBuild && build.plan && (
        <BuildBanner
          build={build}
          selectedWaveId={selectedWaveId}
          historyCpId={historyCpId}
          onExitHistory={() => setHistoryCpId(null)}
        />
      )}

      <div className="workspace">
        <div className="canvas-wrap">
          <FloorPlan
            planner={planner}
            showPaths={showPaths}
            activeAlertId={activeAlertId}
            onActiveAlertChange={setActiveAlertId}
            onZoomChange={setZoom}
            view={
              inBuild
                ? buildView ?? {
                    booths: [],
                    analysis: { alerts: [], paths: {}, blockedExitIds: [] },
                    readOnly: true,
                  }
                : undefined
            }
          />
          <div className="hint-chip">
            {inBuild
              ? historyCp
                ? '历史检查点证据（只读）：还原当时真实平面与告警'
                : '搭建模式：拖动现场件更新实测占地 · 双击空白登记暂存货箱 · 前序波次遗留锁定不可改'
              : '双击空白添加展位 · 拖动移动 · 手柄缩放 · R 旋转 · 滚轮缩放 · 拖空白平移'}
          </div>
          <Legend inBuild={inBuild} />
        </div>

        <div className={`sidebar ${inBuild ? 'build-sidebar' : ''}`}>
          {inBuild && build.plan ? (
            <>
              <WavePanel
                build={build}
                selectedWaveId={selectedWaveId}
                onSelectWave={setSelectedWaveId}
                historyCpId={historyCpId}
                onPickHistory={setHistoryCpId}
              />
              <AlertPanel
                alerts={buildAlerts}
                activeAlertId={activeAlertId}
                onSelect={focusAlert}
              />
              <LateReceiptPanel build={build} />
              <ComparisonPanel build={build} />
            </>
          ) : (
            <>
              <AlertPanel
                alerts={planner.analysis.alerts}
                activeAlertId={activeAlertId}
                onSelect={focusAlert}
              />
              <Inspector planner={planner} onAlertClick={focusAlert} />
            </>
          )}
        </div>
      </div>

      <footer className="statusbar">
        {inBuild && build.plan ? (
          <>
            <span className="stat">
              搭建计划：{build.plan.waves.length} 波 · 冻结于{' '}
              {new Date(build.plan.frozenAt).toLocaleDateString()}
            </span>
            <span className="stat">
              <span className="dot" style={{ background: alertCount ? '#b91c1c' : '#15803d' }} />
              {alertCount === 0 ? '当前真实平面检查通过' : `${alertCount} 条现场告警`}
            </span>
            <span className="stat">
              待核对回执 {build.plan.lateReceipts.filter((r) => r.resolution === 'pending').length} 条
            </span>
            <span className="save-state">现场记录自动保存 · 刷新可恢复</span>
          </>
        ) : (
          <>
            <span className="stat">展位 {planner.booths.length} 个</span>
            <span className="stat">
              <span className="dot" style={{ background: alertCount ? '#b91c1c' : '#15803d' }} />
              {alertCount === 0 ? '检查通过，无告警' : `${alertCount} 条告警待处理`}
            </span>
            <span className="stat">{Math.round(zoom * 100)}% 缩放</span>
            <span className="save-state">方案已自动保存到本地浏览器</span>
          </>
        )}
      </footer>

      {showFreeze && (
        <FreezeDialog
          booths={planner.booths}
          onCancel={() => setShowFreeze(false)}
          onConfirm={(name, assignments) => {
            build.freeze(planner.booths, name, assignments);
            setShowFreeze(false);
          }}
        />
      )}
    </div>
  );
}

/* ---------------- 搭建模式顶栏 ---------------- */

function BuildToolbar({
  build,
  onExit,
}: {
  build: ReturnType<typeof useBuildPlan>;
  onExit: () => void;
}) {
  return (
    <header className="toolbar build-toolbar">
      <div className="brand">
        <span className="logo build-logo">搭</span>
        <span>搭建波次交接</span>
        <small>{build.plan?.name}</small>
      </div>
      <div className="tb-group">
        <button className="tb" onClick={build.undo} disabled={!build.canUndo} title="撤销 (Ctrl+Z)">
          ↶ 撤销
        </button>
        <button className="tb" onClick={build.redo} disabled={!build.canRedo} title="重做 (Ctrl+Y)">
          ↷ 重做
        </button>
      </div>
      <div className="tb-group">
        <button
          className="tb"
          title="归档当前计划（用于日后两次搭建对比）并退出"
          onClick={() => {
            if (window.confirm('归档当前搭建并退出？归档后可与下一次搭建做对比。')) {
              build.archiveAndExit();
            }
          }}
        >
          🗂 归档并退出
        </button>
        <button className="tb danger-text" onClick={onExit}>
          暂离（保留现场）
        </button>
      </div>
      <div className="tb-spacer" />
      {build.archive.length > 0 && (
        <div className="tb-group">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) build.compareWith(e.target.value);
              e.target.value = '';
            }}
            title="与历史搭建对比"
          >
            <option value="">两次搭建对比…</option>
            {build.archive.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </header>
  );
}

function BuildBanner({
  build,
  selectedWaveId,
  historyCpId,
  onExitHistory,
}: {
  build: ReturnType<typeof useBuildPlan>;
  selectedWaveId: string;
  historyCpId: string | null;
  onExitHistory: () => void;
}) {
  const wave = build.plan?.waves.find((w) => w.id === selectedWaveId) ?? null;
  return (
    <div className="build-banner">
      {historyCpId ? (
        <>
          <b>📷 正在回看检查点证据</b>
          <span>画面为只读还原；关闭后回到当前现场。</span>
          <button className="tb" onClick={onExitHistory}>
            返回当前现场
          </button>
        </>
      ) : wave ? (
        <>
          <b>{wave.name}</b>
          <span>
            {wave.status === 'planned'
              ? '尚未开工：蓝色虚线为计划占地，开工后才能记录现场'
              : wave.status === 'active'
                ? '记录现场：可在图上拖动已安装/暂存件更新实测占地，每次记录自动重算并留证'
                : '已关闭：现场占地已冻结，迟到上报进入待核对区，可局部重演补录'}
          </span>
          {wave.status === 'active' && (
            <span className="banner-tip">提示：双击空白可在该位置登记临时堆放</span>
          )}
        </>
      ) : null}
    </div>
  );
}

function Legend({ inBuild }: { inBuild: boolean }) {
  if (!inBuild) {
    return (
      <div className="legend">
        <div className="row">
          <span className="swatch exit" /> 安全出口（绿色开口）
        </div>
        <div className="row">
          <span className="swatch path" /> 疏散路径（至最近出口）
        </div>
        <div className="row">
          <span className="swatch overlap" /> 重叠 / 越界 / 出口封堵
        </div>
        <div className="row">
          <span className="swatch clearance" /> 净空不足 1.5 m
        </div>
        <div className="row">
          <span className="swatch nopath" /> 接待点不可达
        </div>
      </div>
    );
  }
  return (
    <div className="legend">
      <div className="row">
        <span className="swatch ghost" /> 计划占地虚影
      </div>
      <div className="row">
        <span className="swatch legacy" /> 前序波次遗留（锁定）
      </div>
      <div className="row">
        <span className="swatch pile" /> 暂存/临时堆放（占通道）
      </div>
      <div className="row">
        <span className="swatch path" /> 真实平面疏散路径
      </div>
      <div className="row">
        <span className="swatch overlap" /> 重叠 / 出口封堵 / 不可达
      </div>
    </div>
  );
}
