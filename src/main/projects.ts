import { app, shell } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CreateProjectInput } from '@shared/ipc'
import type { Project, ProjectSummary } from '@shared/model'
import { newProject, uid } from '@shared/factory'

const EXT = '.tvproj'

export function projectsDir(): string {
  // Tests point this at a temp folder so they never touch the user's real projects.
  if (process.env.TRAILER_DATA_DIR) return join(process.env.TRAILER_DATA_DIR, 'Projects')
  return join(app.getPath('documents'), 'Trailer-V', 'Projects')
}

const fileFor = (id: string) => join(projectsDir(), `${id}${EXT}`)
const posterFor = (id: string) => join(projectsDir(), `${id}.jpg`)

function assertId(id: string): void {
  if (!/^[a-z0-9]{6,32}$/i.test(id)) throw new Error(`Invalid project id: ${id}`)
}

/** Write to a temp file then rename, so a crash mid-save never corrupts a project. */
async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

function durationOf(p: Project): number {
  return p.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0)
}

async function summarize(p: Project): Promise<ProjectSummary> {
  let poster: string | null = null
  try {
    const s = await stat(posterFor(p.id))
    poster = `media://local/${encodeURIComponent(posterFor(p.id))}?v=${s.mtimeMs}`
  } catch {
    /* no poster yet */
  }
  return {
    id: p.id,
    name: p.name,
    updated: p.updated,
    aspect: p.settings.aspect,
    width: p.settings.width,
    height: p.settings.height,
    duration: durationOf(p),
    poster,
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await mkdir(projectsDir(), { recursive: true })
  const names = (await readdir(projectsDir())).filter((n) => n.endsWith(EXT))
  const results = await Promise.all(
    names.map(async (n) => {
      try {
        const p = JSON.parse(await readFile(join(projectsDir(), n), 'utf8')) as Project
        return await summarize(p)
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is ProjectSummary => r !== null).sort((a, b) => b.updated - a.updated)
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  await mkdir(projectsDir(), { recursive: true })
  const p = newProject(input.name.trim() || 'Untitled project', input.settings, input.mediaFolder)
  await atomicWrite(fileFor(p.id), JSON.stringify(p))
  return p
}

export async function readProject(id: string): Promise<Project> {
  assertId(id)
  return JSON.parse(await readFile(fileFor(id), 'utf8')) as Project
}

export async function saveProject(p: Project): Promise<void> {
  assertId(p.id)
  await mkdir(projectsDir(), { recursive: true })
  await atomicWrite(fileFor(p.id), JSON.stringify({ ...p, updated: Date.now() }))
}

export async function renameProject(id: string, name: string): Promise<void> {
  const p = await readProject(id)
  p.name = name.trim() || p.name
  await saveProject(p)
}

export async function duplicateProject(id: string): Promise<ProjectSummary> {
  const p = await readProject(id)
  const copy: Project = { ...p, id: uid(), name: `${p.name} copy`, created: Date.now(), updated: Date.now() }
  await atomicWrite(fileFor(copy.id), JSON.stringify(copy))
  try {
    await writeFile(posterFor(copy.id), await readFile(posterFor(id)))
  } catch {
    /* no poster */
  }
  return summarize(copy)
}

/** Moves to the Recycle Bin rather than hard-deleting. */
export async function removeProject(id: string): Promise<void> {
  assertId(id)
  await shell.trashItem(fileFor(id))
  await rm(posterFor(id), { force: true })
}

export async function savePoster(id: string, jpeg: Uint8Array): Promise<void> {
  assertId(id)
  await atomicWrite(posterFor(id), jpeg)
}
