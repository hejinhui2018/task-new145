/**
 * 搭建波次交接侧栏：
 * - 波次列表（计划中/进行中/已关闭、提前关闭标记、班组、检查点数量）
 * - 当前波次各件的现场记录（到场/暂存/安装/移位/撤场）与实测状态
 * - 检查点证据（每次按真实平面的重算结果，可回看历史）
 * - 待核对区（关闭后的迟到回执）
 * - 两次搭建对比结果
 */
import { useMemo, useState } from 'react';
import type {
  BuildComparison,
  BuildItem,
  ItemStage,
  LateReceipt,
  Wave,
  WaveCheckpoint,
} from '../types';
import type { BuildPlanApi } from '../state/useBuildPlan';
import {
  STAGE_LABEL,
  latestCheckpoint,
  orderedWaves,
  unfinishedItems,
} from '../lib/waves';

const STAGE_BTN: { stage: ItemStage; label: string; title: string }[] = [
  { stage: 'arrived', label: '到场', title: '货箱/材料到场' },
  { stage: 'staging', label: '暂存', title: '临时堆放（占通道，参与检查）' },
  { stage: 'installed', label: '安装', title: '按实测占地安装到位' },
  { stage: 'relocated', label: '移位', title: '现场移位后重新实测' },
  { stage: 'removed', label: '撤场', title: '撤离真实平面' },
];

export function WavePanel({
  build,
  selectedWaveId,
  onSelectWave,
  historyCpId,
  onPickHistory,
}: {
  build: BuildPlanApi;
  selectedWaveId: string;
  onSelectWave: (id: string) => void;
  historyCpId: string | null;
  onPickHistory: (id: string | null) => void;
}) {
  const plan = build.plan!;
  const wave = plan.waves.find((w) => w.id === selectedWaveId) ?? null;

  return (
    <div className="sidebar-section wave-panel">
      <div className="section-head">
        搭建波次
        <span className="count">{plan.waves.length} 波</span>
      </div>

      <div className="wave-tabs">
        {orderedWaves(plan).map((w) => {
          const cp = latestCheckpoint(w);
          const bad = cp ? cp.alerts.length > 0 : false;
          return (
            <button
              key={w.id}
              className={`wave-tab ${w.id === selectedWaveId ? 'on' : ''} ${
                w.status === 'active' ? 'active' : ''
              } ${w.status === 'closed' ? 'closed' : ''}`}
              onClick={() => {
                onSelectWave(w.id);
                onPickHistory(null);
              }}
              title={w.closeNote || w.name}
            >
              <span className="wave-tab-name">{w.name}</span>
              <span className={`wave-tab-status st-${w.status}`}>
                {w.status === 'planned'
                  ? '计划中'
                  : w.status === 'active'
                    ? '进行中'
                    : w.earlyClosed
                      ? '提前关闭'
                      : '已关闭'}
              </span>
              {bad && <span className="wave-dot" title={`${cp!.alerts.length} 条检查告警`} />}
            </button>
          );
        })}
      </div>

      {wave && (
        <WaveBody
          key={wave.id}
          build={build}
          wave={wave}
          historyCpId={historyCpId}
          onPickHistory={onPickHistory}
        />
      )}
    </div>
  );
}

function WaveBody({
  build,
  wave,
  historyCpId,
  onPickHistory,
}: {
  build: BuildPlanApi;
  wave: Wave;
  historyCpId: string | null;
  onPickHistory: (id: string | null) => void;
}) {
  const [fromCrew, setFromCrew] = useState(wave.crewFrom || '甲班');
  const [toCrew, setToCrew] = useState(wave.crewTo || '乙班');
  const [closeNote, setCloseNote] = useState('');
  const cp = latestCheckpoint(wave);
  const unfinished = unfinishedItems(wave);
  const historyCp = wave.checkpoints.find((c) => c.id === historyCpId) ?? null;

  return (
    <div className="wave-body">
      {/* 班组与波次操作 */}
      <div className="crew-row">
        <input
          value={fromCrew}
          onChange={(e) => setFromCrew(e.target.value)}
          placeholder="交班班组"
          disabled={wave.status === 'closed'}
        />
        <span className="arrow">→</span>
        <input
          value={toCrew}
          onChange={(e) => setToCrew(e.target.value)}
          placeholder="接班班组"
          disabled={wave.status === 'closed'}
        />
      </div>
      <div className="wave-actions">
        {wave.status === 'planned' && (
          <button className="tb primary" onClick={() => build.startWave(wave.id)}>
            ▶ 开工
          </button>
        )}
        {wave.status === 'active' && (
          <>
            <button
              className="tb"
              onClick={() =>
                build.handover(wave.id, { fromCrew, toCrew, note: '班组交接' })
              }
            >
              🤝 班组交接
            </button>
            <button className="tb" onClick={() => build.checkpointNow('record')}>
              ↻ 路径重算留证
            </button>
            <button
              className="tb danger-text"
              onClick={() => {
                const early =
                  unfinished.length > 0
                    ? window.confirm(
                        `仍有 ${unfinished.length} 件未完成。确认提前关闭本波次？未完成件将记入差异，迟到上报进入待核对区。`,
                      )
                    : window.confirm('确认关闭本波次？关闭后现场占地将冻结。');
                if (early) build.closeWave(wave.id, closeNote || undefined);
              }}
            >
              {unfinished.length > 0 ? '⏹ 提前关闭' : '⏹ 正常关闭'}
            </button>
          </>
        )}
        {wave.status === 'closed' && (
          <button
            className="tb"
            title="重新打开本波次补录；既有检查点不删除，只追加新证据"
            onClick={() => build.reopen(wave.id)}
          >
            ↺ 局部重演
          </button>
        )}
      </div>
      {wave.status === 'active' && unfinished.length > 0 && (
        <input
          className="close-note"
          value={closeNote}
          onChange={(e) => setCloseNote(e.target.value)}
          placeholder="关闭/交接备注（可选）"
        />
      )}

      {wave.handovers.length > 0 && (
        <div className="handover-chain">
          {wave.handovers.map((h) => (
            <div key={h.id} className="handover-item" title={h.note}>
              {fmtTime(h.at)} {h.fromCrew} → {h.toCrew}
              {h.note ? ` · ${h.note}` : ''}
            </div>
          ))}
        </div>
      )}
      {wave.status === 'closed' && wave.closeNote && (
        <div className="close-note-line">关闭说明：{wave.closeNote}</div>
      )}

      {/* 件清单与现场记录 */}
      <div className="item-list">
        {wave.items.length === 0 && (
          <div className="wave-empty">本波次暂无安排，可把其他波次中未开工的件改派过来。</div>
        )}
        {wave.items.map((item) => (
          <ItemRow key={item.id} build={build} wave={wave} item={item} />
        ))}
      </div>

      {/* 最新检查结论 */}
      {cp && !historyCp && (
        <CheckpointSummary
          title="最新真实平面检查"
          cp={cp}
          onBrowse={() => onPickHistory(cp.id)}
          browsable={wave.checkpoints.length > 1}
        />
      )}

      {/* 历史检查点（证据链） */}
      {wave.checkpoints.length > 0 && (
        <div className="cp-history">
          <div className="cp-history-head">
            检查点证据（{wave.checkpoints.length}）
            {historyCp && (
              <button className="link-btn" onClick={() => onPickHistory(null)}>
                返回最新
              </button>
            )}
          </div>
          {historyCp ? (
            <CheckpointDetail cp={historyCp} />
          ) : (
            <div className="cp-chips">
              {[...wave.checkpoints].reverse().map((c) => (
                <button
                  key={c.id}
                  className={`cp-chip ${c.alerts.length ? 'bad' : 'ok'}`}
                  onClick={() => onPickHistory(c.id)}
                >
                  {fmtTime(c.at)} · {reasonText(c.reason)} ·{' '}
                  {c.alerts.length ? `${c.alerts.length} 告警` : '通过'}
                  {c.crew ? ` · ${c.crew}` : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemRow({
  build,
  wave,
  item,
}: {
  build: BuildPlanApi;
  wave: Wave;
  item: BuildItem;
}) {
  const [open, setOpen] = useState(false);
  const [lateStage, setLateStage] = useState<ItemStage>('arrived');
  const disabled = wave.status !== 'active';
  const last = item.measurements[item.measurements.length - 1];
  const moved =
    item.actualBooth &&
    (item.actualBooth.x !== item.planBooth.x ||
      item.actualBooth.y !== item.planBooth.y ||
      item.actualBooth.w !== item.planBooth.w ||
      item.actualBooth.h !== item.planBooth.h ||
      item.actualBooth.rotation !== item.planBooth.rotation);

  return (
    <div className={`item-row st-${item.stage} ${item.transient ? 'transient' : ''}`}>
      <button className="item-head" onClick={() => setOpen((v) => !v)}>
        <span className="item-label">
          {item.planBooth.label}
          {item.transient && <em className="pile-tag">临时堆放</em>}
        </span>
        <span className={`stage-badge sb-${item.stage}`}>{STAGE_LABEL[item.stage]}</span>
        {moved && <span className="moved-tag" title="实测占地与计划不同">偏</span>}
      </button>
      <div className="item-btns">
        {STAGE_BTN.map(({ stage, label, title }) => (
          <button
            key={stage}
            className={`mini-tb ${item.stage === stage ? 'on' : ''}`}
            disabled={disabled}
            title={title}
            onClick={() => {
              build.record(item.id, stage, undefined);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {wave.status === 'closed' && (
        <div className="late-report">
          <select
            value={lateStage}
            onChange={(e) => setLateStage(e.target.value as ItemStage)}
            title="现场迟到上报的状态"
          >
            {STAGE_BTN.map(({ stage, label }) => (
              <option key={stage} value={stage}>
                {label}
              </option>
            ))}
          </select>
          <button
            className="mini-tb"
            title="波次已关闭，迟到上报不直接入账，进入待核对区"
            onClick={() => build.record(item.id, lateStage, undefined)}
          >
            迟到上报→待核对
          </button>
        </div>
      )}
      {open && (
        <div className="item-detail">
          <div className="kv">
            计划占地：{item.planBooth.x},{item.planBooth.y} ·{' '}
            {item.planBooth.w}×{item.planBooth.h} m
          </div>
          <div className="kv">
            实测占地：
            {item.actualBooth
              ? `${item.actualBooth.x},${item.actualBooth.y} · ${item.actualBooth.w}×${item.actualBooth.h} m（可在图上拖动实测）`
              : '未测量（安装时默认按计划占地）'}
          </div>
          {item.stagingAt && (
            <div className="kv">
              暂存点：{item.stagingAt.x},{item.stagingAt.y}
            </div>
          )}
          <div className="kv">实测记录 {item.measurements.length} 次</div>
          {last && (
            <div className="kv sub">
              最近：{fmtTime(last.at)} · {STAGE_LABEL[last.stage]}
            </div>
          )}
          {wave.status !== 'closed' && item.stage === 'pending' && (
            <div className="item-reassign">
              <ReassignSelect build={build} item={item} waveId={wave.id} />
              <button
                className="mini-tb danger-text"
                onClick={() => build.removeItem(item.id)}
              >
                移出计划
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReassignSelect({
  build,
  item,
  waveId,
}: {
  build: BuildPlanApi;
  item: BuildItem;
  waveId: string;
}) {
  const plan = build.plan!;
  return (
    <select
      value={waveId}
      onChange={(e) => build.reassignItem(item.id, e.target.value)}
      title="改派到其他未开工波次（改线只允许调整未执行安排）"
    >
      {orderedWaves(plan).map((w) => (
        <option key={w.id} value={w.id} disabled={w.status === 'closed'}>
          {w.name}
        </option>
      ))}
    </select>
  );
}

/* ---------------- 检查点展示 ---------------- */

const REASON_TEXT: Record<WaveCheckpoint['reason'], string> = {
  record: '现场记录',
  handover: '班组交接',
  close: '波次关闭',
  replay: '局部重演',
  amend: '关闭后补录',
};
function reasonText(r: WaveCheckpoint['reason']): string {
  return REASON_TEXT[r];
}

function CheckpointSummary({
  title,
  cp,
  onBrowse,
  browsable,
}: {
  title: string;
  cp: WaveCheckpoint;
  onBrowse: () => void;
  browsable: boolean;
}) {
  return (
    <div className={`cp-summary ${cp.alerts.length ? 'bad' : 'ok'}`}>
      <div className="cp-summary-head">
        {title}（{fmtTime(cp.at)} · {reasonText(cp.reason)}
        {cp.crew ? ` · ${cp.crew}` : ''}）
        {browsable && (
          <button className="link-btn" onClick={onBrowse}>
            查看历史证据
          </button>
        )}
      </div>
      {cp.alerts.length === 0 ? (
        <div className="cp-ok">✓ 真实平面通过重叠/净空/出口/疏散全部检查</div>
      ) : (
        <ul className="cp-alerts">
          {cp.alerts.map((a) => (
            <li key={a.id}>{a.message}</li>
          ))}
        </ul>
      )}
      {cp.diffs.length > 0 && (
        <div className="cp-diffs">
          {cp.diffs.slice(0, 4).map((d) => (
            <div key={d.itemId} className={`diff-line ${d.missing ? 'miss' : 'move'}`}>
              {d.missing ? '缺' : '偏'} · {d.label}：{d.detail}
            </div>
          ))}
          {cp.diffs.length > 4 && (
            <div className="diff-more">等 {cp.diffs.length} 条差异</div>
          )}
        </div>
      )}
    </div>
  );
}

function CheckpointDetail({ cp }: { cp: WaveCheckpoint }) {
  return (
    <div className="cp-detail">
      <CheckpointSummary title="历史检查点" cp={cp} onBrowse={() => {}} browsable={false} />
      <div className="kv sub">
        真实平面 {cp.actualBooths.length} 件 · 暂存 {cp.stagingBooths.length} 件
      </div>
    </div>
  );
}

/* ---------------- 待核对区 ---------------- */

export function LateReceiptPanel({ build }: { build: BuildPlanApi }) {
  const pending = build.plan!.lateReceipts;
  if (pending.length === 0) return null;
  const groups = useMemo(() => {
    return {
      pending: pending.filter((r) => r.resolution === 'pending'),
      done: pending.filter((r) => r.resolution !== 'pending'),
    };
  }, [pending]);

  return (
    <div className="sidebar-section receipt-panel">
      <div className="section-head">
        待核对区
        <span className={`count ${groups.pending.length ? 'bad' : 'zero'}`}>
          {groups.pending.length} 待处理
        </span>
      </div>
      <div className="alert-list">
        {groups.pending.map((r) => (
          <ReceiptCard key={r.id} r={r} build={build} />
        ))}
        {groups.done.map((r) => (
          <div key={r.id} className="receipt-done">
            {fmtTime(r.receivedAt)} · {r.waveName} · {r.boothLabel} 迟到「
            {STAGE_LABEL[r.attemptedStage]}」→{' '}
            {r.resolution === 'accepted' ? '已补录' : '已作废'}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReceiptCard({ r, build }: { r: LateReceipt; build: BuildPlanApi }) {
  return (
    <div className="receipt-card">
      <div className="receipt-title">
        迟到检查回执 · {r.waveName}
      </div>
      <div className="receipt-body">
        {fmtTime(r.receivedAt)}，{r.boothLabel} 上报「{STAGE_LABEL[r.attemptedStage]}」
        ，但该波次已关闭。
        {r.note ? ` 备注：${r.note}` : ''}
      </div>
      <div className="receipt-btns">
        <button
          className="mini-tb"
          onClick={() => build.resolveLateReceipt(r.id, 'accepted')}
        >
          ✓ 核对补录（追加 amend 证据）
        </button>
        <button
          className="mini-tb danger-text"
          onClick={() => build.resolveLateReceipt(r.id, 'rejected')}
        >
          ✕ 作废
        </button>
      </div>
    </div>
  );
}

/* ---------------- 两次搭建对比 ---------------- */

export function ComparisonPanel({ build }: { build: BuildPlanApi }) {
  const cmp = build.comparison;
  if (!cmp || !build.compareName) return null;
  return (
    <div className="sidebar-section compare-panel">
      <div className="section-head">
        两次搭建对比
        <button className="link-btn" onClick={build.clearComparison}>
          关闭
        </button>
      </div>
      <div className="compare-names">
        A：{build.compareName.a}
        <br />
        B：{build.compareName.b}
      </div>
      <CompareList title={`仅 A 搭建（${cmp.onlyInA.length}）`} diffs={cmp.onlyInA} cls="miss" />
      <CompareList title={`仅 B 搭建（${cmp.onlyInB.length}）`} diffs={cmp.onlyInB} cls="miss" />
      <div className="cp-diffs">
        <div className="compare-sub">占地变化（{cmp.changed.length}）</div>
        {cmp.changed.map((c) => (
          <div key={c.boothId} className="diff-line move">
            偏 · {c.label}：{c.detail}
          </div>
        ))}
      </div>
      <div className="compare-same">占地一致：{cmp.same} 件</div>
    </div>
  );
}

function CompareList({
  title,
  diffs,
  cls,
}: {
  title: string;
  diffs: BuildComparison['onlyInA'];
  cls: string;
}) {
  if (diffs.length === 0) return null;
  return (
    <div className="cp-diffs">
      <div className="compare-sub">{title}</div>
      {diffs.map((d) => (
        <div key={d.boothId} className={`diff-line ${cls}`}>
          {d.label}：{d.detail}
        </div>
      ))}
    </div>
  );
}

/* ---------------- 杂项 ---------------- */

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}
