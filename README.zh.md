# dsh-progressive-tools

[English](README.md) | 中文

面向 DeepSeek Harness Native、Code 与 Both 模式的 Agent 作用域渐进式工具披露层。它只改变呈现层：即使实时 ToolRuntime 目录注册、注销、限制或遮蔽非 eager 工具，模型可见的工具前缀仍保持稳定。

## 安装与组装

按照 [`INSTALL.md`](INSTALL.md) 把这个自包含包安装到 dsh profile，再将配置行挂载到用户自己的 Agent preset。插件固定依赖 `tools` 与 `systemPrompt`；只有实际呈现 Code Mode 时才需要 `codeRuntime`。它拒绝全局挂载，也不会修改 Harness checkout。

```yaml
- id: progressive-tools
  name: dsh-progressive-tools
  config:
    eagerTools: []
    maxSearchResults: 10
    maxDescribeTools: 5
    maxSummaryChars: 240
    maxQueryChars: 500
    maxToolNameChars: 200
    maxResultBytes: 1048576
```

`eagerTools` 只应包含真正稳定、需要直接声明的精确工具名。未知 eager 名称会让 assembly 失败。条目数、字素数和结果 UTF-8 字节上限都会在成功返回前强制执行。

## 各模式的稳定表面

| 有效模式 | 模型可见的稳定工具 | 搜索后的调用方式 |
| --- | --- | --- |
| Native | `search_tools`、`describe_tools`、eager 工具 | 使用返回的精确名称与参数发起普通工具调用 |
| Code | 线路仅有 `run_code`，其 SDK 声明发现与 eager binding | 后续 `run_code` 中调用 `tools[exactName](arguments)` |
| Both | `run_code`、发现工具、eager 工具 | 普通调用或 Code binding |

设计中刻意没有 `invoke_tool`。搜索只提供知识；执行继续使用标准模型工具调用协议或现有 Code Mode transport。

## 发现协议

1. Native/Both 直接调用 `search_tools({ query, limit? })`，Code 则把它作为 Code binding 调用。`*` 会列出有界目录。每个匹配都包含精确 `name`、有界 `description`、`parameters` 与 `output` schema。
2. 后续模型步骤中，Native/Both 使用该精确名称与参数发起普通工具调用，即使稳定 wire 列表没有重复声明其 schema。Code 在后续 `run_code` 中调用 `tools[exactName](arguments)`。
3. 执行时 ToolRuntime 重新解析当前作用域目录。仍存在且可见的工具正常运行；已删除、受限、被遮蔽或拼错的名称返回当前失败原因。
4. `describe_tools({ names })` 保留为可选的精确名称批量查询。所有模式都返回 canonical schema；Code/Both 另外返回当前 runtime 的 SDK 片段。

每个结果都包含排序后当前作用域目录的 SHA-256 `catalogVersion` 以及 `presentationMode`。搜索与描述每次都使用 `ctx.tools.schemas(exec.agent)` 和 `ctx.tools.get(name, exec.agent)`。

协议保持无状态：搜索不会解锁能力，没有 reveal 集合改变后续 assembly，完整实时目录仍是执行权威。

## 模型体验

### Native

```markdown
## Progressive tool disclosure

search_tools returns exact names, descriptions, input schemas, and output schemas.
On a later model step, issue an ordinary tool call with the returned exact name and arguments.
An unavailable call fails with the current ToolRuntime reason.
```

### Code

线路仍只有 `run_code`；紧凑 SDK 只包含 `search_tools`、`describe_tools` 与 eager binding。搜索返回目标精确 schema，后续程序调用 `tools[exactName](arguments)`。

### Token 与 KV Cache 影响

稳定前缀只随发现声明与 `eagerTools` 增长，不随完整可见目录增长。注册或注销非 eager 工具只改变后续发现结果和 `catalogVersion`，不会改变投影后的 wire tools 或紧凑 SDK。这直接针对 [deepseek-harness discussion #935](https://github.com/deepseek-ai/deepseek-harness/discussions/935) 中的动态工具前缀失效问题。

## 已知限制

- **供应商对未声明标准调用的支持不同** —— Harness 会把模型返回的精确名称交给 ToolRuntime，但使用 constrained decoding 的供应商可能拒绝生成 wire 声明中不存在的函数名。本插件刻意不提供 generic invocation fallback。
- **呈现不是授权** —— 已知精确名称的调用方可以尝试调用；ToolRuntime 的可见性、policy、approval、guard 与调度仍是最终权威。
- **不会过滤独立 `tool:*` guidance** —— 若其他插件动态改变单独指引文本，system prefix 仍可能变化。
- **完整提示仍是最终权威** —— Harness 会在 assembly waterfall 后恢复 complete prompt，因此无法向其中注入发现指引，但稳定 wire 投影仍保留。
- **搜索是确定性词法匹配，不是语义检索。**
- **每个作用域假定只有一个协作式呈现所有者** —— 两个都改写最终工具表面的插件没有合并契约。

## 许可证

Apache License 2.0，参见 [`LICENSE`](LICENSE)。
