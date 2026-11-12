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
plugin_manager install_bundle target=@lixiangzhong/dsh-suggestion-bundle
```

本地开发（以符号链接方式装进 profile）：

```text
plugin_manager install_bundle target=link:/path/to/dsh-suggestion
```

安装后在 Plugins 页启用 `输入框建议`（bundle 名 `@lixiangzhong/dsh-suggestion-bundle`，插件行 id `dsh-suggestion`）。配置见 [docs/DETAIL.md](docs/DETAIL.md)。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 入口：配置归一化、服务装配、路由注册 |
| `lib/route.js` | 鉴权 HTTP 路由 `GET /dsh-suggestion/suggest` |
| `lib/service.js` | 建议生成、按轮次去重缓存、近期建议记忆 |
| `lib/session-context.js` | 从会话事件折出最后一轮上下文与工具摘要 |
| `lib/summary.js` | 早期对话的增量摘要 |
| `lib/prompt.js` | 提示词构造与输出归一化 |
| `client.js` | 浏览器半边：触发、占位文字接管、Tab 接受、降级建议条 |

## 开发

```sh
npm test      # node --check + 纯函数单测
```

无构建步骤：`client.js` 直接以 `window.__ModuleLoader__` 工厂形式加载。

## License

MIT
