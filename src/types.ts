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
  kind?: 'booth' | 'partition';
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
/* 搭建波次交接                                                          */
/* ================================================================== */

/** 现场执行状态：未到场 → 到场 → 暂存 → 安装 →（移位）→ 撤场。 */
export type ItemStage =
  | 'pending'
  | 'arrived'
  | 'staging'
  | 'installed'
  | 'relocated'
  | 'removed';

/** 单个搭建件在某波次中的计划行：冻结时从当前平面复制一份不可变快照。 */
export interface BuildItem {
  id: string;
  /** 冻结时引用的展位/围挡 id（与 planBooth.id 一致） */
  boothId: string;
  /** 冻结时刻的计划占地（不可变，差异证据的“计划”一侧） */
  planBooth: Booth;
  /**
   * 实测占地：现场记录。到场/暂存期间可为 null（尚未测量）；
   * 安装/移位后必须存在，作为真实平面的一部分参与检查。
   */
  actualBooth: Booth | null;
  stage: ItemStage;
  /** 暂存位置（staging/arrived 后可记录）；仅作记录，不参与安装平面检查 */
  stagingAt: Point | null;
  note: string;
  /** 临时堆放/货箱：不属于冻结基线，计划当波撤场，不延续到后续波次 */
  transient?: boolean;
  /** 每一次“实测占地”登记：保留全部历史，作为计划与实际差异的证据链 */
  measurements: MeasurementRecord[];
}

/** 一次实测占地登记。 */
export interface MeasurementRecord {
  at: number;
  /** 该次测量得到的占地 */
  booth: Booth;
  /** 当时进入的现场状态 */
  stage: ItemStage;
  note?: string;
}

/** 波次状态：计划中 → 进行中（可中断续作）→ 已关闭（正常完成或提前关闭）。 */
export type WaveStatus = 'planned' | 'active' | 'closed';

export interface Wave {
  id: string;
  name: string;
  order: number;
  status: WaveStatus;
  items: BuildItem[];
  /** 交接信息：下班班组 → 接班班组 */
  crewFrom: string;
  crewTo: string;
  /** 开工/收工时间戳（毫秒）；未开始/未结束为 null */
  startedAt: number | null;
  closedAt: number | null;
  /** 提前关闭标记：关闭时仍有件未安装到位 */
  earlyClosed: boolean;
  /** 关闭原因/交接备注 */
  closeNote: string;
  /** 班组交接历史（中断续作的凭据链） */
  handovers: WaveHandover[];
  /**
   * 检查点：每次现场记录或关闭时，按【当时真实平面】重新检查后留存。
   * 最新一条即该波次当前的真实检查证据；历史条保留“第三波通道被堵过”的证据。
   */
  checkpoints: WaveCheckpoint[];
}

/** 班组交接记录。 */
export interface WaveHandover {
  id: string;
  at: number;
  fromCrew: string;
  toCrew: string;
  note: string;
}

/** 波次检查点：对某一时刻真实平面的完整检查留证。 */
export interface WaveCheckpoint {
  id: string;
  at: number;
  /** 触发原因：现场记录 / 交接 / 关闭 / 重演 / 关闭后补录 */
  reason: 'record' | 'handover' | 'close' | 'replay' | 'amend';
  /** 检查时真实平面上的全部占地（已安装/移位，含前序已关闭波次的遗留） */
  actualBooths: Booth[];
  /** 同时在场但尚未安装的暂存件（仅供说明，不参与检查） */
  stagingBooths: Booth[];
  alerts: Alert[];
  paths: Record<string, Point[]>;
  blockedExitIds: string[];
  /** 本次检查相对计划的差异（按件列出） */
  diffs: ItemDiff[];
  /** 操作班组，便于交接追溯 */
  crew: string;
}

/** 单件“计划 vs 实际”差异。 */
export interface ItemDiff {
  itemId: string;
  boothId: string;
  label: string;
  /** 是否缺失：计划应安装但真实平面里没有该件（撤场/未装） */
  missing: boolean;
  /** 是否多占：实测占地与计划占地不一致（位置/尺寸/旋转） */
  footprintChanged: boolean;
  /** 是否计划外出现（真实平面里有、本波次计划里没有——通常来自暂存件被误装，留作提示） */
  unexpected: boolean;
  detail: string;
  planBooth: Booth | null;
  actualBooth: Booth | null;
}

/** 关闭后的迟到检查回执：波次已关闭才送达的现场记录，进入待核对区。 */
export interface LateReceipt {
  id: string;
  waveId: string;
  waveName: string;
  itemId: string;
  boothLabel: string;
  /** 现场尝试上报的状态/占地 */
  attemptedStage: ItemStage;
  actualBooth: Booth | null;
  note: string;
  receivedAt: number;
  /** 处置：pending=待核对；accepted=核对后已作为补录；rejected=作废 */
  resolution: 'pending' | 'accepted' | 'rejected';
}

/** 搭建计划：从当前方案冻结，含若干波次。 */
export interface BuildPlan {
  id: string;
  name: string;
  /** 冻结时刻的方案名/说明 */
  frozenAt: number;
  /** 冻结时的基线平面（全部展位+围挡的计划快照） */
  baseline: Booth[];
  waves: Wave[];
  /** 待核对区：迟到回执 */
  lateReceipts: LateReceipt[];
  /** 当前激活波次 id（中断续作靠它恢复现场） */
  activeWaveId: string | null;
}

/** 两次搭建对比结果（按件匹配，缺失/多占/占地变化分别列出）。 */
export interface BuildComparison {
  onlyInA: ItemDiff[];
  onlyInB: ItemDiff[];
  changed: Array<{
    boothId: string;
    label: string;
    a: Booth;
    b: Booth;
    detail: string;
  }>;
  /** 两次都一致（含占地相同）的件数 */
  same: number;
}
