import { describe, it, expect, beforeEach } from 'vitest';
import type { PlanState } from '../types';
import { BUILD_ARCHIVE_KEY, BUILD_KEY, STORAGE_KEY } from '../constants';
import {
  clearSavedPlan,
  clearBuildPlan,
  loadBuildArchive,
  loadBuildPlan,
  loadPlan,
  saveBuildArchive,
  saveBuildPlan,
  savePlan,
} from './persistence';
import { closeWave, createBuildPlan, recordEvent, startWave } from './waves';

/** node 测试环境没有 localStorage，用内存 Map 打桩。 */
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
}

function setStorage(s: MemoryStorage) {
  (globalThis as unknown as { localStorage: unknown }).localStorage = s;
}
function storage(): MemoryStorage {
  return (globalThis as unknown as { localStorage: MemoryStorage }).localStorage;
}

beforeEach(() => {
  setStorage(new MemoryStorage());
});

function rotatedPlan(rotation: number): PlanState {
  return {
    booths: [
      {
        id: 'b1', x: 3.5, y: 2, w: 6, h: 2, rotation,
        orientation: 'east', label: 'A01', color: '#000', kind: 'booth',
      },
    ],
  };
}

describe('persistence 旋转角度与尺寸持久化', () => {
  it('保存含 rotation 的方案后能原样恢复（角度与未旋转尺寸都不丢）', () => {
    const plan = rotatedPlan(3 * (Math.PI / 2)); // 270°
    savePlan(plan);
    const loaded = loadPlan();
    expect(loaded).not.toBeNull();
    expect(loaded!.booths[0].rotation).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(loaded!.booths[0].w).toBe(6);
    expect(loaded!.booths[0].h).toBe(2);
    expect(loaded!.booths[0].orientation).toBe('east');
  });

  it('旧版本数据（无 rotation 字段）加载时迁移为 0，尺寸保持原值', () => {
    const legacy = JSON.stringify({
      booths: [
        { id: 'b1', x: 1, y: 1, w: 2, h: 6, orientation: 'west', label: 'L', color: '#fff' },
      ],
    });
    storage().setItem(
      STORAGE_KEY,
      legacy,
    );
    const loaded = loadPlan();
    expect(loaded).not.toBeNull();
    expect(loaded!.booths[0].rotation).toBe(0);
    expect(loaded!.booths[0].w).toBe(2); // 旧的未旋转宽高不被交换
    expect(loaded!.booths[0].h).toBe(6);
    expect(loaded!.booths[0].orientation).toBe('west');
  });

  it('非法 rotation（NaN/字符串）的方案被拒绝', () => {
    const bad = JSON.stringify({
      booths: [{ id: 'b', x: 0, y: 0, w: 1, h: 1, rotation: '90', orientation: 'south', label: 'L', color: '#000' }],
    });
    storage().setItem(STORAGE_KEY, bad);
    expect(loadPlan()).toBeNull();
  });

  it('清空后读取为 null', () => {
    savePlan(rotatedPlan(0));
    clearSavedPlan();
    expect(loadPlan()).toBeNull();
  });
});

describe('搭建计划持久化（刷新恢复）', () => {
  function sampleBuild() {
    let p = createBuildPlan(
      [
        {
          id: 'a', x: 1, y: 1, w: 3, h: 2, rotation: 0,
          orientation: 'south', label: 'A', color: '#000', kind: 'booth',
        },
      ],
      { now: 1000, name: '测试搭建' },
    );
    p = startWave(p, p.waves[0].id, 1001);
    const itemId = p.waves[0].items[0].id;
    p = recordEvent(
      p,
      itemId,
      {
        stage: 'installed',
        actualBooth: {
          id: 'a', x: 1.5, y: 1, w: 3, h: 2, rotation: 0,
          orientation: 'south', label: 'A', color: '#000', kind: 'booth',
        },
      },
      1002,
    ).plan;
    p = closeWave(p, p.waves[0].id, 1003);
    return p;
  }

  it('保存后可原样恢复：波次、检查点、实测占地、归档都在', () => {
    const p = sampleBuild();
    saveBuildPlan(p);
    const loaded = loadBuildPlan();
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('测试搭建');
    expect(loaded!.waves[0].status).toBe('closed');
    expect(loaded!.waves[0].items[0].actualBooth!.x).toBe(1.5);
    expect(loaded!.waves[0].checkpoints.length).toBeGreaterThan(0);

    saveBuildArchive([p]);
    const archive = loadBuildArchive();
    expect(archive).toHaveLength(1);
    expect(archive[0].waves[0].items[0].measurements.length).toBeGreaterThan(0);
  });

  it('结构损坏/缺字段时返回 null，而不是抛错', () => {
    storage().setItem(BUILD_KEY, '{not-json');
    expect(loadBuildPlan()).toBeNull();
    storage().setItem(
      BUILD_KEY,
      JSON.stringify({ id: 'x', frozenAt: 1, baseline: [], waves: [{ id: 'w', name: 'W' }] }),
    );
    expect(loadBuildPlan()).toBeNull();
    storage().setItem(BUILD_ARCHIVE_KEY, JSON.stringify([{ junk: true }]));
    expect(loadBuildArchive()).toEqual([]);
  });

  it('清除搭建计划后读取为 null', () => {
    saveBuildPlan(sampleBuild());
    clearBuildPlan();
    expect(loadBuildPlan()).toBeNull();
  });

  it('旧版本缺 lateReceipts/activeWaveId 时补默认值', () => {
    const p = sampleBuild();
    const { lateReceipts, activeWaveId, ...old } = p;
    void lateReceipts;
    void activeWaveId;
    storage().setItem(BUILD_KEY, JSON.stringify(old));
    const loaded = loadBuildPlan();
    expect(loaded).not.toBeNull();
    expect(loaded!.lateReceipts).toEqual([]);
    expect(loaded!.activeWaveId).toBeNull();
  });
});
