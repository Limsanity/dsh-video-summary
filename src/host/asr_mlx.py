#!/usr/bin/env python3
"""mlx-whisper worker(Apple Silicon GPU):音频 → 分段转录稿(JSON)。

和 asr.py 输出完全一致的格式,只是后端换成 MLX:
    python asr_mlx.py --audio a.m4a --model /path/to/mlx-model --lang zh --out transcript.json

--model 指向本地快照目录(含 config.json + weights.safetensors)或 HF repo id。
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
    args = parser.parse_args()

    import mlx_whisper

    result = mlx_whisper.transcribe(
        args.audio,
        path_or_hf_repo=args.model,
        language=args.lang or None,
        verbose=None,
        # 长音频里让上下文滚动会把一句话变成复读机,关掉
        condition_on_previous_text=False,
        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
    )

    segments = []
    for segment in result.get("segments") or []:
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        segments.append(
            {
                "start": round(float(segment.get("start") or 0), 2),
                "end": round(float(segment.get("end") or 0), 2),
                "text": text,
            }
        )
        print(f"seg {len(segments)} {segment.get('start')}", file=sys.stderr, flush=True)

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "lang": result.get("language") or args.lang,
                "duration": float(segments[-1]["end"]) if segments else 0.0,
                "segments": segments,
            },
            handle,
            ensure_ascii=False,
        )
    print(f"done {len(segments)}", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - 子进程边界,错误要原样带给 node
        print(f"ASR_FAILED: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
