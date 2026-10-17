/** URL for a local file served by the main process's `media://` protocol (Range-capable). */
export const mediaUrl = (path: string): string => `media://local/${encodeURIComponent(path)}`
