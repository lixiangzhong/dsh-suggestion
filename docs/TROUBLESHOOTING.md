# 排障记录

按「现象 → 怎么确认 → 原因 → 怎么处理」记录实际踩过的坑，避免重复判断。

## Host 半改了代码但没生效（需要重启 DSH）

**现象**：改了 `index.js` / `lib/*` 后，用 `plugin_manager` 的 `remove_bundle` + `install_bundle`（或禁用再启用）更新插件，结果返回 `applied`，但运行时行为仍是旧版：新增的日志字段没有、修掉的 bug 还在。

**怎么确认**：开启 `tracePath` 后看留痕字段。以 0.2.3 为例，新版才会写 `service.created` 与每条 host 事件的 `instance`；如果安装新版后留痕里仍然只有旧字段，就是 Host 模块没换：

```
05:19:08 host plugin.start          ← applied 了
05:19:09 host suggest (无 instance) ← 跑的还是旧模块
```

**原因**：DSH 替换**已安装的包**只应用配置层，不会替换进程内已经加载的 Host 模块代际；`applied` 表示 Loader 的配置树更新成功，不等于模块换了新代码。重启 DSH 才会加载新的模块代际。

**怎么处理**：

| 改动位置 | 生效方式 |
| --- | --- |
| Host 半（`index.js`、`lib/*`、`config`、路由） | **重启 DSH** |
| 客户端半（`client.js`） | 内容变化会换 rev，刷新窗口即加载新版本（不必重启） |

**验证**：重启后再看留痕，应出现新版本独有的字段（如 `service.created`、`instance`）；或直接在浏览器控制台调 `__DSH_SUGGESTION__.request(<sessionId>)` 对比行为。

**背景（2026-11-13）**：排查「同一轮生成两次」时踩到。当时 cacheKey 仍按语言分区（`…en` / `…zh`），兜底与客户端各生成一次；安装修复版后现象不变，起初误判为「两个 Host 实例」，直到加了 `instance` 字段才发现运行的一直是旧模块。重启后同样的顺序立刻命中缓存（`background generated` → `request cached ms=0`，同一 `instance`、同一 `cacheKey`）。

## 升级后「没看到建议」

**现象**：升级或改配置后，输入框占位不再出现建议。

**先看 trace 的三处**：

1. `bridge.mount` 的 `sessionId` —— 是不是**当前这个会话**。DSH 可能同时开着多个窗口，留痕来自哪个窗口要看这个字段；
2. `outcome` —— `generated` / `cached` 说明 Host 侧正常，问题在显示；`no-turn`、`stale-turn`、`llm-failed` 等见 [DETAIL.md](DETAIL.md) 的排障留痕表；
3. `paint.applied` —— 有这行才说明占位真的被替换过；只有 `paint.skipped` 说明宿主正显示别的状态文案（计划模式、插话提示、未选工作区等），是预期行为。

如果整段留痕都没有该会话，刷新一次窗口（客户端模块重新加载）。

## 手机上只有占位、没有可点建议条

**现象**：手机打开同一个会话，轮次结束后没看到建议条，也无法像桌面那样按 <kbd>Tab</kbd>。

**怎么确认**：开启 `tracePath` 看 `client.start` 的 `touch` 字段。`touch: true` 表示按触控形态启动了，此时不看 `paint.*`（触控形态不接管占位），而应看到 `bridge.mount` + `request.done`；建议条是否出现取决于该会话此刻「草稿为空 + 普通输入态 + 无排队插话」。

**原因**：

1. 触控判定只在页面加载时做一次，用的是 `(hover: none) and (pointer: coarse)`；远程调试面板、桌面浏览器的「手机模拟」如果没开触控模拟，仍会被判成桌面形态。
2. `touch: false` 时按桌面处理：建议写进占位文字，需要 <kbd>Tab</kbd>——手机上自然看不到可点入口。

**怎么处理**：刷新一次窗口让客户端模块重新加载；仍不行就在浏览器控制台执行 `matchMedia('(hover: none) and (pointer: coarse)').matches` 确认判定结果。桌面浏览器「手机模拟」要同时启用触控模拟（DevTools 里 device 模式默认会启用）。
