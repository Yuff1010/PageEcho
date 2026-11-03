# 字幕质量回归

当前入口 `npm run quality:compare` 对同一批公开人工参考重算并逐组比较，读取原生 worker checkpoint，不加载模型。它先独立审计历史基线，再验证本次报告、音频和文稿。缺数据、验证失败或样本未完成时不会给出整批 CER。

## 固定范围与本轮结果

0.40.0-dev.1 使用 `PageEcho-ASR-0.8.0-sec.1-win-x64`，两引擎分别执行 CPU／CUDA。CPU 指通用组件中的 CPU 执行，本轮没有测 CPU 专用发行包。三个参考集各四组，共 12 个配置、244 个样本结果；每个配置使用独立新缓存，随后核对缓存重放及 worker 重启复用。

| 参考集             | 样本／规范化参考字 | Paraformer CPU／CUDA | WhisperX CPU／CUDA       |
| ------------------ | ------------------ | -------------------- | ------------------------ |
| AISHELL-3 干声     | 40／267            | 5／5，1.87%／1.87%   | 116／117，43.45%／43.82% |
| AISHELL-4 连续语音 | 3／1012            | 84／85，8.30%／8.40% | 189／191，18.68%／18.87% |
| CH-SIMS 影视片段   | 18／244            | 24／24，9.84%／9.84% | 39／41，15.98%／16.80%   |

表中数值是编辑错误数与 CER；每行的 CPU／CUDA 保持原参考集分母。12 组错误数均与历史基线相同。连续语音使用实际拼接结果 `actual`，不用旧规则回放或跨切口小子集替代。任何一组增加都会单独报告，其他组改善不能抵消。

这只证明本轮固定材料上未观察到文字回归。WhisperX 干声错误率仍高，不能因此确定默认引擎。未知训练重合、真实小说角色／专名／广告、人工发音边界和长单集质量均不在该结果内。真实小说 12 个固定听审切点仍为 0/12 人工完成，见 [人工听审](LISTENING_REVIEW.md)；不得把自动流程通过算成人工验收。

## 复跑

准备材料、归属和固定版本沿用 [干声](STUDIO_REFERENCE.md)、[连续语音](CONTINUOUS_REFERENCE.md)、[影视](FILM_REFERENCE.md)。源音频、人工参考正文、模型、运行报告和 checkpoint 都保留本机，不随源码提交。首次准备按各文档显式下载，普通 CI 不下载模型或数据。历史基线完整性依赖这些原材料及原报告；缺失时应恢复相同材料，不能换参考集、复制成绩或重新写历史快照。

```powershell
# 显式指定本地组件；设备／引擎各跑一组，依次执行，CPU 加 --cpu。
npm.cmd run asr:reference -- --component '<组件>/component.json' --engine paraformer --studio
npm.cmd run asr:reference -- --component '<组件>/component.json' --engine paraformer --continuous
npm.cmd run asr:reference -- --component '<组件>/component.json' --engine paraformer --film '<固定影视manifest.json>'
# 再运行 whisperx，并对两引擎各运行上述 CPU 组合，共 12 组。

# 本地 JSON 数组列出这 12 份 report.json；相对路径以列表文件所在目录为准。
npm.cmd run quality:compare -- --report-list '<当前报告列表.json>' --ffmpeg '<ffmpeg.exe绝对路径>' --ffprobe '<ffprobe.exe绝对路径>' --output '<不存在的新比较.json>'
```

`--ffmpeg`／`--ffprobe` 必须成对：仅允许替换干声清单中已移动的工具位置，并要求工具字节 SHA-256 与原清单完全一致。没有替换参数时仍严格使用原位置；不会改清单、重采样参数或参考正文。

输出保留基线／报告／计分源码摘要、各组分母、失败信息和原指标。退出码 `0` 表示完整且没有逐组增加，`1` 表示完整但至少一组 CER 增加，`2` 表示证据不完整或验证失败。输出文件已存在时拒绝覆盖；基础输入或历史审计失败在 stderr 输出错误并退出 2，不产生完整成绩。`qualityAcceptance` 始终为 `not-determined`。

## 本轮证据与修复

首次矩阵的四组干声在推理前因原临时 FFmpeg 路径不存在而失败，另八组完成。原清单和失败矩阵保留。核对替代工具 SHA 完全相同后，四组干声用明确记录的临时适配入口重新跑完，随后将同样的严格位置替换支持加入正式入口；不是挑选多次推理中的最好结果。

评分入口另修复两项兼容：从只读 v1／v2 诊断配置确定真实缓存位置；分别从 checkpoint 严格重构历史序号 ID 文稿和当前稳定 ID 文稿，保存文稿必须与其中一个整体完全相同，内容、时间、覆盖及 warnings 不放宽。顶层引擎／设备必须与 checkpoint 配置一致，工具子进程失败归为不完整。

- 首次矩阵与最终 12 报告索引：`cache/quality-regression/2026-11-03T03-44-57.312Z/`。
- 四组干声补跑：`cache/quality-regression/2026-11-03T03-53-35.740Z/matrix.json`。
- 适配入口来源：`cache/quality-regression/studio-adaptation-provenance.json`；推理前后不可变输入核对：首个目录的 `pre-edit-integrity.json`。
- 最终比较及验证：`cache/quality-regression/final-validation/`，原始失败和中间比较分别保留。

本轮没有修改 worker、模型、参考归一化、匹配阈值或历史基线，也未以此宣称 Torch／Transformers 框架迁移完成。安全边界继续见 [依赖安全](DEPENDENCY_SECURITY.md)。
