'use client'

import {
  IconAlertCircle as AlertCircle,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconListNumbers as ListNumbers,
  IconPhoto as Photo,
  IconVideo as Video
} from '@tabler/icons-react'

import { toPublicErrorPayload } from '@/lib/errors/public-error'
import type { ToolPart } from '@/lib/types/ai'
import { cn } from '@/lib/utils'

import ProcessHeader from './process-header'

interface BeatsSectionProps {
  tool: ToolPart<'cutBeats'>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

type Shot = {
  narration: string
  kind: 'photo' | 'video'
  visualQuery: string
  visualIntent: string
  start: number
  duration: number
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m ? `${m}m ${sec}s` : `${sec}s`
}

// Renders the cutBeats tool: the storyboard skeleton as a numbered shot list with each
// shot's footage query and duration — the chat-native version of the Studio's beat step.
export function BeatsSection({
  tool,
  isOpen,
  onOpenChange,
  borderless = false,
  isFirst = false,
  isLast = false
}: BeatsSectionProps) {
  const isRunning =
    tool.state === 'input-streaming' || tool.state === 'input-available'
  const output = tool.state === 'output-available' ? tool.output : undefined
  const failed = tool.state === 'output-error'
  const error = failed
    ? toPublicErrorPayload(tool.errorText, {
        fallbackMessage: 'Beat segmentation failed'
      }).error
    : undefined

  const shots: Shot[] = output?.shots ?? []

  const header = (
    <ProcessHeader
      onInspect={() => onOpenChange(!isOpen)}
      isLoading={isRunning}
      label={
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <ListNumbers className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="block min-w-0 max-w-full truncate">Storyboard</span>
        </div>
      }
      meta={
        output ? (
          <>
            <Check size={16} className="text-green-500" />
            <span>
              {shots.length} shots · {fmt(output.totalSeconds)}
            </span>
          </>
        ) : failed ? (
          <>
            <AlertCircle size={16} className="text-destructive" />
            <span>{error}</span>
          </>
        ) : (
          <span className="animate-pulse">Segmenting into shots…</span>
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
          <div className="max-h-[28rem] space-y-2 overflow-y-auto px-4 pb-4">
            {shots.map((s, i) => (
              <div
                key={i}
                className="flex gap-3 rounded-md border border-border/60 bg-muted/30 p-2"
              >
                <div className="flex flex-col items-center gap-1 pt-0.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  {s.kind === 'video' ? (
                    <Video className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Photo className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug">{s.narration}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    🔎 {s.visualQuery} · {s.duration.toFixed(1)}s
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default BeatsSection
