/**
 * Long-running MCP work (exports, song generation) as jobs: a tool starts one and may wait a
 * while for it; `job_status` long-polls the rest. Same shape as YuE2's Micro-UI jobs.
 */
import { randomUUID } from 'node:crypto'

export type JobKind = 'export' | 'music'
export type JobState = 'running' | 'completed' | 'failed' | 'cancelled'

export interface Job {
  id: string
  kind: JobKind
  label: string
  state: JobState
  /** 0..1 when known. */
  progress: number | null
  message: string
  result: Record<string, unknown> | null
  error: string | null
  started: number
  ended: number | null
  cancel: () => void | Promise<void>
}

const jobs = new Map<string, Job>()
const subscribers = new Map<string, Set<(j: Job) => void>>()

export function createJob(kind: JobKind, label: string, cancel: Job['cancel']): Job {
  const job: Job = {
    id: randomUUID(), kind, label, state: 'running', progress: 0, message: 'Starting', result: null, error: null,
    started: Date.now(), ended: null, cancel,
  }
  jobs.set(job.id, job)
  // Keep the last few finished jobs around for status queries.
  const done = [...jobs.values()].filter((j) => j.state !== 'running')
  for (const j of done.slice(0, Math.max(0, done.length - 20))) jobs.delete(j.id)
  return job
}

export const getJob = (id: string): Job | undefined => jobs.get(id)
export const runningJob = (kind: JobKind): Job | undefined => [...jobs.values()].find((j) => j.kind === kind && j.state === 'running')

export function updateJob(job: Job, patch: Partial<Pick<Job, 'state' | 'progress' | 'message' | 'result' | 'error'>>): void {
  if (job.state !== 'running') return
  Object.assign(job, patch)
  if (job.state !== 'running') job.ended = Date.now()
  for (const cb of subscribers.get(job.id) ?? []) cb(job)
}

export function subscribe(job: Job, cb: (j: Job) => void): () => void {
  let set = subscribers.get(job.id)
  if (!set) subscribers.set(job.id, (set = new Set()))
  set.add(cb)
  return () => set.delete(cb)
}

/** Resolve when the job ends or after `ms`, whichever is first. */
export function waitFor(job: Job, ms: number, signal?: AbortSignal, onUpdate?: (j: Job) => void): Promise<Job> {
  if (job.state !== 'running' || ms <= 0) return Promise.resolve(job)
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      off()
      signal?.removeEventListener('abort', finish)
      resolve(job)
    }
    const timer = setTimeout(finish, ms)
    const off = subscribe(job, (j) => {
      onUpdate?.(j)
      if (j.state !== 'running') finish()
    })
    signal?.addEventListener('abort', finish)
  })
}

export function jobView(job: Job): Record<string, unknown> {
  const now = job.ended ?? Date.now()
  return {
    jobId: job.id,
    kind: job.kind,
    label: job.label,
    state: job.state,
    progress: job.progress,
    message: job.message,
    elapsedSeconds: Math.round((now - job.started) / 100) / 10,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}
