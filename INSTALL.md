# Installation runbook

This is a standalone DeepSeek Harness bundle. Installing it into a profile activates progressive tool disclosure for every Agent preset in that profile. It does not patch the Harness checkout or create, copy, edit, or select an Agent preset.

## 1. Install the bundle into a profile

For the published package and default Web profile:

```sh
dsh plugin --profile web add dsh-progressive-tools
```

For a local checkout:

```sh
cd E:/source/ai/dsh/progressive-tools
pnpm install
npm run check
dsh plugin --profile web add link:E:/source/ai/dsh/progressive-tools
```

The package's `cordis.patch.yml` inserts one host-plane `progressive-tools` row. Scoped ToolRuntime and SystemPrompt views apply that row to Native, Code, and Both agents regardless of which preset they use. Removing the package removes the row.

## 2. Optional configuration

Defaults require no profile edits. To override them, target the bundle-owned row from the profile's `cordis.patch.yml`:

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

`eagerTools` names exact tools that remain declared directly on every affected model surface. Unknown names fail prompt assembly.

## 3. Verify

Start a new session with any Agent preset. Native always exposes `search_tools` and `describe_tools`; APIs without native deferred loading also expose `invoke_tool`, while capable pi-ai Responses/Anthropic models receive disclosed schemas at the describe-result position. Code keeps only `run_code` on the wire and exposes discovery bindings in its compact SDK; Both exposes the stable transports for both paths and does not need `invoke_tool`.

To uninstall:

```sh
dsh plugin --profile web remove dsh-progressive-tools
```
