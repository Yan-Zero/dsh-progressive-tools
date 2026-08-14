# dsh-progressive-tools

[English](README.md) | 中文

面向 DeepSeek Harness Native、Code 与 Both 模式中所有 Agent preset 的自动挂载、渐进式工具披露层。它只改变呈现层：即使实时 ToolRuntime 目录注册、注销、限制或遮蔽非 eager 工具，模型可见的工具前缀仍保持稳定。

## 安装与组装

按照 [`INSTALL.md`](INSTALL.md) 把这个自包含 bundle 安装到 dsh profile。bundle patch 会在 host plane 挂载插件一次，再由 ToolRuntime 与 SystemPrompt 的作用域视图将它传递给所有已有和未来的 Agent preset。无需复制、编辑或选择额外 preset。插件固定依赖 `tools`、`systemPrompt` 与 `llm`；只有 Agent 实际呈现 Code Mode 时才需要 `codeRuntime`。它不会修改 Harness checkout。

```yaml
- id: progressive-tools
  config:
    eagerTools: []
    maxSearchResults: 10
    maxDescribeTools: 5
    maxSummaryChars: 240
    maxQueryChars: 500
    maxToolNameChars: 200
    maxResultBytes: 1048576
```

上述配置块是 profile `cordis.patch.yml` 中的可选覆盖；bundle 已经拥有 `progressive-tools` 行。`eagerTools` 只应包含真正稳定、需要直接声明的精确工具名。未知 eager 名称会让 assembly 失败。条目数、字素数和结果 UTF-8 字节上限都会在成功返回前强制执行。

## 各模式的稳定表面

| 有效模式 | 模型可见的稳定工具 | 描述后的调用方式 |
| --- | --- | --- |
| Native，原生延迟披露 API | `search_tools`、`describe_tools`、eager 工具 | 使用返回的精确名称与参数发起普通工具调用 |
| Native，其他 API | `search_tools`、`describe_tools`、`invoke_tool`、eager 工具 | `invoke_tool({ name, arguments })` |
| Code | 线路仅有 `run_code`，其 SDK 声明发现与 eager binding | 后续 `run_code` 中调用 `tools[exactName](arguments)` |
| Both | `run_code`、发现工具、eager 工具 | 普通调用或 Code binding |

`invoke_tool` 是能力兜底，不是第二套 Code transport。若解析后的模型支持 OpenAI Responses client tool search 或 Anthropic tool reference，插件会在 pi-ai 请求边界移除它。Code 与 Both 已有 `run_code`，因此不会暴露 `invoke_tool`。

## 发现协议

1. Native/Both 直接调用 `search_tools({})` 或 `search_tools({ query: "*" })`，Code 则把它作为 Code binding 调用，以列出完整轻量目录。与 Harness Skills 的“摘要优先”形态一致，每项只包含精确 `name` 与有界 `description`。文本查询只是可选的排序过滤器：各查询词独立匹配，不再要求全部命中；零命中时自动退回完整目录。需要时仍可显式传入 `limit` 缩小响应。
2. 对准备使用的候选项调用 `describe_tools({ names })`。它返回完整描述和 canonical 输入/输出 schema；Code/Both 还会获得当前 runtime 的 SDK 片段。
3. 后续模型步骤中，原生支持的 API 使用该精确名称与参数发起普通工具调用。插件从持久化请求历史重建成功的 `describe_tools` 结果，并把 schema 注入对应 tool-result 位置。不支持该能力的 Native API 使用稳定的 `invoke_tool({ name, arguments })` 兜底。Code 在后续 `run_code` 中调用 `tools[exactName](arguments)`。
4. 执行时 ToolRuntime 重新解析当前作用域目录。仍存在且可见的工具正常运行；已删除、受限、被遮蔽或拼错的名称返回当前失败原因。

搜索与描述每次都使用 `ctx.tools.schemas(exec.agent)` 和 `ctx.tools.get(name, exec.agent)`。Search 只返回 `name`、`description` 与紧凑计数元数据；describe 只为选中的名称返回精确 schema。两者都不会暴露内部目录或呈现元数据。

协议不维护可变 reveal 集合：搜索不会解锁能力，完整实时目录仍是执行权威。每次请求都会从已记录的 `describe_tools` 调用/结果对重建 Native 披露。

### Native API 注入

Harness 请求对象保持冻结与只读。插件通过公开的 `llm/stream` waterfall 传递当前请求的持久化披露信息，再以可恢复方式包装解析后的 pi-ai `Models.streamSimple` 实例。对支持的模型，它在匹配结果上添加 pi-ai `addedToolNames` 并提供披露 schema；pi-ai 随后在该上下文位置序列化 OpenAI `tool_search_call`/`tool_search_output` 或 Anthropic `tool_reference`。不支持或无法识别的适配器保持原样并保留 `invoke_tool`。

## 模型体验

### Native

```markdown
## Progressive tool disclosure

Start with search_tools({}) or search_tools({ query: "*" }) when you need the complete lightweight catalog of all available names and summaries. A text query is only an optional ranking filter and falls back to that catalog when nothing matches.
Call describe_tools with only the exact names you intend to use.
describe_tools returns the exact input and output schemas; in Code Mode it also returns the active-runtime SDK excerpt.
On a later model step, issue an ordinary tool call with the returned exact name and arguments.
If the interface declares invoke_tool instead, pass it that exact name and arguments.
An unavailable call fails with the current ToolRuntime reason.
```

### Code

线路仍只有 `run_code`；紧凑 SDK 只包含 `search_tools`、`describe_tools` 与 eager binding。Search 会列出轻量目录或按需排序，describe 再返回目标精确 schema 与 SDK 片段，后续程序调用 `tools[exactName](arguments)`。

### Token 与 KV Cache 影响

稳定前缀只随发现声明、固定兜底与 `eagerTools` 增长，不随完整可见目录增长。Native API 会在历史 describe 结果处追加披露 schema，而不是替换顶层工具数组，因此缓存前缀保持稳定。注册或注销非 eager 工具只改变后续发现结果。这直接针对 [deepseek-harness discussion #935](https://github.com/deepseek-ai/deepseek-harness/discussions/935) 中的动态工具前缀失效问题。

## 已知限制

- **Native bridge 会按特征探测 pi-ai 内部对象** —— DSH 提供只读 stream waterfall，但没有 adapter context-transform hook。因此插件在不改 Harness 源码的前提下包装当前 pi-ai Models 实例。若内部形态变化，它会退化为稳定 `invoke_tool`；Both 仍有 `run_code`。
- **Native 能力元数据必须准确** —— OpenAI Responses 使用 `compat.supportsToolSearch`；Anthropic 使用 `supportsToolReferences` 或 pi-ai 的第一方模型规则。错误宣称能力的 gateway 可能拒绝注入协议。
- **呈现不是授权** —— 已知精确名称的调用方可以尝试调用；ToolRuntime 的可见性、policy、approval、guard 与调度仍是最终权威。
- **不会过滤独立 `tool:*` guidance** —— 若其他插件动态改变单独指引文本，system prefix 仍可能变化。
- **完整提示仍是最终权威** —— Harness 会在 assembly waterfall 后恢复 complete prompt，因此无法向其中注入发现指引，但稳定 wire 投影仍保留。
- **搜索是宽松、确定性的词法排序，不是语义检索。** 独立词匹配、标识符拆分和少量英文复数归一化可以提升召回率；没有任何词法候选时会返回完整轻量目录，而不是留下空结果死路。
- **每个作用域假定只有一个协作式呈现所有者** —— 两个都改写最终工具表面的插件没有合并契约。

## 许可证

Apache License 2.0，参见 [`LICENSE`](LICENSE)。
