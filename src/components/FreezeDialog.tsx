/**
 * 冻结对话框：从当前平面生成搭建计划前，把每个展位/围挡分到波次。
 * 默认围挡第一波、展位第二波；可改件的波次归属与计划名称。
 * 临时堆放不在这里冻结——进场后在波次面板按现场位置登记。
 */
import { useMemo, useState } from 'react';
import type { Booth } from '../types';
import { defaultAssignments } from '../lib/waves';

export function FreezeDialog({
  booths,
  onCancel,
  onConfirm,
}: {
  booths: Booth[];
  onCancel: () => void;
  onConfirm: (name: string, assignments: Record<string, number>) => void;
}) {
  const defaults = useMemo(() => defaultAssignments(booths), [booths]);
  const [assignments, setAssignments] = useState<Record<string, number>>(defaults);
  const [name, setName] = useState(`搭建计划 ${booths.length} 件`);
  const waveCount = Math.max(2, ...Object.values(assignments));

  const setAll = (kind: 'booth' | 'partition', wave: number) => {
    setAssignments((prev) => {
      const next = { ...prev };
      for (const b of booths) {
        const isPart = b.kind === 'partition';
        if ((kind === 'partition') === isPart) next[b.id] = wave;
      }
      return next;
    });
  };

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>冻结搭建计划</h3>
        <p className="modal-tip">
          冻结后平面与计划分离：继续编辑平面不会改变计划；现场按波次记录
          到场/暂存/安装/移位/撤场与实测占地，每波按真实平面重算检查。
        </p>
        <div className="field">
          <label>计划名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="freeze-batch">
          <span>批量：围挡 → 第</span>
          <WavePicker value={1} waveCount={waveCount} onChange={(w) => setAll('partition', w)} />
          <span>波；展位 → 第</span>
          <WavePicker value={2} waveCount={waveCount} onChange={(w) => setAll('booth', w)} />
          <span>波</span>
        </div>
        <div className="freeze-list">
          {booths.map((b) => (
            <div key={b.id} className="freeze-row">
              <span className={`freeze-kind ${b.kind === 'partition' ? 'part' : ''}`}>
                {b.kind === 'partition' ? '围挡' : '展位'}
              </span>
              <span className="freeze-label">{b.label}</span>
              <span className="freeze-meta">
                {b.w}×{b.h} m @ {b.x},{b.y}
              </span>
              <WavePicker
                value={assignments[b.id] ?? 1}
                waveCount={waveCount}
                onChange={(w) =>
                  setAssignments((prev) => ({ ...prev, [b.id]: w }))
                }
              />
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="tb" onClick={onCancel}>
            取消
          </button>
          <button
            className="tb primary"
            disabled={booths.length === 0 || !name.trim()}
            onClick={() => onConfirm(name.trim(), assignments)}
          >
            冻结并开始搭建交接
          </button>
        </div>
      </div>
    </div>
  );
}

function WavePicker({
  value,
  waveCount,
  onChange,
}: {
  value: number;
  waveCount: number;
  onChange: (w: number) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: Math.max(waveCount, value, 3) }, (_, i) => i + 1).map(
        (w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ),
      )}
    </select>
  );
}
