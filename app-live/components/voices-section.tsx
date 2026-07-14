'use client'

import {
  IconAlertCircle as AlertCircle,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconWaveSine as Wave
} from '@tabler/icons-react'

import { toPublicErrorPayload } from '@/lib/errors/public-error'
import type { ToolPart } from '@/lib/types/ai'
import { cn } from '@/lib/utils'

import ProcessHeader from './process-header'

interface VoicesSectionProps {
  tool: ToolPart<'listVoices'>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

type Voice = { provider: string; id: string; name: string; desc: string; preview?: string }

// Renders the listVoices tool: a browsable list of AI33 voices with previews. The agent
// passes a chosen voice id to generateVoiceover.
export function VoicesSection({
  tool,
  isOpen,
  onOpenChange,
  borderless = false,
  isFirst = false,
  isLast = false
}: VoicesSectionProps) {
  const isRunning =
    tool.state === 'input-streaming' || tool.state === 'input-available'
  const output = tool.state === 'output-available' ? tool.output : undefined
  const failed = tool.state === 'output-error'
  const error = failed
    ? toPublicErrorPayload(tool.errorText, { fallbackMessage: 'Could not list voices' }).error
    : undefined
  const voices: Voice[] = output?.voices ?? []

  const header = (
    <ProcessHeader
      onInspect={() => onOpenChange(!isOpen)}
      isLoading={isRunning}
      label={
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <Wave className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="block min-w-0 max-w-full truncate">
            {output ? `Voices — ${output.provider}` : 'Loading voices'}
          </span>
        </div>
      }
      meta={
        output ? (
          <>
            <Check size={16} className="text-green-500" />
            <span>{output.count} voices</span>
          </>
        ) : failed ? (
          <>
            <AlertCircle size={16} className="text-destructive" />
            <span>{error}</span>
          </>
        ) : (
          <span className="animate-pulse">Fetching…</span>
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
        {output && isOpen && (
          <div className="max-h-96 space-y-2 overflow-y-auto px-4 pb-4">
            {voices.map(v => (
              <div
                key={v.id}
                className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/30 p-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{v.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{v.desc}</p>
                  <code className="text-[10px] text-muted-foreground">{v.id}</code>
                </div>
                {v.preview && (
                  <audio controls preload="none" src={v.preview} className="h-8 w-40 shrink-0" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default VoicesSection
