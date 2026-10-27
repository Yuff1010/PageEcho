# 实际中文有声书验收（0.8.2）

日期：2026-10-20（America/New_York）。本轮补充真实 MP3/M4B 播放和长篇转写，并修复长章节暴露的重复标点。人工听审、实际 M4A、整书持续收听及主程序安装验收仍未完成。

0.8.3 后续已定位并修正下文的 CTC 前缀评分问题，见 [完整波形评分验收](CTC_ALIGNMENT.md)。以下 0.8.1/0.8.2 的原报告和质量限制保留，不覆盖失败证据。

0.8.4 后续补齐两份原始 AAC LC M4A、远距离重启恢复与 M4A→MP3→M4B 自然连播，见 [M4A 验收](M4A_VALIDATION.md)。后续完整 50 分钟 M4A 与 4 小时 38 分钟 M4B 已完成自然播放、切集和暂停重启，两轮独立审计均通过，见 [整书记录](LONG_PLAYBACK.md)。本页的 0.8.2 待验收项保留其历史范围；人工质量和安装/干净设备仍未完成。

## 来源与输入

使用鲁迅《呐喊》，Jing Li 中文朗读，LibriVox 2012 年发布。目录与原文件信息来自 [LibriVox](https://librivox.org/call-to-arms-by-xun-lu/)、[Archive 发布页](https://archive.org/details/call_to_arms_jl_librivox)和[文件元数据](https://archive.org/metadata/call_to_arms_jl_librivox)。发布页标记 Public Domain Mark 1.0；LibriVox 的公版说明针对美国。

`python -B -X utf8 python/prepare_audiobook_samples.py --download --ffprobe <路径>` 显式下载固定原文件，先核对发布方 size/SHA-1/MD5，再保存 SHA-256 和 ffprobe 结果。不转码、改后缀或以合成文件代替实际格式。媒体和运行报告位于 Git 忽略的 `cache/asr-evaluation/audiobook-source/`，不进入应用包。

| 原文件                           | 内容              | 容器时长     | 编码与章节                             |
| -------------------------------- | ----------------- | ------------ | -------------------------------------- |
| `calltoarms_01_lu.mp3`           | 自序              | 11:35.798    | MP3，单声道 44.1 kHz                   |
| `calltoarms_06_lu.mp3`           | 一件小事          | 04:22.949    | MP3，单声道 44.1 kHz                   |
| `calltoarms_10_lu.mp3`           | 阿Q正传，第一部分 | 43:13.959    | MP3，单声道 44.1 kHz                   |
| `chinesecallToArms_librivox.m4b` | 整书              | 04:38:17.446 | AAC LC，单声道 44.1 kHz；16 个内嵌章节 |

长 MP3 的 SHA-256 为 `e2e1c7a405ddee08e50666d5dabc9b54d13ce169f528e2fb5d99a74b73e3119d`；M4B 为 `3c8be8bde1cf196f2830102fc9f4f5edae14b512d0e2e017ceac4e8600f216f6`。全部摘要、发布方信息与探测结果在 `manifest.json`，可重复核对。

## 真实播放

`npm run test:audiobook` 使用隔离用户目录和原文件的副本，只替换原生选择器返回值。实际 Electron、媒体协议、HTMLAudioElement、IPC 和 SQLite 均运行，没有替换媒体时间或触发虚构 EOF。

0.8.1 的播放报告 `cache/asr-evaluation/audiobook-playback/2026-10-20T08-14-52.979Z/report.json` 通过：

- 四个文件逐一解码，在 0.75、1.5、2 倍速分别定位到 5%、50%、95% 并继续播放。
- 短篇从头以 1 倍速自然播完，真实 `ended` 后自动进入 M4B，继续到 10.123 秒；总观察约 273.2 秒。
- 关闭隐藏约 30 秒，原生窗口确认为不可见；恢复后显式退出，重启恢复 M4B 和位置并保持暂停。
- 533 次媒体观察没有超过 1.5 秒的未观察间隔，没有采样到持续的媒体时钟停顿；同应用无活动转写时 IPC p95 约 0.6 ms。该项没有证明声音听感或同应用推理时的性能。
- 原文件大小、修改时间和 SHA-256 均未变化；截图 `natural-transition.png` 已检查。

M4B 当前作为单集播放；ffprobe 能读取 16 个章节，不表示已实现章节导入。未连续播放完整 4 小时 38 分钟，不将短篇连播当作整书稳定性结论。0.8.2 的产品变更仅涉及转写标点链；上述播放证据保留其实际版本。

## 长篇转写与标点修复

0.8.1 对 43 分钟 MP3 的完整应用流程通过，报告 `cache/asr-evaluation/app-runs/2026-10-20T08-17-23.035Z/report.json`。但检查真实文稿发现 `，，`、`。。`：Paraformer 已输出标点，任务层又调用 CTPunc，CTC 重新对齐路径保留的原标点被补了第二遍。

0.8.2 对已有标点的模型结果只保留一层原始标点；Paraformer 原生时间有效时将标点放回原时间锚点，原生无效时仍使用严格 CTC 对齐。WhisperX 已有句读时保留原结果，未标点的窗口才补标点。没有按书名或小说原文改写识别文字。

缓存配置加入 `punctuationPolicy: engine-surface-once-v1`，旧配置不能命中新处理缓存；已有文稿仍由原有预览/采用流程保护。代码随应用分发，独立 0.7.0 组件包不需改写。

只读审计工具 `python/audit_audiobook_run.py` 检查实际数据库、音频摘要、87 块完成和缓存复用/清理，并比较每块归属文字与引擎原始文字。比较仅做 NFKC、大小写与空白归一化，保留标点；输出必须是原始识别结果的连续子串。它验证处理链没有重复插入标点，不验证声音识别准确率。0.8.1 基线有 81/87 块不满足该条件，报告 `cache/asr-evaluation/audiobook-source/long-before-0.8.1.json`；失败证据保留。

0.8.2 复测 `cache/asr-evaluation/app-runs/2026-10-20T08-40-44.538Z/report.json` 的九个应用阶段全部通过。审计 `cache/asr-evaluation/audiobook-source/long-after-0.8.2.json` 通过：87/87 块满足原始标点条件，末次零缓存命中生成 878 个阅读段，覆盖到 2,593,895 ms；不是已有纠错稿的段数。第一次退出后同任务 attempt 2 命中 1 块，再次生成命中 87 块，清理后重新生成命中 0 块。取消 CPU 任务时普通播放保留，测试范围标记在纠错、重生成、缓存清理和重启后保留；该范围只是人工测试标记，不代表广告识别。`app.png` 已检查，重复句读消失，模型词语错误仍原样显示。

长 MP3 的容器时长为 2,593,959.184 ms；HTML 媒体时长为 2,593,895.329 ms。独立流式解码数得 83,004,650 字节的单声道 16 kHz PCM16，即 2,593,895.3125 ms，与播放器相差不足 0.017 ms，见 `mp3-duration-audit.json`。转写范围使用播放器时长四舍五入后的 `[0, 2593895]`，无需补齐容器填充的约 64 ms。

## M4B 四小时位置与待复核的对齐

0.8.2 的 `cache/asr-evaluation/worker-runs/2026-10-20T08-45-17.398Z/report.json` 使用原始 M4B 的 `[14400000, 14460000]`，即 04:00:00–04:01:00，WhisperX GPU 实际生成两个 30 秒块。完成、两块重放、worker 重启复用及取消通过；文稿通过 M2 音频哈希/范围校验。`source-1.desktop.json` 记录原 M4B 播放、生成稿导入、原时间轴点句跳转、高亮和重启复用通过，截图已检查。只生成一分钟，不代表整书转写。

该任务从 worker ready 后提交到完整结果约 20.30 秒，首个块约 15.55 秒，缓存重放约 223 ms；包含此次延迟加载，不是应用点击到可读文字的全路径延迟，也没有同时运行其他 GPU 模型。

**同步质量仍需排查。** 原识别第一段跨度为 0.031–28.972 秒，CTC 却将其 113 个字压到 0.031–3.954 秒；第二块也有相似压缩。原始字符都有数值时间，因此格式检查不能检出这类问题。诊断 `cache/asr-evaluation/audiobook-source/alignment-review-0.8.2.json` 保留跨度、字密度和输入摘要，标为 `needs-human-boundary-review`。两组模型输出都不是人工边界参考，未据此计算真实误差、裁剪时间或将这个样本判为同步质量通过。下一步先核查解码/CTC 对齐链并听审这段，再讨论引擎选择。

## 回归与资源

0.8.2 完整自动检查报告为 `cache/verification/2026-10-20T08-34-16-946Z/report.json`：TypeScript、ESLint、Prettier、57 项基础单元/模块、9 项 Node 协议和 38 项 Python 检查全部通过，开发窗口、生产构建及 29 项源码桌面测试通过。新增检查覆盖原生标点和大写 Q 的时间锚点保留，以及已带标点结果不再进入第二次标点模型、缓存重放一致。

同一 AISHELL-4 清单的两个 GPU worker 各 15/15 完成，重放及 worker 重启复用通过；Paraformer 37/610（6.07%）、WhisperX 103/610（16.89%）参考字错误，与 0.8.1 相同。汇总工具从实际文稿重新计算，报告 `cache/asr-evaluation/audiobook-source/reference-regression-0.8.2.json`；本轮这些数字只对应 GPU worker，0.8.1 CPU/适配器结果保留原版本。Paraformer 有 10 段使用 CTC 重新对齐，不隐去复核标记。

`electron-builder --win --x64 --dir` 仅生成并核对资源，报告 `cache/asr-runtime-source/package-0.8.2.json`：版本正确，5 个 out 文件与构建一致，8 个 ASR 资源与源码一致，无私有媒体/模型/缓存目录。没有运行打包 EXE 或 NSIS；没有可用的 0.8.2 主程序安装包。

## 重复运行

先准备本机组件配置路径和上面的原文件清单；以下检查独立于普通 CI，不自动下载模型：

```powershell
npm run test:audiobook
npm run asr:app -- --component "<component.json>" --audio "cache/asr-evaluation/audiobook-source/calltoarms_10_lu.mp3" --engine paraformer --isolated-runtime --offline-ui
python -B -X utf8 python/audit_audiobook_run.py --app-report "<新的应用运行目录>/report.json" --output "<新的审计报告.json>"
npm run asr:worker -- --component "<component.json>" --manifest "cache/asr-evaluation/audiobook-source/m4b-worker-input.json" --engine whisperx --isolated-runtime
npm run asr:validate -- "<新的 worker 运行目录>"
npm run asr:desktop -- "<新的 worker 运行目录>" source-1
```

远距离片段清单的 `tools.ffmpeg`/`tools.ffprobe` 和 `samples[].sourcePath` 需指向本机真实路径，音频哈希及范围保持原值；不要把本机路径提交到仓库。播放器测试默认读取准备好的 `manifest.json`。长篇审计另需已核对的 `mp3-duration-audit.json`；它是上述原始长 MP3 的独立解码计数，不能套用到其他文件。

## 验收边界

- 目录标题和出版文字不是逐字听审参考。识别文稿仍出现“阿贵”等专名问题；未计算有声书 CER，也未据此选定默认引擎。
- AISHELL-4 的 15 段人工参考属于远场会议诊断，不能代表长篇干声、角色对话、广告或所有听书质量。
- 实际 M4A、整书持续收听、人工时间边界与跨块漏字/重复检查继续保留。没有以更换后缀填补格式验收。
- 主程序 EXE/NSIS 仍受本机系统策略限制；仅核对应用资源，未宣称安装版或干净设备通过。
