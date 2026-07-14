'use client'

import {
  IconAlertCircle as AlertCircle,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconMicrophone as Mic
} from '@tabler/icons-react'

import { toPublicErrorPayload } from '@/lib/errors/public-error'
import type { ToolPart } from '@/lib/types/ai'
import { cn } from '@/lib/utils'

import ProcessHeader from './process-header'

interface VoiceoverSectionProps {
  tool: ToolPart<'generateVoiceover'>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m ? `${m}m ${sec}s` : `${sec}s`
}

// Renders the generateVoiceover tool: an audio player for the narration plus its
// duration/word count. The bulky word timings live server-side under the voiceoverId.
export function VoiceoverSection({
  tool,
  isOpen,
  onOpenChange,
  borderless = false,
  isFirst = false,
  isLast = false
}: VoiceoverSectionProps) {
  const isRunning =
    tool.state === 'input-streaming' || tool.state === 'input-available'
  const output = tool.state === 'output-available' ? tool.output : undefined
  const failed = tool.state === 'output-error'
  const error = failed
    ? toPublicErrorPayload(tool.errorText, {
        fallbackMessage: 'Voiceover generation failed'
      }).error
    : undefined

  const header = (
    <ProcessHeader
      onInspect={() => onOpenChange(!isOpen)}
      isLoading={isRunning}
      label={
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <Mic className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="block min-w-0 max-w-full truncate">
            {output ? 'Voiceover' : 'Generating voiceover'}
          </span>
        </div>
      }
      meta={
        output ? (
          <>
            <Check size={16} className="text-green-500" />
            <span>
              {fmt(output.durationSec)} · {output.wordCount} words
              {output.voiceName ? ` · ${output.voiceName}` : ''}
            </span>
          </>
        ) : failed ? (
          <>
            <AlertCircle size={16} className="text-destructive" />
            <span>{error}</span>
          </>
        ) : (
          <span className="animate-pulse">Synthesizing narration…</span>
        )
      }
    />
  )

  return (
    <div className="relative">
      {borderless && (
        <>
          {!isFirst && (
            <div className="absolute left-[19.5px] top-0 h-2 w-px bg-border" />
          )}
          {!isLast && (
            <div className="absolute bottom-0 left-[19.5px] h-2 w-px bg-border" />
          )}
        </>
      )}
      <div
        className={cn('rounded-lg', !borderless && 'border border-border bg-card')}
      >
        <div
          className="flex cursor-pointer select-none items-center gap-2 p-3"
          onClick={() => output && onOpenChange(!isOpen)}
        >
          <div className="min-w-0 flex-1">{header}</div>
          {output && (
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                isOpen && 'rotate-180'
              )}
            />
          )}
        </div>
        {output && isOpen && (
          <div className="space-y-2 px-4 pb-4 text-sm">
            {output.audioUrl ? (
              <audio controls preload="metadata" src={output.audioUrl} className="w-full" />
            ) : (
              <p className="text-xs text-muted-foreground">
                Audio generated. Configure the render worker + storage to get a
                playable URL; the timings are ready for the storyboard either way.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default VoiceoverSection
