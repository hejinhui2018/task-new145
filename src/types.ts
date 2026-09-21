/** 全局领域类型：所有坐标、尺寸单位均为“米”，展厅坐标系原点在左上角，x 向右、y 向下。 */

/** 展位朝向：接待点（正面）所在方向。旋转 90° 时在 north/east 间切换。 */
export type Orientation = 'north' | 'east' | 'south' | 'west';

export interface Point {
  x: number;
  y: number;
}

/**
 * 展位（可旋转矩形）。
 * x/y 为旋转锚点（局部原点，默认是未旋转矩形的左上角）的世界坐标（米）；
 * w/h 始终为未旋转的局部宽高；
 * rotation 为绕锚点顺时针旋转的弧度（0 = 轴对齐，π/2 = 顺时针 90°）。
 * 渲染、命中、碰撞、越界、净空与寻路障碍一律以同一旋转后多边形为准。
 */
export interface Booth {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 顺时针旋转弧度（绕 x/y 锚点）；0/π/2/π/3π/2 为四向。 */
  rotation: number;
  orientation: Orientation;
  label: string;
  color: string;
  /** booth=普通展位（适用 1.5 m 净空规则）；partition=围挡/隔断，允许互相拼接 */
  kind?: 'booth' | 'partition' | 'storage';
}

/** 固定出口：位于某面墙上的一段开口（沿墙方向的起止坐标）。 */
export interface ExitDef {
  id: string;
  wall: 'north' | 'south' | 'west' | 'east';
  /** 沿墙方向的起始坐标（米） */
  start: number;
  /** 沿墙方向的结束坐标（米，start < end） */
  end: number;
}

export interface PlanState {
  booths: Booth[];
}

export type AlertKind =
  | 'out-of-bounds'
  | 'overlap'
  | 'clearance'
  | 'exit-blocked'
  | 'no-path';

export interface Alert {
  id: string;
  kind: AlertKind;
  /** 主展位 id（越界/净空/不可达是一个展位，重叠取两个中的第一个） */
  boothId: string;
  /** 相关展位：重叠时为对方；净空时为距离过近的展位；其他情况为空 */
  relatedBoothId?: string;
  message: string;
}

/** 一次分析结果：告警 + 每个展位正面接待点到最近出口的路径（网格点，米坐标）。 */
export interface AnalysisResult {
  alerts: Alert[];
  paths: Record<string, Point[]>;
  /** 被展位直接封住（开口内侧网格被占）的出口 id */
  blockedExitIds: string[];
}

/* ================================================================== */
/* 搭建波次（build waves）                                               */
/* ================================================================== */

/**
 * 现场生命周期状态：
 * - pending   未到场（计划里有，现场还没有东西）
 * - arrived   已到场（货已进场，尚未指定暂存占地；不占平面）
 * - staging   暂存中（货箱/材料堆在实测的临时占地，是通道障碍）
 * - installed 已安装（按实测占地落位）
 * - removed   已撤场（现场已无占地）
 */
export type ItemStatus =
  | 'pending'
  | 'arrived'
  | 'staging'
  | 'installed'
  | 'removed';

/** 一个被冻结进搭建计划的对象（展位/围挡，或现场新增的临时堆放）。 */
export interface PlannedItem {
  id: string;
  /** 来源展位 id（计划冻结时对应方案里的 Booth.id）；临时堆放没有来源 */
  sourceBoothId?: string;
  /** 冻结时的计划几何与属性（不可变证据） */
  plan: Booth;
  /** 实测占地；未记录时为空，检查按 plan 占位 */
  actual?: Booth;
  status: ItemStatus;
  /** 所属波次（1 起）；0 = 未分配波次 */
  wave: number;
}

/** 现场记录事件类型：到场 / 暂存 / 安装 / 移位 / 撤场 / 实测占地 / 系统检查 */
export type BuildEventType =
  | 'arrive'
  | 'stage'
  | 'install'
  | 'remove'
  | 'move'
  | 'measure'
  | 'check';

export interface BuildEvent {
  id: string;
  /** ISO 时间戳 */
  at: string;
  /** 记录时的当班班组 */
  crew: string;
  /** check 类（关闭/复查）事件没有具体对象，为空串 */
  itemId: string;
  type: BuildEventType;
  /** stage/move/measure 时携带的占地（暂存位或实测占地） */
  footprint?: Booth;
  /** 记录事件时该波次的检查结论（快照证据） */
  snapshot: WaveCheck;
  /** 备注（关闭前检查/复查等系统事件的说明） */
  note?: string;
}

/** 班组交接记录。 */
export interface Handover {
  id: string;
  at: string;
  /** 交出班组 */
  from: string;
  /** 接班班组 */
  to: string;
  note: string;
}

export type WaveStatus = 'open' | 'closed';

/** 一次波次检查：按当时真实平面重算的结论。 */
export interface WaveCheck {
  /** 检查时刻 ISO 时间戳 */
  at: string;
  crew: string;
  /** 检查时刻在场的对象（installed + staging，使用实测/暂存占地） */
  presentIds: string[];
  alerts: Alert[];
  paths: Record<string, Point[]>;
  blockedExitIds: string[];
  /** 告警数（便于列表展示，不必展开 alerts） */
  alertCount: number;
  ok: boolean;
}

export interface Wave {
  /** 波次序号（1 起，创建后不变） */
  index: number;
  name: string;
  status: WaveStatus;
  createdAt: string;
  closedAt?: string;
  /** 最近一次检查（每次现场记录、改线或刷新检查后覆盖） */
  lastCheck?: WaveCheck;
}

/** 迟到检查回执：波次关闭后才送达的现场检查记录，进入待核对区。 */
export interface LateCheck {
  id: string;
  waveIndex: number;
  at: string;
  crew: string;
  check: WaveCheck;
  /** 核对结论：pending 未核对 / confirmed 与关闭结论一致 / conflict 存在差异 */
  resolution?: 'pending' | 'confirmed' | 'conflict';
  resolvedAt?: string;
  note?: string;
}

/** 计划 vs 实测的单对象差异证据。 */
export interface ItemDiff {
  itemId: string;
  label: string;
  /** 几何是否不同（位置/尺寸/旋转） */
  geometryChanged: boolean;
  /** 位移距离（锚点米，未移动为 0） */
  shift: number;
  plan: Booth;
  actual: Booth;
}

/** 一份被冻结的搭建计划。 */
export interface BuildPlan {
  id: string;
  name: string;
  /** 冻结时刻 ISO 时间戳 */
  frozenAt: string;
  /** 冻结时的方案完整快照（展位/围挡，几何不可变） */
  frozenBooths: Booth[];
  items: PlannedItem[];
  waves: Wave[];
  events: BuildEvent[];
  handovers: Handover[];
  /** 待核对区：关闭后的迟到检查回执 */
  lateChecks: LateCheck[];
  /** 当前当班班组 */
  crew: string;
}

/* ================================================================== */
/* 两次搭建对比                                                          */
/* ================================================================== */

/** 两次搭建计划（波次检查结论）对比的单行结果。 */
export interface WaveCompareRow {
  index: number;
  name: string;
  status: WaveStatus;
  a?: WaveCheck;
  b?: WaveCheck;
  /** 告警数差异（B - A） */
  delta: number | null;
  same: boolean;
}
