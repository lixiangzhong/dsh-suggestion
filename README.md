# dsh-suggestion

DSH 插件：每轮任务结束后，用模型生成一句「下一步建议」写进输入框占位文字，<kbd>Tab</kbd> 一键填入草稿。

```text
┌────────────────────────────────────────────────┐
│ 修复 go test 的 3 个失败用例                     │  ← 建议（占位文字）
│                                                │
│  +  发消息…                              ↑     │
└────────────────────────────────────────────────┘
```

## 安装

从 npm 安装：

```text
plugin_manager install_bundle target=@lixiangzhong/dsh-suggestion
```

本地开发（以符号链接方式装进 profile）：

```text
plugin_manager install_bundle target=link:/path/to/dsh-suggestion
```

安装后在 Plugins 页启用 `输入框建议`（bundle 名 `@lixiangzhong/dsh-suggestion`，插件行 id `dsh-suggestion`）。配置见 [docs/DETAIL.md](docs/DETAIL.md)。

## 行为

| 你在哪 | 会怎样 | 花不花调用 |
| --- | --- | --- |
| 当前会话、草稿为空 | 一轮结束立刻请求，1～3 秒占位出现建议 | 一轮一次 |
| 当前会话、草稿里有字 | 不请求，并通知 Host 取消兜底 | 不花 |
| 切到别的会话 / 最小化 / 关窗（应用还在跑） | Host 在轮次结束 2 秒后自己生成，放进进程内缓存 | 一轮一次 |
| 切回那个会话 | 直接命中缓存，立刻看到，不用等模型 | 不花 |

建议缓存按「会话 + 轮次」分区（不按语言，避免兜底与客户端各生成一次），进程存活期间有效（12 小时）；「10 分钟」只约束首次生成，已生成的结果切回多久都能用。模型调用遇到上游错误会自动重试一次。

占位文字是**单行显示**（宿主用 `text-overflow: ellipsis` 截断），但按 <kbd>Tab</kbd> 填入草稿的是**完整建议**——可视截断不影响采纳内容。建议长度上限默认 200 字（`maxChars` 可调）。

以下状态不被接管，宿主原文案保持原样：新会话空白页、未选择工作区、输入被锁、计划模式、有排队插话。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 入口：配置归一化、服务装配、路由注册 |
| `lib/route.js` | 鉴权 HTTP 路由：`suggest` / `skip` / `trace` |
| `lib/service.js` | 建议生成、按轮次去重缓存、后台兜底与取消 |
| `lib/session-context.js` | 从会话事件折出最后一轮上下文与工具摘要 |
| `lib/summary.js` | 早期对话的增量摘要 |
| `lib/prompt.js` | 提示词构造与输出归一化 |
| `client.js` | 浏览器半边：触发、占位文字接管、Tab 接受、降级建议条、草稿非空时取消兜底 |

## 开发

```sh
npm test      # node --check + 纯函数单测
```

无构建步骤：`client.js` 直接以 `window.__ModuleLoader__` 工厂形式加载。

## License

MIT
