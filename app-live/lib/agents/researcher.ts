import { stepCountIs, tool, ToolLoopAgent } from 'ai'

import type { ResearcherTools } from '@/lib/types/agent'
import { type Model } from '@/lib/types/models'

import { fetchTool } from '../tools/fetch'
import { createQuestionTool } from '../tools/question'
import { createSearchTool } from '../tools/search'
import { createTodoTools } from '../tools/todo'
import { createCloneVoiceTool } from '../tools/video/clone-voice'
import { createComposeRenderTool } from '../tools/video/compose-render'
import { createCutBeatsTool } from '../tools/video/cut-beats'
import { createGenerateMusicTool } from '../tools/video/generate-music'
import { createGenerateVoiceoverTool } from '../tools/video/generate-voiceover'
import { createListVoicesTool } from '../tools/video/list-voices'
import { createSourceFootageTool } from '../tools/video/source-footage'
import { createWriteScriptTool } from '../tools/video/write-script'
import { SearchMode } from '../types/search'
import { getModel } from '../utils/registry'
import { isTracingEnabled } from '../utils/telemetry'

import {
  getAdaptiveModePrompt,
  getQuickModePrompt
} from './prompts/search-mode-prompts'

// Enhanced wrapper function with better type safety and streaming support
function wrapSearchToolForQuickMode<
  T extends ReturnType<typeof createSearchTool>
>(originalTool: T): T {
  return tool({
    description: originalTool.description,
    inputSchema: originalTool.inputSchema,
    // Preserve the original tool's model-output trimming (strips the duplicated
    // citationMap / UI-only images) so quick mode gets the same payload savings.
    toModelOutput: originalTool.toModelOutput,
    async *execute(params, context) {
      const executeFunc = originalTool.execute
      if (!executeFunc) {
        throw new Error('Search tool execute function is not defined')
      }

      // Force optimized type for quick mode
      const modifiedParams = {
        ...params,
        type: 'optimized' as const
      }

      // Execute the original tool and pass through all yielded values
      const result = executeFunc(modifiedParams, context)

      // Handle AsyncIterable (streaming) case
      if (
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in result
      ) {
        for await (const chunk of result) {
          yield chunk
        }
      } else {
        // Fallback for non-streaming (shouldn't happen with new implementation)
        const finalResult = await result
        yield finalResult || {
          state: 'complete' as const,
          results: [],
          images: [],
          query: params.query,
          number_of_results: 0
        }
      }
    }
  }) as T
}

// Enhanced researcher function with improved type safety using ToolLoopAgent
// Note: abortSignal should be passed to agent.stream() or agent.generate() calls, not to the agent constructor
export function createResearcher({
  model,
  modelConfig,
  parentTraceId,
  searchMode = 'adaptive',
  relatedEnabled = true
}: {
  model: string
  modelConfig?: Model
  parentTraceId?: string
  searchMode?: SearchMode
  relatedEnabled?: boolean
}) {
  try {
    const currentDate = new Date().toLocaleString()

    // Create model-specific tools with proper typing
    const originalSearchTool = createSearchTool(model)
    const askQuestionTool = createQuestionTool(model)
    const todoTools = createTodoTools()
    const writeScriptTool = createWriteScriptTool(model)
    const sourceFootageTool = createSourceFootageTool()
    const cutBeatsTool = createCutBeatsTool(model)
    const composeRenderTool = createComposeRenderTool()
    const generateVoiceoverTool = createGenerateVoiceoverTool()
    const listVoicesTool = createListVoicesTool()
    const cloneVoiceTool = createCloneVoiceTool()
    const generateMusicTool = createGenerateMusicTool()

    let systemPrompt: string
    let activeToolsList: (keyof ResearcherTools)[] = []
    let maxSteps: number
    let searchTool = originalSearchTool

    // Configure based on search mode
    switch (searchMode) {
      case 'quick':
        console.log(
          '[Researcher] Quick mode: maxSteps=20, tools=[search, fetch, writeScript, sourceFootage, cutBeats, listVoices, generateVoiceover, cloneVoice, generateMusic, composeRender]'
        )
        systemPrompt = getQuickModePrompt(relatedEnabled)
        activeToolsList = [
          'search',
          'fetch',
          'writeScript',
          'sourceFootage',
          'cutBeats',
          'listVoices',
          'generateVoiceover',
          'cloneVoice',
          'generateMusic',
          'composeRender'
        ]
        maxSteps = 20
        searchTool = wrapSearchToolForQuickMode(originalSearchTool)
        break

      case 'adaptive':
      default:
        systemPrompt = getAdaptiveModePrompt(relatedEnabled)
        activeToolsList = [
          'search',
          'fetch',
          'todoWrite',
          'writeScript',
          'sourceFootage',
          'cutBeats',
          'listVoices',
          'generateVoiceover',
          'cloneVoice',
          'generateMusic',
          'composeRender'
        ]
        console.log(
          `[Researcher] Adaptive mode: maxSteps=50, tools=[${activeToolsList.join(', ')}]`
        )
        maxSteps = 50
        searchTool = originalSearchTool
        break
    }

    // VidRush producer layer: every morphic capability stays (search, fetch, todos,
    // questions), retargeted at video production — search doubles as script research
    // and footage discovery.
    const vidrushPrompt = `

## VidRush video production
You are also VidRush, an agentic YouTube video producer. When the user wants a video, script, or channel content:
1. RESEARCH FIRST: use the search and fetch tools to gather real facts, numbers, names, and competitor angles on the topic. Use todos to plan multi-step productions.
2. Then call writeScript with the topic, target minutes, language/tone, and a distilled researchNotes summary of what you found — never write a script without researching unless the user insists.
3. VOICEOVER: call generateVoiceover with the finished script to produce narration audio with real word-level timings. It returns a voiceoverId — carry that id forward (it is small; never try to copy the word timings yourself). If the user wants to choose or audition a voice, call listVoices first (ElevenLabs/MiniMax/Fish/etc.) and pass the chosen voiceId; to narrate in the user's own voice, cloneVoice from a sample URL and use the returned clone id.
4. BEATS: call cutBeats to segment the script into an ordered storyboard of shots (each gets a visualQuery, a visualIntent and a still/clip hint). Pass the voiceoverId so the shot durations and captions lock to the actual spoken audio instead of estimates.
5. FOOTAGE: for each shot, call sourceFootage with that shot's visualQuery and visualIntent. It pools open archives (Wikimedia, Internet Archive, National Archives) AND the general web via the same search provider you use for research, ranks the candidates, and vision-verifies the best pick. Use the plain search tool for exploratory "what footage exists" questions; use sourceFootage when you need actual usable b-roll for a specific scene.
6. MUSIC (optional): call generateMusic with a mood/genre prompt to create a background bed; pass its audioUrl as composeRender's music input (it is ducked automatically under the narration).
7. RENDER: call composeRender with the storyboard shots (each carrying its resolved asset src, start, duration and words), the voiceoverId (its audio is mixed in automatically) and any music URL to produce the finished MP4 (Ken Burns, crossfades, karaoke captions, ducked audio). Shots with no asset render as clean brand cards.
The natural pipeline is writeScript → generateVoiceover → cutBeats (with voiceoverId) → sourceFootage (per shot) → [generateMusic] → composeRender (with voiceoverId + music). Present returned scripts as-is (they are clean spoken narration) and narrate progress through the pipeline as you go.`
    systemPrompt = systemPrompt + vidrushPrompt

    // Build tools object with proper typing
    const tools: ResearcherTools = {
      search: searchTool,
      fetch: fetchTool,
      askQuestion: askQuestionTool,
      writeScript: writeScriptTool,
      sourceFootage: sourceFootageTool,
      cutBeats: cutBeatsTool,
      listVoices: listVoicesTool,
      generateVoiceover: generateVoiceoverTool,
      cloneVoice: cloneVoiceTool,
      generateMusic: generateMusicTool,
      composeRender: composeRenderTool,
      ...todoTools
    } as ResearcherTools

    // Create ToolLoopAgent with all configuration
    const agent = new ToolLoopAgent({
      model: getModel(model),
      instructions: `${systemPrompt}\nCurrent date and time: ${currentDate}`,
      tools,
      activeTools: activeToolsList,
      stopWhen: stepCountIs(maxSteps),
      ...(modelConfig?.providerOptions && {
        providerOptions: modelConfig.providerOptions
      }),
      experimental_telemetry: {
        isEnabled: isTracingEnabled(),
        functionId: 'research-agent',
        metadata: {
          modelId: model,
          agentType: 'researcher',
          searchMode,
          ...(parentTraceId && {
            langfuseTraceId: parentTraceId,
            langfuseUpdateParent: false
          })
        }
      }
    })

    return agent
  } catch (error) {
    console.error('Error in createResearcher:', error)
    throw error
  }
}

// Helper function to access agent tools
export function getResearcherTools(
  agent: ToolLoopAgent<never, ResearcherTools, never>
): ResearcherTools {
  return agent.tools
}

// Export the legacy function name for backward compatibility
export const researcher = createResearcher
