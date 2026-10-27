# 公开人工参考语音诊断

后续更新：0.8.1 已修复参数调用，并在原生时间无效时使用中文 CTC 重新对齐；同批 CPU/GPU 适配器及实际 worker 均 15/15 完成，见 [时间戳修复验收](PARAFORMER_TIMESTAMPS.md)。下文保留 0.8.0 原始失败与质量测量，不改写历史报告。

日期：2026-10-20（America/New_York），应用/worker 实现仍为 0.8.0。本轮补充真实人声参考、评估入口及失败证据，没有改变识别算法或文稿时间校验。

## 来源与范围

选用 [AISHELL-4](https://www.openslr.org/111/) 的一场会议公开副本：`AISHELL/AISHELL-4`，固定 revision `aada72727856313b19d4a030383c426364931dbf`，录音 `S_R004S03C01`。源音频为 2,327.119 秒、16 kHz、8 声道 FLAC；本次只提取第 0 声道。固定文件可在 [该版本目录](https://huggingface.co/datasets/AISHELL/AISHELL-4/tree/aada72727856313b19d4a030383c426364931dbf/test) 追溯。

OpenSLR 标注数据许可为 CC BY-SA 4.0，HF 元数据写 Apache-2.0；本次按 OpenSLR 的数据许可记录归属，不把代码许可视为音频许可。归属：Yihui Fu 等，AISHELL-4，Interspeech 2021；Beijing Shell Shell Technology Co.,Ltd。裁剪、单声道转换是本次修改。音频、人工转录及派生片段只保存在忽略的 cache 中。

| 资源     |        字节 | SHA-256                                                            |
| -------- | ----------: | ------------------------------------------------------------------ |
| FLAC     | 235,113,956 | `c21ce5ce455b87926ca6b486431db2889de5d14be91b55f8cffea31cd94c1262` |
| TextGrid |      75,321 | `ca515d60e370362aebbf481c465dadc0b8f0f0dc6eeb125845edd09f17cee3d3` |

人工参考来自发布的 TextGrid；没有以识别结果作为参考，也没有把这些远场会议语音称为干声有声书。按源时间顺序取每位说话人的前三个合格区间：2–15 秒、12–200 个字母/数字、与其他标注区间无重叠。只去掉 `<sil>`，保留“嗯、呃、儿”等发声；含其他不确定/事件标记的区间排除。前后最多补 250 ms，上下文不得进入相邻标注语音。规则在首次识别前确定。

最终 5 位说话人、15 段，合计 160.123 秒，规范化参考 610 字。准备入口会重新验证源文件哈希、选段规则、参考文字/时间和每段音频哈希。实际修改参考文字、末端时间、导出偏移或漏掉一个样本均被拒绝，原清单未改。

这是小型诊断子集；不遵循官方整个测试集的 CER 协议，未评估重叠说话/说话人分离，也不知道模型训练集与这些材料有无交集。

## 实测结果

模型 revision 和依赖沿用 [固定模型清单](../python/evaluation-models.json) 与原 M3 环境。四个配置顺序执行，每段一次；固定样本、内存 PCM、进程级离线。模型/OS 文件缓存可能已预热，时间不是稳定吞吐承诺。

CER 为各段编辑距离之和除以 610；NFKC、casefold、仅字母/数字，不转换数字、繁简或同音字，不删语气词。原始文字评分纳入全部 15 段，时间戳失败也不从文字分母中剔除。

| 原始模型适配器            | 编辑距离 / 610 |    CER | 时间戳有效片段 | 识别+对齐总时长 / 音频时长 |
| ------------------------- | -------------: | -----: | -------------: | -------------------------: |
| Paraformer CPU            |             37 |  6.07% |           2/15 |                     0.0253 |
| Paraformer GPU            |             37 |  6.07% |           2/15 |                     0.0133 |
| WhisperX CPU int8         |            105 | 17.21% |          15/15 |                     0.3607 |
| WhisperX GPU int8_float16 |            103 | 16.89% |          15/15 |                     0.0299 |

速度比不包含模型加载、解码、采样器退出等总流程开销。原始适配器的 Paraformer 两次报告均为 failed：全部识别完成，但 13 段的末端原生时间戳比实际音频长 17–73 ms，严格导出检查拒绝。没有把它改记成通过。

随后使用应用相同的 `AsrWorkerProcess`、FFmpeg、分块/标点/文稿校验及独立组件，分别对两个 GPU 引擎运行全部 15 段，使用新的块缓存：

- Paraformer：2/15 完成，其余 13 段为 `ALIGNMENT_FAILED`，与原生时间越界对应。只有完成的 84 个参考字可以评分；不能把这两段的零错误当成整批零错误，完整子集 CER 保持 null。
- WhisperX：15/15 完成，零分块缓存命中，输出文稿 CER 仍为 103/610（16.89%）；应用后处理没有改变本轮规范化识别文字。

一条最小编辑路径中，WhisperX GPU 为 28 个替换、75 个删除、0 个插入；删除中“嗯”19、“呃”11、“儿”9。Paraformer 为 20 个替换、15 个删除、2 个插入。编辑路径有并列最优时固定优先替换、删除、插入，因此这是可复现的文字差异分解，不是人工语义错误分类。保留完整 CER，不通过删除参考语气词改善分数。

时间偏差仍未充分验证：仅 Paraformer 的 2/15 段完整文字精确匹配，粗粒度起点最大绝对差约 397 ms、末端约 1,196 ms；WhisperX 无完整精确匹配段。这里比较的是发布的整段端点，存在选中精确匹配段的偏差，不能据此给出全局强制对齐误差或发音边界门槛。

## 当前结论与后续

Paraformer 在这批人声上文字更接近人工参考，但应用任务会因尾端时间越界失败。WhisperX 的文稿流程通过，保留全部发声的能力仍有不足。**默认引擎仍未确定**。优先定位 Paraformer 的特征帧末端与实际媒体时长处理，验证可追溯的时间修正或重新对齐方案；不简单放宽时间校验掩盖越界。

单人干声、真实有声书对话/专名/广告、较长听书单集及人工发音边界仍待样本。这场源录音虽然较长，本轮只识别了裁剪片段，没有据此勾选长单集、重叠对话或整场处理验收。此前歌曲与 [连续收听基线](LISTENING_BASELINE.md) 保留各自范围。实际 MP3/M4A/M4B、安装与干净设备验收继续开放。

## 证据与复现

缓存根：`cache/asr-evaluation/`。

- `public-reference/aishell4/manifest.json`：音频/人工参考清单，SHA-256 `7ee694cf408cc983e2bed2ecb8f59cb9b64138960445a6b22af8274a9e84c5ae`。
- `public-reference/aishell4/comparison.json`：六次运行的汇总及报告/原始输出哈希；`reference-integrity-checks.json` 保存参考篡改拒绝检查。
- `runs/public-2026-10-20T07-21-39Z-paraformer-cuda/`、`public-2026-10-20T07-22-47Z-whisperx-cuda/`、`public-2026-10-20T07-23-31Z-paraformer-cpu/`、`public-2026-10-20T07-23-49Z-whisperx-cpu/`：原始模型报告、输出、可导出的文稿。具体目录以 comparison 为准。
- `public-worker-runs/2026-10-20T07-25-58.656Z-paraformer-cuda/`、`2026-10-20T07-27-21.280Z-whisperx-cuda/`：应用 worker 结果及日志。

```powershell
# 显式准备公开数据（约 224 MiB），不会在普通 CI 下载
python -B -X utf8 python/public_reference.py --download --ffmpeg 'ffmpeg.exe 完整路径' --ffprobe 'ffprobe.exe 完整路径'
# 使用已有 M3 依赖和本地模型清单；设备、引擎可分别替换
python -B -X utf8 python/evaluate_asr.py --reference-manifest cache/asr-evaluation/public-reference/aishell4/manifest.json --engine whisperx --device cuda --whisper-compute int8_float16 --repeats 1 --offline --ffmpeg-directory 'FFmpeg 文件夹'
npm run asr:reference -- --component '组件/component.json' --engine whisperx
# 对 Paraformer 的当前失败保留非零退出码
npm run asr:reference -- --component '组件/component.json' --engine paraformer
```

汇总使用 `python/reference_summary.py <各 report.json 路径> --output <输出 JSON>`，先重新校验固定参考，再根据原始模型输出复算 CER；任何样本失败时不给 worker 完整子集 CER。新解析/选段/失败评分测试不需要数据、网络或模型。TextGrid 格式依据 [Praat 官方说明](https://www.fon.hum.uva.nl/praat/manual/TextGrid_file_formats.html)，AISHELL 会议场景与标注说明见 [OpenSLR 111](https://www.openslr.org/111/) 和 [发布者基线代码](https://github.com/felixfuyihui/AISHELL-4)。

本轮 `npm run check`（57 项基础测试、类型、lint、格式）及 `npm run test:worker`（9 项 Node、29 项 Python）通过，共 95 项。普通检查通过不覆盖真实模型时间戳质量；上面的 Paraformer 原始模型/worker 失败仍保留。应用 UI 和打包资源未改动，本轮没有将旧桌面报告记成新一轮全量桌面验收。
