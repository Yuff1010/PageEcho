# WhisperX 音频末端对齐修复（0.10.0-dev.6）

日期：2026-10-21（America/New_York）。修复固定影视短片中 CPU 四段、GPU 三段因字符终点超出音频而失败的问题。修复后同一清单两组各完成 18/18，识别输出完整不变。此项验证时间区间和应用流程，人工发音边界与完整听书质量仍待验收。

## 原因与修复

[首轮影视诊断](FILM_REFERENCE.md)保留原失败报告。随后按原配置对所有失败段进行一次带原始输出采集的复验，未修改旧报告、检查点或模型。证据位于 `cache/asr-evaluation/film-failure-diagnostics/`：

- GPU：`2026-10-21T07-46-51.015077+00-00-cuda/report.json`
- CPU：`2026-10-21T07-47-22.136438+00-00-cpu/report.json`

例如实际音频为 1,600 ms，原识别区间为 233–1,617 ms。固定对齐器切片时只读到实际末端，但用声明的 `end - start` 换算帧时间，导致最后一字返回 1,597–1,617 ms，应用据此拒绝生成。另两段音频为 1,728/2,176 ms，识别终点为 1,752/2,191 ms；CPU 的额外一段为 3,136 ms、识别终点 3,153 ms。它们均在原始输出中可复核。

`python/asr_engines.py` 现在按解码采样数计算真实时长，将送入声学对齐的区间终点限定于该时长，再执行对齐。原始识别文字、区间和置信度保留在 `raw.recognition`，实际对齐输入另存于 `raw.alignmentInput`，完整对齐输出继续保存。负数、非数、倒序或完全在音频之外的区间直接失败。返回字符时间仍由原严格校验处理，不做裁剪、拉伸或补造。

WhisperX worker 配置新增 `alignmentAudioBounds: whisperx-decoded-audio-bounds-v1`，与旧缓存隔离。CTC 完整波形目标、插值策略、模型和组件依赖不变；Paraformer 路径不变。已有文稿和纠错继续使用预览/明确采用保护。

## 固定样本复验

完整清单仍为原来的 18 段、55.425 秒、244 个归一化参考字，没有替换失败段。新运行：

- GPU：`cache/asr-evaluation/film-worker-runs/2026-10-21T07-49-16.598Z-whisperx-cuda/report.json`
- CPU：`cache/asr-evaluation/film-worker-runs/2026-10-21T07-50-20.736Z-whisperx-cpu/report.json`

两组均 18/18 完成、首次缓存命中为零、全部块重放与 worker 重启复用通过。`film-summary-bounded-whisper.json` 从原始检查点重建文稿再计分：GPU 为 41/244、CER 16.80%；CPU 为 39/244、CER 15.98%。两者现在都是整个固定集合的结果，不能与旧报告只包含完成段的 CER 当作质量改善对比。此次没有改变识别文字。

`cache/asr-evaluation/film-bounds-comparison.json` 逐段对照旧成功检查点及失败采集记录：CPU/GPU 各 18 份完整 recognition 对象完全一致，各有 12 段的输入终点需按实际音频收束。未收束的六段原始对齐输出也完全一致。所有新字符区间在实际音频内，新旧缓存 key 分开；旧失败材料保留。

两组共 36 份新文稿经现有导出入口及 M2 文稿校验通过。这里的 CER 是短影视片段文字诊断，没有人工发音时间，不能据此确定同步精度、长书质量或默认引擎。

## 实际应用与分发

独立预览为 `cache/preview-builds/2026-10-21T07-51-12.632Z/app`，版本 `0.10.0-dev.6`。新增可选入口 `test:film:app`，在独立用户数据与全新缓存中，使用原来失败的 `chsims-video_0005-0010` 检查真实 UI：选音频、配置组件、选择设备并生成；结果与同设备独立 worker 文稿一致，再检查点句/高亮、正常退出重启、文稿保留及新任务复用缓存。CPU/GPU 两组各通过四个检查，两次退出均为正常退出，截图已核对。

报告位于 `cache/asr-evaluation/film-app-runs/2026-10-21T07-53-12.158Z-cuda/report.json` 和 `2026-10-21T07-54-07.114Z-cpu/report.json`。这两次是应用内实际生成，并非导入现成文稿；没有将短片段结果扩展为整书验收。

```powershell
npm run test:film:app -- "<preview-app>" "<新 worker report.json>"
```

新增四项无模型单元检查覆盖真实末端输入、有效区间原样保留、原识别证据不变、非法区间拒绝，以及无效返回时间继续失败。`npm run check` 的 113 项逻辑、类型、lint 和格式检查通过；`npm run test:worker` 的 9 项协议与 97 项 Python 检查通过。

dev.6 独立预览的完整 36 项桌面回归通过，零跳过、零异常、零不稳定重试，报告为 `cache/asr-evaluation/film-bounds-desktop.json`。两次真实模型应用检查在这 36 项之外单独记录。

独立终态审计为 `cache/asr-evaluation/film-bounds-verification/2026-10-21T07-59-16.331Z-N9Db0N/verification.json`：核对实际报告、完整 recognition 对照、运行入口快照、检查日志、63 份产品源码、8 份新预览输出、9 份分发 ASR 资源及 ZIP 摘要；原 `out` 五份及 dev.5 八份输出未变。

新目录包静态核对通过，见 [预览包验收](PACKAGE_PREVIEW.md)。原 0.8.4 `out` 和 dev.5 预览保留；未运行受限打包 EXE 或 NSIS。人工听审、原文匹配正确率、默认引擎及安装升级/干净设备仍为待办。

## 便携组件的真实长篇回归

同一 dev.6 冻结生产项目复制到中文/空格临时目录后，使用原 0.7.0 独立离线组件对《呐喊》43 分钟原始 MP3 执行 WhisperX GPU 全流程。应用和组件均设为只读，PATH 仅保留 Windows 系统目录，清除 PYTHONHOME/PYTHONPATH，Chromium 及 worker 处于离线模式。没有重建模型组件，也没有运行打包 EXE。

`cache/asr-evaluation/app-runs/2026-10-21T08-03-18.831Z/report.json` 的九阶段通过：部分生成正常退出；同一任务第二次尝试续接并复用一块，最终完成 87 块；完整重放复用 87 块；纠错/明确采用保护；CPU 取消不打断播放；活动任务阻止清理；清理保留文稿；清理后重新生成 87 块且零命中；测试范围标记在重启后保留。三次应用关闭均为正常退出。

权限记录 `cache/asr-runtime-source/readonly-offline-20261021T080313.json` 为 passed，十项实际写入打开得到 AccessDenied，包括本次修改的 `asr_engines.py`；原 ACL 已精确恢复。重新运行的 `runtime-probe-dev6.json` 确认包内 Python 3.12.10、isolated=1、全部 sys.path 和 torch 均在组件内，系统 Python 不参与。完整流程和 ACL 恢复后，`relocated-integrity-dev6-after-asr.json` 再次核对 35,468 个文件、13,427,330,601 字节，全部大小和 SHA-256 与原组件清单一致。

独立审计 `cache/asr-evaluation/portable-dev6-audit/report.json` 重新解码全部 87 个原音频窗口，核对原始模型字符、上下文/归属和完整数据库生成稿：662 个阅读段完全一致。全文件流式解码共 83,004,650 字节 PCM16，即 2,593,895.3125 ms，四舍五入后为任务范围 2,593,895 ms；容器元数据为 2,593,959 ms，未将两种时长混为一谈。这份长篇的识别输入均在实际解码范围内，收束数量为零；它补充便携兼容和长篇处理证据，末端修复本身由前面的短片段复验覆盖。

本轮保留 15 个 `BOUNDARY_CONTEXT_UNRESOLVED`、40 个 `BOUNDARY_CONFLICT`、3 个 `BOUNDARY_REPEAT_DEDUPLICATED`、3 个 `BOUNDARY_TEXT_RECOVERED`。未把这些标记删掉或当作识别/同步质量通过；测试中给首句添加的“广告”标记仅验证保存机制，不是真实广告标注。该结果不能替代人工听审、安装版或干净 Windows 设备验收。

复验入口支持显式冻结项目目录，并复制其中生产依赖；普通默认入口仍保留旧构建使用方式：

```powershell
./tests/model/readonly-offline.ps1 -Component '<已登记的本任务临时组件/component.json>' -Engine whisperx -Audio '<原始 MP3>' -AppRoot '<pack:preview 生成的 project 目录>'
```

只对本任务登记且位于临时目录的组件施加测试 ACL，恢复记录在运行前保存；没有更改系统安全策略。

本轮终态审计为 `cache/asr-runtime-source/dev6-portable-verification/2026-10-21T08-16-56.224Z-Cd0ZmX/verification.json`。实际运行与快照、87 块/数据库重建、组件全量摘要、权限恢复和隔离 Python 证据已关联核对；产品 63 份源码、8 份预览输出、原 `out` 五份、九份 ASR 资源及既有 dev.6 ZIP 未改变。测试入口的类型/lint/113 项逻辑和格式检查通过，两份实际应用截图已检查；产品版本仍为 dev.6。
