'use client'

import { Streamdown } from 'streamdown'

import { cn } from '@/lib/utils'

export function ReasoningContent({ reasoning }: { reasoning: string }) {
  return (
    <div className="overflow-auto">
      <div className={cn('prose-sm dark:prose-invert max-w-none')}>
        <Streamdown>{reasoning}</Streamdown>
      </div>
    </div>
  )
}
