/**
 * 搭建现场画布（只读 + 点选）：
 * - 真实楼层：已安装物按实测占地实绘，暂存物用琥珀色斜纹；未到场对象不占平面。
 * - 告警与路径来自按当前真实平面重算的 check（每次现场记录都会变化），
 *   与平面编辑器共用同一套几何/校验/寻路，不另造结论。
 * - 计划模式：按计划位推演当前波（含）之前装完的样子，用于波次预演。
 * - 活动波次里尚未到场的对象以虚线虚影显示“计划位”，与真实现场并存而不混淆。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { Booth, PlannedItem, Point } from '../types';
import type { BuildsApi } from '../state/useBuilds';
import {
  EXITS,
  GRID_SIZE,
  HALL_HEIGHT,
  HALL_WIDTH,
} from '../constants';
import {
  footprint,
  frontEdgeLocal,
  frontPointLocal,
  intersectionPolygon,
} from '../lib/geometry';

interface Props {
  builds: BuildsApi;
  view: 'live' | 'plan';
  selectedItemId: string | null;
  onSelect: (id: string | null) => void;
}

export function BuildFloorPlan({ builds, view, selectedItemId, onSelect }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [scale, setScale] = useState(40);
  const [size, setSize] = useState({ w: 1000, h: 700 });

  useLayoutEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const fit = () => {
      const s = Math.min(
        (el.clientWidth - 60) / HALL_WIDTH,
        (el.clientHeight - 80) / HALL_HEIGHT,
      );
      setScale(s);
      setSize({ w: el.clientWidth, h: el.clientHeight });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plan = builds.activePlan;
  const check =
    view === 'plan'
      ? builds.previewCheck(builds.activeWaveIndex)
      : builds.liveFloor?.check ?? null;
  if (!plan || !check) return null;

  // 平面上的对象
  const ghostItems: PlannedItem[] =
    view === 'live'
      ? plan.items.filter(
          (it) =>
            it.wave === builds.activeWaveIndex &&
            (it.status === 'pending' || it.status === 'arrived'),
        )
      : plan.items.filter(
          (it) => it.wave > 0 && it.wave <= builds.activeWaveIndex,
        );

  const liveItems =
    view === 'live'
      ? plan.items.filter(
          (it) => it.status === 'installed' || it.status === 'staging',
        )
      : [];

  const installedBooths = liveItems
    .filter((it) => it.status === 'installed')
    .map((it) => ({ it, b: builds.effectiveBooth(it) }));
  const stagingBooths = liveItems
    .filter((it) => it.status === 'staging')
    .map((it) => ({ it, b: builds.effectiveBooth(it) }));

  const allBooths = [...installedBooths.map((x) => x.b), ...stagingBooths.map((x) => x.b)];

  // 重叠区域（与实时校验同源算法）
  const overlapRegions: Point[][] = [];
  for (let i = 0; i < allBooths.length; i++) {
    for (let j = i + 1; j < allBooths.length; j++) {
      const a = allBooths[i];
      const c = allBooths[j];
      if (a.kind === 'partition' && c.kind === 'partition') continue;
      const reg = intersectionPolygon(footprint(a), footprint(c));
      if (reg) overlapRegions.push(reg);
    }
  }

  const alertItemIds = new Set<string>();
  for (const a of check.alerts) {
    alertItemIds.add(a.boothId);
    if (a.relatedBoothId) alertItemIds.add(a.relatedBoothId);
  }

  const panX = (size.w - HALL_WIDTH * scale) / 2;
  const panY = (size.h - HALL_HEIGHT * scale) / 2 - 4;
  const u = 1 / scale;

  return (
    <svg ref={svgRef}>
      <defs>
        <pattern id="b-hatch-red" patternUnits="userSpaceOnUse" width={0.22} height={0.22} patternTransform="rotate(45)">
          <rect width={0.22} height={0.22} fill="rgba(185,28,28,0.18)" />
          <line x1="0" y1="0" x2="0" y2={0.22} stroke="#b91c1c" strokeWidth={0.05} />
        </pattern>
        <pattern id="b-hatch-storage" patternUnits="userSpaceOnUse" width={0.5} height={0.4}>
          <rect width={0.5} height={0.4} fill="#fde68a" />
          <line x1="0" y1="0" x2="0.5" y2="0.4" stroke="#b45309" strokeWidth={0.03} />
          <line x1="0.5" y1="0" x2="0" y2="0.4" stroke="#b45309" strokeWidth={0.03} />
        </pattern>
      </defs>

      <g transform={`translate(${panX},${panY}) scale(${scale})`}>
        <rect x={-1.2} y={-1.2} width={HALL_WIDTH + 2.4} height={HALL_HEIGHT + 2.4} rx={0.15} fill="#cdd4de" />
        <rect x={0} y={0} width={HALL_WIDTH} height={HALL_HEIGHT} fill="#fcfdfe" onClick={() => onSelect(null)} />

        {/* 网格 */}
        <g pointerEvents="none">
          {Array.from({ length: HALL_WIDTH / GRID_SIZE + 1 }, (_, i) => (
            <line key={`gx${i}`} x1={i * GRID_SIZE} y1={0} x2={i * GRID_SIZE} y2={HALL_HEIGHT}
              stroke={i % 2 === 0 ? '#d3dae4' : '#e8edf3'} strokeWidth={(i % 2 === 0 ? 1 : 0.6) * u} />
          ))}
          {Array.from({ length: HALL_HEIGHT / GRID_SIZE + 1 }, (_, i) => (
            <line key={`gy${i}`} x1={0} y1={i * GRID_SIZE} x2={HALL_WIDTH} y2={i * GRID_SIZE}
              stroke={i % 2 === 0 ? '#d3dae4' : '#e8edf3'} strokeWidth={(i % 2 === 0 ? 1 : 0.6) * u} />
          ))}
        </g>

        {/* 疏散路径（真实/预演） */}
        {Object.entries(check.paths).map(([id, path]) =>
          path.length < 2 ? null : (
            <polyline
              key={`p-${id}`}
              points={path.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke="#15803d"
              strokeWidth={(id === selectedItemId ? 3.4 : 2) * u}
              strokeDasharray={`${0.28} ${0.2}`}
              opacity={id === selectedItemId ? 0.95 : 0.45}
              strokeLinecap="round"
              strokeLinejoin="round"
              pointerEvents="none"
            />
          ),
        )}

        {/* 重叠区域 */}
        {overlapRegions.map((poly, i) => (
          <polygon key={`ov${i}`} points={poly.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="url(#b-hatch-red)" stroke="#b91c1c" strokeWidth={1.2 * u} pointerEvents="none" />
        ))}

        {/* 计划虚影 */}
        {view === 'live' &&
          ghostItems.map((it) => (
            <GhostBooth key={`g-${it.id}`} b={it.plan} u={u} />
          ))}

        {/* 已安装物 */}
        {installedBooths.map(({ it, b }) => (
          <ItemRect
            key={b.id}
            item={it}
            b={b}
            u={u}
            state={it.status}
            selected={b.id === selectedItemId}
            alert={alertItemIds.has(b.id)}
            reachable={(check.paths[b.id]?.length ?? 0) > 0}
            onSelect={onSelect}
          />
        ))}
        {/* 暂存物 */}
        {stagingBooths.map(({ it, b }) => (
          <ItemRect
            key={b.id}
            item={it}
            b={b}
            u={u}
            state={it.status}
            selected={b.id === selectedItemId}
            alert={alertItemIds.has(b.id)}
            reachable
            onSelect={onSelect}
          />
        ))}

        {/* 计划预演模式下的对象 */}
        {view === 'plan' &&
          ghostItems.map((it) => (
            <PlanBooth key={`pb-${it.id}`} b={it.plan} id={it.id} u={u}
              selected={it.id === selectedItemId}
              alert={alertItemIds.has(it.id)}
              reachable={(check.paths[it.id]?.length ?? 0) > 0}
              onSelect={onSelect}
            />
          ))}

        <SimpleWalls blockedExitIds={check.blockedExitIds} />
      </g>
    </svg>
  );
}

/* ---------- 子组件 ---------- */

function GhostBooth({ b, u }: { b: Booth; u: number }) {
  const deg = (b.rotation * 180) / Math.PI;
  const isStorage = b.kind === 'storage';
  return (
    <g transform={`rotate(${deg} ${b.x} ${b.y})`} opacity={0.5} pointerEvents="none">
      <rect x={0} y={0} width={b.w} height={b.h} rx={0.06}
        fill={isStorage ? '#fef3c7' : '#eef2f7'}
        stroke={isStorage ? '#b45309' : '#94a3b8'}
        strokeWidth={1 * u}
        strokeDasharray={`${0.2} ${0.12}`}
      />
      <text x={b.w / 2} y={b.h / 2 + 0.05} textAnchor="middle" fontSize={0.22}
        fill={isStorage ? '#92400e' : '#64748b'} fontWeight={700}>
        {b.label}
      </text>
    </g>
  );
}

function ItemRect({
  item, b, u, state, selected, alert, reachable, onSelect,
}: {
  item: PlannedItem;
  b: Booth;
  u: number;
  state: string;
  selected: boolean;
  alert: boolean;
  reachable: boolean;
  onSelect: (id: string | null) => void;
}) {
  void item;
  const deg = (b.rotation * 180) / Math.PI;
  const isPartition = b.kind === 'partition';
  const isStorage = b.kind === 'storage';
  const staging = state === 'staging';
  const [fp1, fp2] = frontEdgeLocal(b);
  const recv = frontPointLocal(b, 0.25);
  const corner = footprint(b)[0];

  return (
    <>
      <g transform={`rotate(${deg} ${b.x} ${b.y})`} style={{ cursor: 'pointer' }}
        onPointerDown={(e) => { e.stopPropagation(); onSelect(b.id); }}>
        {isStorage || staging ? (
          <rect x={0} y={0} width={b.w} height={b.h} rx={0.06}
            fill="url(#b-hatch-storage)" stroke="#b45309" strokeWidth={(selected ? 2.6 : 1.4) * u} />
        ) : (
          <rect x={0} y={0} width={b.w} height={b.h} rx={0.06}
            fill={isPartition ? '#a1887f' : b.color}
            fillOpacity={alert ? 0.55 : 0.88}
            stroke={selected ? '#1d4ed8' : '#1f2937'}
            strokeWidth={(selected ? 2.6 : 1.4) * u}
          />
        )}
        {staging && (
          <rect x={0} y={0} width={b.w} height={b.h} rx={0.06} fill="none"
            stroke="#b45309" strokeWidth={2.4 * u} strokeDasharray={`${0.16} ${0.12}`} pointerEvents="none" />
        )}
        {alert && !staging && (
          <rect x={0} y={0} width={b.w} height={b.h} rx={0.06} fill="none"
            stroke="#b91c1c" strokeWidth={2.2 * u} strokeDasharray={`${0.3} ${0.14}`} pointerEvents="none" />
        )}
        {!isPartition && !isStorage && (
          <line x1={fp1.x} y1={fp1.y} x2={fp2.x} y2={fp2.y}
            stroke="#f8fafc" strokeWidth={3 * u} strokeLinecap="round" pointerEvents="none" />
        )}
        <text
          x={b.w / 2}
          y={b.h / 2 + (isPartition || isStorage ? 0.04 : -0.05)}
          textAnchor="middle"
          fontSize={Math.min(isStorage ? 0.26 : 0.3, Math.max(0.2, (isStorage ? Math.max(b.w, b.h) : b.h) * 0.26))}
          fill={isPartition || isStorage ? '#4e342e' : '#fff'}
          fontWeight={700}
          pointerEvents="none"
          transform={isPartition && b.h > b.w ? `rotate(-90 ${b.w / 2} ${b.h / 2})` : undefined}
        >
          {b.label}
          {staging ? '（暂存）' : isStorage ? '' : isPartition ? '（围挡）' : ''}
        </text>
        {!isPartition && !isStorage && (
          <>
            <circle cx={recv.x} cy={recv.y} r={0.1} fill="#fff"
              stroke={reachable ? '#15803d' : '#6d28d9'} strokeWidth={2 * u} pointerEvents="none" />
            {!reachable && (
              <g pointerEvents="none">
                <line x1={recv.x - 0.09} y1={recv.y - 0.09} x2={recv.x + 0.09} y2={recv.y + 0.09} stroke="#6d28d9" strokeWidth={2.2 * u} />
                <line x1={recv.x + 0.09} y1={recv.y - 0.09} x2={recv.x - 0.09} y2={recv.y + 0.09} stroke="#6d28d9" strokeWidth={2.2 * u} />
              </g>
            )}
          </>
        )}
      </g>
      <g pointerEvents="none">
        {staging && (
          <g>
            <circle cx={corner.x + 0.15} cy={corner.y - 0.15} r={0.15} fill="#b45309" stroke="#fff" strokeWidth={1.4 * u} />
            <text x={corner.x + 0.15} y={corner.y - 0.085} textAnchor="middle" fontSize={0.19} fill="#fff" fontWeight={700}>暂</text>
          </g>
        )}
        {alert && (
          <g>
            <circle cx={corner.x + (staging ? 0.5 : 0.18)} cy={corner.y - 0.15} r={0.15} fill="#b91c1c" stroke="#fff" strokeWidth={1.4 * u} />
            <text x={corner.x + (staging ? 0.5 : 0.18)} y={corner.y - 0.085} textAnchor="middle" fontSize={0.19} fill="#fff" fontWeight={700}>!</text>
          </g>
        )}
      </g>
    </>
  );
}

function PlanBooth({
  b, id, u, selected, alert, reachable, onSelect,
}: {
  b: Booth;
  id: string;
  u: number;
  selected: boolean;
  alert: boolean;
  reachable: boolean;
  onSelect: (id: string | null) => void;
}) {
  const deg = (b.rotation * 180) / Math.PI;
  const isPartition = b.kind === 'partition';
  const isStorage = b.kind === 'storage';
  const [fp1, fp2] = frontEdgeLocal(b);
  const recv = frontPointLocal(b, 0.25);
  return (
    <g transform={`rotate(${deg} ${b.x} ${b.y})`} style={{ cursor: 'pointer' }}
      onPointerDown={(e) => { e.stopPropagation(); onSelect(id); }}>
      <rect x={0} y={0} width={b.w} height={b.h} rx={0.06}
        fill={isStorage ? '#fef3c7' : isPartition ? '#d7ccc8' : '#dbeafe'}
        fillOpacity={0.9}
        stroke={alert ? '#b91c1c' : selected ? '#1d4ed8' : '#64748b'}
        strokeWidth={(selected || alert ? 2.4 : 1.2) * u}
        strokeDasharray={alert ? `${0.3} ${0.14}` : undefined}
      />
      {!isPartition && !isStorage && (
        <line x1={fp1.x} y1={fp1.y} x2={fp2.x} y2={fp2.y}
          stroke="#fff" strokeWidth={3 * u} strokeLinecap="round" pointerEvents="none" />
      )}
      <text x={b.w / 2} y={b.h / 2 + 0.05} textAnchor="middle" fontSize={0.24}
        fill={isStorage ? '#92400e' : isPartition ? '#4e342e' : '#1e3a8a'} fontWeight={700} pointerEvents="none">
        {b.label}
      </text>
      {!isPartition && !isStorage && (
        <circle cx={recv.x} cy={recv.y} r={0.1} fill="#fff"
          stroke={reachable ? '#15803d' : '#6d28d9'} strokeWidth={2 * u} pointerEvents="none" />
      )}
    </g>
  );
}

function SimpleWalls({ blockedExitIds }: { blockedExitIds: string[] }) {
  const t = 0.22;
  return (
    <g pointerEvents="none">
      <rect x={-t / 2} y={0} width={t} height={HALL_HEIGHT} fill="#475569" />
      <rect x={HALL_WIDTH - t / 2} y={0} width={t} height={HALL_HEIGHT} fill="#475569" />
      {EXITS.filter((e) => e.wall === 'north').map((e) => (
        <g key={e.id}>
          <rect x={0} y={-t / 2} width={e.start} height={t} fill="#475569" />
          <rect x={e.end} y={-t / 2} width={HALL_WIDTH - e.end} height={t} fill="#475569" />
        </g>
      ))}
      {EXITS.filter((e) => e.wall === 'south').map((e) => (
        <g key={e.id}>
          <rect x={0} y={HALL_HEIGHT - t / 2} width={e.start} height={t} fill="#475569" />
          <rect x={e.end} y={HALL_HEIGHT - t / 2} width={HALL_WIDTH - e.end} height={t} fill="#475569" />
        </g>
      ))}
      {EXITS.map((e) => {
        const blocked = blockedExitIds.includes(e.id);
        const color = blocked ? '#b91c1c' : '#15803d';
        const horizontal = e.wall === 'north' || e.wall === 'south';
        const mid = (e.start + e.end) / 2;
        const x = horizontal ? mid : e.wall === 'east' ? HALL_WIDTH + 0.78 : -0.78;
        const y = horizontal ? (e.wall === 'south' ? HALL_HEIGHT + 0.62 : -0.62) : mid;
        return (
          <g key={`label-${e.id}`}>
            <rect x={x - 0.62} y={y - 0.2} width={1.24} height={0.4} rx={0.06} fill={color} />
            <text x={x} y={y + 0.06} textAnchor="middle" fontSize={0.26} fill="#fff" fontWeight={700}>
              {blocked ? '出口堵死' : '安全出口'}
            </text>
          </g>
        );
      })}
    </g>
  );
}
