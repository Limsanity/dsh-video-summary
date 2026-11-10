#!/usr/bin/env python3
"""faster-whisper worker: 音频 → 分段转录稿(JSON)。

由 pipeline.js 以子进程方式调用,只依赖 faster_whisper + ffmpeg:
    python asr.py --audio a.m4a --model /path/to/model --lang zh --out transcript.json

--model 既是本地模型的目录,也可以是 HF repo id(需要网络+SSL)。
输出:{ "lang": "zh", "duration": 270.0, "segments": [{"start","end","text"}] }
"""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--lang", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument("--beam", type=int, default=5)
    parser.add_argument("--compute", default="int8")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type=args.compute)
    segments, info = model.transcribe(
        args.audio,
        language=args.lang or None,
        vad_filter=True,
        beam_size=args.beam,
        # 长音频里 condition_on_previous_text 很容易把一句话滚成复读机
        condition_on_previous_text=False,
    )

    out = []
    for segment in segments:
        text = (segment.text or "").strip()
        if not text:
            continue
        out.append(
            {
                "start": round(float(segment.start), 2),
                "end": round(float(segment.end), 2),
                "text": text,
            }
        )
        print(f"seg {len(out)} {segment.start:.1f}", file=sys.stderr, flush=True)

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "lang": getattr(info, "language", args.lang) or args.lang,
                "duration": float(getattr(info, "duration", 0) or 0),
                "segments": out,
            },
            handle,
            ensure_ascii=False,
        )
    print(f"done {len(out)}", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - 子进程边界,错误要原样带给 node
        print(f"ASR_FAILED: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
