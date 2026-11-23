# Handoff: 口播推荐视频精剪版验收与发布物料

> 来源：把用户父亲（亢铨宝）的 4:22 口播原素材剪成「完整版 + 3 切片」推荐视频，已完成粗剪 v1→v2→精剪 v3 三轮，v3 待用户验收 · 生成于 2026-11-13 14:24

## 🎯 下个会话要做什么

接收用户对 **精剪 v3**（`tools/promo/out/*精剪*`，4 条视频 + 4 张封面，已交付待看片）的反馈并继续调整；反馈收敛后大概率进入**发布环节**（视频号/抖音标题、简介、Tags、定时发布——参考 koubo-edit skill 的发布章节）。若用户看了片又提新修改点，全部走 `tools/promo/roughcut.py` 一键重建，单条 1 分钟内出。

## 🧠 必读上下文（不可重建，重点中的重点）

**用户的硬约束与偏好（违者返工）：**
- 观众是中老年：口播**全程 1.0x 原速不许加速**；字幕要大、少、高对比（白底色块被骂「突兀」，现在是底部渐变压暗+白字黑描边+亮绿/黄重点词）
- 素材卡（上 1/3 白墙区）**必须与当句口播内容严格对应**；说反面教材（收费/绑卡/被扣钱）时**绝不放自家产品图**
- 只教核心闭环（选歌→调调→试听→开始转调→发回微信），登录/我的页等非必需功能不进教程
- 程序在快速迭代（现为 v0.3.3：试听 3 分钟、解锁页三档「限时免费·关注亢铨宝视频号/额度下载/包月」、PAY_ENABLED=true）→ **视频里任何界面素材必须与当前代码同步**，截图用 `tools/promo/shots-promo.js`（automator）重截
- 防坑切片 = **完整故事版**（机票踩坑 46 秒全保留，结尾才亮免费）；完整版则浓缩踩坑为两句——两种口径是用户分别确认过的，别混
- 博主口误/口水要剪，但「自我剖析/方言口癖」保留原意只删重复

**关键决策与理由：**
- 旁白/字幕的高亮逻辑与「调调」读音：视频里所有界面素材来自 automator 真截图（`tools/autotest/shots/`），不用手绘 mock（v1 手绘 mock 被现实打脸：程序改版后 mock 全过时）
- 剪点用 `words.json` 词级时间戳定位；边界遵循 koubo 规则：**剪除区间起点=排除词起点（=保留词词尾），终点=下一个保留词起点前**——曾吞掉「要」字尾 20ms、把「事儿」削 20ms，按此规则修掉
- 精剪 v3 重构为「基础保留区间 − 剪除区间」自动分段（subtract 函数）：v2 手写 piece 列表出过**区间重叠 bug**（「实在没办法，答应了朋友的事」重复播两遍，1.9s），是成片音轨重转写自检抓出来的——**每次改剪点必须做成片重转写连贯性自检**（koubo 惯例，已两次救场）
- 能量检测能抓到词表漏记的语癖：v3 剪掉了「措手不及**说是**所以」里的「说是」（words.json 没有它，silencedetect -30dB 发现 112.39~112.61 有人声）

**已排除的死胡同（别再试）：**
- py3.15 装 `av` 编译失败 → faster-whisper 必须 `/opt/homebrew/bin/python3.11` venv（`tools/promo/.venv`）
- HF 直连 Connection refused → `HF_ENDPOINT=https://hf-mirror.com`
- `tools/autotest/shots/` 里 4 个 65747 字节文件互为首页重复截图；`pitch-with-song.png` 曾是旧版 UI——**用截图前先看 mtime 和内容**，界面素材一律以 `shots-promo.js` 最新产物为准
- ffmpeg subprocess（无 shell）下 `enable='...'` 单引号与 `\,` 转义都能过，真正的坑是 overlay 链 label 重复包方括号（`[[v0]]`）——报「Trailing garbage after a filter」就查这个
- fish TTS：Flo/Eddy 等 zh_CN 新音色读中文输出 0.01s 空音频；长音频 chunked 响应会 IncompleteRead（`http.client.HTTPException`，不是 OSError）→ 已换 requests + 5 次重试（这套在 `tools/tutorial/build.py`，教程视频旁白用；**promo 管线不用 TTS**，用 faster-whisper 反向转写）
- 完整版曾把「机票坑」剪到只剩两句——那是**完整版**的口径；切片2 的完整故事口径已确认，别「优化」回去

## 📍 当前状态

- v3 精剪 4 条已交付（完整版 3:48 / 切片1 痛点 36s / 切片2 防坑故事 2:00 / 切片3 亲情 76s）+ 同名封面 jpg，**用户尚未反馈验收**
- 已验证：两个关键剪区成片音轨重转写连贯（前情段不吞字、「说是」语癖消失）；抽帧确认字幕样式/素材卡/插片/尾卡
- 自检中修掉：完整版 EDL 区间重叠（重复播 1.9s）、「说是」漏词、零长剪切（tok tol 过宽匹配到第一个「我」）
- automator IDE 会话可能还挂着（`cli auto --auto-port 9420`）；git 有大量未提交改动（miniprogram v0.3.3 代码 + 本管线产物），未 commit——是否提交由用户定
- 管线可复用：改 `roughcut.py` 里 EDL（base/cues/cards/removals）→ `rm -rf build/<条目名>` → 重跑，改动的段才重渲染

## 📎 相关文件（只引用，不复制内容）

- `tools/promo/roughcut.py` — 精剪管线全部逻辑：CUTS（词级剪除）、PAUSE_REMOVALS（气口收紧）、EDL（FULL/S1/S2/S3 的 base/cues/cards/cover）、subtract、渲染
- `tools/promo/words.json` / `transcript.txt` — 词级/句级转写（faster-whisper small，`transcribe.py`）
- `tools/promo/剪辑方案-定稿.md` — 结构、钩子、标题候选、素材插入点位、用户确认口径
- `tools/promo/shots-promo.js` — automator 重截当前版 UI（3 分钟试听态/三档解锁/处理中/结果页）
- `tools/autotest/shots/` — 素材截图（unlock-tiers/pitch-preview/result 等为 11-13 最新）
- `tools/tutorial/` — 教程视频管线（另一条线，fish kqb 旁白；key 在 `tools/tutorial/.env`，已 gitignore，**勿提交勿外泄**）
- 记忆：`promo-video-pipeline.md`、`tiao-diao-tutorial-video-pipeline.md`、`wechat-channels-embed-research.md`（视频号发布/内嵌结论）
- 参考剪辑 skill：`/Users/kongkang/Developer/koubo/.claude/skills/koubo-edit/SKILL.md`（切点边界规则、观众三问、视频号/抖音发布实测章节）

## 🛠 建议先调用的 skills

- 无需开场 skill。进入发布环节时再读 koubo-edit 的「视频号存草稿/定时发表」「抖音定时发布」章节（路径见上，本项目未注册成 skill，直接读文件照做）

## 🚀 启动指令

"读 docs/handoff/handoff-2026-11-13-1424-promo-video-finecut.md，按里面的上下文继续：我看完精剪版了，反馈如下：<逐条说修改点或'可以，做发布物料'>。"
