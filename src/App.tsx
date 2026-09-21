import { useEffect, useState } from 'react';
import { usePlanner } from './state/usePlanner';
import { useBuilds } from './state/useBuilds';
import { Toolbar } from './components/Toolbar';
import { FloorPlan } from './components/FloorPlan';
import { AlertPanel } from './components/AlertPanel';
import { Inspector } from './components/Inspector';
import { BuildPanel } from './components/BuildPanel';
import { BuildFloorPlan } from './components/BuildFloorPlan';
import type { Alert } from './types';

type Mode = 'plan' | 'build';

export default function App() {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem('booth-planner:mode') === 'build'
        ? 'build'
        : 'plan';
    } catch {
      return 'plan';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('booth-planner:mode', mode);
    } catch {
      // ignore
    }
  }, [mode]);
  const planner = usePlanner({ shortcuts: mode === 'plan' });
  const builds = useBuilds();
  const [activeAlertId, setActiveAlertId] = useState<string | null>(null);
  const [showPaths, setShowPaths] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [buildView, setBuildView] = useState<'live' | 'plan'>('live');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const focusAlert = (alert: Alert) => {
    setActiveAlertId(alert.id);
    planner.selectBooth(alert.boothId);
  };

  const freezeFromCurrent = () => {
    if (planner.booths.length === 0) {
      window.alert('当前方案没有任何展位/围挡，无法冻结。请先在平面编辑里排好最终方案。');
      return;
    }
    builds.freeze(planner.booths);
    setSelectedItemId(null);
    setMode('build');
  };

  // 搭建模式下的撤销/重做快捷键作用于现场记录历史
  useEffect(() => {
    if (mode !== 'build') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        builds.undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        builds.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, builds]);

  const alertCount = planner.analysis.alerts.length;
  const buildCheck =
    buildView === 'plan'
      ? builds.previewCheck(builds.activeWaveIndex)
      : builds.liveFloor?.check ?? null;

  return (
    <div className="app">
      <Toolbar
        canUndo={mode === 'plan' ? planner.canUndo : builds.canUndo}
        canRedo={mode === 'plan' ? planner.canRedo : builds.canRedo}
        onUndo={mode === 'plan' ? planner.undo : builds.undo}
        onRedo={mode === 'plan' ? planner.redo : builds.redo}
        onAddBooth={planner.addBooth}
        onReset={planner.resetPlan}
        showPaths={showPaths}
        onTogglePaths={() => setShowPaths((v) => !v)}
        mode={mode}
        onToggleMode={() => setMode(mode === 'plan' ? 'build' : 'plan')}
        onFreeze={freezeFromCurrent}
      />

      <div className="workspace">
        {mode === 'plan' ? (
          <>
            <div className="canvas-wrap">
              <FloorPlan
                planner={planner}
                showPaths={showPaths}
                activeAlertId={activeAlertId}
                onActiveAlertChange={setActiveAlertId}
                onZoomChange={setZoom}
              />
              <div className="hint-chip">
                双击空白添加展位 · 拖动移动 · 手柄缩放 · <b>R</b> 旋转 ·
                滚轮缩放 · 拖空白平移
              </div>
              <Legend />
            </div>

            <div className="sidebar">
              <AlertPanel
                alerts={planner.analysis.alerts}
                activeAlertId={activeAlertId}
                onSelect={focusAlert}
              />
              <Inspector planner={planner} onAlertClick={focusAlert} />
            </div>
          </>
        ) : (
          <>
            <div className="canvas-wrap build-canvas">
              {builds.activePlan ? (
                <>
                  <div className="build-viewbar">
                    <div className="bv-seg">
                      <button
                        className={buildView === 'live' ? 'on' : ''}
                        onClick={() => setBuildView('live')}
                      >
                        现场真实平面
                      </button>
                      <button
                        className={buildView === 'plan' ? 'on' : ''}
                        onClick={() => setBuildView('plan')}
                      >
                        计划预演（≤ 第 {builds.activeWaveIndex} 波）
                      </button>
                    </div>
                    <span className={`bv-check ${buildCheck?.ok ? 'ok' : 'bad'}`}>
                      {buildCheck
                        ? buildCheck.ok
                          ? '✓ 检查通过'
                          : `✗ ${buildCheck.alertCount} 条告警`
                        : ''}
                    </span>
                  </div>
                  <BuildFloorPlan
                    builds={builds}
                    view={buildView}
                    selectedItemId={selectedItemId}
                    onSelect={setSelectedItemId}
                  />
                  <div className="hint-chip">
                    现场只读：在右侧记录到场/暂存/安装/移位/撤场与实测占地；
                    每次记录都按真实平面重算重叠·净空·出口·疏散
                  </div>
                  <BuildLegend />
                </>
              ) : (
                <div className="build-empty">
                  <p>还没有搭建计划。</p>
                  <p>先在「平面编辑」里排好最终方案（通过消防检查的绿色版本），</p>
                  <p>再点击顶部 <b>🧊 冻结搭建计划</b>，把展位、围挡分到不同波次。</p>
                  <button className="tb primary" onClick={freezeFromCurrent}>
                    🧊 从当前方案冻结
                  </button>
                </div>
              )}
            </div>

            <div className="sidebar build-sidebar">
              <BuildPanel
                builds={builds}
                selectedItemId={selectedItemId}
                onSelectItem={setSelectedItemId}
                onFreeze={freezeFromCurrent}
              />
            </div>
          </>
        )}
      </div>

      <footer className="statusbar">
        {mode === 'plan' ? (
          <>
            <span className="stat">展位 {planner.booths.length} 个</span>
            <span className="stat">
              <span
                className="dot"
                style={{ background: alertCount ? '#b91c1c' : '#15803d' }}
              />
              {alertCount === 0 ? '检查通过，无告警' : `${alertCount} 条告警待处理`}
            </span>
            <span className="stat">{Math.round(zoom * 100)}% 缩放</span>
            <span className="save-state">方案已自动保存到本地浏览器</span>
          </>
        ) : (
          <>
            <span className="stat">
              搭建计划 {builds.plans.length} 份
            </span>
            {builds.activePlan && (
              <>
                <span className="stat">当班班组：<b>{builds.activePlan.crew}</b></span>
                <span className="stat">
                  已安装 {builds.activePlan.items.filter((i) => i.status === 'installed').length} ·
                  暂存 {builds.activePlan.items.filter((i) => i.status === 'staging').length} ·
                  撤场 {builds.activePlan.items.filter((i) => i.status === 'removed').length}
                </span>
                <span className="stat">
                  <span
                    className="dot"
                    style={{ background: buildCheck && !buildCheck.ok ? '#b91c1c' : '#15803d' }}
                  />
                  {buildCheck
                    ? buildCheck.ok
                      ? `${buildView === 'plan' ? '预演' : '现场'}检查通过`
                      : `${buildView === 'plan' ? '预演' : '现场'}${buildCheck.alertCount} 条告警`
                    : '—'}
                </span>
                <span className="stat">
                  待核对回执 {builds.activePlan.lateChecks.filter((c) => c.resolution === 'pending').length} 条
                </span>
              </>
            )}
            <span className="save-state">现场记录自动保存，刷新可继续（中断续作）</span>
          </>
        )}
      </footer>
    </div>
  );
}

function Legend() {
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

function BuildLegend() {
  return (
    <div className="legend">
      <div className="row"><span className="swatch plan-ghost" /> 未进场对象的计划位（虚影）</div>
      <div className="row"><span className="swatch storage" /> 暂存货箱 / 临时堆放</div>
      <div className="row"><span className="swatch path" /> 按真实平面重算的疏散路径</div>
      <div className="row"><span className="swatch overlap" /> 占地重叠 / 出口封堵</div>
      <div className="row"><span className="swatch nopath" /> 接待点不可达（通道被堵）</div>
    </div>
  );
}
