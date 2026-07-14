'use client'

import { useState } from 'react'

import {
  IconAlertCircle as AlertCircle,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconEye as Eye,
  IconPhoto as Photo,
  IconVideo as Video
} from '@tabler/icons-react'

import { toPublicErrorPayload } from '@/lib/errors/public-error'
import type { ToolPart } from '@/lib/types/ai'
import { cn } from '@/lib/utils'

import ProcessHeader from './process-header'

interface FootageSectionProps {
  tool: ToolPart<'sourceFootage'>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

type FootageAsset = {
  kind: 'video' | 'photo'
  src: string
  thumb: string
  title: string
  credit: string
  url: string
  source: string
  score?: number
}

function AssetCard({
  asset,
  isBest
}: {
  asset: FootageAsset
  isBest?: boolean
}) {
  return (
    <a
      href={asset.url || asset.src}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'group relative block overflow-hidden rounded-md border bg-muted/40',
        isBest ? 'border-green-500 ring-1 ring-green-500' : 'border-border'
      )}
      title={asset.credit}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={asset.thumb || asset.src}
        alt={asset.title}
        loading="lazy"
        className="aspect-video w-full object-cover"
      />
      <span className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
        {asset.kind === 'video' ? (
          <Video className="h-3 w-3" />
        ) : (
          <Photo className="h-3 w-3" />
        )}
        {asset.source}
      </span>
      {isBest && (
        <span className="absolute right-1 top-1 rounded bg-green-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
          Pick
        </span>
      )}
      <span className="block truncate px-2 py-1 text-[11px] text-muted-foreground">
        {asset.title}
      </span>
    </a>
  )
}

// Renders the sourceFootage tool: a collapsible card showing the vision-verified pick
// plus the ranked candidate grid pooled from open archives and morphic's web search.
export function FootageSection({
  tool,
  isOpen,
  onOpenChange,
  borderless = false,
  isFirst = false,
  isLast = false
}: FootageSectionProps) {
  const [showAll, setShowAll] = useState(false)
  const queries: string[] = tool.input?.queries || []
  const label = queries[0] || 'footage'
  const isRunning =
    tool.state === 'input-streaming' || tool.state === 'input-available'
  const output = tool.state === 'output-available' ? tool.output : undefined
  const failed = tool.state === 'output-error'
  const error = failed
    ? toPublicErrorPayload(tool.errorText, {
        fallbackMessage: 'Footage sourcing failed'
      }).error
    : undefined

  const best: FootageAsset | null = output?.best ?? null
  const candidates: FootageAsset[] = output?.candidates ?? []
  const rest = best
    ? candidates.filter(c => c.src !== best.src || c.url !== best.url)
    : candidates
  const shown = showAll ? rest : rest.slice(0, 5)

  const header = (
    <ProcessHeader
      onInspect={() => onOpenChange(!isOpen)}
      isLoading={isRunning}
      label={
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="block min-w-0 max-w-full truncate">
            {`Footage — ${label}`}
          </span>
        </div>
      }
      meta={
        output ? (
          <>
            <Check size={16} className="text-green-500" />
            <span className="flex items-center gap-1">
              {candidates.length} candidate
              {candidates.length === 1 ? '' : 's'}
              {output.visionVerified && (
                <>
                  {' · '}
                  <Eye size={14} className="text-blue-500" />
                  vision-verified
                </>
              )}
            </span>
          </>
        ) : failed ? (
          <>
            <AlertCircle size={16} className="text-destructive" />
            <span>{error}</span>
          </>
        ) : (
          <span className="animate-pulse">Sourcing footage…</span>
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
        className={cn(
          'rounded-lg',
          !borderless && 'border border-border bg-card'
        )}
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
          <div className="space-y-4 px-4 pb-4">
            {best ? (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Selected shot
                </div>
                <div className="max-w-xs">
                  <AssetCard asset={best} isBest />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {best.credit}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No candidate passed vision verification — try more specific
                search phrases.
              </p>
            )}
            {rest.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Other candidates
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {shown.map((c, i) => (
                    <AssetCard key={`${c.src}-${i}`} asset={c} />
                  ))}
                </div>
                {rest.length > 5 && (
                  <button
                    type="button"
                    className="mt-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={e => {
                      e.stopPropagation()
                      setShowAll(v => !v)
                    }}
                  >
                    {showAll ? 'Show fewer' : `Show all ${rest.length}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default FootageSection
