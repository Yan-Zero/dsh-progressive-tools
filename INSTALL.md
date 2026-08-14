# Installation runbook

This is a standalone DeepSeek Harness plugin. Do not patch or commit changes to a Harness source checkout.

## 1. Build and verify this checkout

```sh
cd E:/source/ai/dsh/progressive-tools
pnpm install
pnpm run check
```

## 2. Install the bundle into a profile

For the local checkout and default Web profile:

```sh
dsh plugin --profile web add link:E:/source/ai/dsh/progressive-tools
```

After publication, the package name alone is sufficient:

```sh
dsh plugin --profile web add dsh-progressive-tools
```

The package's bundle patch is intentionally empty. Installation makes the package resolvable by the profile without mounting it host-globally, because this plugin must own an Agent scope.

## 3. Mount it in a user Agent preset

Copy or create a Native, Code, or Both user preset under `$DSH_HOME/.agent-presets`. Preserve the preset's existing rows, and append [`examples/agent.cordis.fragment.yml`](examples/agent.cordis.fragment.yml) after its tool-presentation row:

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

The plugin detects the preset's final Native, Code, or Both presentation surface during assembly. Do not add this row to the profile root.

## 4. Verify

Select that user preset for a new session. Its model-facing wire surface remains bounded: Native exposes discovery tools, Code exposes `run_code`, and Both exposes those stable transports; non-eager schemas arrive through `search_tools` results. Removing this one preset row disables the plugin without modifying Harness.
