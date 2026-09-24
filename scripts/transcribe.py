#!/usr/bin/env python3
# =============================================================================
#  Transcribe media audio → timed captions (local & free, via faster-whisper).
#  Runs entirely on your machine — nothing leaves the box.
#
#  One-time setup:  pip install faster-whisper
#  First run downloads a model (tiny/base/small/medium) to ~/.cache — cached after.
#
#  Usage:
#    python3 transcribe.py <media_path> [--model small] [--language en] [--out file.json]
#  Prints JSON: { "captions": [{start, end, text}], "language": "en", "error": null }
#  Exit code 2 = faster-whisper not installed.
# =============================================================================
import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser(description="Whisper transcription → captions JSON")
    ap.add_argument("media", help="audio or video file to transcribe")
    ap.add_argument("--model", default=os.environ.get("SP_WHISPER_MODEL", "small"),
                    help="tiny|base|small|medium|large-v3 (default small)")
    ap.add_argument("--language", default=os.environ.get("SP_WHISPER_LANG") or None)
    ap.add_argument("--out", default=None, help="write JSON to this file instead of stdout")
    args = ap.parse_args()

    if not os.path.exists(args.media):
        print(json.dumps({"captions": [], "error": f"media not found: {args.media}"}))
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel  # noqa: WPS433
    except ImportError:
        print(json.dumps({
            "captions": [],
            "error": "faster-whisper is not installed. Run: pip install faster-whisper",
        }))
        sys.exit(2)

    try:
        # Memory-lean defaults: int8 on CPU survives 512MB free-tier boxes.
        # Override with SP_WHISPER_DEVICE / SP_WHISPER_COMPUTE / SP_WHISPER_THREADS
        # if you have a GPU or a bigger machine.
        model = WhisperModel(
            args.model,
            device=os.environ.get("SP_WHISPER_DEVICE", "cpu"),
            compute_type=os.environ.get("SP_WHISPER_COMPUTE", "int8"),
            cpu_threads=int(os.environ.get("SP_WHISPER_THREADS", "2")),
        )
        segments, info = model.transcribe(args.media, language=args.language, vad_filter=True)
        captions = []
        for seg in segments:
            text = (seg.text or "").strip()
            if text:
                captions.append({
                    "start": round(float(seg.start), 2),
                    "end": round(float(seg.end), 2),
                    "text": text,
                })
        result = {
            "captions": captions,
            "language": getattr(info, "language", None),
            "probability": getattr(info, "language_probability", None),
        }
    except Exception as exc:  # noqa: BLE001
        result = {"captions": [], "error": str(exc)}

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh)
    else:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
