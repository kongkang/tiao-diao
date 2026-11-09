#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音乐转调 · 使用教程视频构建器
分镜（scenes.json）→ 系统 TTS 旁白（say 婷婷）→ 截图合成（手机框+高亮+大字幕）
→ ffmpeg zoompan 逐场景渲染 → 拼接成片。

用法:
  .venv/bin/python build.py --compose-only   # 只出静帧供核对坐标
  .venv/bin/python build.py                  # 全量构建 out/音乐转调-使用教程.mp4
"""
import http.client, json, os, subprocess, sys, urllib.request, urllib.error

BASE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(BASE, "build")
OUT = os.path.join(BASE, "out")
os.makedirs(BUILD, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

CFG = json.load(open(os.path.join(BASE, "scenes.json"), encoding="utf-8"))
SHOTS = os.path.join(BASE, CFG["shots_dir"])

# ---------- Fish Audio（key 在 tools/tutorial/.env，见 FISH_AUDIO_API_KEY） ----------
def _load_env():
    env = {}
    p = os.path.join(BASE, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("\"'")
    return env

ENV = _load_env()
FISH_KEY = ENV.get("FISH_AUDIO_API_KEY", "") or os.environ.get("FISH_AUDIO_API_KEY", "")
FISH_REF = ENV.get("FISH_AUDIO_REFERENCE_ID", "") or os.environ.get("FISH_AUDIO_REFERENCE_ID", "")
FISH_SPEED = float(ENV.get("FISH_AUDIO_SPEED", "0.9"))   # 中老年语速，略慢

# 多音字强制读音：「调调」= tiáo diào（音素标签逐字替换音节，官方文档语法）
PRON_FIXUPS = [
    ("调调", "<|phoneme_start|>tiao2<|phoneme_end|><|phoneme_start|>diao4<|phoneme_end|>"),
]

# ---------- 画布常量（canvas = 2160x3840，输出 1080x1920 的 2 倍超采样） ----------
CW, CH = 2160, 3840
OW, OH = 1080, 1920
FPS = 30
GREEN = (7, 193, 96)        # 微信绿 #07C160
GREEN_DK = (5, 162, 79)
INK = (17, 17, 17)
SUBC = (91, 100, 112)       # #5b6470
GRAY = (138, 143, 152)
BG = (247, 248, 250)        # 与 app 页面底色一致

# 手机框（canvas 坐标）—— 尽量大，保证截图文字可读
PHONE_W = 1320
BORDER = 24
PHONE_X = (CW - PHONE_W) // 2
PHONE_Y = 150
SHOT_W, SHOT_H = 734, 1588      # 截图统一归一化（367x794 的 2 倍）
INNER_W = PHONE_W - BORDER * 2              # 1164
S367 = INNER_W / 367.0                      # 367 空间 → canvas 空间 ≈3.17
S734 = INNER_W / float(SHOT_W)              # 734 空间 → canvas 空间 ≈1.585
INNER_H = round(794 * S367)                 # ≈2516
PHONE_H = INNER_H + BORDER * 2              # ≈2568
PHONE_BOT = PHONE_Y + PHONE_H               # ≈2818

F_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"
F_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"

from PIL import Image, ImageDraw, ImageFont, ImageFilter

def font(size, bold=True):
    path = F_BOLD if bold else F_LIGHT
    for idx in (0, 1):
        try:
            return ImageFont.truetype(path, size, index=idx)
        except Exception:
            continue
    return ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", size, index=0)

def tcenter(d, cx, cy, s, f, fill):
    d.text((cx, cy), s, font=f, fill=fill, anchor="mm")

def rrect(d, box, r, **kw):
    d.rounded_rectangle(box, radius=r, **kw)

# ---------- 截图预处理 ----------
def load_shot(name):
    p = os.path.join(SHOTS, name)
    im = Image.open(p).convert("RGB").resize((SHOT_W, SHOT_H), Image.LANCZOS)
    return im

def make_process_mock():
    """处理中页 mock：按 pages/process/index.wxml 真实结构绘制
    （大百分比+绿进度条+「正在处理，请稍等」+ 音乐/调整 行），导航标题=正在处理。"""
    W, H = 367, 794
    s = 2
    im = Image.new("RGB", (W * s, H * s), (247, 247, 247))
    d = ImageDraw.Draw(im)
    d.text((18 * s, 20 * s), "15:50", font=font(13 * s, False), fill=(0, 0, 0), anchor="lm")
    d.rounded_rectangle([W * s - 36 * s, 12 * s, W * s - 16 * s, 23 * s], radius=3 * s, outline=(0, 0, 0), width=s)
    d.rectangle([W * s - 33 * s, 15 * s, W * s - 24 * s, 20 * s], fill=(0, 0, 0))
    d.rounded_rectangle([W * s / 2 - 60 * s, 6 * s, W * s / 2 + 60 * s, 34 * s], radius=14 * s, fill=(0, 0, 0))
    d.text((W * s / 2, 62 * s), "正在处理", font=font(15 * s), fill=(17, 17, 17), anchor="mm")
    m, r = 12, 8
    y0, y1 = 95, 300
    d.rounded_rectangle([m * s, y0 * s, (W - m) * s, y1 * s], radius=r * s, fill=(255, 255, 255))
    cx = W * s / 2
    d.text((cx, (y0 + 44) * s), "46%", font=font(48 * s), fill=GREEN, anchor="mm")
    bw, bx0, by = (W - 2 * m - 24), (m + 12) * s, (y0 + 88) * s
    d.rounded_rectangle([bx0, by, bx0 + bw * s, by + 10 * s], radius=5 * s, fill=(240, 240, 240))
    d.rounded_rectangle([bx0, by, bx0 + bw * s * 0.46, by + 10 * s], radius=5 * s, fill=GREEN)
    d.text((cx, (y0 + 128) * s), "正在处理，请稍等", font=font(16 * s), fill=(17, 17, 17), anchor="mm")
    d.text((cx, (y0 + 158) * s), "大约需要 40 秒", font=font(13 * s, False), fill=GRAY, anchor="mm")
    d.text((cx, (y0 + 180) * s), "别退出，也别切出去", font=font(13 * s, False), fill=GRAY, anchor="mm")
    y2 = 312
    d.rounded_rectangle([m * s, y2 * s, (W - m) * s, (y2 + 96) * s], radius=r * s, fill=(255, 255, 255))
    for i, (k, v) in enumerate([("音乐", "测试歌（3分钟）.wav"), ("调整", "升 2 个半音")]):
        yy = y2 + 30 + i * 36
        d.text(((m + 14) * s, yy * s), k, font=font(15 * s, False), fill=GRAY, anchor="lm")
        d.text(((W - m - 14) * s, yy * s), v, font=font(15 * s, False), fill=(51, 51, 51), anchor="rm")
    d.rounded_rectangle([W * s / 2 - 60 * s, H * s - 10 * s, W * s / 2 + 60 * s, H * s - 6 * s], radius=2 * s, fill=(0, 0, 0))
    return im.resize((SHOT_W, SHOT_H), Image.LANCZOS)

# ---------- 场景底图 ----------
def hl_box_734(scene):
    """高亮框（含外扩 padding），返回 734 空间坐标"""
    x0, y0, x1, y1 = [v * 2 for v in scene["hl"]]
    pad = 16
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad]

def compose_phone_bg(scene, shot):
    c = Image.new("RGBA", (CW, CH), BG + (255,))
    d = ImageDraw.Draw(c)
    rrect(d, [PHONE_X, PHONE_Y, PHONE_X + PHONE_W, PHONE_Y + PHONE_H], 92, fill=(26, 26, 32, 255))
    ix, iy = PHONE_X + BORDER, PHONE_Y + BORDER
    srgba = shot.convert("RGBA")
    if scene.get("hl"):
        x0, y0, x1, y1 = hl_box_734(scene)
        fx = lambda v: ix + v * S734
        fy = lambda v: iy + v * S734
        hole = [fx(x0), fy(y0), fx(x1), fy(y1)]
        # 高亮区外压暗（洞内保持原样；压暗宜淡，避免整体发灰）
        dim = Image.new("RGBA", srgba.size, (8, 14, 10, 68))
        dimmed = Image.alpha_composite(srgba, dim)
        mask = Image.new("L", srgba.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([x0, y0, x1, y1], radius=32, fill=255)
        srgba = Image.composite(srgba, dimmed, mask)  # mask=255 → 洞内亮
        srgba = srgba.resize((INNER_W, INNER_H), Image.LANCZOS)
        c.paste(srgba.convert("RGB"), (ix, iy))
        # 光圈（外发光 + 实线）
        glow = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        rrect(ImageDraw.Draw(glow), hole, 56, outline=GREEN + (255,), width=30)
        glow = glow.filter(ImageFilter.GaussianBlur(16))
        c = Image.alpha_composite(c, glow)
        d = ImageDraw.Draw(c)
        rrect(d, hole, 56, outline=GREEN + (255,), width=12)
        # 「点这里/看这里」标签（none = 不放标签，只留圆圈）
        kind = scene.get("hl_kind")
        if kind == "none":
            return c.convert("RGB")
        tag = "点这里" if kind == "tap" else "看这里"
        tf = font(72)
        tw = d.textlength(tag, font=tf)
        tx = min(max((hole[0] + hole[2]) / 2, 240), CW - 240)
        ty = hole[1] - 96
        if ty < 300:
            ty = hole[3] + 96
        rrect(d, [tx - tw / 2 - 46, ty - 58, tx + tw / 2 + 46, ty + 58], 58, fill=GREEN + (255,))
        d.text((tx, ty), tag, font=tf, fill=(255, 255, 255, 255), anchor="mm")
    else:
        srgba = srgba.resize((INNER_W, INNER_H), Image.LANCZOS)
        c.paste(srgba.convert("RGB"), (ix, iy))
    return c.convert("RGB")

def compose_intro_bg(scene):
    c = Image.new("RGB", (CW, CH), BG)
    d = ImageDraw.Draw(c)
    for y in range(CH):
        t = min(1.0, y / (CH * 0.78))   # 绿色保持更长，白字对比度足
        col = tuple(int(GREEN[i] + (BG[i] - GREEN[i]) * t) for i in range(3))
        d.line([(0, y), (CW, y)], fill=col)
    nx, ny = CW // 2, 1180
    d.ellipse([nx - 170, ny - 100, nx + 16, ny + 100], fill=(255, 255, 255))
    d.rounded_rectangle([nx - 17, ny - 460, nx + 30, ny], radius=22, fill=(255, 255, 255))
    d.polygon([(nx + 30, ny - 460), (nx + 250, ny - 385), (nx + 30, ny - 305)], fill=(255, 255, 255))
    tcenter(d, CW / 2, 1780, scene["title"], font(270), (255, 255, 255))
    tcenter(d, CW / 2, 2030, scene["sub"], font(92, False), (255, 255, 255))
    f = font(68)
    w = d.textlength(scene["small"], font=f)
    rrect(d, [CW / 2 - w / 2 - 56, 2220, CW / 2 + w / 2 + 56, 2352], 66, fill=(255, 255, 255))
    tcenter(d, CW / 2, 2286, scene["small"], f, (4, 138, 66))
    return c

def compose_outro_bg(scene):
    c = Image.new("RGB", (CW, CH), BG)
    d = ImageDraw.Draw(c)
    cx, cy, r = CW / 2, 980, 175
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GREEN)
    d.line([(cx - 72, cy + 9), (cx - 16, cy + 65)], fill=(255, 255, 255), width=30)
    d.line([(cx - 16, cy + 65), (cx + 77, cy - 47)], fill=(255, 255, 255), width=30)
    tcenter(d, CW / 2, 1310, scene["title"], font(170), (0, 0, 0))
    pills = scene["steps"]
    f = font(82)
    pw, ph, gap = 470, 160, 60
    rows = [pills[:3], pills[3:]]
    y0 = 1580
    for ri, row in enumerate(rows):
        x_start = CW / 2 - (len(row) * pw + (len(row) - 1) * gap) / 2
        for ci, s in enumerate(row):
            x0 = x_start + ci * (pw + gap)
            yy = y0 + ri * (ph + gap)
            rrect(d, [x0, yy, x0 + pw, yy + ph], 80, fill=(255, 255, 255), outline=GREEN, width=7)
            d.ellipse([x0 + 30, yy + 38, x0 + 118, yy + 126], fill=GREEN)
            tcenter(d, x0 + 74, yy + 82, str(ri * 3 + ci + 1), font(56), (255, 255, 255))
            tcenter(d, x0 + 118 + (pw - 118) / 2, yy + ph / 2, s, f, (0, 0, 0))
    tcenter(d, CW / 2, 2170, scene["small"], font(78), (4, 138, 66))
    return c

# ---------- 字幕层（静态 overlay，不参与 zoom） ----------
def compose_caption(scene):
    ov = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    if scene["type"] in ("intro", "outro"):
        return ov
    # 底部字幕底衬板：纯白不透明，保证任意 zoom 下黑字对比度
    rrect(d, [110, 2966, CW - 110, 3790], 64, fill=(255, 255, 255, 252))
    # 步骤胶囊：骑在衬板顶边
    f_chip = font(72)
    w = d.textlength(scene["chip"], font=f_chip)
    cy = 2966
    rrect(d, [CW / 2 - w / 2 - 52, cy - 74, CW / 2 + w / 2 + 52, cy + 74], 74, fill=GREEN + (255,))
    d.text((CW / 2, cy), scene["chip"], font=f_chip, fill=(255, 255, 255, 255), anchor="mm")
    # 大标题：纯黑加大
    tcenter(d, CW / 2, 3205, scene["title"], font(150), (0, 0, 0, 255))
    # 副标题：一行短句，深黑灰，加大
    for i, ln in enumerate(scene.get("sub", "").split("\n")):
        tcenter(d, CW / 2, 3405 + i * 120, ln, font(78), (45, 45, 45, 255))
    return ov

# ---------- zoom 参数 ----------
def zoom_target(scene):
    if not scene.get("hl"):
        return 1.045
    x0, y0, x1, y1 = hl_box_734(scene)
    rw = (x1 - x0) * S734
    rh = (y1 - y0) * S734
    zh = CH / (rh * 2.0)     # 高亮区约占画面一半高
    zw = CW / (rw * 1.18)
    return max(1.0, min(min(zh, zw), 1.9))

def zoom_start(z1):
    return max(1.0, z1 * 0.82)

def focus_center(scene):
    if not scene.get("hl"):
        return 0.5, 0.5
    x0, y0, x1, y1 = scene["hl"]
    cx = PHONE_X + BORDER + (x0 + x1) / 2 * S367
    cy = PHONE_Y + BORDER + (y0 + y1) / 2 * S367
    return cx / CW, cy / CH

def still(scene, bg, cap, path):
    z1 = zoom_target(scene)
    z0 = zoom_start(z1)
    z = z0 + (z1 - z0) * 0.5
    cx, cy = focus_center(scene)
    w, h = CW / z, CH / z
    x0 = min(max(cx * CW - w / 2, 0), CW - w)
    y0 = min(max(cy * CH - h / 2, 0), CH - h)
    crop = bg.crop((int(x0), int(y0), int(x0 + w), int(y0 + h))).resize((OW, OH), Image.LANCZOS)
    Image.alpha_composite(crop.convert("RGBA"), cap.resize((OW, OH), Image.LANCZOS)).convert("RGB").save(path)

# ---------- TTS ----------
def _apply_pron(text):
    for w, p in PRON_FIXUPS:
        text = text.replace(w, p)
    return text

def tts_fish(text, path_m4a):
    body = json.dumps({
        "text": text, "reference_id": FISH_REF, "format": "mp3", "mp3_bitrate": 128,
        "normalize": True, "latency": "normal",
        "temperature": 0.4, "top_p": 0.7,
        "prosody": {"speed": FISH_SPEED, "volume": 0, "normalize_loudness": True},
    }).encode()
    req = urllib.request.Request(
        "https://api.fish.audio/v1/tts", data=body,
        headers={"Authorization": f"Bearer {FISH_KEY}", "Content-Type": "application/json",
                 "User-Agent": "tiao-diao-tutorial/1.0"})
    audio = None
    last_err = None
    import requests as _rq
    headers = dict(req.headers)
    headers.pop("User-agent", None)
    for attempt in range(5):
        try:
            resp = _rq.post("https://api.fish.audio/v1/tts", data=req.data,
                            headers=headers, timeout=(20, 300))
            resp.raise_for_status()
            audio = resp.content
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            hint = {401: "key 无效或过期", 402: "账户余额/额度不足", 503: "服务过载，稍后重试"}.get(e.code, "")
            raise RuntimeError(f"fish TTS HTTP {e.code} {hint}\n{detail}") from e
        except (urllib.error.URLError, http.client.HTTPException, ConnectionError, TimeoutError, OSError) as e:
            # 网络抖动/流被掐断：退避后重发
            last_err = e
            import time
            time.sleep(2 + attempt * 3)
    if audio is None:
        raise RuntimeError(f"fish TTS 网络失败（重试 4 次）：{last_err}")
    if len(audio) < 2000:
        raise RuntimeError(f"fish TTS 返回异常（{len(audio)} 字节）")
    tmp = path_m4a.replace(".m4a", ".src.mp3")
    open(tmp, "wb").write(audio)
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", tmp, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                    "-ar", "44100", "-ac", "1", "-c:a", "aac", path_m4a], check=True)
    os.remove(tmp)

def tts(text, path_m4a, path_aiff):
    text = _apply_pron(text)
    if FISH_KEY:
        if not FISH_REF:
            raise RuntimeError(".env 缺 FISH_AUDIO_REFERENCE_ID（kqb 音色 id）")
        tts_fish(text, path_m4a)
        return
    print("  [未配 fish key，回退系统 say]")
    subprocess.run(["say", "-v", CFG["tts_voice"], "-r", str(CFG["tts_rate"]),
                    "-o", path_aiff, text], check=True)
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", path_aiff,
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                    "-ar", "44100", "-ac", "1", "-c:a", "aac", path_m4a], check=True)

def probe_dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", p], capture_output=True, text=True)
    return float(r.stdout.strip())

# ---------- 主流程 ----------
def main():
    compose_only = "--compose-only" in sys.argv
    scenes = CFG["scenes"]
    shots = {}
    for sc in scenes:
        if sc["type"] == "phone":
            shots[sc["id"]] = load_shot(sc["img"])
        elif sc["type"] == "mock-process":
            mp = os.path.join(BUILD, "process-mock.png")
            if not os.path.exists(mp):
                make_process_mock().save(mp)
            shots[sc["id"]] = Image.open(mp).convert("RGB")

    for i, sc in enumerate(scenes):
        bg = {"phone": lambda s: compose_phone_bg(s, shots[s["id"]]),
              "mock-process": lambda s: compose_phone_bg(s, shots[s["id"]]),
              "intro": compose_intro_bg,
              "outro": compose_outro_bg}[sc["type"]](sc)
        bg.save(os.path.join(BUILD, f"bg_{i:02d}.png"))
        cap = compose_caption(sc)
        cap.save(os.path.join(BUILD, f"cap_{i:02d}.png"))
        still(sc, bg, cap, os.path.join(BUILD, f"still_{i:02d}.png"))

    if compose_only:
        print(f"stills written: {len(scenes)} -> {BUILD}/still_XX.png")
        return

    segs = []
    for i, sc in enumerate(scenes):
        aiff = os.path.join(BUILD, f"vo_{i:02d}.aiff")
        m4a = os.path.join(BUILD, f"vo_{i:02d}.m4a")
        tts(sc["narration"], m4a, aiff)
        ad = probe_dur(m4a)
        dur = max(4.0, round((0.35 + ad + 1.05) * FPS) / FPS)
        N = int(round(dur * FPS))
        seg = os.path.join(BUILD, f"seg_{i:02d}.mp4")
        z1 = zoom_target(sc)
        z0 = zoom_start(z1)
        cx, cy = focus_center(sc)
        zexpr = f"{z0:.4f}+({z1:.4f}-{z0:.4f})*on/{max(N - 1, 1)}"
        vf = (
            f"[0:v]zoompan=z='{zexpr}':"
            f"x='clip({cx:.4f}*iw-iw/zoom/2,0,iw-iw/zoom)':"
            f"y='clip({cy:.4f}*ih-ih/zoom/2,0,ih-ih/zoom)':"
            f"d={N}:s={OW}x{OH}:fps={FPS}[z];"
            f"[1:v]scale={OW}:{OH}[o];"
            f"[z][o]overlay=0:0,fade=t=in:st=0:d=0.25,format=yuv420p[v]"
        )
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
               "-i", os.path.join(BUILD, f"bg_{i:02d}.png"),
               "-i", os.path.join(BUILD, f"cap_{i:02d}.png"),
               "-i", m4a,
               "-filter_complex", vf,
               "-map", "[v]", "-map", "2:a",
               "-af", "adelay=350:all=1,apad",
               "-t", f"{dur:.3f}",
               "-c:v", "libx264", "-preset", "medium", "-crf", "18",
               "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
               seg]
        subprocess.run(cmd, check=True)
        segs.append(seg)
        print(f"scene {i:02d} {sc['id']}: vo={ad:.1f}s seg={dur:.1f}s")

    lst = os.path.join(BUILD, "list.txt")
    with open(lst, "w") as f:
        for s in segs:
            f.write(f"file '{s}'\n")
    final = os.path.join(OUT, "音乐转调-使用教程.mp4")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "concat", "-safe", "0", "-i", lst,
                    "-c", "copy", final], check=True)
    total = probe_dur(final)
    print(f"\n✅ 成片: {final}  时长 {total:.1f}s, 大小 {os.path.getsize(final)/1e6:.1f} MB")

if __name__ == "__main__":
    main()
