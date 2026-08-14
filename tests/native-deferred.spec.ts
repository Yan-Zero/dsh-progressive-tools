import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DESCRIBE_TOOLS_NAME, INVOKE_TOOL_NAME, SEARCH_TOOLS_NAME } from '../src/index.ts'
import { installNativeDeferredBridge } from '../src/native-deferred.ts'

interface CapturedContext {
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  messages: Array<Record<string, unknown>>
}

class FixtureAdapter extends LlmAdapter {
  captured: CapturedContext | undefined
  readonly model: Record<string, unknown>
  readonly models = {
    streamSimple: (_model: unknown, context: CapturedContext): AsyncIterable<StreamChunk> => {
      this.captured = context
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })()
    },
  }

  constructor(supportsToolSearch: boolean) {
    super()
    this.model = {
      api: 'openai-responses',
      provider: 'fixture',
      id: 'fixture-model',
      compat: { supportsToolSearch },
    }
  }

  current() {
    return { models: this.models }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const callNames = new Map<string, string>()
    const messages: Array<Record<string, unknown>> = []
    for (const message of options.messages) {
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'tool-call') callNames.set(String(block.id), block.name)
        }
        continue
      }
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        messages.push({
          role: 'toolResult',
          toolCallId: String(block.toolCallId),
          toolName: callNames.get(String(block.toolCallId)) ?? 'unknown',
        })
      }
    }
    return this.models.streamSimple(this.model, {
      messages,
      ...options.tools === undefined ? {} : { tools: options.tools.map(tool => ({ ...tool })) },
    })
  }
}

const discoveryTools = [
  { name: SEARCH_TOOLS_NAME, description: 'search', parameters: {} },
  { name: DESCRIBE_TOOLS_NAME, description: 'describe', parameters: {} },
  { name: INVOKE_TOOL_NAME, description: 'invoke', parameters: {} },
]

function request(tools = discoveryTools): GenerateOptions {
  return {
    provider: 'fixture',
    model: 'fixture-model',
    tools,
    messages: [
      {
        id: 'assistant' as never,
        role: 'assistant',
        source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
        content: [{
          type: 'tool-call',
          id: CallId('describe-call'),
          name: DESCRIBE_TOOLS_NAME,
          arguments: '{"names":["pwsh"]}',
        }],
      },
      {
        id: 'result' as never,
        role: 'user',
        source: { kind: 'tool', callId: CallId('describe-call') },
        content: [{
          type: 'tool-result',
          toolCallId: CallId('describe-call'),
          content: [{
            type: 'text',
            text: JSON.stringify({
              tools: [{
                name: 'pwsh',
                description: 'Run PowerShell.',
                parameters: { type: 'object', properties: { command: { type: 'string' } } },
                output: { type: 'string' },
              }],
            }),
          }],
          isError: false,
        }],
      },
    ],
  }
}

async function consume(iterable: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of iterable) { /* consume the lazy adapter path */ }
}

async function setup(supportsToolSearch: boolean) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new FixtureAdapter(supportsToolSearch)
  ctx.llm.registerAdapter(['fixture'], adapter)
  installNativeDeferredBridge(ctx, {
    describe: DESCRIBE_TOOLS_NAME,
    invoke: INVOKE_TOOL_NAME,
    progressive: new Set([SEARCH_TOOLS_NAME, DESCRIBE_TOOLS_NAME, INVOKE_TOOL_NAME]),
  })
  return { ctx, adapter }
}

describe('native deferred bridge', () => {
  it('loads disclosed schemas at the describe result and removes invoke_tool for capable models', async () => {
    const { ctx, adapter } = await setup(true)
    await consume(ctx.llm.stream(request()))

    expect(adapter.captured?.tools?.map(tool => tool.name)).toEqual([
      SEARCH_TOOLS_NAME,
      DESCRIBE_TOOLS_NAME,
      'pwsh',
    ])
    expect(adapter.captured?.messages[0]?.['addedToolNames']).toEqual(['pwsh'])
    await ctx.fiber.dispose()
  })

  it('keeps only the stable invoke_tool fallback for models without native loading', async () => {
    const { ctx, adapter } = await setup(false)
    await consume(ctx.llm.stream(request()))

    expect(adapter.captured?.tools?.map(tool => tool.name)).toEqual([
      SEARCH_TOOLS_NAME,
      DESCRIBE_TOOLS_NAME,
      INVOKE_TOOL_NAME,
    ])
    expect(adapter.captured?.messages[0]?.['addedToolNames']).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('does not inject native tools into a Code-only request', async () => {
    const { ctx, adapter } = await setup(true)
    await consume(ctx.llm.stream(request([{
      name: 'run_code',
      description: 'run code',
      parameters: {},
    }])))

    expect(adapter.captured?.tools?.map(tool => tool.name)).toEqual(['run_code'])
    expect(adapter.captured?.messages[0]?.['addedToolNames']).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
