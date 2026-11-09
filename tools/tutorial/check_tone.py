#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读音验证：对一段音频画 F0（基频）曲线，按浊音段输出走向。
用法: .venv/bin/python check_tone.py build/vo_test.m4a
判断: 「调调 tiao2 diao4」期望 第1个浊音段音高上升(阳平)，第2段下降(去声)。"""
import subprocess, sys, math, wave, tempfile, os

def f0_contour(path, sr=16000):
    tmp = tempfile.mktemp(suffix=".wav")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", path, "-ar", str(sr), "-ac", "1", "-c:a", "pcm_s16le", tmp], check=True)
    w = wave.open(tmp)
    n = w.getnframes()
    data = w.readframes(n)
    os.remove(tmp)
    samples = [s / 32768.0 for (s,) in __import__("struct").iter_unpack("<h", data)]
    win, hop = int(0.04 * sr), int(0.02 * sr)      # 40ms 窗 / 20ms 步
    fmin, fmax = 60, 500
    out = []
    for i in range(0, len(samples) - win, hop):
        frame = samples[i:i + win]
        rms = math.sqrt(sum(x * x for x in frame) / win)
        if rms < 0.005:
            continue
        # 自相关求基频
        best_lag, best_corr = 0, 0.0
        e0 = sum(x * x for x in frame) + 1e-9
        for lag in range(sr // fmax, sr // fmin):
            c = sum(frame[j] * frame[j + lag] for j in range(win - lag))
            e1 = sum(frame[j + lag] * frame[j + lag] for j in range(win - lag)) + 1e-9
            r = c / math.sqrt(e0 * e1)
            if r > best_corr:
                best_corr, best_lag = r, lag
        if best_corr > 0.45 and best_lag:
            f = sr / best_lag
            if 90 <= f <= 380:            # 人声带宽，滤掉倍频跳变
                out.append((i / sr, f))
    return out

def syllables(contour):
    """按 >120ms 空档分段浊音区"""
    segs, cur = [], [contour[0]]
    for a, b in zip(contour, contour[1:]):
        if b[0] - a[0] > 0.12:
            segs.append(cur); cur = []
        cur.append(b)
    segs.append(cur)
    return [s for s in segs if len(s) >= 4]

def trend(seg):
    """前 1/3 与后 1/3 中位音高比 → 上升/下降/平"""
    k = max(1, len(seg) // 3)
    head = sorted(p for _, p in seg[:k])[len(seg[:k]) // 2]
    tail = sorted(p for _, p in seg[-k:])[len(seg[-k:]) // 2]
    r = tail / head
    return ("上升", r) if r > 1.12 else (("下降", r) if r < 0.88 else ("平", r))

if __name__ == "__main__":
    c = f0_contour(sys.argv[1])
    if not c:
        print("无浊音段"); sys.exit(1)
    t0 = c[0][0]
    for i, seg in enumerate(syllables(c)):
        name, r = trend(seg)
        print(f"音段{i+1}: {seg[0][0]-t0:.2f}s~{seg[-1][0]-t0:.2f}s  "
              f"音高 {min(p for _,p in seg):.0f}→{max(p for _,p in seg):.0f}Hz  走向={name} (尾/首={r:.2f})")
