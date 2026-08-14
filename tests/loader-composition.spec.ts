import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as SourceDiscovery from '../src/index.ts'

const Discovery = process.env.DSH_EXAMPLE_MODE === 'lib'
  ? await import(/* @vite-ignore */ pathToFileURL(resolve('lib/index.js')).href)
  : SourceDiscovery

let root: string | undefined
let context: Context | undefined

interface FixtureState {
  wire: string[]
  sdk: string
  search: unknown
  hidden: unknown
  hasRunCode: boolean
  nativeWire: string[]
  bothWire: string[]
}
let state: FixtureState | undefined

class FixtureRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  run(_request: CodeRunRequest): Promise<CodeRunResult> {
    return Promise.resolve({ logs: [] })
  }
}

const FixturePlugin = {
  name: 'progressive-tools-loader-fixture',
  inject: ['tools', 'systemPrompt'],
  async apply(ctx: Context) {
    ctx.tools.register(defineTool({
      name: 'fixture_weather',
      description: 'Read current weather for one city.',
      parameters: { city: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: args => Promise.resolve('sunny:' + args.city),
    }))
    ctx.tools.register(defineTool({
      name: 'fixture_write',
      description: 'Write fixture content.',
      parameters: { text: { type: 'string', required: true } },
      output: { schema: { type: 'boolean' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => Promise.resolve(true),
    }))
    await ctx.plugin(FixtureRuntime)

    const mountMode = async (id: string, mode: 'native' | 'code' | 'both') => {
      const session = Session.create(SessionId(id))
      const agent = { id: session.id, session } as unknown as Agent
      const scoped = createScope(ctx, agent)
      scoped.ctx.tools.presentAs(mode)
      return { agent, assembly: await ctx.systemPrompt.assemble({ scope: agent }) }
    }
    const code = await mountMode('loader-discovery-code', 'code')
    const native = await mountMode('loader-discovery-native', 'native')
    const both = await mountMode('loader-discovery-both', 'both')
    const agent = code.agent

    const runContext = (callId: CallId, toolName: string, args: unknown): ToolRunContext => ({
      token: Symbol('fixture') as ToolExecutionToken,
      callId,
      rootCallId: callId,
      name: toolName,
      arguments: args,
      agent,
      signal: new AbortController().signal,
      deferContext: () => {},
      concludeTurn: () => {},
    })
    const assembly = code.assembly
    const search = ctx.tools.get(Discovery.SEARCH_TOOLS_NAME, agent)
    const hidden = ctx.tools.get('fixture_weather', agent)
    if (search === undefined || hidden === undefined) throw new Error('fixture tools missing')
    state = {
      wire: assembly.tools.map(tool => tool.name),
      sdk: assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? '',
      search: await search.execute({ query: '*' }, runContext(CallId('search'), Discovery.SEARCH_TOOLS_NAME, { query: '*' })),
      hidden: await hidden.execute({ city: 'Paris' }, runContext(CallId('hidden'), 'fixture_weather', { city: 'Paris' })),
      hasRunCode: ctx.tools.get(RUN_CODE_NAME, agent) !== undefined,
      nativeWire: native.assembly.tools.map(tool => tool.name),
      bothWire: both.assembly.tools.map(tool => tool.name),
    }
  },
}

afterEach(async () => {
  state = undefined
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('dsh-progressive-tools real Loader composition', () => {
  it('loads independently and projects stable Native, Code, and Both surfaces', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-progressive-tools-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: system-prompt',
      "  name: 'test-system-prompt'",
      '- id: tools',
      "  name: 'test-tools'",
      '  config:',
      '    mode: native',
      '- id: progressive-tools',
      '  name: dsh-progressive-tools',
      '  config:',
      '    maxSearchResults: 1',
      '- id: fixture',
      "  name: 'test-fixture'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-system-prompt', SystemPrompt],
      ['test-tools', ToolRuntime],
      ['dsh-progressive-tools', Discovery],
      ['test-fixture', FixturePlugin],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error('unexpected Loader import: ' + specifier)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    expect(state).toBeDefined()
    expect(state?.wire).toEqual([RUN_CODE_NAME])
    expect(state?.sdk).toContain(Discovery.SEARCH_TOOLS_NAME)
    expect(state?.sdk).toContain(Discovery.DESCRIBE_TOOLS_NAME)
    expect(state?.sdk).not.toContain('fixture_weather')
    expect(state?.search).toMatchObject({ total: 2, truncated: true, matches: [{ name: 'fixture_weather' }] })
    expect(state?.hidden).toBe('sunny:Paris')
    expect(state?.hasRunCode).toBe(true)
    expect(state?.nativeWire.toSorted()).toEqual([Discovery.SEARCH_TOOLS_NAME, Discovery.DESCRIBE_TOOLS_NAME].sort())
    expect(state?.bothWire.toSorted()).toEqual([RUN_CODE_NAME, Discovery.SEARCH_TOOLS_NAME, Discovery.DESCRIBE_TOOLS_NAME].sort())
  })
})
