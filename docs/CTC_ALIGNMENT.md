# CTC 完整波形路径评分（0.8.3）

日期：2026-10-20（America/New_York）。本次修复《呐喊》M4B 四小时片段中出现的长句时间压缩。它修正固定 CTC 搜索的目标函数，不代表已完成人工同步质量验收或选定默认引擎。

后续 0.8.4 已检查这些切分点并修复归属丢字/真实叠字误去重，见 [窗口拼接验收](ASR_OVERLAP.md)。下文保留 0.8.3 的原始 CTC 结果与边界记录；CTC 目标函数和声学模型没有因拼接修复而改变。

## 可复现的问题

0.8.2 的真实 WhisperX worker 将一段 113 字、原识别跨度 0.031–28.972 秒的文字对齐到 0.031–3.954 秒；第二块的约 27 秒长句也被压到不足 4 秒。字符都有数值时间，文稿格式、点句跳转和重启检查因此通过，声音同步质量仍未通过。输入、旧报告和范围在 [有声书验收](AUDIOBOOK_VALIDATION.md)中保留。

解码检查确认单声道 16 kHz、32 秒窗口；模型规定的特征提取归一化也没有消除压缩。受控试验复用同一份识别文字、原音频及模型，记录原输入、特征提取输入和完整波形评分三种结果，见 `cache/asr-evaluation/ctc-diagnostics/2026-10-20T08-53-09Z/report.json`。该试验没有把另一模型的输出当作人工真值。

整理后的诊断工具也已用组件 Python 直接执行，最终对照 `cache/asr-evaluation/ctc-diagnostics/2026-10-20T09-12-07Z/report.json` 为 compared，记录工具摘要和最终 `ctc-complete-waveform-logodds-v1` 契约；原输入/特征提取仍压缩，完整波形路径与最终 worker 一致。前一试验报告保留作为诊断历史。

固定 WhisperX 3.8.6 的 [alignment.py](https://github.com/m-bain/whisperX/blob/v3.8.6/whisperx/alignment.py) 在 `backtrack` 中以终列前缀累计分数的最大值选择结束位置，未计入结束位置之后的 blank 代价。下载的标签源码与组件文件逐字节一致：21,696 字节，SHA-256 `cc3607dcc25e592ae218f74a6ca644d6ce1c77d9cee4672f01c751da8feb9aa7`，核对记录 `cache/asr-evaluation/ctc-diagnostics/source-integrity.json`。输入归一化与通配字符行为另有问题空间，本次没有以这些猜测替代实测原因。

## 处理方式与证明边界

设原搜索图中 `S(t,k)` 是前 t 帧、k 个字符的最佳前缀分数，`B(t)` 是前 t 帧 blank 对数概率之和。一个在 t 处完成的路径，其完整波形分数为：

```text
S(t,K) + B(T) - B(t)
```

`B(T)` 对所有候选结束位置相同，因此比较 `S(t,K) - B(t)` 就能包含尾部代价。实现只在搜索矩阵中使用逐帧的 `log P(token) - log P(blank)`，blank 转移得分为零；这样直接构建相对分数，避免长序列累计后再相减导致的浮点抵消。回溯每一步比较的两个前驱仍减去同一个基线，原回溯规则和原始概率保留。

这是固定原搜索图中的完整波形最优路径，不是对所有 CTC 算法或真实发音边界的质量证明。没有按字数均分、拉伸或裁剪返回时间，也没有强迫最后一字到音频结尾。模型原始 emission 和识别文字保持不变。

`python/asr_ctc.py` 只给调用方复制的 `align` 函数绑定私有 `get_trellis`，原模块、原 helper、模型、组件文件和其他调用方不变。版本和文件摘要均与已验证的 3.8.6 一致才启用；其他实现拒绝静默套用。新兼容逻辑随应用分发，原 0.7.0 离线组件 ZIP 可以继续使用。

WhisperX 与 Paraformer 的按需 CTC 重新对齐使用同一修正；有效的 Paraformer 原生时间仍直接采用。缓存配置加入 `ctcAlignmentObjective: ctc-complete-waveform-logodds-v1`，避免命中旧评分的缓存。旧任务若运行时契约变化，按已有规则提示重新生成；已有文稿和纠错仍由预览/采用保护。

## 数值与流程检查

无需模型的兼容绑定测试覆盖原全局函数不变、关键字/默认参数保留、重复绑定不重复处理，以及未知版本/摘要拒绝套用。

`python/model_checks/check_ctc_objective.py` 用组件自带 Torch 运行五项独立数值检查，无需加载模型权重：

- 明确构造旧前缀最大值过早结束的情况，修正后选择完整波形概率更高的字符位置。
- 对 3/5/8 帧、1/2/3 个字符的多组输入穷举所有候选完整路径，对比实际回溯得分；包括重复目标字符。
- 加入尾部静音后，最后一字保持原有位置，不被推到 EOF。
- 1,500 帧的等分尾部使用首个完整结束位置，避免累计抵消带来的漂移。
- 实际组件的函数绑定保持原模块/helper 不变，重复获取复用同一私有函数。

五项均通过，日志 `cache/asr-evaluation/ctc-diagnostics/numerical-checks-0.8.3.log`。这组数值检查使用组件的 Torch，独立于普通无模型检查，不将两者混计。

0.8.3 最终完整回归 `cache/verification/2026-10-20T09-01-08-003Z/report.json` 通过：57 项基础单元/模块、9 项 Node 协议、41 项 Python，共 107 项；开发窗口、生产构建和 29 项源码桌面测试通过。未知版本/摘要、绑定隔离等在这 41 项 Python 内；上述五项数值检查另计。

## 实际模型回归

最终原始 M4B worker 为 `cache/asr-evaluation/worker-runs/2026-10-20T09-01-08.005Z/report.json`。固定输入对照 `cache/asr-evaluation/ctc-diagnostics/product-comparison-0.8.3-final.json` 核对两个块的完整 recognition 对象与 0.8.2 完全相同，缓存 key 改变。第一段由 0.031–3.954 秒变为 1.792–28.732 秒，第二块长段由 0.051–3.373 秒变为 0.051–26.389 秒。变化来自声学路径搜索，没有拉伸旧时间或改写识别内容。

该 worker 完成两块生成、重放 2/2、重启复用 2/2 和取消；导出文稿通过 M2 校验，`source-1.desktop.json` 的实际 M4B 播放、原时间轴点句跳转、高亮和重启复用通过，截图已查看。生成约 21.49 秒、首块约 16.32 秒、重放约 252 ms，从 worker ready 后提交计时，包含此次延迟加载；不是应用端到端延迟。

AISHELL-4 的原清单与参考不变，每组均为 15 段、610 个参考字。四次实际 worker 均 15/15 完成，并验证重放和 worker 重启复用：

| 引擎       | 设备     | 参考字编辑距离 / CER | 运行目录（public-worker-runs 下）          |
| ---------- | -------- | -------------------- | ------------------------------------------ |
| Paraformer | GPU      | 37/610，6.07%        | `2026-10-20T09-02-26.254Z-paraformer-cuda` |
| WhisperX   | GPU      | 103/610，16.89%      | `2026-10-20T09-02-53.693Z-whisperx-cuda`   |
| Paraformer | CPU      | 37/610，6.07%        | `2026-10-20T09-04-13.516Z-paraformer-cpu`  |
| WhisperX   | CPU int8 | 105/610，17.21%      | `2026-10-20T09-05-17.434Z-whisperx-cpu`    |

汇总 `cache/asr-evaluation/ctc-diagnostics/reference-regression-0.8.3-final.json` 从实际文稿重算，不将失败样本当作零错误。GPU 两引擎的 CER 与 0.8.2 一致，Paraformer 每次有 10 段 CTC 重新对齐，仍保留复核标记。CPU WhisperX 的结果按本次 int8 实测单列，不假设与 GPU 相同。

`conditional-boundaries-0.8.3.json` 另比较公开话轮端点：Paraformer 仅有 2/15 段全文精确匹配，其最大绝对起点/终点差约 218/116 ms，与 0.8.2 相同；WhisperX 全文精确匹配为 0 段，对应误差留空。这是按识别正确子集条件筛选的粗端点检查，不是全样本或有声书对齐准确率。

## 分发资源

43 分钟原始 MP3 的完整应用流程在只读应用副本、只读组件、隔离 PATH 和进程级离线条件下通过，报告 `cache/asr-evaluation/app-runs/2026-10-20T09-06-24.047Z/report.json`。九个阶段覆盖部分文稿退出、同任务重启命中 1 块、完整重放命中 87 块、纠错保护/预览采用、CPU 取消不打断播放、活动任务阻止清理、清理后零命中重新生成和人工测试标记重启保留。应用截图已检查。

`cache/asr-evaluation/ctc-diagnostics/long-after-0.8.3.json` 审计通过：87 块全部完成，末次生成 1,006 个阅读段，原时间覆盖到 2,593,895 ms，标点与引擎表面文字的分块不一致数为零。该段数属于最终生成预览，现有纠错稿仍独立保留。81 块使用 CTC 重新对齐。复核标记共 125 个：81 个 `NATIVE_REALIGNED`、41 个 `BOUNDARY_CONFLICT`、3 个 `BOUNDARY_REPEAT_DEDUPLICATED`，由原 checkpoint 重建并与数据库计数核对；**边界冲突没有被隐藏或判为质量通过**，后续需听审这些跨块区域。

只读/离线报告 `cache/asr-runtime-source/readonly-offline-20261020T090619.json` 为 passed、`aclRestored=true`；九项真实写入打开得到 AccessDenied，含新的 `asr_ctc.py` 和原 WhisperX 对齐模块。仅对本任务拥有的临时副本施加 ACL，并已恢复原权限，不修改系统策略。离线是 Python 外联审计、FFmpeg file/pipe 白名单和渲染器离线，不是操作系统防火墙隔离。

全部模型运行后，两个受保护实现模块的 SHA-256 与原始 FunASR/WhisperX 一致，报告 `cache/asr-evaluation/ctc-diagnostics/component-implementation-0.8.3.json`。这是两份实现文件的重新核对，没有冒充整个 13 GB 组件的全量复验。

`cache/asr-runtime-source/package-0.8.3.json` 核对 `electron-builder --win --x64 --dir` 的实际资源：版本 0.8.3、5 个 out 文件与构建一致，8 个 Python 模块和 1 个模型清单与源码一致，无私有缓存、媒体、模型或开发测试目录。只生成 win-unpacked，没有重复运行受限 EXE/NSIS；仍无可用的 0.8.3 主程序安装包。

## 继续保留的验收

人工时间边界、专名、漏字、角色对话、广告与整书持续收听仍未验收。完整波形目标也可能在识别错误、词表缺失或噪声下选出不准确的声学路径；没有将模型分数当作人工准确率。WhisperX 的原插值行为、Paraformer CTC 禁用插值的规则均未放宽。实际 M4A、主程序安装版及干净设备门槛继续保留。

后续首先检查长篇的 41 个跨块冲突及 3 个去重位置，区分真实重复、两侧识别差异和时间偏差；不要靠删除复核标记、裁剪区间或按字数均分时间使其通过。`python/diagnose_ctc_alignment.py --component <component.json> --worker-report <旧 WhisperX report.json>` 可在组件 Python 内重复受控对照；其输出是模型诊断，不是人工参考。
