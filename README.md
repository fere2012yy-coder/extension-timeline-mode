# 时间轴布局（com.zcode.timeline-mode）

Project Graph 扩展 · 作者：明亮 · 当前版本 0.5.1

**质点挂载四键**：选中节点按数字键，一键挂出「质点串 + 子项」结构（XMind 拐弯样式）。

```
        ┌→ 质点 → 子项A      ← 按 8：上方
 目标 ──┤
        └→ 质点 → 子项B      ← 按 2：下方
```

## 按键

| 键 | 作用 |
|---|---|
| `8` | 当前节点**正上方**挂质点，质点右侧建子项并直接进入编辑 |
| `2` | 当前节点**正下方**挂质点，质点右侧建子项并直接进入编辑 |
| `9` | **父节点**正上方挂质点+子项（须恰好一个父才执行） |
| `3` | **父节点**正下方挂质点+子项（同上） |
| `0` | 弹窗显示当前运行的插件版本（装机校验用） |

特性与纪律：

- **恰好一父**：9/3 要求目标节点恰好有一个父节点，否则不动
- **不整树重排**：只动新增部分，已有节点原地不动；质点连线用**虚线**，官方树形重排（Tab）物理上碰不到它
- **质点串链**：同方向连续挂载时，新质点接在同侧最外侧质点之后（一条竖干），间距 = 子项高度 + 20px 自适应防重叠

## 使用

1. 重启 Project Graph（或重载应用）加载本扩展
2. 按 `0` 校验弹出版本为 0.5.1
3. 选中节点 → 按对应数字键

## 开发

- `pnpm build` — 构建（输出 dist/，含 metadata.msgpack）
- `pnpm vitest run` — 跑落位计算单测
- `pnpm package` — 出包
- ⚠️ `pnpm install:ext` 因 extprg 1.1.0 的 bug（install 命令缺 --dist 参数定义）不可用，手动安装法：

```bash
python -c "
import zipfile, os
with zipfile.ZipFile(os.path.join(os.environ['APPDATA'],'liren.project-graph','extensions','com.zcode.timeline-mode.prg'),'w',zipfile.ZIP_DEFLATED) as z:
    [z.write(os.path.join('dist',f),f) for f in ['extension.js','metadata.msgpack','icon.svg','README.md']]
"
```
