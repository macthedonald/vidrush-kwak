import type { ReasoningPart, TextPart } from '@ai-sdk/provider-utils'
import type { InferUITool, UIMessage as AIMessage } from 'ai'

import { fetchTool } from '@/lib/tools/fetch'
import { askQuestionTool } from '@/lib/tools/question'
import { searchTool } from '@/lib/tools/search'
import { createTodoTools, type TodoItem } from '@/lib/tools/todo'
import { createCloneVoiceTool } from '@/lib/tools/video/clone-voice'
import { createComposeRenderTool } from '@/lib/tools/video/compose-render'
import { createCutBeatsTool } from '@/lib/tools/video/cut-beats'
import { createGenerateMusicTool } from '@/lib/tools/video/generate-music'
import { createGenerateVoiceoverTool } from '@/lib/tools/video/generate-voiceover'
import { createListVoicesTool } from '@/lib/tools/video/list-voices'
import { createSourceFootageTool } from '@/lib/tools/video/source-footage'
import { createWriteScriptTool } from '@/lib/tools/video/write-script'
import type { SearchMode } from '@/lib/types/search'

// Re-export TodoItem for external use
export type { TodoItem }

// Define metadata type for messages
export interface UIMessageMetadata {
  traceId?: string
  feedbackScore?: number | null
  searchMode?: SearchMode
  modelId?: string
  [key: string]: any
}

export type UIMessage<
  TMetadata = UIMessageMetadata,
  TDataTypes = UIDataTypes,
  TTools = UITools
> = AIMessage

export type UIDataTypes = {
  sources?: any[]
  // User-authored attachments (composer): a pasted text blob and a pasted URL.
  pastedContent?: { text: string }
  quotedContext?: { text: string }
  noteContext?: { title?: string; text: string }
  sourceUrl?: { url: string }
}

// Create tool instances for type inference
const todoTools = createTodoTools()
const writeScriptTool = createWriteScriptTool('anthropic:claude-sonnet-5')
const sourceFootageTool = createSourceFootageTool()
const cutBeatsTool = createCutBeatsTool('anthropic:claude-sonnet-5')
const composeRenderTool = createComposeRenderTool()
const generateVoiceoverTool = createGenerateVoiceoverTool()
const listVoicesTool = createListVoicesTool()
const cloneVoiceTool = createCloneVoiceTool()
const generateMusicTool = createGenerateMusicTool()

export type UITools = {
  search: InferUITool<typeof searchTool>
  fetch: InferUITool<typeof fetchTool>
  askQuestion: InferUITool<typeof askQuestionTool>
  todoWrite: InferUITool<typeof todoTools.todoWrite>
  writeScript: InferUITool<typeof writeScriptTool>
  sourceFootage: InferUITool<typeof sourceFootageTool>
  cutBeats: InferUITool<typeof cutBeatsTool>
  generateVoiceover: InferUITool<typeof generateVoiceoverTool>
  listVoices: InferUITool<typeof listVoicesTool>
  cloneVoice: InferUITool<typeof cloneVoiceTool>
  generateMusic: InferUITool<typeof generateMusicTool>
  composeRender: InferUITool<typeof composeRenderTool>
  // Dynamic tools will be added at runtime
  [key: string]: any
}

export type ToolPart<T extends keyof UITools = keyof UITools> = {
  type: `tool-${T}`
  toolCallId: string
  input: UITools[T]['input']
  output?: UITools[T]['output']
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
  errorText?: string
}

export type Part = TextPart | ReasoningPart | ToolPart
