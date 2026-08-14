/**
 * Plugin-owned bridge from durable describe_tools results to pi-ai's native
 * transcript-position deferred-tool protocol.
 *
 * DSH intentionally freezes `llm/stream` requests, so this module does not
 * rewrite them. It wraps the resolved pi-ai Models instance at its public
 * `streamSimple(model, context, options)` boundary and uses AsyncLocalStorage
 * to carry the read-only request's disclosures into that call.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'

interface PiTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface PiToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  addedToolNames?: string[]
  [key: string]: unknown
}

interface PiContext {
  tools?: PiTool[]
  messages: Array<PiToolResultMessage | Record<string, unknown>>
  [key: string]: unknown
}

interface PiModel {
  api?: string
  provider?: string
  id?: string
  compat?: Record<string, unknown>
}

type StreamSimple = (model: PiModel, context: PiContext, options?: unknown) => unknown

interface PiModelsLike {
  streamSimple: StreamSimple
}

interface AdapterLike {
  current?: () => { models?: PiModelsLike }
}

interface LlmRuntimeInternals {
  adapters?: Map<string, { adapter?: AdapterLike }>
}

interface DisclosureFrame {
  loads: ReadonlyMap<string, readonly PiTool[]>
  progressiveSurface: boolean
}

interface PatchedModels {
  models: PiModelsLike
  original: StreamSimple
  wrapper: StreamSimple
  hadOwn: boolean
}

/** Exact native gates used by the pi-ai release DSH currently composes. */
function supportsDeferredTools(model: PiModel): boolean {
  if (model.api === 'openai-responses'
    || model.api === 'azure-openai-responses'
    || model.api === 'openai-codex-responses') {
    return model.compat?.['supportsToolSearch'] === true
  }
  if (model.api !== 'anthropic-messages') return false
  const explicit = model.compat?.['supportsToolReferences']
  if (typeof explicit === 'boolean') return explicit
  if (model.provider !== 'anthropic' || model.id?.includes('haiku') === true) return false
  const version = model.id?.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/u)
  if (version === undefined || version === null) return false
  const major = Number(version[1])
  const minorText = version[2]
  const minor = minorText !== undefined && minorText.length < 8 ? Number(minorText) : 0
  return major > 4 || (major === 4 && minor >= 5)
}

/** Flatten only textual presentation from one tool result. */
function resultText(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? resultText(block.content) : '').join('')
}

function isToolSchema(value: unknown): value is ToolSchema {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['name'] === 'string'
    && record['name'].length > 0
    && typeof record['description'] === 'string'
    && typeof record['parameters'] === 'object'
    && record['parameters'] !== null
    && !Array.isArray(record['parameters'])
}

/** Recover exact disclosures from the durable describe_tools call/result pairs. */
function disclosureFrame(
  options: GenerateOptions,
  describeToolName: string,
  progressiveNames: ReadonlySet<string>,
): DisclosureFrame {
  const callNames = new Map<string, string>()
  const loads = new Map<string, PiTool[]>()
  for (const message of options.messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') callNames.set(String(block.id), block.name)
      }
      continue
    }
    for (const block of message.content) {
      if (block.type !== 'tool-result' || block.isError === true) continue
      const callId = String(block.toolCallId)
      if (callNames.get(callId) !== describeToolName) continue
      try {
        const parsed: unknown = JSON.parse(resultText(block.content))
        if (typeof parsed !== 'object' || parsed === null) continue
        const tools = (parsed as Record<string, unknown>)['tools']
        if (!Array.isArray(tools) || !tools.every(isToolSchema)) continue
        loads.set(callId, tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        })))
      } catch {
        // A rewritten/spilled/non-JSON presentation cannot authorize schemas.
      }
    }
  }
  return {
    loads,
    progressiveSurface: options.tools?.some(tool => progressiveNames.has(tool.name)) ?? false,
  }
}

/** Add schemas at their result positions without mutating DSH or pi-ai input. */
function augmentContext(context: PiContext, frame: DisclosureFrame, invokeToolName: string): PiContext {
  const tools = new Map<string, PiTool>()
  for (const tool of context.tools ?? []) {
    if (tool.name !== invokeToolName) tools.set(tool.name, tool)
  }
  for (const disclosed of frame.loads.values()) {
    for (const tool of disclosed) tools.set(tool.name, tool)
  }
  const messages = context.messages.map((message) => {
    if (message['role'] !== 'toolResult' || typeof message['toolCallId'] !== 'string') return message
    const disclosed = frame.loads.get(message['toolCallId'])
    return disclosed === undefined
      ? message
      : { ...message, addedToolNames: disclosed.map(tool => tool.name) }
  })
  const { tools: _originalTools, ...rest } = context
  return tools.size > 0
    ? { ...rest, messages, tools: [...tools.values()] }
    : { ...rest, messages }
}

/** Keep AsyncLocalStorage active across lazy AsyncIterable consumption. */
function withinFrame<T>(
  storage: AsyncLocalStorage<DisclosureFrame>,
  frame: DisclosureFrame,
  source: () => AsyncIterable<T>,
  beforeNext: () => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = storage.run(frame, () => source()[Symbol.asyncIterator]())
      return {
        next: value => storage.run(frame, () => {
          beforeNext()
          return iterator.next(value)
        }),
        return: value => storage.run(frame, () => iterator.return?.(value) ?? Promise.resolve({ done: true, value })),
        throw: error => storage.run(frame, () => iterator.throw?.(error) ?? Promise.reject(error)),
      }
    },
  }
}

/** Install the reversible pi-ai bridge through DSH's read-only stream hook. */
export function installNativeDeferredBridge(
  ctx: Context,
  names: { describe: string; invoke: string; progressive: ReadonlySet<string> },
): void {
  const storage = new AsyncLocalStorage<DisclosureFrame>()
  const patched = new Set<PatchedModels>()
  const seen = new WeakSet<object>()

  const patchProvider = (provider: string): boolean => {
    const runtime = ctx.llm as unknown as LlmRuntimeInternals
    const adapter = runtime.adapters?.get(provider)?.adapter
    if (typeof adapter?.current !== 'function') return false
    let models: PiModelsLike | undefined
    try {
      models = adapter.current().models
    } catch {
      return false
    }
    if (models === undefined || typeof models.streamSimple !== 'function') return false
    if (seen.has(models as object)) return true
    const original = models.streamSimple
    const hadOwn = Object.hasOwn(models, 'streamSimple')
    const wrapper: StreamSimple = function (this: PiModelsLike, model, context, options) {
      const frame = storage.getStore()
      return original.call(
        this,
        model,
        frame?.progressiveSurface === true && supportsDeferredTools(model)
          ? augmentContext(context, frame, names.invoke)
          : context,
        options,
      )
    }
    try {
      models.streamSimple = wrapper
    } catch {
      return false
    }
    seen.add(models as object)
    patched.add({ models, original, wrapper, hadOwn })
    return true
  }

  ctx.on('llm/stream', (options, next) => {
    const frame = disclosureFrame(options, names.describe, names.progressive)
    if (!frame.progressiveSurface || !patchProvider(options.provider)) return next()
    return withinFrame(storage, frame, next, () => { patchProvider(options.provider) })
  })

  ctx.effect(function* () {
    yield () => {
      for (const entry of patched) {
        if (entry.models.streamSimple !== entry.wrapper) continue
        if (entry.hadOwn) entry.models.streamSimple = entry.original
        else delete (entry.models as Partial<PiModelsLike>).streamSimple
      }
      storage.disable()
    }
  }, 'dsh-progressive-tools native deferred bridge')
}
