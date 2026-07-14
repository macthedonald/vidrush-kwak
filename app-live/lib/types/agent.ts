import type {
  InferAgentUIMessage,
  InferUITools,
  ToolLoopAgent,
  UIMessage,
  UIToolInvocation
} from 'ai'

import type { fetchTool } from '../tools/fetch'
import type { createQuestionTool } from '../tools/question'
import type { createSearchTool } from '../tools/search'
import type { createTodoTools } from '../tools/todo'
import type { createCloneVoiceTool } from '../tools/video/clone-voice'
import type { createComposeRenderTool } from '../tools/video/compose-render'
import type { createCutBeatsTool } from '../tools/video/cut-beats'
import type { createGenerateMusicTool } from '../tools/video/generate-music'
import type { createGenerateVoiceoverTool } from '../tools/video/generate-voiceover'
import type { createListVoicesTool } from '../tools/video/list-voices'
import type { createSourceFootageTool } from '../tools/video/source-footage'
import type { createWriteScriptTool } from '../tools/video/write-script'

// Define the tools type for researcher agent
export type ResearcherTools = {
  search: ReturnType<typeof createSearchTool>
  fetch: typeof fetchTool
  askQuestion: ReturnType<typeof createQuestionTool>
  writeScript: ReturnType<typeof createWriteScriptTool>
  sourceFootage: ReturnType<typeof createSourceFootageTool>
  cutBeats: ReturnType<typeof createCutBeatsTool>
  listVoices: ReturnType<typeof createListVoicesTool>
  generateVoiceover: ReturnType<typeof createGenerateVoiceoverTool>
  cloneVoice: ReturnType<typeof createCloneVoiceTool>
  generateMusic: ReturnType<typeof createGenerateMusicTool>
  composeRender: ReturnType<typeof createComposeRenderTool>
} & ReturnType<typeof createTodoTools>

// Type alias for the researcher agent using ToolLoopAgent
// ToolLoopAgent generic signature is <CALL_OPTIONS, TOOLS, OUTPUT>
export type ResearcherAgent = ToolLoopAgent<never, ResearcherTools, never>

// Infer UI message type for researcher agent
export type ResearcherUIMessage = InferAgentUIMessage<ResearcherAgent>

// Infer UI tools type for researcher agent
export type ResearcherUITools = InferUITools<ResearcherTools>

// Tool invocation types for each tool
export type SearchToolInvocation = UIToolInvocation<ResearcherTools['search']>
export type FetchToolInvocation = UIToolInvocation<ResearcherTools['fetch']>
export type QuestionToolInvocation = UIToolInvocation<
  ResearcherTools['askQuestion']
>
export type TodoWriteToolInvocation = UIToolInvocation<
  ResearcherTools['todoWrite']
>
export type WriteScriptToolInvocation = UIToolInvocation<
  ResearcherTools['writeScript']
>
export type SourceFootageToolInvocation = UIToolInvocation<
  ResearcherTools['sourceFootage']
>
export type CutBeatsToolInvocation = UIToolInvocation<
  ResearcherTools['cutBeats']
>
export type ComposeRenderToolInvocation = UIToolInvocation<
  ResearcherTools['composeRender']
>
export type GenerateVoiceoverToolInvocation = UIToolInvocation<
  ResearcherTools['generateVoiceover']
>
export type ListVoicesToolInvocation = UIToolInvocation<
  ResearcherTools['listVoices']
>
export type CloneVoiceToolInvocation = UIToolInvocation<
  ResearcherTools['cloneVoice']
>
export type GenerateMusicToolInvocation = UIToolInvocation<
  ResearcherTools['generateMusic']
>

// Union type for all tool invocations
export type ResearcherToolInvocation =
  | SearchToolInvocation
  | FetchToolInvocation
  | QuestionToolInvocation
  | TodoWriteToolInvocation
  | WriteScriptToolInvocation
  | SourceFootageToolInvocation
  | CutBeatsToolInvocation
  | ComposeRenderToolInvocation
  | GenerateVoiceoverToolInvocation
  | ListVoicesToolInvocation
  | CloneVoiceToolInvocation
  | GenerateMusicToolInvocation

// Helper type to extract tool names
export type ResearcherToolName = keyof ResearcherTools

// Type guard functions
export function isSearchToolInvocation(
  invocation: ResearcherToolInvocation
): invocation is SearchToolInvocation {
  return 'query' in (invocation as any).input
}

export function isFetchToolInvocation(
  invocation: ResearcherToolInvocation
): invocation is FetchToolInvocation {
  return 'url' in (invocation as any).input
}

// Response type for agent.respond()
export type ResearcherResponse = Response

// Options type for agent.respond()
export type ResearcherRespondOptions = {
  messages: UIMessage<never, never, ResearcherUITools>[]
}
