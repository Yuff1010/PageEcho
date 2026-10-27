# 真人干声识别诊断（0.8.4）

日期：2026-10-20（America/New_York）。补充 AISHELL-3 发布方原始样本包的全部 40 条 test 录音：两位说话人、123.689 秒、267 个归一化参考字。四组 CPU/GPU 实际 worker 各完成 40/40，重放与重启复用通过；这批短词/短句不代表完整有声书或人工同步边界。

## 来源与固定选择

原始包来自[发布方公告](https://www.aishelltech.com/newsitem/278532347)链接的 `AISHELL-3-Sample.rar`，使用同一发布方 OSS 地址的 HTTPS 下载。[原始论文](https://www.isca-archive.org/interspeech_2021/shi21c_interspeech.pdf)说明，录音来自安静室内的真人朗读，字符和拼音是录音后人工转写；没有使用网页的模型合成演示。

包大小为 75,587,143 字节，MD5 为 `b810013b026719c0f4ff58b15a250601`，SHA-256 为 `4879c25bc00da3477e34ae2d8fd0496112835958f63fb18a4e2f7ed8753c0343`。读取包内 `AISHELL-3-Sample/test/content.txt` 和对应全部 test WAV，按原始 ID 排序；不按时长、字数或识别结果筛选。保留 SSB0009 的 9 条、SSB1711 的 31 条，包含单字、店名、地名和数字串。

原标注按“汉字、拼音”交替排列，只抽取汉字作为参考，拼音另行保留；异常或不成对内容直接拒绝，不能静默丢弃。`content.txt` 的 SHA-256 为 `90e3b5d70e8fb4017b11b9b611586ca1337572046313e9c2343c989c1b19ebe9`。

模型前固定清单 `cache/asr-evaluation/public-reference/aishell3-studio/manifest.json`，SHA-256 为 `19aaef24050a90c948b3ca9444bb57fc33d0e1c90049c089168ca9f4767a9f51`。全部原 WAV 保留，完整原句仅重采样为单声道 PCM16/16 kHz，没有拼接、插入静音或降噪。容器时长不是人工发音边界；参考记录只有 ID 和文字，没有编造 `startMs`/`endMs`。

`studio_reference.py` 每次核对完整 RAR、原成员内容、全部文字与选择、工具摘要、WAV 参数及媒体时长，并重新解码 40 条与实际 PCM 逐字节比较。缓存复核不重写清单。七种实际修改被拒绝，包括参考文字、选择、伪造人工时间、哈希、帧数、时长，以及修改 PCM 后更新对应哈希；测试后派生文件及修改时间精确恢复。记录为 `cache/asr-evaluation/studio-source-discovery/frozen-reference.json`。冻结完成早于首个 worker 构建/提交，时间核对在同目录 `source-order-audit.json`。

[OpenSLR 93](https://www.openslr.org/93/)标记 Apache-2.0，发布方页面还列出 CC BY-NC-SA 4.0；保留这些来源说明。媒体、参考和报告均在忽略的 cache 中，只作本机诊断，不进入主程序或组件包。

## 实际结果

汇总 `cache/asr-evaluation/studio-source-discovery/summary-final.json` 从实际文稿和完整 checkpoint 上下文重建并重新计分，同时核对清单摘要、输入音频、配置指纹、时间格式和警告。四组使用同一份固定参考；失败样本不会按零错误处理，任意失败则整集合 CER 为 null。

CER 沿用 NFKC、casefold、只保留字母/数字，**不做数字转换**。数字子组在模型前由参考字形定义：完全由中文数字字符组成的 10 条、91 字；其余 30 条、176 字。不是人工命名实体边界标注。

| worker                 | 完成  | 全部编辑数 / 267 字 | 原样 CER | 数字子组编辑数 / 91 字 | 其他短句编辑数 / 176 字 |
| ---------------------- | ----- | ------------------- | -------- | ---------------------- | ----------------------- |
| Paraformer GPU         | 40/40 | 5                   | 1.87%    | 0                      | 5（2.84%）              |
| Paraformer CPU float32 | 40/40 | 5                   | 1.87%    | 0                      | 5（2.84%）              |
| WhisperX GPU           | 40/40 | 117                 | 43.82%   | 91                     | 26（14.77%）            |
| WhisperX CPU int8      | 40/40 | 116                 | 43.45%   | 91                     | 25（14.20%）            |

数值必须连同文字呈现方式解释。例如参考 `零三四七幺零七二六五零`，WhisperX 输出 `03471072650.`；按原规则计为不同字符。也有单字输出与参考不同，不能把全部数字组错误都解释为格式差异。没有据此改写参考、放宽主 CER 或声称 43% 的声音内容都被听错。

Paraformer 每组有 7 条使用 CTC 重新对齐，复核标记保留。WhisperX 本轮没有该 Paraformer 原生时间回退标记；这不表示其同步精度已由人工验证。样本很短、只有两位说话人，标注未由本项目逐句听审，模型训练重合未知；不据此选定默认引擎。

四份原生报告位于 `cache/asr-evaluation/studio-worker-runs/`：

- `2026-10-20T23-17-05.344Z-paraformer-cuda/report.json`
- `2026-10-20T23-18-43.232Z-whisperx-cuda/report.json`
- `2026-10-20T23-20-00.206Z-paraformer-cpu/report.json`
- `2026-10-20T23-21-40.067Z-whisperx-cpu/report.json`

## M2 与回归

每组 `desktop-input/` 保留真实文稿的受控副本及源报告/文稿摘要，160/160 通过 M2 格式、音频哈希与完整覆盖校验。两组 GPU 对清单中最长的 `aishell3-SSB17110285` 完成实际播放、导入、点句跳转、高亮和重启复用；截图已检查。播放的是 worker 实际使用的完整原句重采样版本，不宣称测试了原始 44.1 kHz 容器或人工同步误差。

新增可重复入口 `asr:desktop:prepare`：只接受完整成功的原生参考运行，核对源清单、源音频和文稿；重复导出保留相同结果，所有权或内容变化时拒绝覆盖。M2 桌面测试也使用有期限的正常退出和测试进程清理。

`npm run check` 的类型、lint、格式及 63 项单元/模块检查通过；`npm run test:worker` 的 9 项 Node 协议和 61 项 Python 检查通过，其中包括新增五项标注解析检查。旧 AISHELL-4 worker 记录由新汇总入口复算，仍为 37/610，作为兼容检查；没有重复执行其模型推理。本轮不改写产品 ASR 脚本或模型，也没有重建 out 或运行受限的主程序 EXE/NSIS。

导出入口另用实际文稿的独立副本验证了首次导出、重复导出保持字节/修改时间，以及操作字段被改写后拒绝覆盖，记录为 `cache/asr-evaluation/worker-desktop-export-regression/2026-10-20T23-36-34.277Z/regression.json`。此项是导出工具检查，不另计模型样本。

本轮独立 ASR workers 和两次 M2 窗口验证与[整书播放检查](LONG_PLAYBACK.md)同时发生，条件记入该长检查的 `external-evaluations.jsonl`。播放器内没有转写任务；该时段不能称为全系统空闲性能基准，也不能作为同应用边听边转写的长期验收。

## 重复运行

Windows 准备工具使用系统 `tar.exe` 读取原 RAR，FFmpeg/ffprobe 来自已准备的组件。默认输出为上述 cache 目录；缺少媒体时显式 `--download`，也可以 `--archive` 指向同一固定原包。已有完整清单只校验；部分输出保留并要求新目录。

```powershell
python -B -X utf8 python/studio_reference.py --download --ffmpeg "<ffmpeg.exe>" --ffprobe "<ffprobe.exe>"
npm run asr:reference -- --component "<component.json>" --engine paraformer --studio
npm run asr:reference -- --component "<component.json>" --engine whisperx --studio
# CPU 两组在相同命令末尾加 --cpu；依次运行。
python -B -X utf8 python/reference_summary.py "<报告1>" "<报告2>" "<报告3>" "<报告4>" --output "<新汇总.json>"
npm run asr:desktop:prepare -- "<worker运行目录>"
npm run asr:validate -- "<worker运行目录>/desktop-input"
npm run asr:desktop -- "<worker运行目录>/desktop-input" aishell3-SSB17110285
```

这些是独立模型检查，不在普通 CI 下载数据或模型。长书人工参考、角色对话、广告、原书三个待听审切点及人工发音时间偏差仍按原计划跟踪，见 [计划](PLAN.md)和[窗口拼接记录](ASR_OVERLAP.md)。
