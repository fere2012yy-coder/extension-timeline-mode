/*
 * 质点挂载插件 v0.5.0（虚线边版）（com.zcode.timeline-mode）
 *
 * 按键（模拟"对齐样板"的手工操作流）：
 *   8 = 选中节点正上方挂质点，质点右侧建子项并进入编辑
 *   2 = 正下方同款
 *   9 = 选中节点的父节点正上方挂质点+子项（恰好一个父才执行）
 *   3 = 正下方同款
 *
 * 极简原则（v0.2.x 卡死教训）：
 *   - 零日志、零弹窗、零超时包装——每按一次键只做最少的远程调用
 *   - 读一次画布快照（节点矩形+边表），本地算好全部坐标，然后只写不读
 *   - 建边 = 纯序列化数据（端点用 uuid+矩形副本），不回读新边、不做 unknown 换绑
 *   - 质点串链：新质点接在同方向最外侧质点之后（一条竖干）
 */

/*
 * 尺寸基准（v0.4.2：全部按软件自带基准文件实测，见
 * E:/Project Graph/tutorial-xxx 目录下的 测试.prg：Tab 建的 5 层链 + 反斜杠建的 5 个兄弟）
 *   Tab 水平间隙（父右缘→子左缘）= 150px  ← 源码 fatherChildNormalGap = 50*3
 *   反斜杠相邻兄弟中心距 = 96px          ← 子项高 76 + 内置 treesGap 20
 * 原则：不改变软件尺寸，插件跟随软件；动态量取失败才用这里的兜底值。
 */
/*
 * v0.4.4 终极方案：完全复刻布局引擎的定位数学 → Tab 重排变成"空操作"
 * 引擎源码 autoLayoutFastTreeMode：
 *   nearGap = 50 * 2^(fontScaleLevel/2)        单子节点间距
 *   topCenter 定位：子群中心 = 父.top - gap - 子群高/2
 * 代入质点 30x30、fp=0：
 *   首个质点中心 = 节点边缘 - (50 + 15) = 边缘 - 65
 *   链上下一质点中心 = 上一质点中心 - (50 + 30) = -80
 *   右侧子项左缘 = 质点右缘 + 150（normalGap = 50*3）
 */
const NEAR_GAP = 50; // 引擎 fatherChildNearGap（fontScaleLevel=0）
const PLUGIN_VERSION = "v0.5.1";
const POINT_SIZE = 30; // 质点边长
const POINT_EDGE_GAP = NEAR_GAP + POINT_SIZE / 2; // 65：节点边缘 → 首个质点中心
const POINT_CHAIN_STEP = NEAR_GAP + POINT_SIZE; // 80：质点中心 → 下一质点中心
const CHILD_GAP = 150; // 质点右缘 → 子项左缘（= 引擎 normalGap 50*3）
const R = 15; // 质点半径
const CHILD_W = 146;
const CHILD_H = 76;

/* v0.4.5：待执行的进编辑定时器。若上一次按键的延迟编辑还没触发，
 * 用户又按了 Tab/反斜杠，它会迟到地抢走编辑焦点（表现为新节点没进编辑态）→ 必须先取消。 */
let pendingEditTimer: ReturnType<typeof setTimeout> | null = null;
function cancelPendingEdit(): void {
  if (pendingEditTimer !== null) {
    clearTimeout(pendingEditTimer);
    pendingEditTimer = null;
  }
}

const V = (x: number, y: number) => ({ _: "Vector", x, y });
const RPC = { deserializeWithProject: true };
const COLOR = { _: "Color", r: 0, g: 0, b: 0, a: 0 };

/** 端点副本（序列化为实体替身，uuid 用于保存/加载时对上真身） */
function endpointCopy(uuid: string, rect: { x: number; y: number; w: number; h: number }) {
  return {
    _: "TextNode", $rpc: RPC, uuid, text: "", details: [],
    collisionBox: { _: "CollisionBox", shapes: [{ _: "Rectangle", location: V(rect.x, rect.y), size: V(rect.w, rect.h) }] },
    color: COLOR, fontScaleLevel: 0, sizeAdjust: "manual",
    fontFamily: "", fontWeight: "", borderStyle: "solid",
  };
}

function pointEnt(uuid: string, cx: number, cy: number) {
  return {
    _: "ConnectPoint", details: [],
    collisionBox: { _: "CollisionBox", shapes: [{ _: "Rectangle", location: V(cx - R, cy - R), size: V(R * 2, R * 2) }] },
    uuid,
  };
}

function childEnt(uuid: string, text: string, x: number, y: number) {
  return {
    _: "TextNode", details: [],
    uuid, text,
    collisionBox: { _: "CollisionBox", shapes: [{ _: "Rectangle", location: V(x, y), size: V(CHILD_W, CHILD_H) }] },
    color: COLOR, fontScaleLevel: 0, sizeAdjust: "manual",
    fontFamily: "", fontWeight: "", borderStyle: "solid",
  };
}

function edgeEnt(fromUuid: string, fromRect: any, toUuid: string, toRect: any, src: any, tgt: any, forcedUuid?: string) {
  return {
    _: "LineEdge",
    // v0.3.3：顶层必须带 $rpc（探针扩展 lineEdgeSer 同款）——
    // 触发 host 端 CUSTOM_TYPES 处理器带 project 反序列化，缺它会导致挂起
    $rpc: RPC,
    uuid: forcedUuid ?? crypto.randomUUID(),
    associationList: [endpointCopy(fromUuid, fromRect), endpointCopy(toUuid, toRect)],
    text: "",
    sourceRectangleRate: V(src.x, src.y),
    targetRectangleRate: V(tgt.x, tgt.y),
    color: COLOR,
    // v0.5.0 核心改动：solid → dashed（虚线）。
    // 源码铁证：autoLayoutFastTreeMode/getRoots/validateTreeStructure/getSuccessorSet
    // 全部无条件跳过 lineType==="dashed" 的边——这是官方为"不参与树形布局的连接"
    // 预留的机制。虚线后 Tab/反斜杠的整树重排物理上碰不到质点结构：
    //   → 布局永不被打乱（77/86/96 之争彻底终结，间距只由插件自己决定）
    //   → 树校验不再误报 → 编辑态不再被重排破坏
    lineType: "dashed", arrowType: "default",
  };
}

interface Rect { x: number; y: number; w: number; h: number }

async function getSM(): Promise<any> {
  const p = await prg.tabs_getCurrentProject();
  if (!p) throw new Error("no project");
  return p.stageManager;
}

/* ---- 一次性读快照（读完释放代理，之后全本地计算） ---- */

async function snapshot(sm: any): Promise<{
  nodes: Map<string, { rect: Rect; isPoint: boolean; selected: boolean; fsl: number }>;
  edges: Array<{ from: string; to: string }>;
}> {
  const nodes = new Map<string, { rect: Rect; isPoint: boolean; selected: boolean; fsl: number }>();
  const entities = await sm.getConnectableEntity();
  for (const e of entities) {
    try {
      const uuid = await e.uuid;
      const sel = await e._isSelected;
      const cb = await e.collisionBox;
      const shapes = await cb.shapes;
      const s0 = shapes[0];
      const loc = await s0.location;
      const size = await s0.size;
      const x = await loc.x;
      const y = await loc.y;
      const w = await size.x;
      const h = await size.y;
      if (![x, y, w, h].every(Number.isFinite)) continue;
      let fsl = 0;
      try {
        const f = await e.fontScaleLevel;
        if (typeof f === "number" && Number.isFinite(f)) fsl = f;
      } catch { /* 非 TextNode 无此字段 */ }
      nodes.set(uuid, {
        rect: { x, y, w, h },
        isPoint: Math.abs(w - 30) < 1 && Math.abs(h - 30) < 1,
        selected: sel === true,
        fsl,
      });
    } catch { /* 单个实体失败跳过，不阻塞 */ }
  }
  const edges: Array<{ from: string; to: string }> = [];
  const allEdges = await sm.getEdges();
  for (const ed of allEdges) {
    try {
      const list = await ed.associationList;
      if (!list || list.length < 2) continue;
      const f = await list[0].uuid;
      const t = await list[1].uuid;
      if (f && t) edges.push({ from: f, to: t });
    } catch { /* 跳过 */ }
  }
  return { nodes, edges };
}

/** 节点某方向质点链最外侧 (uuid, cy)；无则 null */
function chainTail(snap: any, nodeUuid: string, up: boolean): { uuid: string; cy: number } | null {
  const info = snap.nodes.get(nodeUuid);
  if (!info) return null;
  let cur = nodeUuid;
  let curCy = info.rect.y + info.rect.h / 2;
  let tail: { uuid: string; cy: number } | null = null;
  const guard = new Set<string>([nodeUuid]);
  while (true) {
    let best: { uuid: string; cy: number } | null = null;
    for (const e of snap.edges) {
      if (e.from !== cur) continue;
      const child = snap.nodes.get(e.to);
      if (!child || !child.isPoint) continue;
      if (guard.has(e.to)) continue;
      const cy = child.rect.y + child.rect.h / 2;
      if (up && cy >= curCy) continue;
      if (!up && cy <= curCy) continue;
      if (!best || (up ? cy < best.cy : cy > best.cy)) best = { uuid: e.to, cy };
    }
    if (!best) break;
    guard.add(best.uuid);
    tail = best;
    cur = best.uuid;
    curCy = best.cy;
  }
  return tail;
}

/** 父节点 uuid（恰好一个入边才返回） */
function parentOf(snap: any, uuid: string): string | null {
  let p: string | null = null;
  let n = 0;
  for (const e of snap.edges) {
    if (e.to === uuid && e.from !== uuid) {
      p = e.from;
      n++;
    }
  }
  return n === 1 ? p : null;
}

/* ---- 核心动作 ---- */

/** 建边后换绑（探针扩展同款三步）：找回新边→端点标 unknown→updateReferences 按 uuid 换真身。
 * v0.2.x 日志实证这三步全能跑通；缺它则运行时端点是副本（线删不掉/不跟随/渲染错位） */
async function rebindEdge(sm: any, edgeUuid: string): Promise<void> {
  try {
    const edges = await sm.getLineEdges();
    for (const e of edges) {
      if ((await e.uuid) !== edgeUuid) continue;
      const s = await e.source;
      const t = await e.target;
      if (s) s.unknown = true;
      if (t) t.unknown = true;
      await sm.updateReferences();
      return;
    }
  } catch { /* 换绑失败：保存重开后仍会正确（加载链路自带换绑） */ }
}

async function run(fromParent: boolean, up: boolean): Promise<void> {
  cancelPendingEdit(); // 先清掉上次按键遗留的延迟编辑，避免它抢走后续焦点
  const sm = await getSM();
  const snap = await snapshot(sm);

  // 选中节点（跳过质点本身）
  let sel: string | null = null;
  for (const [uuid, info] of snap.nodes) {
    if (info.selected && !info.isPoint) { sel = uuid; break; }
  }
  if (!sel) return;

  // 9/3：换父节点
  let anchor = sel;
  if (fromParent) {
    const p = parentOf(snap, sel);
    if (!p) return;
    anchor = p;
  }
  const ar = snap.nodes.get(anchor);
  if (!ar) return;

  const cx = ar.rect.x + ar.rect.w / 2;
  const tail = chainTail(snap, anchor, up);
  const chainParent = tail ? tail.uuid : anchor;

  // 引擎间距随字号等级缩放：nearGap = 50 * 2^(fsl/2)，normalGap = nearGap * 3
  const nearGap = NEAR_GAP * 2 ** ((ar.fsl || 0) / 2);
  const firstPointGap = nearGap + POINT_SIZE / 2; // 边缘 → 首个质点中心
  const chainStep = nearGap + POINT_SIZE; // 质点中心 → 下一质点中心
  const childGap = nearGap * 3; // 质点右缘 → 子项左缘

  const pUuid = crypto.randomUUID();
  const childX = cx + R + childGap;

  // 竖边源端：链尾质点或锚点本体（锚点率全中心 = unknown 方向，Tab 重排不动我们）
  const vertFrom = tail
    ? { x: cx - R, y: tail.cy - R, w: R * 2, h: R * 2 }
    : { x: ar.rect.x, y: ar.rect.y, w: ar.rect.w, h: ar.rect.h };
  // 标准方向锚点率（与引擎一致；这样软件认可树结构，Tab 的编辑态/选择转移正常）
  const SRC_RATE = { x: 0.5, y: up ? 0.01 : 0.99 }; // 父：上/下边缘发出
  const TGT_RATE = { x: 0.5, y: up ? 0.99 : 0.01 }; // 子：下/上边缘接收
  const RIGHT_RATE = { x: 0.99, y: 0.5 }; // 质点右缘
  const LEFT_RATE = { x: 0.01, y: 0.5 }; // 子项左缘

  const sections: any[] = [];

  // ---- 顺序：先建子项 → 量它真实高度 → 按"高度+20"定质点位置 → 子项对齐质点 → 建质点/边 ----
  // 这样质点间距 = 子项高 + 软件内置 treesGap(20)，与 \ 键的兄弟间距一致，且随内容自适应
  const project2 = await prg.tabs_getCurrentProject();
  const adder = await project2.nodeAdder;
  const tentativeY = tail ? tail.cy : (up ? ar.rect.y : ar.rect.y + ar.rect.h);
  const cUuid2 = await adder.addTextNodeByClick(
    { _: "Vector", x: childX, y: tentativeY - CHILD_H / 2 },
    sections,
    false,
  );

  // 量真实尺寸
  let cRect = { x: childX, y: tentativeY - CHILD_H / 2, w: CHILD_W, h: CHILD_H };
  let cNode: any = null;
  try {
    cNode = await sm.getTextNodeByUUID(cUuid2);
    const cb2 = await cNode.collisionBox;
    const sh2 = await cb2.shapes;
    const loc2 = await sh2[0].location;
    const size2 = await sh2[0].size;
    const rx = await loc2.x;
    const ry = await loc2.y;
    const rw = await size2.x;
    const rh = await size2.y;
    if ([rx, ry, rw, rh].every(Number.isFinite)) {
      cRect = { x: rx, y: ry, w: rw, h: rh };
    }
  } catch { /* 量取失败用兜底尺寸 */ }

  // v0.4.4：质心位置完全按引擎数学（首点 边缘±65 / 链步 ±80）→ Tab 重排是空操作
  const pcy = tail
    ? tail.cy + (up ? -chainStep : chainStep)
    : up ? ar.rect.y - firstPointGap : ar.rect.y + ar.rect.h + firstPointGap;

  // 子项垂直居中对齐质点
  try {
    const idealY = pcy - cRect.h / 2;
    if (Math.abs(cRect.y - idealY) > 1 && cNode && cNode.moveTo) {
      await cNode.moveTo({ _: "Vector", x: cRect.x, y: idealY });
      cRect = { ...cRect, y: idealY };
    }
  } catch { /* 对齐失败只影响横线斜度，间距不受影响 */ }

  await sm.add(pointEnt(pUuid, cx, pcy));

  const e1 = crypto.randomUUID();
  const e2 = crypto.randomUUID();
  await sm.add(edgeEnt(
    chainParent, vertFrom,
    pUuid, { x: cx - R, y: pcy - R, w: R * 2, h: R * 2 },
    SRC_RATE, TGT_RATE,
    e1,
  ));
  await sm.add(edgeEnt(
    pUuid, { x: cx - R, y: pcy - R, w: R * 2, h: R * 2 },
    cUuid2, cRect,
    RIGHT_RATE, LEFT_RATE,
    e2,
  ));
  await rebindEdge(sm, e1);
  await rebindEdge(sm, e2);

  // v0.4.3：进编辑态必须延迟（官方 onDeepGenerateNode 用 setTimeout 6 帧 ≈100ms，
  // 目的是等渲染/输入元素就绪）。立刻调用会让编辑状态错乱，导致后续 Tab/反斜杠
  // 新建的节点进不了编辑态。
  const cu = await project2.controllerUtils;
  pendingEditTimer = setTimeout(() => {
    pendingEditTimer = null;
    try { cu.textNodeInEditModeByUUID(cUuid2); } catch { /* ignore */ }
  }, 100);
}

/* ---- 四键注册 ---- */

await prg.keybinds_register("tl-up-child", { $lucide: "CornerRightUp" }, "8", Comlink.proxy(() => run(false, true)));
await prg.keybinds_register("tl-down-child", { $lucide: "CornerRightDown" }, "2", Comlink.proxy(() => run(false, false)));
await prg.keybinds_register("tl-up-parent", { $lucide: "CornerUpRight" }, "9", Comlink.proxy(() => run(true, true)));
await prg.keybinds_register("tl-down-parent", { $lucide: "CornerDownRight" }, "3", Comlink.proxy(() => run(true, false)));

// 版本探针：按 0 弹出当前运行的插件版本（排查"改了没生效"）
await prg.keybinds_register("tl-version-probe", { $lucide: "Info" }, "0", Comlink.proxy(async () => {
  try {
    await prg.dialog_confirm("插件版本 " + PLUGIN_VERSION, "当前运行的插件版本。如与此不符 = 软件未重启，请重启 Project Graph 后再测。");
  } catch {
    try { await prg.toast("timeline-mode " + PLUGIN_VERSION); } catch {}
  }
}));
