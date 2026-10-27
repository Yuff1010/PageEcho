# M3 首轮模型评估

0.8.1 更新：Paraformer 原生时间参数修正及按需 CTC 重新对齐，已使原人声子集的 CPU/GPU 适配器和 worker 均 15/15 完成，CER 仍为 6.07%，见 [修复验收](PARAFORMER_TIMESTAMPS.md)。下文和原始基线保留历史测量，默认引擎仍未确定。

后续质量诊断：2026-10-20 已增加 [公开人工参考基线](HUMAN_REFERENCE_BASELINE.md)，补充 5 位真实说话人、15 段的四配置 CER 与实际 worker 结果，发现 Paraformer 末端时间越界导致 13/15 个任务失败。下文仍保留首轮歌曲/TTS 测量范围，不用新结果改写历史报告；默认引擎继续未定。

日期：2026-10-19（America/New_York）。本文件保存首轮模型比较结果；后续已完成分块、标点、取消、缓存及应用内任务系统，见 [组件说明](ASR_WORKER.md) 和 [0.4.0 应用验收](M3_APP_VALIDATION.md)。完整听书质量仍待验收，以下首轮数据未改写为后续实现的测量结果。

## 设备与环境

| 项目       | 实际读取结果                                                                                |
| ---------- | ------------------------------------------------------------------------------------------- |
| 系统       | Windows x64 10.0.26300                                                                      |
| CPU        | AMD Ryzen 7 9800X3D，8 核 / 16 线程；推理限制为 4 个 CPU 线程                               |
| 物理内存   | 33,944,223,744 字节，约 31.61 GiB                                                           |
| GPU        | NVIDIA GeForce RTX 5060 Ti，8,151 MiB，驱动 610.88                                          |
| Python     | 3.12.10；独立环境 cache/asr-evaluation/venv/                                                |
| GPU 运行时 | PyTorch / torchaudio 2.8.0+cu128，torchvision 0.23.0+cu128                                  |
| GPU 实测   | CUDA 12.8，计算能力 12.0，wheel 含 sm_120；实际矩阵乘法成功                                 |
| 模型工具   | FunASR 1.4.16、WhisperX 3.8.6、faster-whisper 1.2.1、CTranslate2 4.8.3、transformers 4.57.6 |
| 解码       | FFmpeg/ffprobe 7.1.1 将样本预先解码为 PCM；模型接收内存音频                                 |

完整依赖见 [requirements-evaluation.txt](../python/requirements-evaluation.txt)，pip check 通过。没有改变其他 Python 环境。模型、媒体、日志和结果在 Git 忽略的 cache 中，原歌曲保持原处。音频推理在本机执行，首次下载的是公开模型权重。

TorchCodec 0.7 在现有 FFmpeg 8 shared 路径下提示无法加载其 FFmpeg 4–7 解码 DLL。本次 WAV→内存数组路径成功运行，不据此声称 TorchCodec 解码可用；发布前仍须确定解码运行时分发方案。

## 样本与测量方法

用户指定先用 CloudMusic 歌曲。顶层找到 12 个可读 FLAC，按自然顺序取首批 3 个，排除程序资源音效和加密缓存。原时长约 168、230、165 秒，每首截取原时间 30–90 秒。ffprobe 确认三个片段均为 60.000 秒、PCM16、16 kHz、单声道。清单记录原始 SHA-256、大小、修改时间、编码、时长和偏移。

另用 M2 原创中文 TTS 夹具作对照：16.360 秒、3 句、去标点后 38 字，已知参考文字。CER 使用 NFKC、大小写折叠后仅保留字母和数字；不做同音字、繁简或数字转换。歌曲没有人工参考，**不计算歌曲 CER/WER 或识别准确率**。

每个配置在同一进程先处理对照，再处理 3 个歌曲片段，各重复两次。模型预先下载，加载耗时包含引擎导入、建模与权重加载，不含网络下载。识别/对齐计时从已解码的内存音频开始；首个可用文稿为整个片段完成后的结果，尚未实现逐段流式输出。两次测量只能展示本次观测，不能推导稳定吞吐量或 P95。

RSS 每 100 ms 采样；整卡显存每 1 秒由 nvidia-smi 采样，**包括桌面及其他应用**。另外记录 PyTorch 分配/保留峰值，但该值不包含 CTranslate2。本机其他 GPU 占用随时间变化，未隔离后台负载，因此不能把速度变化单独归因于量化或显存。

模型固定到 [evaluation-models.json](../python/evaluation-models.json) 的提交版本：

- FunASR：paraformer-zh + fsmn-vad + ct-punc；显式开启 output_timestamp=True 与 sentence_timestamp=True。识别、VAD、标点及原生时间戳一起计时，无单独对齐阶段。
- WhisperX：large-v3-turbo + 包内 Pyannote VAD + 中文 wav2vec2 CTC 对齐；语言固定 zh，不启用说话人分离。分别测试 GPU float16/batch 4、GPU int8_float16/batch 1、CPU int8/batch 1。

## 实测结果

下表为识别与对齐总耗时，两次结果按“第一次 / 第二次”列出；歌曲每段输入均为 60 秒。

| 配置                               | 缓存权重加载 | 中文对照 CER   | 歌曲 1          | 歌曲 2          | 歌曲 3                |
| ---------------------------------- | ------------ | -------------- | --------------- | --------------- | --------------------- |
| Paraformer GPU                     | 11.85 s      | 0 / 38 = 0%    | 1.35 / 1.35 s   | 2.02 / 1.97 s   | 0.71 / 0.67 s，空结果 |
| Paraformer CPU                     | 9.89 s       | 0 / 38 = 0%    | 1.66 / 1.67 s   | 1.95 / 1.89 s   | 1.89 / 1.92 s，空结果 |
| WhisperX GPU float16，batch 4      | 35.42 s      | 2 / 38 ≈ 5.26% | 1.85 / 3.41 s   | 8.36 / 58.06 s  | 9.91 / 6.26 s         |
| WhisperX GPU int8_float16，batch 1 | 11.27 s      | 2 / 38 ≈ 5.26% | 2.03 / 1.79 s   | 1.87 / 5.32 s   | 7.78 / 3.75 s         |
| WhisperX CPU int8，batch 1         | 11.44 s      | 2 / 38 ≈ 5.26% | 17.51 / 17.75 s | 19.16 / 18.74 s | 15.57 / 17.35 s       |

量化 GPU 配置的识别/对齐耗时分别为：歌曲 1，1.60+0.43 / 1.33+0.46 秒；歌曲 2，1.36+0.50 / 3.91+1.42 秒；歌曲 3，5.86+1.92 / 2.26+1.49 秒。60 秒输入的总处理时间小于输入时长，但不包含切段解码、任务调度或长时间连续工作，尚不承诺应用可稳定边听边处理。

进程 RSS 采样峰值约为 Paraformer GPU 5.08 GiB、CPU 6.07 GiB；WhisperX 量化 GPU 2.46 GiB、CPU 4.51 GiB。量化 GPU 的整卡采样峰值 7,479 MiB，PyTorch 分配峰值约 1.76 GiB；两者统计范围不同，不能相减推算模型显存。CPU 测试没有创建 PyTorch CUDA 分配。

### 识别与时间戳需要分别判断

- Paraformer 对照文字全对，但原生字符边界相对合成放置边界仍有约 -215 至 +575 ms 偏差。两首歌曲末尾分别到了 60,030 / 60,029 ms，超出 60,000 ms，严格校验拒绝导出；不裁剪后冒充准确时间戳。第一首含英文词，评估器没有将词级时间虚拟拆给字符，其字级映射未评定。第三首 VAD 返回空结果，而 WhisperX 返回文字，需人工听审确定漏检和幻觉情况。
- WhisperX 三种配置均对三首歌返回文字，导出的区间有序、不重叠且未越界。量化 GPU 的三首歌曲分别有 164 / 237 / 155 个带时间的字符；“有时间”不等于“时间正确”。对照中只有两句全文匹配可做粗边界比较，起点偏差约 +140/+168 ms，终点约 +868/+841 ms；第三句有错字，不推算其准确边界。
- 对照边界来自 SAPI 合成片段的放置位置，**不是人工听标的发音边界**。以上数字用于发现流程问题，不作为对齐误差达标结论。
- WhisperX 此样本输出的中文缺少标点，片段偏长（60 秒歌曲为 2–3 段）。应用接入前需要中文断句/标点恢复，并保留字级时间依据；尚未把这些段落称为已验收的句级文稿。

最早一轮 Paraformer 漏传 output_timestamp=True，只有 VAD 粗分段，该诊断轮保留在本地但不纳入上述原生时间戳比较。更正后重新跑完全部 CPU/GPU 样本，越界与空结果均如实记录为问题。

## 与播放器的实际集成验证

npm run asr:validate 调用 M2 的真实 TypeScript 文稿校验器，检查内容哈希、毫秒区间、覆盖范围与原偏移。所有已导出的比较文稿通过；Paraformer 的越界结果没有导出，空结果单独保留为质量未定。

WhisperX 量化 GPU 生成的三首文稿都已在真实源码 Electron 中测试：

1. 从原歌曲导入书架并实际播放 FLAC。
2. 经原生 JSON 选择流程导入模型文稿，主进程检查原音频哈希。
3. 点击第一段，媒体时间准确跳到原音频的 30 秒偏移之后，高亮对应片段并保持暂停。
4. 关闭、重启、恢复原歌曲，已有文稿仍可复用，无页面脚本错误。

测试只替换操作系统选择器返回值，其余 preload、IPC、文件、播放器和 SQLite 均执行。截图、测试数据目录与 JSON 结果留在私有 cache，不提交歌词、标题和路径。此流程仍为“离线生成 JSON→导入”，不替代待实现的应用内自动转写任务。打包程序继续受 Device Guard 限制，本次验证的是源码窗口。

本轮新增 4 项 Python 指标/偏移/错误边界测试通过；22 项现有单元/模块测试、TypeScript、lint 和格式检查通过。安装 Python 依赖后发现 lint 扫到了 cache 内第三方 JS，已将媒体、模型及环境目录加入开发工具忽略列表，复查通过。样本准备增加切段后文件大小/修改时间检查与原子替换；重新准备的三个 WAV 经 SHA-256 对比与评估输入逐字节一致。

## 可复现命令

普通开发检查不下载模型，也不依赖私有歌曲。Windows x64、Python 3.12 评估环境：

```powershell
python -m venv cache/asr-evaluation/venv
& cache/asr-evaluation/venv/Scripts/python.exe -m pip install -r python/requirements-evaluation.txt
& cache/asr-evaluation/venv/Scripts/python.exe -m pip check
& cache/asr-evaluation/venv/Scripts/python.exe -X utf8 python/prepare_asr_models.py
npm run asr:prepare -- '本地歌曲文件夹' --ffprobe 'ffprobe.exe 的完整路径'
& cache/asr-evaluation/venv/Scripts/python.exe -X utf8 python/evaluate_asr.py --engine paraformer --device cpu
& cache/asr-evaluation/venv/Scripts/python.exe -X utf8 python/evaluate_asr.py --engine paraformer --device cuda
& cache/asr-evaluation/venv/Scripts/python.exe -X utf8 python/evaluate_asr.py --engine whisperx --device cpu
& cache/asr-evaluation/venv/Scripts/python.exe -X utf8 python/evaluate_asr.py --engine whisperx --device cuda --whisper-compute int8_float16 --whisper-batch-size 1
npm run asr:validate -- 'cache/asr-evaluation/runs/某次运行'
npm run build
npm run asr:desktop -- 'cache/asr-evaluation/runs/某次运行' song-1
python -X utf8 -m unittest discover -s python -p 'test_*.py'
```

准备脚本在 Windows 使用单下载线程，让 Hugging Face 自带的普通文件回退生效，避免并行符号链接探测竞争；无需管理员权限或改变系统设置。每次报告包含精确模型 revision、软件版本、参数、时长、耗时、资源采样、原始输出、校验问题及 JSON 文稿。固定随机种子 0，仍可能因 CPU/GPU 和数值实现不同而改变断句或字符。

本次比较报告在 cache/asr-evaluation/runs/：

- 2026-10-20T03-19-25Z-paraformer-cuda
- 2026-10-20T03-21-18Z-paraformer-cpu
- 2026-10-20T03-16-27Z-whisperx-cuda（float16）
- 2026-10-20T03-20-12Z-whisperx-cuda（int8_float16；含三首桌面验收）
- 2026-10-20T03-22-28Z-whisperx-cpu

## 后续决策

WhisperX 量化 GPU 配置作为下一步音乐背景任务接入的优先候选，CPU int8 已有实测路径；它在本次三首样本中产出了符合区间约束的结果。Paraformer 保留为可替换候选，对照识别优势明确，歌曲 VAD 与边界问题需先解决。**尚未确定产品默认引擎**。

后续已实现独立转写组件、保留偏移的重叠窗口、中文标点、取消与分块缓存，三首带标点文稿通过播放器验证；0.4.0 已接入应用任务持久化、逐块阅读、纠错保护和重启续接，并完成整首歌曲流程。下一步补齐单人干声、多人对话、专名、片头广告、长听书与人工参考；没有这些样本，不能完成 M3 的完整质量与日常听书验收。

实现依据：[FunASR](https://github.com/modelscope/FunASR)、[WhisperX 3.8.6](https://github.com/m-bain/whisperX/tree/v3.8.6)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[TorchCodec 兼容说明](https://github.com/pytorch/torchcodec)。速度、质量与问题来自本机报告，不由上游项目的性能宣称推导。

## 0.8.0 应用内连续播放与并行处理

2026-10-20 新增三曲约 9 分 23 秒自然连播基线，同时分别运行全曲 WhisperX CPU int8 和 GPU int8_float16。两次任务分块缓存命中均为 0，首个可用前缀分别约 27.8/21.1 秒，完成约 55.0/26.7 秒，总耗时与音频时长之比分别为 0.327/0.116。输入不同、先后运行，且模型/OS 缓存可能预热，不用作严格的同样本速度比较。

播放、自然切集与重启恢复通过，但播放位置仍有约 20–32 秒确认领先已处理前缀的区间。首个前缀、覆盖、IPC 响应及 RSS/整卡显存的测量定义、原始数据位置和复现命令见 [连续收听基线](LISTENING_BASELINE.md)。指定文件夹 12 首均为 FLAC，没有可用内嵌歌词，唯一 LRC 为“暂无歌词”占位；未生成歌曲人工 CER，也未据此选择默认引擎。代表性听书质量、发音时间偏差和长单集验收仍待补齐。
