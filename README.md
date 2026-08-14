# dsh-progressive-tools

English | [中文](README.zh.md)

An agent-scoped, presentation-only progressive tool disclosure layer for DeepSeek Harness Native, Code, and Both modes. It keeps the model-visible tool prefix stable while the live ToolRuntime catalog may register, unregister, restrict, or shadow non-eager tools.

## Installation and composition

Follow [`INSTALL.md`](INSTALL.md): install this standalone package into a dsh profile, then mount its row inside a user-owned Agent preset. The plugin requires `tools` and `systemPrompt`; `codeRuntime` is required only when that preset actually presents Code Mode. It refuses a global mount and never patches the Harness checkout.

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

`eagerTools` contains exact, genuinely stable tools that remain declared directly. Unknown eager names fail assembly. Every count, grapheme, and rendered UTF-8 result limit is enforced before a successful discovery result returns.

## Stable mode surfaces

| Effective mode | Stable model-visible tools | Invocation after search |
| --- | --- | --- |
| Native | `search_tools`, `describe_tools`, eager tools | ordinary tool call with the returned exact name and arguments |
| Code | `run_code`; its SDK declares discovery and eager bindings | `tools[exactName](arguments)` inside a later `run_code` |
| Both | `run_code`, discovery tools, eager tools | ordinary tool call or Code binding |

There is deliberately no `invoke_tool`. Search supplies knowledge; execution remains the ordinary model tool-call protocol or the existing Code Mode transport.

## Discovery protocol

1. Call `search_tools({ query, limit? })` directly in Native/Both, or as a Code binding in Code mode. `*` lists the bounded catalog. Every match includes the exact `name`, bounded `description`, `parameters`, and `output` schema.
2. On a later model step, Native/Both emits an ordinary tool call using that exact name and arguments even though the stable wire list does not repeat the schema. Code calls `tools[exactName](arguments)` from a later `run_code`.
3. ToolRuntime resolves the current scoped registry at execution time. Existing visible tools run normally; removed, restricted, shadowed, or misspelled names return the current failure reason.
4. `describe_tools({ names })` remains an optional exact-name batch lookup. It returns canonical schemas in every mode and adds the active runtime SDK excerpt only for Code/Both.

Every result includes `catalogVersion`, a SHA-256 digest of the sorted current scoped catalog, plus `presentationMode`. Search and describe use `ctx.tools.schemas(exec.agent)` and `ctx.tools.get(name, exec.agent)` on every call.

The protocol is stateless: search does not unlock a capability, no reveal set changes future assemblies, and the complete runtime catalog remains the execution authority.

## Model experience

### Native

```markdown
## Progressive tool disclosure

search_tools returns exact names, descriptions, input schemas, and output schemas.
On a later model step, issue an ordinary tool call with the returned exact name and arguments.
An unavailable call fails with the current ToolRuntime reason.
```

### Code

The wire remains `run_code`; its compact SDK contains only `search_tools`, `describe_tools`, and eager bindings. Search returns exact target schemas, and a later program calls `tools[exactName](arguments)`.

### Token and KV-cache effect

The stable prefix scales with discovery declarations plus `eagerTools`, not the complete visible catalog. Registering or unregistering a non-eager tool changes only later discovery results and `catalogVersion`; it does not change the projected wire tools or compact SDK. This directly addresses dynamic-tool prefix invalidation such as [deepseek-harness discussion #935](https://github.com/deepseek-ai/deepseek-harness/discussions/935).

## Known limitations

- **Provider support for undeclared standard calls varies** — Harness will dispatch a returned exact name through ToolRuntime, but a provider using constrained decoding may refuse to generate a function name absent from the wire declaration. This plugin intentionally does not add a generic invocation fallback.
- **Presentation is not authorization** — callers that already know an exact name may try it; ToolRuntime visibility, policy, approval, guards, and scheduling remain authoritative.
- **Independent `tool:*` guidance is not filtered** — a plugin that dynamically changes separate guidance text can still change the system prefix.
- **Complete prompts remain authoritative** — Harness restores a complete prompt after the assembly waterfall, so discovery guidance cannot be injected there even though the stable wire projection remains.
- **Search is deterministic lexical matching, not semantic retrieval.**
- **One cooperative presentation owner per scope is assumed** — two plugins that both rewrite the final tool surface have no merge contract.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
