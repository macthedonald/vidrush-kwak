'use client'

import { useState } from 'react'

import {
  IconAlertCircle as AlertCircle,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconCopy as Copy,
  IconMovie as Movie
} from '@tabler/icons-react'

import { toPublicErrorPayload } from '@/lib/errors/public-error'
import type { ToolPart } from '@/lib/types/ai'
import { cn } from '@/lib/utils'

import ProcessHeader from './process-header'

interface ScriptSectionProps {
  tool: ToolPart<'writeScript'>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

// Renders the writeScript tool: a collapsible card with the creative brief and the
// full narration script, plus copy buttons — the chat-native version of the Studio's
// script step.
export function ScriptSection({
  tool,
  isOpen,
  onOpenChange,
  borderless = false,
  isFirst = false,
  isLast = false
}: ScriptSectionProps) {
  const [copied, setCopied] = useState<'script' | 'brief' | null>(null)
  const topic = tool.input?.topic
  const isRunning =
    tool.state === 'input-streaming' || tool.state === 'input-available'
  const output = tool.state === 'output-available' ? tool.output : undefined
  const failed = tool.state === 'output-error'
  const error = failed
    ? toPublicErrorPayload(tool.errorText, {
        fallbackMessage: 'Script generation failed'
      }).error
    : undefined

  const copy = (kind: 'script' | 'brief', text?: string) => {
    if (!text) return
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }

  const header = (
    <ProcessHeader
      onInspect={() => onOpenChange(!isOpen)}
      isLoading={isRunning}
      label={
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <Movie className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate block min-w-0 max-w-full">
            {topic ? `Script — ${topic}` : 'Writing script'}
          </span>
        </div>
      }
      meta={
        output ? (
          <>
            <Check size={16} className="text-green-500" />
            <span>
              {output.words} words · ≈{output.estMinutes} min
              {output.language && output.language !== 'English'
                ? ` · ${output.language}`
                : ''}
            </span>
          </>
        ) : failed ? (
          <>
            <AlertCircle size={16} className="text-destructive" />
            <span>{error}</span>
          </>
        ) : (
          <span className="animate-pulse">Researching & writing…</span>
        )
      }
    />
  )

  return (
    <div className="relative">
      {borderless && (
        <>
          {!isFirst && (
            <div className="absolute left-[19.5px] w-px bg-border h-2 top-0" />
          )}
          {!isLast && (
            <div className="absolute left-[19.5px] w-px bg-border h-2 bottom-0" />
          )}
        </>
      )}
      <div
        className={cn(
          'rounded-lg',
          !borderless && 'bg-card border border-border'
        )}
      >
        <div
          className="flex items-center gap-2 p-3 cursor-pointer select-none"
          onClick={() => output && onOpenChange(!isOpen)}
        >
          <div className="flex-1 min-w-0">{header}</div>
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
          <div className="px-4 pb-4 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Narration script
                </span>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={e => {
                    e.stopPropagation()
                    copy('script', output.script)
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copied === 'script' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto rounded-md bg-muted/40 p-3">
                {output.script}
              </div>
            </div>
            <details>
              <summary className="text-xs font-medium uppercase tracking-wide text-muted-foreground cursor-pointer">
                Creative brief
              </summary>
              <div className="mt-2 text-sm leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto rounded-md bg-muted/40 p-3">
                {output.brief}
              </div>
              <button
                type="button"
                className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={e => {
                  e.stopPropagation()
                  copy('brief', output.brief)
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                {copied === 'brief' ? 'Copied' : 'Copy brief'}
              </button>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}

export default ScriptSection
