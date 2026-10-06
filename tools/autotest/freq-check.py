#!/usr/bin/env python3
# 频谱判定：wav 文件主频是否命中期望频率（±2%），且信噪比足够
# 用法：freq-check.py <wav路径> <期望Hz> [容差，默认0.02]
import sys
import wave
import numpy as np


def main():
    path = sys.argv[1]
    expected = float(sys.argv[2])
    tol = float(sys.argv[3]) if len(sys.argv) > 3 else 0.02

    w = wave.open(path, 'rb')
    sr = w.getframerate()
    ch = w.getnchannels()
    n = w.getnframes()
    raw = w.readframes(n)
    w.close()

    data = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
    if ch > 1:
        data = data[::ch]
    data -= data.mean()

    win = np.hanning(len(data))
    sp = np.abs(np.fft.rfft(data * win))
    freqs = np.fft.rfftfreq(len(data), 1.0 / sr)

    mask = (freqs >= 200) & (freqs <= 1500)
    f2, s2 = freqs[mask], sp[mask]
    peak_i = int(np.argmax(s2))
    peak_f, peak_a = float(f2[peak_i]), float(s2[peak_i])
    med = float(np.median(s2))

    # 抛物线插值提高频率分辨率
    if 0 < peak_i < len(s2) - 1:
        y0, y1, y2 = s2[peak_i - 1], s2[peak_i], s2[peak_i + 1]
        denom = y0 - 2 * y1 + y2
        if denom != 0:
            peak_f += 0.5 * (y0 - y2) / denom * float(f2[1] - f2[0])

    err = abs(peak_f - expected) / expected
    snr = peak_a / med if med > 0 else 0
    ok = err <= tol and snr >= 5
    print(f"peak={peak_f:.1f}Hz expected={expected:.1f}Hz err={err * 100:.2f}% snr={snr:.0f}x -> {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


main()
