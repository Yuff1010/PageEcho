# 已确认原文的声学对齐协议

固定入口 `python/asr_original_alignment.py`，独立进程处理一个请求后退出。主进程构造全部资源路径、音频身份和已人工确认的一段原文；该脚本不重新运行 Whisper / Paraformer，不修改转写稿，也不写应用数据库。

## 调用

组件 Python 运行固定应用脚本，参数均由 main 指定：

```text
asr_original_alignment.py --models <models.json> --resources <resources> --ffmpeg <ffmpeg> --ffprobe <ffprobe> --cache <writable-cache>
```

stdin 一行 UTF-8 JSON，最大 64 KiB，main 发送后关闭 stdin：

```json
{
  "protocolVersion": 1,
  "requestId": "main-generated-id",
  "audioPath": "D:\\library\\episode.mp3",
  "audioHash": "64 lowercase SHA256 hex characters",
  "device": "cuda",
  "range": { "startMs": 10000, "endMs": 20000 },
  "text": "已经人工确认的一段原文。"
}
```

只接受上述字段，设备为明确的 `cpu` 或 `cuda`。范围为原媒体整数毫秒，长度大于 0 且不超过 60 秒。原文为 1–1000 个 Unicode code point；字母、数字参与声学对齐，标点和空白保留原位置但不制造时间。实际字符边界输出使用 UTF-16 offset，供 JavaScript 切片。词表缺字拒绝，不使用 WhisperX 通配符。

## 终态输出

stdout 只有一行 JSON；库日志写 stderr。成功执行质量检查后：

```text
{
  protocolVersion: 1, type: 'result', requestId,
  status: 'accepted' | 'rejected', audioHash, range, textSha256,
  contract: 'original-ctc-support-v1',
  ctcContract: 'ctc-complete-waveform-logodds-v1',
  qualityPolicy: 'confirmed-original-acoustic-gate-v1', device,
  thresholds: { ... },
  characters: [{ text, textStart, textEnd, startMs, endMs, score }],
  evidence: { ... },
  reasons: [{ code, message }], elapsedMs,
  // accepted 才有以下字段：
  startMs, endMs, confidence
}
```

`characters` 仅在 accepted 时提供可预览建议，拒绝时为空。时间为原媒体绝对毫秒；`score` 是原生 WhisperX 字符路径分数，`confidence` 是最弱字符的模型后验支持值，均不是人工准确率或已校准概率。`evidence.confidence` 始终有该字段，提前拒绝、未测时为 null；accepted 另在顶层保留同值。main 必须重新验证身份与原文/对齐修订后才允许预览、明确采用。Python 不自动保存结果，建议仍须试听。

`evidence` 常规字段为 `lexicalCharacters`、`timedCharacters`、`characterCoverage`、`audioRms`、`freePathCharacters`、`freePathEditDistance`、`freePathErrorRate`、`minTokenPosterior`、`meanTokenPosterior`、`maxUnexplainedPosterior`、`minCharScore`、`meanCharScore`、`candidateOccurrences`、`confidence`。缺字等提前拒绝还提供 `unsupportedCharacters`，其他未执行测量的指标为 null，不会用 0 冒充实测。`characterCoverage` 仅表示原生时间结构覆盖，不表示质量门槛已经通过；拒绝时也可能为 1。

质量拒绝 reason 包括 `UNSUPPORTED_CHARACTERS`、`NO_LEXICAL_TEXT`、`AUDIO_TOO_SHORT`、`NO_SPEECH`、`MISSING_CHARACTER_TIMES`、`INVALID_CHARACTER_TIMES`、`LOW_ACOUSTIC_SUPPORT`、`TEXT_AUDIO_MISMATCH`、`AMBIGUOUS_TARGET`。可能包含多个原因，供用户了解为何保留原人工同步点。

格式、组件、解码或音频身份失败输出：

```text
{ protocolVersion: 1, type: 'error', requestId: string | null,
  code: 'INVALID_REQUEST' | 'FILE_CHANGED' | 'RUNTIME_UNAVAILABLE' | 'DECODE_FAILED' | 'ALIGNMENT_FAILED', message }
```

请求无法解析前 `requestId` 为 null。取消由 main 终止该独立进程，Windows 使用现有进程 job 回收解码子进程；没有持久服务或独立取消 stdin 消息。

## 实际对齐与实验性门槛

使用已有 `ChineseCTCAligner`、固定 WhisperX 3.8.6 和 `ctc-complete-waveform-logodds-v1` 完整波形目标。新增 `align_with_evidence` 是专供已确认原文的显式入口：按该固定模型 `preprocessor_config.json` 的规定，对完整解码波形执行 feature extractor，再截获同一次推理的 emission。原 ASR 识别路径、原 `align()` 默认行为和组件安装文件不变。

只有原文的字母/数字进入对齐器，逐字符对应回原始 UTF-16 位置。标点不走通配符，也没有按字数均分、插值、补字、拉伸、裁剪或把最后一字强行放到片段末尾。原生字符时间缺失、非有限、重叠、越界或毫秒化后为空就拒绝。小于模型最小有效输入 400 samples 的波形也拒绝，不靠填充制造时间。

强制 CTC 路径本身不足以通过。还要检查同一 emission 中不受目标文字约束的自由路径和每个目标字符的直接声学支持：

| 检查                                   | 当前门槛                                               |
| -------------------------------------- | ------------------------------------------------------ |
| 原始字符时间覆盖                       | 每个原文实词字符都有独立有效时间，覆盖必须为 1         |
| 音频 RMS                               | 至少 0.0001                                            |
| 每字 token peak posterior              | 每个字符至少 0.02                                      |
| 目标原生时间范围内自由路径的字符编辑率 | 不大于 0.35，保留非零容差                              |
| 未被目标解释的插入语音 peak posterior  | 不大于 0.3                                             |
| 上下文候选                             | 相同容差的 semiglobal 搜索不能发现两个不重叠的近似目标 |

自由路径比较只使用原生目标起止范围内的声学帧，前后邻句本身不会造成拒绝；整个上下文另用于重复目标歧义检查。候选计数最多为 2，含义是至少发现两处，不声称穷尽重复次数。原生字符的 WhisperX score 可能包含 blank 帧贡献，不能把高 score 当成“文字读对”；每字独立 posterior 检查正是为避免这一问题。

这些是有限对照上建立的实验性支持门槛。接受意味着可试听的建议，不意味着文字肯定读对或时间经人工确认。低支持结果保持人工位置。同音字、模型自身错误、漏读/改读及背景噪声仍可能漏检；无法承诺所有误读都被识别。没有降低该边界来宣称“强制对齐即准确”。

## 全分母真实对照

2026-10-23，使用只读的既有 `release/asr-component-0.7.0-win-x64/component.json`，没有下载模型或修改组件资源。固定采用已有人工参考 manifest 中全部 18 条 CH-SIMS 片段和全部 40 条 AISHELL-3 片段，没有按模型结果筛掉失败样本。公开参考与本模型不一致的原因仍待听审，不根据模型给参考改标签。

按源顺序固定划为 43 条校准、15 条保留：电影前 13/后 5，studio 前 30/后 10。迭代中已查看分折结果，因此保留折不是未触碰的外部盲测，不能当泛化准确率。最终结果由保存的真实 emission、原生 alignment 和新评分规则重算，没有重复整套推理：

| 输入/对照                                  | 全部分母 |        接受 |        拒绝 |
| ------------------------------------------ | -------: | ----------: | ----------: |
| 出版方人工参考原文                         |       58 | 21（36.2%） | 37（63.8%） |
| 其中 CH-SIMS                               |       18 |           1 |          17 |
| 其中 AISHELL-3                             |       40 |          20 |          20 |
| 错词文字对照                               |       58 |           0 |          58 |
| 原文加入音频中未读的词                     |       58 |           0 |          58 |
| 删除原文内部一个字、声音保留的额外语音对照 |       53 |           1 |          52 |
| 生成的全零静音                             |        1 |           0 |           1 |
| 固定种子的白噪声                           |        1 |           0 |           1 |

正确参考在校准折接受 15/43，保留折接受 6/15；后者的错词 0/15、加入未读词 0/15、内部删字 0/14 被接受。这里的“正确参考接受率”是该门槛的可用性诊断，不是时间正确率。样本来自有限说话人和场景，训练重叠未知；白噪声也不代表所有自然背景噪声。

58 条原样参考中有 6 条因词表缺字提前拒绝，仍完整计入拒绝分母：`SSB00090030` 缺“碗”，`SSB17110047`、`SSB17110049`、`SSB17110285`、`SSB17110326`、`SSB17110429` 缺“幺”。其中校准折 5 条、保留折 1 条。连同对应的构造控制，229 个总用例里共 23 次词表缺字提前拒绝（原样参考 6、错词 5、加入未读词 6、内部删字 6）；这些用例没有执行声学对齐，也不能把同一音频另一个控制保存的 emission 当成该次已推理的证据。

错词对照在原文字间把最多两个字替换成“火车”，极短文本可能同时增加长度；未读词对照在原文内部加入“火车”，音频完全不变。内部删字只对至少 3 字的文本构造，保留首尾，另外 5 条不适用。该对照仍有一处漏检：“这一套”删成“这套”，自由路径未提供足够证据区分，不能据此断言实际录音确有漏读。该漏检完整保留，不能承诺内部改读全检。

要求这些构造负例全部零误收的网格会退化到自由路径零编辑，只接受 15/58；最终采用有每字独立支持的非零容差，并公开漏检和拒绝率。功能范围因此是人工确认段的实验性同步建议，必须预览、试听和明确采用，保留原人工同步点可恢复。

原始两轮及修复前证据不覆盖：

- `cache/optimization/original-acoustic-calibration-2026-10-23/report.json`：raw-waveform 首轮，全部原生输出、emission 与执行源码快照。
- `cache/optimization/original-acoustic-normalized-2026-10-23/report.json`：同分母的模型规定 feature extractor 对照。
- `cache/optimization/original-acoustic-full-controls-2026-10-23/report.json`：全 58 参考及固定控制，带原生输出、每个音频 emission、来源 hash、组件/模型文件前后 hash。
- `cache/optimization/original-acoustic-final-gates-context-2026-10-23/report.json`：最终门槛和近似重复检测的原始重评分，保留审计前证据；其中 23 个提前拒绝用例的 `nativeAlignmentInSourceReport` 曾误标 true。
- **当前审计版** `cache/optimization/original-acoustic-final-gates-audited-2026-10-23/report.json`：只修正上述来源标记，接受结果、理由、所有指标、门槛和分母逐字段保持不变，质量字段 SHA-256 前后相同。206 次实际对齐标记为 true，23 次提前拒绝为 false 且 emission hash 为 null。保存的 emission 是不依赖文字的输入波形证据，可被该音频实际执行过的控制共享；审计版另注明其首次保存的源用例，不声称每次控制都独立保存了一份 tensor。原评分源码与本次审计脚本分别保存在 `sources/`、`audit-sources/`，不覆盖历史，也没有新增推理。

## 长段、邻句及重复上下文

`check_original_alignment_context.py` 实际运行已有自然连续人声：

- 第一个冻结 AISHELL-4 连续样本的全部 8 个人工 turn 均提前拒绝，因为固定词表缺少“呃”（其中一条还缺“蔬”）。没有删掉这些字使其通过。
- 在源顺序中选择首对连续、词表全支持且总长度达到 20 秒的相邻 turn，保持原始连续音频与原样参考：22.953 秒、72 个实词字符。模型返回 72/72 有效原生时间，最弱字符 posterior 为 `4.535e-8`，最终拒绝 `LOW_ACOUSTIC_SUPPORT`。这证明该长度可以执行检查，未证明长段同步建议可用或准确。
- 两条先前已支持的 studio 参考，用完整未裁音频分别对齐全文及内部文字，邻句上下文共 5/5 可接受；这是上下文可行性对照，不加进新的质量分母。
- 将同一真实 studio 录音重复两次，中间插入 300 ms 静音，形成明确重复控制。首次精确计数漏掉一份有自由路径错字的重复并误收，证据保留；改用近似 semiglobal 候选后计为 2，拒绝 `AMBIGUOUS_TARGET`。该控制是明确标注的人工拼接，不冒充自然连续参考。

证据分别为 `cache/optimization/original-acoustic-context-2026-10-23/report.json`、`cache/optimization/original-acoustic-context-fixed-2026-10-23/report.json`。本批没有有声书人工音素时间标签，因此不报告人工边界误差或有声书通过率。

## 实际 CLI、预览绑定与单元检查

`python/model_checks/check_original_alignment_cli.py` 通过固定脚本独立进程完成 6/6：CUDA 正确文字 accepted、CUDA 错误文字 rejected、CUDA 静音 rejected、CPU 同一正确文字 accepted、词表缺字 rejected、错误音频 hash 返回 `FILE_CHANGED`。正样本明确使用之前已支持的校准输入“太平洋商业中心”，是协议/设备 smoke，不作为额外准确率证据。

所有输入输出原样保留在 `cache/optimization/original-acoustic-cli-2026-10-23/`：

- `report.json`：真实命令、返回码、完整输出、组件/模型 keyfile 前后 hash、源码快照 hash。
- `correct-cuda.request.json` / `correct-cuda.stdout.jsonl`，其余用例为相同命名，另有完整 stderr log。可交生产 Node parser 验证。
- 该报告的 `componentUnchanged=true`，包括模型权重、vocab、特征提取配置和本机 WhisperX alignment.py 的前后核对；没有冒充整个组件的全量复验。

运行开始早于统一预览，因此对已经执行的 workspace 脚本做逐字节绑定：`cache/optimization/original-acoustic-preview-binding.json` 核对 0.14.0-dev.1 预览 `cache/preview-builds/2026-10-23T06-04-02.926Z/app/python` 的全部 11 份 `asr_*.py` / `evaluation-models.json` 与实际执行源文件完全一致。没有为路径变化重复模型推理。退出后 `cache/optimization/original-acoustic-processes.json` 记录本批 acoustic Python 进程为 0。

针对性无模型检查：

```powershell
python -B -X utf8 -m unittest discover -s python -p test_asr_original_alignment.py
python -B -X utf8 -m unittest discover -s python -p test_asr_engines.py
python -B -X utf8 -m unittest discover -s python -p test_asr_ctc.py
```

12 + 8 + 3 项通过。新 core 单元检查涵盖严格输入/设备/范围、UTF-16 对应、缺字不走通配路径、缺失/越界/重叠/非有限时间不修补、音频绝对 offset、强制路径不能绕过自由证据、静音、词间 delimiter、邻句上下文、近似重复歧义。它们验证契约与安全边界，不能替代上述真实模型对照。
