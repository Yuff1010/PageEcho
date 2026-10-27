# 连续多窗口人工参考评估

日期：2026-10-20（America/New_York）。本轮补充 0.8.4 的评估工具和参考数据，产品运行代码、声学模型及打包资源未变化。两引擎的 CPU/GPU 均完成三段连续音频，并用人工转录验证拼接效果；默认引擎仍未确定。

## 固定样本与参考完整性

沿用 [人工参考基线](HUMAN_REFERENCE_BASELINE.md)的 AISHELL-4 固定录音 `S_R004S03C01`、revision `aada72727856313b19d4a030383c426364931dbf` 和原始 TextGrid。选择只依据标注、先于本次识别结果：先取最早合格单人段，再取不相交的最早多人轮流讲话段，再取另一位说话人的最早不相交单人段。

合格范围为 90–120 秒、至少 180 个规范化字，无重叠/不完整话轮或其他不确定标记；只移除显式 `<sil>`，保留“嗯、呃”等口语。至少两个 30 秒切分点位于标注话轮内部且离端点超过 250 ms。该条件不是逐字发音边界标注，也不能证明切口瞬间一定在发声。

| 样本           | 原录音范围（ms） | 时长      | 说话人       | 话轮 / 参考字 |
| -------------- | ---------------- | --------- | ------------ | ------------- |
| solo-first     | 92502–189679     | 97.177 秒 | 001-M        | 8 / 318       |
| dialogue-first | 273664–367619    | 93.955 秒 | 001-M、004-F | 8 / 391       |
| solo-other     | 824618–921908    | 97.290 秒 | 003-F        | 9 / 303       |

合计 288.422 秒、25 话轮、1012 字，每段四个模型处理块，共 9 个内部切分点。对话标签来自人工标注，没有实现或声称模型说话人识别。音频只取原连续范围的声道 0 并转为单声道 PCM16/16 kHz，没有拼接、插入静音或降噪。测试媒体是有独立内容哈希的派生 WAV，媒体时间从零开始，原录音偏移另存，不冒充整份原录音的播放位置测试。

参考清单 `cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json` 在模型运行前固定，SHA-256 为 `83e892faf6b4c426ad4ddde0211451bdf5eacbb1eb62c9b94468215f2be10896`，运行后保持一致。验证器重新解析固定源标注、重算选择和全部参考时间/文字，再核对音频哈希及样本数。

`cache/asr-evaluation/continuous-reference-audit/integrity.json` 另验证七种篡改均被拒绝：参考文字、人工端点、源偏移、音频哈希、说话人、缺失样本和标注版本。三段 WAV 的 PCM 数据也与第二次从固定原文件按对应范围解码的字节完全相同。

## 实际模型结果

最终汇总 `cache/asr-evaluation/continuous-reference-summary-final.json` 从实际文稿和 checkpoint 重算；四组均为 3/3 完成、每段缓存重放 4/4、worker 重启复用通过。每段首次运行命中零块。

| 引擎       | 设备     | 现行拼接：编辑距离 / CER | 同一识别窗口的旧规则回放 | 跨切口话轮：现行 / 旧规则       |
| ---------- | -------- | ------------------------ | ------------------------ | ------------------------------- |
| Paraformer | GPU      | 85/1012，8.40%           | 86/1012，8.50%           | 39/424，9.20% / 40/424，9.43%   |
| Paraformer | CPU      | 84/1012，8.30%           | 85/1012，8.40%           | 37/424，8.73% / 38/424，8.96%   |
| WhisperX   | GPU      | 191/1012，18.87%         | 192/1012，18.97%         | 79/424，18.63% / 80/424，18.87% |
| WhisperX   | CPU int8 | 189/1012，18.68%         | 190/1012，18.77%         | 79/424，18.63% / 80/424，18.87% |

每组各减少一个编辑错误。Paraformer 补回了参考中的“糕”，WhisperX 补回了参考中的“这”；CPU/GPU 分别得到同样的对应恢复。旧规则回放只改变归属/去重方式，使用完全相同的当前识别窗口，没有另跑旧模型，因而不是依靠推理结果偶然变化来比较。

CER 使用 NFKC、大小写归一化、仅字母和数字，不做数字读法转换。跨切口话轮统计包含跨越九个切口的**完整九个话轮**，共 424 字；通过整段最小编辑路径分配错误，多个切口若落在同一话轮只计一次。并非切口附近几毫秒的误差，也没有给人工文字均分时间。路径并列时依次优先替换、删除、插入，插入归到后方参考字符，EOF 归末话轮。失败/缺样本时不能给出完整队列 CER，未完成参考不会当成零错误。

这三段来自同一场已经使用过的远场会议，训练数据重合未知，不能代表干声演播、广告、重叠说话或所有有声书；也不是官方全语料成绩。此集合中 Paraformer 的错误较少，但不据此批准完整听书质量或设置默认引擎。

后续 [话轮端点审计](UTTERANCE_TIMING.md)复用这些实际缓存：Paraformer CPU/GPU 各仅 4/25 个话轮全文唯一匹配，WhisperX 均无匹配，四组共同集合为空。端点数值只描述该条件子集，不是整体同步成绩，也未补齐人工音素边界。

## 时延与桌面验证

从 worker ready 后提交计时，首次可读前缀的 GPU 观察约 15.46 秒（Paraformer）、15.43 秒（WhisperX），CPU 约 18.97/23.57 秒，包含本次延迟模型加载。相同 worker 的后续片段首前缀约为 GPU 0.28–0.30 / 0.86–0.88 秒、CPU 0.85–0.88 / 9.03–9.07 秒。完整生成耗时另存逐样本报告；这些数值不是应用点击到文字的端到端延迟，没有用它们替代原应用边听边处理基线。

四组原始运行位于 `cache/asr-evaluation/continuous-worker-runs/`：

- `2026-10-20T09-48-19.521Z-paraformer-cuda`
- `2026-10-20T09-49-23.187Z-whisperx-cuda`
- `2026-10-20T09-53-26.755Z-paraformer-cpu`
- `2026-10-20T09-55-30.731Z-whisperx-cpu`

每组 `desktop-input/transcript-validation.json` 共 12 份文稿通过 M2 内容哈希、时间范围和覆盖检查。两个 GPU 对话样本又通过实际播放、导入、点句跳转、高亮及重启复用，结果为同目录 `continuous-dialogue-first.desktop.json`，截图已检查。这验证媒体/文稿流程，不是人工声音同步准确率。

初次校验适配误用了上级目录的文稿引用，被路径保护拒绝；已改为目录内的同内容副本后重验通过，原拒绝记录保存在 `transcript-validation-initial-path-error.json`。没有修改校验规则。

本轮 `npm run check` 和 `npm run test:worker` 通过 TypeScript、lint、格式、57 项基础单元/模块、9 项 Node 协议、56 项 Python，共 122 项逻辑/模块检查。新增七项覆盖选择、重叠/不完整标注、话轮内部切口、口语/标记及逐话轮错误分配。没有重跑全部产品桌面场景；0.8.4 原 29 场景报告保持其原范围。

## 书中待复核音频

原书 13:30、20:00、38:00 处没有明确共同上下文。`cache/asr-evaluation/overlap-review/2026-10-20T09-57-14Z/manifest.json` 提供三段各 8 秒的原音频摘录、原时间、片内第 4 秒切口及左右完整识别上下文。摘录不是新人工参考，`humanReference` 仍为空；原文稿保留待复核标记，不选择一个模型版本冒充听审结果。

## 重复运行

先准备已有固定源数据及本机组件路径。参考媒体、模型输出和摘录均在忽略目录，普通 CI 不下载模型：

```powershell
python -B -X utf8 python/continuous_reference.py --ffmpeg "<ffmpeg.exe>" --ffprobe "<ffprobe.exe>"
npm run asr:reference -- --component "<component.json>" --engine paraformer --continuous
npm run asr:reference -- --component "<component.json>" --engine whisperx --continuous
# CPU 使用相同参数再加 --cpu
python -B -X utf8 python/continuous_summary.py "<运行目录>/report.json" --output "<汇总.json>"
python -B -X utf8 python/export_overlap_review.py --component "<component.json>" --overlap-report "<实际长篇切口审计.json>"
```

已有参考清单只验证、不重写时间/文字或准备时间，便于固定实验身份。主程序仍为 0.8.4；后续已补充 [实际 M4A](M4A_VALIDATION.md)，主程序安装版、干净设备和人工发音时间精度继续保留。
