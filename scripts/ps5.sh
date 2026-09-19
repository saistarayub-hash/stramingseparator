#!/usr/bin/env bash
# =============================================================================
#  PS5 → StreamPilot capture helper
#  ---------------------------------------------------------------------------
#  This script lives on the machine that is ON THE SAME NETWORK as your PS5
#  (run it next to StreamPilot). It:
#
#    1. DISCOVERS your PS5 automatically (UDP broadcast — no IP needed)
#    2. Pairs with the console (Remote Play protocol, via open-source chiaki-ng)
#    3. Plays the PS5 screen into this PC and relays it to a local HLS stream
#
#  StreamPilot then records that HLS stream, and you can clip Shorts/TikToks
#  live while you play — no capture card.
#
#  ONE-TIME SETUP (do these once):
#    • On your PS5: Settings → System → Remote Play → Enable Remote Play
#    • Get your Account-ID (from the PS5's Linked Devices screen it shows
#      after enabling remote play, or use the `npso` webfront)
#    • Install chiaki-ng (remote play client):
#        https://sr.ht/~thestr4ng3r/chiaki/   (chiaki-ng fork preferred)
#
#  USAGE:
#    ./ps5.sh discover                 # find your PS5 on the network
#    ./ps5.sh pair <ACCOUNT_ID>        # register this PC with the PS5
#    ./ps5.sh start  <ACCOUNT_ID>      # remote-play + relay to HLS for StreamPilot
#    ./ps5.sh stop                     # stop everything
#
#  Vars: PS5_PIN (default 0000000), PS5_NICK, PS5_HLS_PORT (default 8080)
# =============================================================================
set -euo pipefail

ACC="${2:-}"
PIN="${PS5_PIN:-0000000}"
NICK="${PS5_NICK:-StreamPilot}"
HLS_PORT="${PS5_HLS_PORT:-8080}"
STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/streampilot-ps5"
CHIAKI_BIN="$(command -v chiaki || command -v chiaki-ng || true)"
FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"

log() { printf '\033[1;36m[ps5]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ps5] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1 (hint: apt install $2)"; }

# --- UDP discovery of PlayStation consoles on the LAN ----------------------
discover() {
  log "Broadcasting for PlayStation 4/5 on the local network…"
  need python3 python3
  python3 - "$@" <<'PY'
import socket, sys, time
BCAST_PORT = 987
PAYLOAD = b"SRCH" + b"\x00" * 4 + b"ps4" + b"\x00" * 4 + b"-"*8 + b"\x01\x00\x00\x00" + b"\x00"*4 + b"\x00"*4 + b"\x00"*4 + b"\x00"*105

def bound_sockets():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(3)
    s2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s2.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s2.bind(("", BCAST_PORT))
    s2.settimeout(3)
    return s, s2

def main():
    s, s2 = bound_sockets()
    found = []
    try:
        for _ in range(3):
            # PS5 discovery may use host-name "ps5" as well as "ps4"
            for host in ("ps4", "ps5"):
                payload = PAYLOAD.replace(b"ps4\x00\x00\x00\x00", host.encode() + b"\x00"*(6-len(host)))
                s.sendto(payload, ("255.255.255.255", BCAST_PORT))
            deadline = time.time() + 3
            while time.time() < deadline:
                try:
                    data, addr = s2.recvfrom(4096)
                except socket.timeout:
                    break
                if len(data) < 64:
                    continue
                status = data[16:18]
                host_name = data[18:34].split(b"\x00")[0].decode("utf-8", "replace")
                sys_ver  = data[34:38].hex()
                found.append((addr[0], host_name, status.hex(), sys_ver))
        for ip, name, st, ver in {x: x for x in found}.keys():
            model = "PS5" if int(ver[:2], 16) >= 9 else "PS4"
            state = {"01": "STANDBY", "02": "AWAKE"}.get(st[:-2], st)
            print(f"FOUND {model}  {name}  ip={ip}  state={state}")
    finally:
        s.close(); s2.close()
    if not found:
        print("No console found. Is the PS5 on the same Wi-Fi/LAN and Remote Play enabled?")
        sys.exit(2)

main()
PY
}

# --- Pair (register) this PC with the PS5 ----------------------------------
pair() {
  [ -n "$ACC" ] || die "usage: $0 pair <ACCOUNT_ID>  (get ID from PS5 → Settings → System → Remote Play → Link Device)"
  mkdir -p "$STATE_DIR"
  need "$CHIAKI_BIN" chiaki
  log "Registering with PS5 as '$NICK' (enter the PIN shown on your PS5 when prompted)…"
  # chiaki-ng auto-detects the console on pairing; PIN is shown on the PS5 screen.
  "$CHIAKI_BIN" -r "$STATE_DIR" -a "$ACC" -n "$NICK" pair
  log "Paired! Use: $0 start $ACC"
}

# --- Start remote play + relay to HLS --------------------------------------
start() {
  [ -n "$ACC" ] || die "usage: $0 start <ACCOUNT_ID>"
  mkdir -p "$STATE_DIR"
  need "$CHIAKI_BIN" chiaki
  need "$FFMPEG_BIN" ffmpeg
  PIPE="$STATE_DIR/video.sock"
  rm -f "$PIPE"
  mkfifo "$PIPE" 2>/dev/null || true

  log "Starting remote play as '$NICK' …"
  # -v pipe dumps raw H.264 to the named pipe; ffmpeg re-muxes it to HLS.
  "$CHIAKI_BIN" -r "$STATE_DIR" -a "$ACC" -n "$NICK" \
    -v "pipe:$PIPE" -a "$STATE_DIR/audio.sock" --no-gui &
  CHIAKI_PID=$!
  echo "$CHIAKI_PID" > "$STATE_DIR/chiaki.pid"
  sleep 3

  log "Relaying screen to http://localhost:$HLS_PORT/ps5/index.m3u8 …"
  "$FFMPEG_BIN" -hide_banner -loglevel warning \
    -i "pipe:$PIPE" -i "$STATE_DIR/audio.sock" \
    -map 0:v:0 -map 1:a:0? \
    -c:v copy -c:a aac -b:a 128k \
    -f hls -hls_time 2 -hls_list_size 8 -hls_flags delete_segments+append_list \
    "$STATE_DIR/hls/index.m3u8" &
  FFMPEG_PID=$!
  echo "$FFMPEG_PID" > "$STATE_DIR/ffmpeg.pid"

  "$FFMPEG_BIN" -hide_banner -loglevel warning \
    -i "$STATE_DIR/hls/index.m3u8" \
    -c copy -f mpegts "http://localhost:$HLS_PORT/ps5/index.m3u8" \
    >/dev/null 2>&1 &
  echo "running" > "$STATE_DIR/state"

  log "PS5 capture relay is LIVE. Point StreamPilot at:  http://localhost:$HLS_PORT/ps5/index.m3u8"
  log "Stop with: $0 stop"
  wait "$CHIAKI_PID" || true
}

stop() {
  log "Stopping PS5 capture…"
  [ -f "$STATE_DIR/chiaki.pid" ] && kill "$(cat "$STATE_DIR/chiaki.pid")" 2>/dev/null || true
  [ -f "$STATE_DIR/ffmpeg.pid" ] && kill "$(cat "$STATE_DIR/ffmpeg.pid")" 2>/dev/null || true
  rm -f "$STATE_DIR"/chiaki.pid "$STATE_DIR"/ffmpeg.pid
  echo "stopped" > "$STATE_DIR/state"
}

case "${1:-}" in
  discover) discover ;;
  pair) pair ;;
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 {discover|pair <ACC>|start <ACC>|stop}"; exit 1 ;;
esac
