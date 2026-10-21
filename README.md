# Trailer-V

A GPU-accelerated video editor for YouTube, built for an NVIDIA RTX card on Windows.

- **Preview:** hardware decode (WebCodecs → NVDEC) into a WebGPU compositor running in its own worker, zero-copy.
- **Export:** the same compositor renders each frame in a hidden export window, converts it to NV12 on the GPU, and pipes it straight into FFmpeg `h264_nvenc` / `hevc_nvenc`.
- **UI:** React + shadcn/ui.

**Production build:** `npm run dist` → `dist\Trailer-V Setup 0.1.0.exe`. See [Build the installer](#build-the-installer-production).

## Requirements

- Windows 10/11 with an NVIDIA GPU (NVENC).
- FFmpeg with NVENC on `PATH`. To use a different binary, set `TRAILER_FFMPEG` to its full path.

## Run

```bash
npm install
```

```bash
npm run dev
```

## Build the installer (production)

```bash
npm run dist
```

This writes `dist\Trailer-V Setup 0.1.0.exe`. Run it to install Trailer-V. The installer adds a Start menu entry and a desktop shortcut, both with the app icon.

To pin it to Start on Windows 11, open Start → **All**, right-click **Trailer-V**, and choose **Pin to Start**. To pin it to the taskbar, choose **More → Pin to taskbar**.

To produce the unpacked app at `dist\win-unpacked\Trailer-V.exe` without an installer, run `npm run dist:dir`.

### App icon

The icon source is `build/icon.svg`. The build uses `build/icon.ico` and `build/icon.png`, which are committed. After editing the SVG, regenerate them:

```bash
npm run icon
```

## Tests

```bash
npm test
```

```bash
npm run fixtures
```

```bash
npm run test:e2e
```

- `npm test` runs the unit tests: timeline operations, render plan, mixer and resampler.
- `npm run fixtures` generates the test media with FFmpeg.
- `npm run test:e2e` builds the app and drives it with Playwright, including a real NVENC export checked with `ffprobe`.
- To run the E2E suite against the packaged app, set `TRAILER_EXE=dist\win-unpacked\Trailer-V.exe`.

## MCP server (agents)

While Trailer-V is running, it serves an MCP server at `http://127.0.0.1:7863/mcp` (Streamable HTTP, localhost only). An agent can create and open projects, put media and styled titles on the timeline, trim, move, cross-fade, layer tracks, set volume envelopes and ducking, render frames or a storyboard to check the cut, export with NVENC, and generate music with YuE2 Studio. Every edit shows live in the editor, is one undo step, and autosaves.

The repo's `.mcp.json` registers it for Claude Code. To add it elsewhere:

```bash
claude mcp add --transport http trailer-v http://127.0.0.1:7863/mcp
```

- `TRAILER_MCP_PORT` changes the port. `TRAILER_MCP=0` turns the server off.
- Exports and song generation run as jobs: the tool waits up to 45 s, then `job_status` follows the rest.
- The server lives in `src/main/mcp/`. Editor-side handlers are in `src/renderer/src/features/automation/`.

## Where things live

- **Projects:** `Documents\Trailer-V\Projects\*.tvproj` (JSON, autosaved). Deleting a project moves it to the Recycle Bin.
- **Media:** read directly from the folder you pick. Trailer-V never moves or manages it.
  - To add files, drag them from File Explorer onto a library tab (Media, Text, Image or Audio) or the panel under it. They're copied into the media folder with a normal Windows copy: Windows' own progress dialog for big files, its Replace or Skip prompt when a name already exists, and Ctrl+Z in Explorer undoes it. A tab only takes its own kind of file.
  - Right-click any library tab and choose **Open in Explorer** to open the media folder.

## Performance (RTX 3060, measured by the E2E suite)

| What | Result |
|---|---|
| Cold start to project list | ~0.5 s |
| Open project to first frame | ~0.9 s |
| Playback, 1080p with cross-fade + title + overlay | 0 dropped frames |
| Scrub to exact frame, typical | 20–90 ms |
| Scrub to exact frame, deep in a 250-frame GOP | ~170 ms |
| Export, 1080p30 from 1080p sources | ~5× real-time (NVENC-bound) |
| Export, timeline with 4K60 sources | ~3.4× real-time (4K decode-bound) |

## Known limits

- With 4K60 sources, playback can drop 1–3 frames in the first ~300 ms after pressing play while the hardware decoder ramps up. Steady-state playback is clean.
- The first drag of a session can show one ~70 ms frame. This is Chromium compiling GPU shaders on first use (partially pre-warmed).
- Only one export can run at a time.
