# dsh-progressive-tools

English | [中文](README.zh.md)

An automatically mounted, presentation-only progressive tool disclosure layer for every DeepSeek Harness Agent preset in Native, Code, and Both modes. It keeps the model-visible tool prefix stable while the live ToolRuntime catalog may register, unregister, restrict, or shadow non-eager tools.

## Installation and composition

Follow [`INSTALL.md`](INSTALL.md) and install this standalone bundle into a dsh profile. Its bundle patch mounts the plugin once on the host plane, whose scoped ToolRuntime and SystemPrompt views carry it into every existing and future Agent preset. No preset copy, preset edit, or preset selection is required. The plugin requires `tools`, `systemPrompt`, and `llm`; `codeRuntime` is required only when an agent actually presents Code Mode. It never patches the Harness checkout.

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

The configuration block above is an optional override in the profile's `cordis.patch.yml`; the bundle already owns the `progressive-tools` row. `eagerTools` contains exact, genuinely stable tools that remain declared directly. Unknown eager names fail assembly. Every count, grapheme, and rendered UTF-8 result limit is enforced before a successful discovery result returns.

## Stable mode surfaces

| Effective mode | Stable model-visible tools | Invocation after describe |
| --- | --- | --- |
| Native, native deferred API | `search_tools`, `describe_tools`, eager tools | ordinary tool call with the returned exact name and arguments |
| Native, other API | `search_tools`, `describe_tools`, `invoke_tool`, eager tools | `invoke_tool({ name, arguments })` |
| Code | `run_code`; its SDK declares discovery and eager bindings | `tools[exactName](arguments)` inside a later `run_code` |
| Both | `run_code`, discovery tools, eager tools | ordinary tool call or Code binding |

`invoke_tool` is a capability fallback, not a second Code transport. The plugin removes it at the pi-ai request boundary when the resolved model supports OpenAI Responses client tool search or Anthropic tool references. Code and Both already have `run_code`, so they never expose `invoke_tool`.

## Discovery protocol

1. Call `search_tools({})` or `search_tools({ query: "*" })` directly in Native/Both, or as a Code binding in Code mode, to list the complete lightweight catalog. Each entry contains only the exact `name` and a bounded `description`, matching Harness Skills' summary-first shape. A text query is an optional ranking filter: terms are matched independently instead of all being required, and a zero-match query falls back to the complete catalog. An explicit `limit` still narrows a response when desired.
2. Call `describe_tools({ names })` for the candidates you intend to use. It returns their canonical input/output schemas and full descriptions; Code/Both also receives the active-runtime SDK excerpt.
3. On a later model step, a natively capable API emits an ordinary tool call using that exact name and arguments. The plugin reconstructs successful `describe_tools` results from durable request history and injects their schemas at the matching tool-result position. A Native API without that capability calls the stable `invoke_tool({ name, arguments })` fallback. Code calls `tools[exactName](arguments)` from a later `run_code`.
4. ToolRuntime resolves the current scoped registry at execution time. Existing visible tools run normally; removed, restricted, shadowed, or misspelled names return the current failure reason.

Search and describe use `ctx.tools.schemas(exec.agent)` and `ctx.tools.get(name, exec.agent)` on every call. Search returns only `name` and `description` entries plus compact count metadata; describe returns exact schemas only for selected names. Neither result exposes internal catalog or presentation metadata.

The protocol keeps no mutable reveal set: search does not unlock a capability, and the complete runtime catalog remains the execution authority. Native disclosure is reconstructed from logged `describe_tools` call/result pairs on every request.

### Native API injection

Harness request objects stay frozen and read-only. The plugin uses the public `llm/stream` waterfall to carry one request's durable disclosures, then reversibly wraps the resolved pi-ai `Models.streamSimple` instance. For capable models it adds pi-ai `addedToolNames` to the matching result and supplies the disclosed schemas; pi-ai serializes OpenAI `tool_search_call`/`tool_search_output` or Anthropic `tool_reference` blocks at that transcript position. Unsupported or unrecognized adapters are left untouched and retain `invoke_tool`.

## Model experience

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

The wire remains `run_code`; its compact SDK contains only `search_tools`, `describe_tools`, and eager bindings. Search lists or optionally ranks the lightweight catalog, describe returns exact target schemas and an SDK excerpt, and a later program calls `tools[exactName](arguments)`.

### Token and KV-cache effect

The stable prefix scales with discovery declarations, the fixed fallback, and `eagerTools`, not the complete visible catalog. Native APIs append disclosed schemas at the historical describe result rather than replacing the top-level tool array, so the cached prefix remains stable. Registering or unregistering a non-eager tool changes only later discovery results. This directly addresses dynamic-tool prefix invalidation such as [deepseek-harness discussion #935](https://github.com/deepseek-ai/deepseek-harness/discussions/935).

## Known limitations

- **The native bridge is feature-detected against pi-ai internals** — DSH exposes a read-only stream waterfall but no adapter context-transform hook. The plugin therefore wraps the current pi-ai Models instance without changing Harness source. If that internal shape changes, it fails open to the stable `invoke_tool` fallback; Both continues to have `run_code`.
- **Native capability metadata must be accurate** — OpenAI Responses uses `compat.supportsToolSearch`; Anthropic uses `supportsToolReferences` or pi-ai's first-party model rule. A gateway that over-claims either capability may reject the injected protocol.
- **Presentation is not authorization** — callers that already know an exact name may try it; ToolRuntime visibility, policy, approval, guards, and scheduling remain authoritative.
- **Independent `tool:*` guidance is not filtered** — a plugin that dynamically changes separate guidance text can still change the system prefix.
- **Complete prompts remain authoritative** — Harness restores a complete prompt after the assembly waterfall, so discovery guidance cannot be injected there even though the stable wire projection remains.
- **Search is relaxed deterministic lexical ranking, not semantic retrieval.** Independent-term matching, identifier splitting, and small English plural normalization improve recall; a query with no lexical candidate returns the complete lightweight catalog instead of an empty dead end.
- **One cooperative presentation owner per scope is assumed** — two plugins that both rewrite the final tool surface have no merge contract.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
