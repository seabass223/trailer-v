#!/usr/bin/env bash
# Generates deterministic test media into ./fixtures using FFmpeg (dev-time only).
set -euo pipefail
out="$(dirname "$0")/../fixtures"
mkdir -p "$out"
cd "$out"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# 1080p30 H.264 long-GOP (scrub worst case) with a tone.
ff -f lavfi -i "gradients=s=1920x1080:r=30:speed=0.02:c0=0x1f3b73:c1=0xf2994a:c2=0x203a43:c3=0xffd194,format=yuv420p" \
   -f lavfi -i "sine=frequency=330:sample_rate=48000" -t 12 \
   -vf "drawtext=text='coastline %{pts\:hms}':fontcolor=white:fontsize=64:x=60:y=60" \
   -c:v libx264 -preset veryfast -g 250 -bf 3 -pix_fmt yuv420p -c:a aac -b:a 192k coastline.mp4

ff -f lavfi -i "mandelbrot=s=1920x1080:r=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 8 \
   -c:v h264_nvenc -preset p4 -g 60 -bf 2 -pix_fmt yuv420p -c:a aac -b:a 192k mountains.mp4

# 4K60 H.264
ff -f lavfi -i "testsrc2=s=3840x2160:r=60" -t 14 -c:v h264_nvenc -preset p4 -b:v 50M -g 120 -bf 2 -pix_fmt yuv420p forest.mp4

# Vertical 1080x1920 with 44.1 kHz audio
ff -f lavfi -i "life=s=1080x1920:r=30:mold=10:ratio=0.1:death_color=#1b2a49:life_color=#f6c26b,format=yuv420p" \
   -f lavfi -i "sine=frequency=220:sample_rate=44100" -t 10 -c:v libx264 -preset veryfast -g 60 -c:a aac portrait.mp4

# HEVC 1080p
ff -f lavfi -i "smptehdbars=s=1920x1080:r=30" -t 6 -c:v hevc_nvenc -preset p4 -tag:v hvc1 -pix_fmt yuv420p hevc-bars.mp4

# 60 s "music": a slow chord with tremolo, mp3 at 44.1 kHz (exercises resampling)
ff -f lavfi -i "aevalsrc='0.2*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.5*t))+0.15*sin(2*PI*277.18*t)+0.12*sin(2*PI*329.63*t)':s=44100:d=60" \
   -ac 2 -c:a libmp3lame -b:a 192k ambient-music.mp3

# Stills
ff -f lavfi -i "gradients=s=1920x1080:c0=0x0b6e4f:c1=0x08a045:c2=0x6bbf59:c3=0xddb771" -frames:v 1 leaves.jpg
ff -f lavfi -i "color=c=black@0.0:s=1200x800,format=rgba,drawbox=x=100:y=100:w=1000:h=600:color=0xff6b35@0.85:t=fill" \
   -frames:v 1 badge.png

printf 'A Brighter Tomorrow\nCoast to coast \xe2\x80\x94 2026 \xe2\x9c\xa6\n' > title.txt
ls -la
