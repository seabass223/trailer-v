/**
 * Copy files the way Explorer does: one Windows shell file operation (SHFileOperation, backed by
 * IFileOperation), so the user gets Windows' own progress dialog for big files, its
 * "Replace or Skip Files" prompt on name clashes, and Ctrl+Z in Explorer undoes it.
 *
 * Runs in a short-lived PowerShell process (~0.5 s to start); paths travel in an environment
 * variable, never on the command line.
 */
import type { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CopyResult } from '@shared/ipc'

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$job = $env:TRAILER_SHELL_COPY | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TrailerShellCopy {
  [StructLayout(LayoutKind.Sequential)]
  struct Op {
    public IntPtr hwnd; public uint wFunc; public IntPtr pFrom; public IntPtr pTo; public ushort fFlags;
    public int fAnyOperationsAborted; public IntPtr hNameMappings; public IntPtr lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperationW(ref Op op);
  // The shell reads path lists up to a double null: build them by hand, never trust string marshaling.
  static IntPtr List(string[] paths) { return Marshal.StringToHGlobalUni(string.Join("\0", paths) + "\0\0"); }
  public static string Copy(long hwnd, string[] from, string to) {
    var op = new Op { hwnd = new IntPtr(hwnd), wFunc = 2 /* FO_COPY */, pFrom = List(from), pTo = List(new[] { to }),
      fFlags = 0x0040 | 0x0200 /* FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR */ };
    try {
      int code = SHFileOperationW(ref op);
      return "{\"code\":" + code + ",\"aborted\":" + (op.fAnyOperationsAborted != 0 ? "true" : "false") + "}";
    } finally {
      Marshal.FreeHGlobal(op.pFrom);
      Marshal.FreeHGlobal(op.pTo);
    }
  }
}
'@
[TrailerShellCopy]::Copy([long]$job.hwnd, [string[]]$job.from, [string]$job.to)
`
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64')

/** Pre-Vista SHFileOperation codes the shell still returns for common failures. */
const ERRORS: Record<number, string> = {
  0x71: 'the source and destination are the same file',
  0x7c: 'a path is invalid',
  0x78: 'access was denied',
  0x10000: 'the destination could not be written',
}

/** A Windows copy keeps the source's size and modified time. */
const sameFile = async (src: string, dst: string): Promise<boolean> => {
  const [a, b] = await Promise.all([stat(src).catch(() => null), stat(dst).catch(() => null)])
  return !!a && !!b && a.size === b.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2000
}

export async function shellCopy(sources: string[], folder: string, owner: BrowserWindow | null): Promise<CopyResult> {
  if (!sources.length) return { copied: [], skipped: [], cancelled: false }
  const hwnd = owner && !owner.isDestroyed() ? owner.getNativeWindowHandle().readBigUInt64LE().toString() : '0'
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { windowsHide: true, env: { ...process.env, TRAILER_SHELL_COPY: JSON.stringify({ hwnd, from: sources, to: folder }) } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim().split(/\r?\n/)[0] || err.message)) : resolve(stdout)),
    )
  })
  const { code, aborted } = JSON.parse(out.trim().split(/\r?\n/).pop() || '{}') as { code?: number; aborted?: boolean }
  if (code && !aborted && code !== 0x4c7 /* ERROR_CANCELLED */) {
    throw new Error(`Windows couldn't copy the files: ${ERRORS[code] ?? `error 0x${code.toString(16)}`}`)
  }
  const copied: string[] = []
  const skipped: string[] = []
  for (const src of sources) {
    const dst = join(folder, basename(src))
    if (await sameFile(src, dst)) copied.push(dst)
    else skipped.push(src)
  }
  return { copied, skipped, cancelled: !!aborted || code === 0x4c7 }
}
