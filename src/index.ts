/**
 * Direct-first progressive tool disclosure for Native, Code, and Both modes:
 * keep the model-visible prefix stable while scoped ToolRuntime stays live.
 * @module dsh-progressive-tools
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-code-runtime'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  RUN_CODE_NAME,
  defineTool,
  renderToolsSdk,
  renderToolsSdkPy,
} from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** Stable model-facing name of the catalog search tool. */
export const SEARCH_TOOLS_NAME = 'search_tools'
/** Stable model-facing name of the exact-schema lookup tool. */
export const DESCRIBE_TOOLS_NAME = 'describe_tools'

const DISCOVERY_NAMES = new Set([RUN_CODE_NAME, SEARCH_TOOLS_NAME, DESCRIBE_TOOLS_NAME])

/** Plugin config: every catalog bound and eager declaration is deployment-owned. */
export interface Config {
  /** Stable non-discovery tools declared eagerly on the projected model surface. */
  eagerTools?: string[]
  /** Maximum matches one search may return. */
  maxSearchResults?: number
  /** Maximum exact tool definitions one describe call may return. */
  maxDescribeTools?: number
  /** Maximum characters copied from one tool description into search results. */
  maxSummaryChars?: number
  /** Maximum characters accepted in one search query. */
  maxQueryChars?: number
  /** Maximum characters accepted in one exact tool name. */
  maxToolNameChars?: number
  /** Maximum UTF-8 bytes in either discovery tool's rendered JSON result. */
  maxResultBytes?: number
}

const DEFAULTS = {
  eagerTools: [] as string[],
  maxSearchResults: 10,
  maxDescribeTools: 5,
  maxSummaryChars: 240,
  maxQueryChars: 500,
  maxToolNameChars: 200,
  maxResultBytes: 1_048_576,
} as const

/** Validated Loader schema for Config. */
export const Config: z<Config> = z.object({
  eagerTools: z.array(z.string()).default([]),
  maxSearchResults: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxSearchResults),
  maxDescribeTools: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxDescribeTools),
  maxSummaryChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxSummaryChars),
  maxQueryChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxQueryChars),
  maxToolNameChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxToolNameChars),
  maxResultBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxResultBytes),
})

/** Cordis plugin name. */
export const name = 'agent-progressive-tools'
/** Always-required services; Code runtime is resolved only for Code/Both assembly. */
export const inject = ['tools', 'systemPrompt']

interface ResolvedConfig {
  eagerTools: string[]
  maxSearchResults: number
  maxDescribeTools: number
  maxSummaryChars: number
  maxQueryChars: number
  maxToolNameChars: number
  maxResultBytes: number
}

interface CatalogTool extends ToolSchema {
  parameters: Record<string, unknown>
  output: JsonSchemaNode
}

type PresentationMode = 'native' | 'code' | 'both'

interface SearchMatch {
  name: string
  description: string
  parameters: JsonValue
  output: JsonValue
  score: number
}

/** Resolve defaults for direct programmatic callers as well as the Loader. */
function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    eagerTools: [...config.eagerTools ?? DEFAULTS.eagerTools],
    maxSearchResults: config.maxSearchResults ?? DEFAULTS.maxSearchResults,
    maxDescribeTools: config.maxDescribeTools ?? DEFAULTS.maxDescribeTools,
    maxSummaryChars: config.maxSummaryChars ?? DEFAULTS.maxSummaryChars,
    maxQueryChars: config.maxQueryChars ?? DEFAULTS.maxQueryChars,
    maxToolNameChars: config.maxToolNameChars ?? DEFAULTS.maxToolNameChars,
    maxResultBytes: config.maxResultBytes ?? DEFAULTS.maxResultBytes,
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'eagerTools') continue
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new Error(`dsh-progressive-tools: ${key} must be a positive safe integer`)
    }
  }
  const duplicate = resolved.eagerTools.find((tool, index) => resolved.eagerTools.indexOf(tool) !== index)
  if (duplicate !== undefined) {
    throw new Error('dsh-progressive-tools: eagerTools contains duplicate ' + JSON.stringify(duplicate))
  }
  for (const eager of resolved.eagerTools) {
    if (eager.length === 0) throw new Error('dsh-progressive-tools: eagerTools cannot contain an empty name')
    if (DISCOVERY_NAMES.has(eager)) {
      throw new Error('dsh-progressive-tools: eagerTools cannot name reserved disclosure infrastructure ' + JSON.stringify(eager))
    }
  }
  return resolved
}

/** One scope's executable catalog, projected from ToolRuntime's authoritative view. */
function catalog(ctx: Context, scope: ScopeKey | undefined, omitted: ReadonlySet<string>): CatalogTool[] {
  const result: CatalogTool[] = []
  for (const schema of ctx.tools.schemas(scope)) {
    if (omitted.has(schema.name)) continue
    const definition = ctx.tools.get(schema.name, scope)
    if (definition === undefined) continue
    result.push({
      name: schema.name,
      description: schema.description,
      parameters: structuredClone(schema.parameters),
      output: structuredClone(definition.output.schema),
    })
  }
  return result.sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

/** Content digest identifying the exact scoped catalog a result describes. */
function catalogVersion(tools: readonly CatalogTool[]): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(tools)).digest('hex')
}

/** Character-safe summary bound for model-facing search results. */
function graphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text),
    part => part.segment,
  )
}

/** Grapheme-safe summary bound for model-facing search results. */
function summarize(text: string, maxChars: number): string {
  const characters = graphemes(text)
  return characters.length <= maxChars ? text : characters.slice(0, maxChars).join('') + '…'
}

/** Deterministic lexical relevance; zero means the tool does not match. */
function relevance(tool: CatalogTool, query: string): number {
  if (query === '*') return 1
  const terms = query.split(/\s+/u).filter(Boolean)
  const name = tool.name.toLocaleLowerCase('en-US')
  const description = tool.description.toLocaleLowerCase('en-US')
  const schema = JSON.stringify(tool.parameters).toLocaleLowerCase('en-US')
  if (terms.some(term => !name.includes(term) && !description.includes(term) && !schema.includes(term))) return 0
  let score = name === query ? 1_000 : name.startsWith(query) ? 500 : name.includes(query) ? 250 : 0
  for (const term of terms) {
    if (name.includes(term)) score += 25
    if (description.includes(term)) score += 5
    if (schema.includes(term)) score += 1
  }
  return score
}

/** Enforce the configured complete rendered-result byte bound. */
function boundedResult<T>(value: T, maxBytes: number, toolName: string): T {
  const bytes = Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8')
  if (bytes > maxBytes) {
    throw new Error(`${toolName} result is ${String(bytes)} UTF-8 bytes, exceeding the configured ${String(maxBytes)}-byte limit; request fewer or narrower tools`)
  }
  return value
}

/** Validate and normalize one model-written search query. */
function queryText(query: string, maxChars: number): string {
  const normalized = query.trim()
  if (normalized.length === 0) throw new Error('search_tools query must not be blank')
  if (graphemes(normalized).length > maxChars) {
    throw new Error(`search_tools query exceeds the configured ${String(maxChars)}-character limit`)
  }
  return normalized
}

/** SDK schema shape consumed by both first-party renderers. */
function sdkSchema(definition: ToolDefinition): CatalogTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output.schema,
  }
}

/** Render the runtime's language while retaining the registry-owned SDK contract. */
function renderSdk(ctx: Context, schemas: CatalogTool[]): { language: string; sdk: string } {
  const runtime = ctx.get('codeRuntime')
  if (runtime === undefined) {
    throw new Error('dsh-progressive-tools: Code or Both presentation requires ctx.codeRuntime')
  }
  switch (runtime.language) {
    case 'typescript': return { language: runtime.language, sdk: renderToolsSdk(schemas) }
    case 'python': return { language: runtime.language, sdk: renderToolsSdkPy(schemas) }
    default: {
      throw new Error('dsh-progressive-tools: unsupported code runtime language '
        + JSON.stringify(runtime.language))
    }
  }
}

const DISCOVERY_SECTION = 'tools:progressive-disclosure'

function discoveryInstructions(mode: PresentationMode): string {
  const invocation = mode === 'code'
    ? 'In a later run_code call the returned exact name as tools[exactName](arguments).'
    : mode === 'native'
      ? 'On a later model step, issue an ordinary tool call using the returned exact name and arguments, even though the stable wire list declares only discovery tools.'
      : 'On a later model step, either issue an ordinary tool call using the returned exact name and arguments or call it from run_code as tools[exactName](arguments).'
  return [
    '## Progressive tool disclosure',
    '',
    'search_tools returns exact names, descriptions, input schemas, and output schemas for the current scoped catalog.',
    invocation,
    'describe_tools remains available for exact-name batch lookup and returns an SDK excerpt only when Code Mode is active.',
    '',
    'Do not invent tool names or arguments. A standard call to an unavailable, restricted, or removed tool is expected to fail with the current ToolRuntime reason.',
    'Discovery changes presentation only: permission, approval, guards, scheduling, and auditing remain authoritative at execution time.',
  ].join('\n')
}

/** Stabilize the model-visible wire surface for Native, Code, and Both modes. */
function compactAssembly(
  ctx: Context,
  assembly: PromptAssembly,
  scope: ScopeKey | undefined,
  eagerTools: readonly string[],
  discoveryDefinitions: readonly ToolDefinition[],
  recordMode: (scope: ScopeKey | undefined, mode: PresentationMode) => void,
): PromptAssembly {
  const sdkIndex = assembly.sections.findIndex(section => section.name === 'tools:sdk' && section.text.trim().length > 0)
  const hasSdk = sdkIndex !== -1
  const hasRunCode = assembly.tools.some(tool => tool.name === RUN_CODE_NAME)
  const mode: PresentationMode = hasSdk
    ? assembly.tools.some(tool => tool.name !== RUN_CODE_NAME) ? 'both' : 'code'
    : 'native'
  if (mode !== 'native' && !hasRunCode) {
    throw new Error('dsh-progressive-tools: Code presentation SDK exists without the run_code wire transport')
  }
  recordMode(scope, mode)

  const known = ctx.tools.schemas(scope).map(tool => tool.name)
  const schemas = discoveryDefinitions.map((expected) => {
    const current = ctx.tools.get(expected.name, scope)
    if (current !== expected) {
      throw new Error(`dsh-progressive-tools: ${expected.name} is unavailable or shadowed in this scope`)
    }
    return sdkSchema(current)
  })
  for (const eagerName of eagerTools) {
    const definition = ctx.tools.get(eagerName, scope)
    if (definition === undefined || eagerName === RUN_CODE_NAME) {
      throw new Error('dsh-progressive-tools: eager tool ' + JSON.stringify(eagerName)
        + ' is not visible in this scope; visible tools: ' + (known.sort().join(', ') || '(none)'))
    }
    schemas.push(sdkSchema(definition))
  }

  const directNames = new Set<string>()
  if (mode !== 'code') {
    for (const definition of discoveryDefinitions) directNames.add(definition.name)
    for (const eagerName of eagerTools) directNames.add(eagerName)
  }
  if (mode !== 'native') directNames.add(RUN_CODE_NAME)
  const tools = assembly.tools.filter(tool => directNames.has(tool.name))

  const instructions = discoveryInstructions(mode)
  let sections = assembly.sections.filter(section => section.name !== DISCOVERY_SECTION)
  if (mode === 'native') {
    sections = [...sections, { name: DISCOVERY_SECTION, text: instructions }]
  } else {
    const rendered = renderSdk(ctx, schemas)
    sections = sections.map((section, sectionIndex) => sectionIndex === sdkIndex
      ? { ...section, text: instructions + '\n\n' + rendered.sdk }
      : section)
  }
  return { ...assembly, sections, tools }
}

/** Register discovery tools and the all-mode stable presentation projection. */
export function apply(ctx: Context, config: Config): void {
  if (scopeOf(ctx) === undefined) {
    throw new Error('dsh-progressive-tools must be mounted in an agent or preset scope')
  }
  const resolved = resolveConfig(config)
  const omitted = new Set([...DISCOVERY_NAMES, ...resolved.eagerTools])
  const presentationModes = new WeakMap<object, PresentationMode>()
  const modeFor = (agent: object | undefined, nested: boolean): PresentationMode =>
    agent === undefined ? nested ? 'code' : 'native' : presentationModes.get(agent) ?? (nested ? 'code' : 'native')

  const searchTool = defineTool({
    name: SEARCH_TOOLS_NAME,
    description: 'Search the current scoped catalog and return matching tool names with exact input/output schemas.',
    parameters: {
      query: { type: 'string', required: true, description: 'Capability words to match against tool names, descriptions, and input schemas; use * to list the bounded catalog.' },
      limit: { type: 'integer', description: 'Maximum matches to return, capped by plugin configuration.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          catalogVersion: { type: 'string', required: true },
          presentationMode: { type: 'string', required: true },
          query: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                parameters: { type: 'json', required: true },
                output: { type: 'json', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const query = queryText(args.query, resolved.maxQueryChars)
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
        throw new Error('search_tools limit must be a positive safe integer')
      }
      const limit = Math.min(args.limit ?? resolved.maxSearchResults, resolved.maxSearchResults)
      const tools = catalog(ctx, exec.agent, omitted)
      const lowerQuery = query.toLocaleLowerCase('en-US')
      const matches: SearchMatch[] = tools
        .map(tool => ({
          name: tool.name,
          description: summarize(tool.description, resolved.maxSummaryChars),
          parameters: structuredClone(tool.parameters) as unknown as JsonValue,
          output: structuredClone(tool.output) as unknown as JsonValue,
          score: relevance(tool, lowerQuery),
        }))
        .filter(match => match.score > 0)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, 'en'))
      return Promise.resolve(boundedResult({
        catalogVersion: catalogVersion(tools),
        presentationMode: modeFor(exec.agent, exec.parent !== undefined),
        query,
        total: matches.length,
        truncated: matches.length > limit,
        matches: matches.slice(0, limit).map(({ score: _score, ...match }) => match),
      }, resolved.maxResultBytes, SEARCH_TOOLS_NAME))
    },
    presentCall: args => ({ card: 'generic', title: 'Search tools', kind: 'read', rawInput: summarize(args.query, 100) }),
  })

  const describeTool = defineTool({
    name: DESCRIBE_TOOLS_NAME,
    description: 'Return exact schemas for named tools and, in Code or Both mode, the active-runtime SDK excerpt.',
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact tool names returned by search_tools.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          catalogVersion: { type: 'string', required: true },
          presentationMode: { type: 'string', required: true },
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                parameters: { type: 'json', required: true },
                output: { type: 'json', required: true },
              },
            },
          },
          language: { type: 'string' },
          sdk: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      if (args.names.length === 0) throw new Error('describe_tools names must not be empty')
      if (args.names.length > resolved.maxDescribeTools) {
        throw new Error(`describe_tools accepts at most ${String(resolved.maxDescribeTools)} names per call`)
      }
      for (const toolName of args.names) {
        if (toolName.length === 0) throw new Error('describe_tools names cannot contain an empty name')
        if (graphemes(toolName).length > resolved.maxToolNameChars) {
          throw new Error(`describe_tools tool names cannot exceed ${String(resolved.maxToolNameChars)} characters`)
        }
      }
      const names = [...new Set(args.names)]
      const tools = catalog(ctx, exec.agent, omitted)
      const byName = new Map(tools.map(tool => [tool.name, tool]))
      const unknown = names.filter(toolName => !byName.has(toolName))
      if (unknown.length > 0) {
        throw new Error('describe_tools received unknown or unavailable tool'
          + (unknown.length === 1 ? '' : 's'))
      }
      const selected = names.map(toolName => byName.get(toolName) as CatalogTool)
      const result = {
        catalogVersion: catalogVersion(tools),
        presentationMode: modeFor(exec.agent, exec.parent !== undefined),
        tools: selected.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters) as unknown as JsonValue,
          output: structuredClone(tool.output) as unknown as JsonValue,
        })),
      }
      if (result.presentationMode === 'native') {
        return Promise.resolve(boundedResult(result, resolved.maxResultBytes, DESCRIBE_TOOLS_NAME))
      }
      const rendered = renderSdk(ctx, selected)
      return Promise.resolve(boundedResult({
        ...result,
        language: rendered.language,
        sdk: rendered.sdk,
      }, resolved.maxResultBytes, DESCRIBE_TOOLS_NAME))
    },
    presentCall: args => ({
      card: 'generic',
      title: `Describe ${String(args.names.length)} tool${args.names.length === 1 ? '' : 's'}`,
      kind: 'read',
      rawInput: String(args.names.length) + ' requested name(s)',
    }),
  })

  ctx.tools.register(searchTool)
  ctx.tools.register(describeTool)
  const definitions = [searchTool, describeTool]
  // Prepend makes this listener the outer wrapper for listeners already present;
  // transforming after next() preserves every cooperative inner rewrite.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    return compactAssembly(ctx, assembly, context.scope, resolved.eagerTools, definitions, (scope, mode) => {
      if (scope !== undefined) presentationModes.set(scope, mode)
    })
  }, { prepend: true })
}
