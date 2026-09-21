/**
 * 搭建波次交接面板：
 * 计划冻结/切换、班组交接、波次管理（新增/提前关闭/局部重演）、
 * 现场记录（到场/暂存/安装/移位/实测/撤场）、临时改线（仅未执行）、
 * 计划 vs 实测差异证据、待核对区（迟到检查回执）、事件日志、两次搭建对比。
 */
import { useState } from 'react';
import type { Booth, PlannedItem } from '../types';
import type { BuildsApi } from '../state/useBuilds';
import { statusLabel } from '../lib/builds';
import type { RecordAction } from '../lib/builds';

interface Props {
  builds: BuildsApi;
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  onFreeze: () => void;
}

const STATUS_CLS: Record<string, string> = {
  pending: 'st-pending',
  arrived: 'st-arrived',
  staging: 'st-staging',
  installed: 'st-installed',
  removed: 'st-removed',
};

const ACTION_TEXT: Record<RecordAction, string> = {
  arrive: '到场',
  stage: '暂存',
  install: '安装',
  move: '移位',
  measure: '实测占地',
  remove: '撤场',
};

export function BuildPanel({ builds, selectedItemId, onSelectItem, onFreeze }: Props) {
  const plan = builds.activePlan;
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);

  return (
    <div className="build-panel">
      {/* 计划选择 / 冻结 */}
      <div className="bp-block">
        <div className="bp-row">
          <select
            className="bp-select"
            value={plan?.id ?? ''}
            onChange={(e) => builds.selectPlan(e.target.value)}
          >
            {builds.plans.length === 0 && <option value="">（暂无冻结计划）</option>}
            {builds.plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.frozenAt.slice(0, 10)}）
              </option>
            ))}
          </select>
        </div>
        <div className="bp-row">
          <button className="tb primary" style={{ flex: 1 }} onClick={onFreeze}
            title="从当前平面方案冻结一份新的搭建计划（深拷贝快照，之后互不影响）">
            🧊 从当前方案冻结新计划
          </button>
        </div>
        {plan && (
          <div className="bp-row">
            <button className="tb" onClick={builds.undo} disabled={!builds.canUndo}>↶ 撤销</button>
            <button className="tb" onClick={builds.redo} disabled={!builds.canRedo}>↷ 重做</button>
            <button
              className="tb danger-text"
              onClick={() => {
                if (window.confirm('确定删除这份搭建计划及其全部现场记录？')) {
                  builds.deletePlan(plan.id);
                  onSelectItem(null);
                }
              }}
            >
              删除计划
            </button>
          </div>
        )}
        {builds.error && (
          <div className="bp-error">
            ⚠ {builds.error}
            <button className="bp-error-x" onClick={builds.clearError}>×</button>
          </div>
        )}
      </div>

      {plan && (
        <>
          {/* 班组交接 */}
          <div className="bp-block bp-crew">
            <div>
              当前班组：<b>{plan.crew}</b>
              <span className="bp-sub">
                已交接 {plan.handovers.length} 次
              </span>
            </div>
            <button className="tb" onClick={() => setHandoverOpen((v) => !v)}>
              🤝 班组交接
            </button>
          </div>
          {handoverOpen && (
            <HandoverForm
              onCancel={() => setHandoverOpen(false)}
              onSubmit={(to, note) => {
                if (builds.handoverTo(to, note)) setHandoverOpen(false);
              }}
            />
          )}

          {/* 波次 */}
          <div className="bp-wavetabs">
            {plan.waves.map((w) => (
              <button
                key={w.index}
                className={w.index === builds.activeWaveIndex ? 'on' : ''}
                onClick={() => builds.setActiveWaveIndex(w.index)}
              >
                {w.name}
                {w.status === 'closed' && <em className="wv-closed">已关闭</em>}
              </button>
            ))}
            <button className="bp-addwave" onClick={builds.addNewWave} title="新增波次">＋波</button>
          </div>

          <WaveSection builds={builds} selectedItemId={selectedItemId} onSelectItem={onSelectItem} />

          {/* 折叠区 */}
          <Collapsible title={`计划 vs 实测差异（${builds.diffs.length}）`}>
            <DiffList builds={builds} onSelectItem={onSelectItem} />
          </Collapsible>

          <Collapsible title={`待核对区（${plan.lateChecks.length}）`} badge={plan.lateChecks.filter((c) => c.resolution === 'pending').length}>
            <LateChecks builds={builds} />
          </Collapsible>

          <Collapsible title={`交接记录（${plan.handovers.length}）`}>
            <div className="bp-log">
              {plan.handovers.length === 0 && <div className="bp-muted">暂无交接</div>}
              {[...plan.handovers].reverse().map((h) => (
                <div key={h.id} className="bp-logline">
                  <b>{fmtTime(h.at)}</b> {h.from} → {h.to}
                  {h.note && <div className="bp-muted">“{h.note}”</div>}
                </div>
              ))}
            </div>
          </Collapsible>

          <Collapsible title={`现场记录（${plan.events.length}）`} defaultOpen={false}>
            <EventLog builds={builds} onSelectItem={onSelectItem} />
          </Collapsible>

          <div className="bp-block">
            <button className="tb" style={{ width: '100%' }} onClick={() => setCompareOpen((v) => !v)}>
              📊 两次搭建对比
            </button>
            {compareOpen && (
              <CompareView builds={builds} onClose={() => setCompareOpen(false)} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ========================= 波次与对象列表 ========================= */

function WaveSection({
  builds,
  selectedItemId,
  onSelectItem,
}: {
  builds: BuildsApi;
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
}) {
  const wave = builds.activeWave;
  const items = builds.itemsByWave.get(wave?.index ?? -1) ?? [];
  const [renaming, setRenaming] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);

  if (!wave) return null;
  const closed = wave.status === 'closed';
  const check = wave.lastCheck ?? builds.liveFloor?.check ?? null;

  return (
    <div className="bp-block">
      <div className="bp-wavehead">
        {renaming ? (
          <input
            className="bp-input"
            defaultValue={wave.name}
            autoFocus
            onBlur={(e) => {
              builds.renameActiveWave(e.target.value || wave.name);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button className="bp-wavename" onClick={() => setRenaming(true)}>
            {wave.name} ✎
          </button>
        )}
        <span className={`bp-wavestatus ${closed ? 'closed' : 'open'}`}>
          {closed ? '已提前关闭' : '进行中'}
        </span>
      </div>

      {/* 波次操作 */}
      <div className="bp-row">
        <button
          className="tb"
          disabled={closed}
          title="按当前真实平面重新检查本波并留证；关闭后将进入待核对区"
          onClick={builds.rerunActiveWave}
        >
          🔄 局部重演/复查
        </button>
        <button
          className="tb danger-text"
          disabled={closed}
          title="未装完也可提前关闭；关闭后该波事实冻结"
          onClick={() => {
            if (window.confirm(`提前关闭${wave.name}？关闭后该波不能再记录或改线，迟到检查将进入待核对区。`)) {
              builds.closeActiveWave();
            }
          }}
        >
          🔒 提前关闭
        </button>
      </div>

      {/* 最近检查 */}
      {check && (
        <div className={`bp-check ${check.ok ? 'ok' : 'bad'}`}>
          <div>
            {check.ok ? '✓ 当前真实平面检查通过' : `✗ ${check.alertCount} 条告警（重叠/净空/出口/疏散）`}
          {closed && <span className="bp-sub"> · 关闭结论已冻结</span>}
          {!check.ok && (
            <ul className="bp-checkalerts">
              {check.alerts.slice(0, 4).map((a) => (
                <li key={a.id}>{a.message}</li>
              ))}
              {check.alerts.length > 4 && <li>…共 {check.alerts.length} 条</li>}
            </ul>
          )}
          </div>
          <div className="bp-sub">
            {fmtTime(check.at)} · {check.crew}
          </div>
        </div>
      )}

      {/* 对象列表 */}
      <div className="bp-items">
        {items.length === 0 && <div className="bp-muted">本波暂无对象</div>}
        {items.map((it) => (
          <ItemRow
            key={it.id}
            builds={builds}
            item={it}
            selected={it.id === selectedItemId}
            onSelect={() => onSelectItem(it.id === selectedItemId ? null : it.id)}
            closed={closed}
          />
        ))}
      </div>

      {/* 新增临时堆放（计划位） */}
      <button className="tb bp-addstorage" disabled={closed} onClick={() => setStorageOpen((v) => !v)}>
        ＋ 添加临时堆放（计划）
      </button>
      {storageOpen && !closed && (
        <StorageForm
          onCancel={() => setStorageOpen(false)}
          onSubmit={(spot) => {
            if (builds.addStorage(wave.index, spot)) setStorageOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ItemRow({
  builds,
  item,
  selected,
  onSelect,
  closed,
}: {
  builds: BuildsApi;
  item: PlannedItem;
  selected: boolean;
  onSelect: () => void;
  closed: boolean;
}) {
  const [form, setForm] = useState<null | 'move' | 'measure' | 'replan'>(null);
  const plan = builds.activePlan!;
  const it = item;
  const b = it.actual ?? it.plan;
  const editable = it.status === 'pending' && !closed;
  const kindIcon =
    it.plan.kind === 'storage' ? '📦' : it.plan.kind === 'partition' ? '🧱' : '🏬';

  const record = (action: RecordAction, fp?: Booth) =>
    builds.record(it.id, action, fp);

  return (
    <div className={`bp-item ${selected ? 'selected' : ''} ${STATUS_CLS[it.status]}`}>
      <div className="bp-item-head" onClick={onSelect}>
        <span className="bp-itemicon">{kindIcon}</span>
        <span className="bp-itemlabel">{it.plan.label}</span>
        <span className={`bp-status ${STATUS_CLS[it.status]}`}>{statusLabel(it.status)}</span>
      </div>

      {it.actual && (
        <div className="bp-itempos">
          实测 ({fmtNum(b.x)}, {fmtNum(b.y)}) {fmtNum(b.w)}×{fmtNum(b.h)} m
        </div>
      )}

      {/* 现场操作 */}
      <div className="bp-itemactions">
        {it.status === 'pending' && (
          <button className="tb mini" disabled={closed} onClick={() => record('arrive')}>到场</button>
        )}
        {(it.status === 'pending' || it.status === 'arrived') && (
          <button className="tb mini" disabled={closed} onClick={() => record('stage')}>暂存</button>
        )}
        {(it.status === 'pending' || it.status === 'arrived' || it.status === 'staging') && (
          <button className="tb mini primary" disabled={closed} onClick={() => record('install')}>安装</button>
        )}
        {(it.status === 'staging' || it.status === 'installed') && (
          <button className="tb mini" disabled={closed} onClick={() => setForm(form === 'move' ? null : 'move')}>移位</button>
        )}
        {(it.status === 'arrived' || it.status === 'staging' || it.status === 'installed') && (
          <button className="tb mini" disabled={closed} onClick={() => setForm(form === 'measure' ? null : 'measure')}>实测</button>
        )}
        {(it.status === 'staging' || it.status === 'installed') && (
          <button className="tb mini danger-text" disabled={closed} onClick={() => record('remove')}>撤场</button>
        )}
        {it.status === 'removed' && <span className="bp-muted">已撤场，不再参与平面</span>}
      </div>

      {/* 移位/实测表单 */}
      {form && (form === 'move' || form === 'measure') && (
        <FootprintForm
          initial={it.actual ?? it.plan}
          requireGeometry={form === 'move'}
          actionLabel={ACTION_TEXT[form]}
          onCancel={() => setForm(null)}
          onSubmit={(fp) => {
            if (record(form, fp)) setForm(null);
          }}
        />
      )}

      {/* 临时改线（仅 pending + 开放波次） */}
      {it.status === 'pending' && (
        <div className="bp-replan">
          <select
            className="bp-select mini"
            value={it.wave}
            disabled={closed}
            onChange={(e) => builds.changeWave(it.id, Number(e.target.value))}
          >
            {plan.waves.map((w) => (
              <option key={w.index} value={w.index} disabled={w.status === 'closed'}>
                第 {w.index} 波{w.status === 'closed' ? '（关闭）' : ''}
              </option>
            ))}
          </select>
          <button className="tb mini" disabled={closed} onClick={() => setForm(form === 'replan' ? null : 'replan')}>
            改计划位
          </button>
          <button className="tb mini danger-text" disabled={closed} onClick={() => builds.dropPending(it.id)}>
            删除
          </button>
        </div>
      )}
      {form === 'replan' && editable && (
        <FootprintForm
          initial={it.plan}
          requireGeometry
          actionLabel="保存改线"
          allowLabel={false}
          onCancel={() => setForm(null)}
          onSubmit={(fp) => {
            if (
              builds.changeGeometry(it.id, {
                x: fp.x,
                y: fp.y,
                w: fp.w,
                h: fp.h,
                rotation: fp.rotation,
              })
            )
              setForm(null);
          }}
        />
      )}
    </div>
  );
}

/* ========================= 表单 ========================= */

function numField(label: string, value: number, onChange: (v: number) => void, step = 0.5) {
  return (
    <label className="bp-numfield">
      {label}
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function FootprintForm({
  initial,
  actionLabel,
  onSubmit,
  onCancel,
  requireGeometry = true,
  allowLabel = true,
}: {
  initial: Booth;
  actionLabel: string;
  onSubmit: (fp: Booth) => void;
  onCancel: () => void;
  requireGeometry?: boolean;
  allowLabel?: boolean;
}) {
  const [x, setX] = useState(initial.x);
  const [y, setY] = useState(initial.y);
  const [w, setW] = useState(initial.w);
  const [h, setH] = useState(initial.h);
  const [label, setLabel] = useState(initial.label);

  return (
    <div className="bp-form">
      <div className="bp-formgrid">
        {numField('x', x, setX)}
        {numField('y', y, setY)}
        {numField('宽', w, setW)}
        {numField('高', h, setH)}
      </div>
      {allowLabel && (
        <input
          className="bp-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="名称"
        />
      )}
      <div className="bp-row">
        <button
          className="tb mini primary"
          onClick={() =>
            onSubmit({
              ...initial,
              x: round2(x),
              y: round2(y),
              w: Math.max(0.5, round2(w)),
              h: Math.max(0.5, round2(h)),
              label: label.trim() || initial.label,
            })
          }
        >
          {actionLabel}
        </button>
        <button className="tb mini" onClick={onCancel}>取消</button>
      </div>
      {!requireGeometry && (
        <div className="bp-muted">不填坐标时按当前占地记录；“移位”必须填写新位置。</div>
      )}
    </div>
  );
}

function StorageForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (spot: { x: number; y: number; w: number; h: number; label?: string }) => void;
  onCancel: () => void;
}) {
  const [x, setX] = useState(8);
  const [y, setY] = useState(5);
  const [w, setW] = useState(2);
  const [h, setH] = useState(2);
  const [label, setLabel] = useState('');
  return (
    <div className="bp-form">
      <div className="bp-formgrid">
        {numField('x', x, setX)}
        {numField('y', y, setY)}
        {numField('宽', w, setW)}
        {numField('高', h, setH)}
      </div>
      <input className="bp-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名称（如：北出口材料堆）" />
      <div className="bp-row">
        <button
          className="tb mini primary"
          onClick={() =>
            onSubmit({ x: round2(x), y: round2(y), w: Math.max(0.5, round2(w)), h: Math.max(0.5, round2(h)), label: label.trim() || undefined })
          }
        >
          加入本波
        </button>
        <button className="tb mini" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

function HandoverForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (to: string, note: string) => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="bp-form">
      <input className="bp-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="接班班组（如：乙班）" autoFocus />
      <input className="bp-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="交接备注（现场遗留问题、材料位置）" />
      <div className="bp-row">
        <button className="tb mini primary" disabled={!to.trim()} onClick={() => onSubmit(to.trim(), note)}>
          完成交接
        </button>
        <button className="tb mini" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/* ========================= 折叠区 ========================= */

function Collapsible({
  title,
  children,
  badge,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  badge?: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bp-collapsible">
      <button className="bp-collapse-head" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'} {title}</span>
        {badge ? <span className="bp-badge">{badge}</span> : null}
      </button>
      {open && <div className="bp-collapse-body">{children}</div>}
    </div>
  );
}

function DiffList({
  builds,
  onSelectItem,
}: {
  builds: BuildsApi;
  onSelectItem: (id: string | null) => void;
}) {
  const diffs = builds.diffs;
  if (diffs.length === 0) return <div className="bp-muted">暂无实测记录；有实测占地后这里会列出计划与实际的差异证据。</div>;
  return (
    <div className="bp-diffs">
      {diffs.map((d) => (
        <button key={d.itemId} className="bp-diff" onClick={() => onSelectItem(d.itemId)}>
          <div>
            <b>{d.label}</b>
            {d.geometryChanged ? (
              <span className="bp-diff-bad">几何不同 · 位移 {d.shift} m</span>
            ) : (
              <span className="bp-diff-ok">几何一致</span>
            )}
          </div>
          <div className="bp-muted">
            计划 ({fmtNum(d.plan.x)}, {fmtNum(d.plan.y)}) {fmtNum(d.plan.w)}×{fmtNum(d.plan.h)}
            {' → '}
            实测 ({fmtNum(d.actual.x)}, {fmtNum(d.actual.y)}) {fmtNum(d.actual.w)}×{fmtNum(d.actual.h)}
          </div>
        </button>
      ))}
    </div>
  );
}

function LateChecks({ builds }: { builds: BuildsApi }) {
  const plan = builds.activePlan!;
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (plan.lateChecks.length === 0)
    return <div className="bp-muted">关闭波次后的迟到检查回执会出现在这里，等待人工核对。</div>;
  return (
    <div className="bp-late">
      {[...plan.lateChecks].reverse().map((c) => (
        <div key={c.id} className={`bp-latecard ${c.resolution ?? 'pending'}`}>
          <div>
            第 {c.waveIndex} 波迟到检查 · {fmtTime(c.at)} · {c.crew}
          {c.resolution && <b className={`bp-late-${c.resolution}`}>
            {c.resolution === 'confirmed' ? '已确认一致' : '已标记冲突'}
          </b>}
          </div>
          <div className={c.check.ok ? 'bp-late-ok' : 'bp-late-bad'}>
            {c.check.ok ? '回执结论：通过' : `回执结论：${c.check.alertCount} 条告警`}
          </div>
          {c.resolution === 'pending' && (
            <>
              <input
                className="bp-input"
                value={notes[c.id] ?? ''}
                onChange={(e) => setNotes((s) => ({ ...s, [c.id]: e.target.value }))}
                placeholder="核对备注"
              />
              <div className="bp-row">
                <button className="tb mini" onClick={() => builds.resolveLate(c.id, 'confirmed', notes[c.id] ?? '')}>
                  ✓ 确认一致
                </button>
                <button className="tb mini danger-text" onClick={() => builds.resolveLate(c.id, 'conflict', notes[c.id] ?? '')}>
                  ✗ 标记冲突
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function EventLog({
  builds,
  onSelectItem,
}: {
  builds: BuildsApi;
  onSelectItem: (id: string | null) => void;
}) {
  const plan = builds.activePlan!;
  const events = [...plan.events].reverse();
  if (events.length === 0) return <div className="bp-muted">还没有现场记录</div>;
  return (
    <div className="bp-log">
      {events.slice(0, 50).map((e) => {
        const item = plan.items.find((it) => it.id === e.itemId);
        return (
          <div key={e.id} className="bp-logline">
            <b>{fmtTime(e.at)}</b>
            <span className="bp-logcrew">{e.crew}</span>
            {item ? (
              <button className="bp-logitem" onClick={() => onSelectItem(item.id)}>
                {item.plan.label}
              </button>
            ) : (
              <span className="bp-muted">系统</span>
            )}
            {EVENT_TEXT[e.type]}
            <span className={e.snapshot.ok ? 'bp-late-ok' : 'bp-late-bad'}>
              {e.snapshot.ok ? '检查通过' : `${e.snapshot.alertCount} 告警`}
            </span>
            {e.note && <div className="bp-muted">{e.note}</div>}
          </div>
        );
      })}
    </div>
  );
}

const EVENT_TEXT: Record<string, string> = {
  arrive: '到场',
  stage: '暂存',
  install: '安装',
  move: '移位',
  measure: '实测占地',
  remove: '撤场',
  check: '复查',
};

function CompareView({
  builds,
  onClose,
}: {
  builds: BuildsApi;
  onClose: () => void;
}) {
  const others = builds.plans.filter((p) => p.id !== builds.activePlan!.id);
  const [otherId, setOtherId] = useState(others[0]?.id ?? '');
  if (others.length === 0)
    return <div className="bp-muted">还没有第二份搭建计划可对比；再冻结一份并完成至少一次波次检查即可。</div>;
  const rows = builds.compareWith(otherId);
  return (
    <div className="bp-compare">
      <select className="bp-select" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
        {others.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <button className="tb mini" onClick={onClose}>收起</button>
      {rows && (
        <table className="bp-table">
          <thead>
            <tr>
              <th>波次</th>
              <th>本次</th>
              <th>对照</th>
              <th>差值</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.index} className={r.same ? 'same' : 'diff'}>
                <td>{r.name}</td>
                <td>{r.a ? `${r.a.alertCount} 告警` : '—'}</td>
                <td>{r.b ? `${r.b.alertCount} 告警` : '—'}</td>
                <td>
                  {r.delta === null
                    ? '—'
                    : r.delta === 0
                      ? '✓ 一致'
                      : `${r.delta > 0 ? '+' : ''}${r.delta}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ========================= 工具 ========================= */

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function round2(n: number): number {
  return Math.round(n * 2) / 2;
}
