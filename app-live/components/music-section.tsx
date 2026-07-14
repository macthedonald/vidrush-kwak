'use client'

import {
  IconAlertCircle as AlertCircle,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconMusic as Music
} from '@tabler/icons-react'

import { toPublicErrorPayload } from '@/lib/errors/public-error'
import type { ToolPart } from '@/lib/types/ai'
import { cn } from '@/lib/utils'

import ProcessHeader from './process-header'

interface MusicSectionProps {
  tool: ToolPart<'generateMusic'>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

// Renders the generateMusic tool: an audio player for the Suno background bed.
export function MusicSection({
  tool,
  isOpen,
  onOpenChange,
  borderless = false,
  isFirst = false,
  isLast = false
}: MusicSectionProps) {
  const isRunning =
    tool.state === 'input-streaming' || tool.state === 'input-available'
  const output = tool.state === 'output-available' ? tool.output : undefined
  const failed = tool.state === 'output-error'
  const error = failed
    ? toPublicErrorPayload(tool.errorText, { fallbackMessage: 'Music generation failed' })
        .error
    : undefined

  const header = (
    <ProcessHeader
      onInspect={() => onOpenChange(!isOpen)}
      isLoading={isRunning}
      label={
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <Music className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="block min-w-0 max-w-full truncate">
            {output ? output.title || 'Music bed' : 'Generating music'}
          </span>
        </div>
      }
      meta={
        output ? (
          <>
            <Check size={16} className="text-green-500" />
            <span>Music bed ready</span>
          </>
        ) : failed ? (
          <>
            <AlertCircle size={16} className="text-destructive" />
            <span>{error}</span>
          </>
        ) : (
          <span className="animate-pulse">Composing (Suno)…</span>
        )
      }
    />
  )

  return (
    <div className="relative">
      {borderless && (
        <>
          {!isFirst && <div className="absolute left-[19.5px] top-0 h-2 w-px bg-border" />}
          {!isLast && <div className="absolute bottom-0 left-[19.5px] h-2 w-px bg-border" />}
        </>
      )}
      <div className={cn('rounded-lg', !borderless && 'border border-border bg-card')}>
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
        {output && isOpen && output.audioUrl && (
          <div className="px-4 pb-4">
            <audio controls preload="metadata" src={output.audioUrl} className="w-full" />
          </div>
        )}
      </div>
    </div>
  )
}

export default MusicSection
