export const MODEL_SELECTION_COOKIE = 'selectedModel'

export interface ParsedModelSelectionCookie {
  providerId: string
  modelId: string
}

export function serializeModelSelectionCookie(
  value: ParsedModelSelectionCookie
): string {
  return `${encodeURIComponent(value.providerId)}:${encodeURIComponent(
    value.modelId
  )}`
}

export function parseModelSelectionCookie(
  rawValue?: string | null
): ParsedModelSelectionCookie | null {
  if (!rawValue) {
    return null
  }

  const separatorIndex = rawValue.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === rawValue.length - 1) {
    return null
  }

  try {
    const providerId = decodeURIComponent(rawValue.slice(0, separatorIndex))
    const modelId = decodeURIComponent(rawValue.slice(separatorIndex + 1))

    if (!providerId || !modelId) {
      return null
    }

    return { providerId, modelId }
  } catch {
    return null
  }
}
