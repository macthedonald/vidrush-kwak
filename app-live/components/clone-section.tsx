'use client'

import {
  IconAlertCircle as AlertCircle,
  IconCheck as Check,
  IconUserPlus as UserPlus
} from '@tabler/icons-react'

import { toPublicErrorPayload } from '@/lib/errors/public-error'
import type { ToolPart } from '@/lib/types/ai'
import { cn } from '@/lib/utils'

import ProcessHeader from './process-header'

interface CloneSectionProps {
  tool: ToolPart<'cloneVoice'>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

// Renders the cloneVoice tool: a compact confirmation with the resulting clone voice id.
export function CloneSection({
  tool,
  isOpen,
  onOpenChange,
  borderless = false,
  isFirst = false,
  isLast = false
}: CloneSectionProps) {
  const isRunning =
    tool.state === 'input-streaming' || tool.state === 'input-available'
  const output = tool.state === 'output-available' ? tool.output : undefined
  const failed = tool.state === 'output-error'
  const error = failed
    ? toPublicErrorPayload(tool.errorText, { fallbackMessage: 'Voice clone failed' }).error
    : undefined

  return (
    <div className="relative">
      {borderless && (
        <>
          {!isFirst && <div className="absolute left-[19.5px] top-0 h-2 w-px bg-border" />}
          {!isLast && <div className="absolute bottom-0 left-[19.5px] h-2 w-px bg-border" />}
        </>
      )}
      <div className={cn('rounded-lg', !borderless && 'border border-border bg-card')}>
        <div className="p-3">
          <ProcessHeader
            onInspect={() => onOpenChange(!isOpen)}
            isLoading={isRunning}
            label={
              <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <UserPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="block min-w-0 max-w-full truncate">
                  {output ? `Cloned voice — ${output.name}` : 'Cloning voice'}
                </span>
              </div>
            }
            meta={
              output ? (
                <>
                  <Check size={16} className="text-green-500" />
                  <code className="text-xs">{output.voiceId}</code>
                </>
              ) : failed ? (
                <>
                  <AlertCircle size={16} className="text-destructive" />
                  <span>{error}</span>
                </>
              ) : (
                <span className="animate-pulse">Uploading sample…</span>
              )
            }
          />
        </div>
      </div>
    </div>
  )
}

export default CloneSection
