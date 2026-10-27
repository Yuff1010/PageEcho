# 影视对白识别诊断

本页保留首轮诊断及失败证据。后续 `0.10.0-dev.6` 已定位并修复识别区间超出实际音频末端造成的对齐换算问题，同一清单 WhisperX CPU/GPU 各完成 18/18，见 [末端修复](WHISPERX_AUDIO_BOUNDS.md)。

日期：2026-10-21（America/New_York）。补充 CH-SIMS 原始数据集官方 test 划分中的固定 18 段、10 个源视频组，共 55.425 秒、244 个归一化参考字。Paraformer CPU/GPU 各完成 18/18；WhisperX GPU 完成 15/18，CPU 完成 14/18，其余为 `ALIGNMENT_FAILED`。失败保留在分母，整体质量和默认引擎仍待验收。

## 来源与选择

[发布方页面](https://thuiar.github.io/sims.github.io/chsims)链接的原始 CH-SIMS [Google Drive](https://drive.google.com/drive/folders/1oplJ15kdS_OK0wHXycI8p77jnmwAHhbG)提供标签 CSV 与独立 MP4。[原始论文 §3.3](https://aclanthology.org/2020.acl-main.343.pdf)说明，中英文文本由人工转录，素材来自影视和综艺。这里使用原始数据集，不使用 v2 无监督集的未校正 ASR 文本。

推理前固定选择：官方 test 中按源视频 ID 排序取前十组，每组按片段编号取前两段；不足两段保留已有段。没有按字数、时长、情绪、背景或模型结果筛选。`video_0004`、`video_0008` 各一段，最终为 18 段；失败后没有换样本。

原始标签为无表头的 2,281 行 CSV，221,618 字节，SHA-256 为 `c7cdb97d9270b8cd975fd01cbf9b79e3526162be73634a50e0c622acdf16ae15`。18 份原始 MP4 共 36,042,395 字节，逐文件 Drive ID、大小和 SHA 固定于 `python/chsims_sources.json`。本地获取记录为 `cache/asr-evaluation/chsims-source/2026-10-21T07-16-27.175Z/acquisition.json`，不保存临时下载凭据。

完整音轨仅转换为单声道 16 kHz PCM16；没有裁剪、拼接、静音或去除背景。每次加载清单都核对原始文件、标签、工具和 WAV 哈希，并重新解码原 MP4 比较完整 PCM 字节、帧数和时长。清单为 `cache/asr-evaluation/public-reference/chsims-film/manifest.json`，SHA-256 为 `1462a41e250bd63756e2dc56e7d9e61744b647185c5be2c3dd59d18367c8e778`。

## 四组实际 worker 结果

使用固定的离线组件、真实应用 worker 及相同清单，依次执行。完成段均验证首次缓存命中为零及全部块重放；两组完整成功的 Paraformer 另通过 worker 重启复用。保留入口源码快照、配置、报告、原始检查点和生成文稿。CER 使用既有 NFKC、大小写、标点/空白归一化，不作繁简、数字读法或口语改写。

| 引擎/设备      | 完成/固定总数 | 已完成段编辑数/参考字 | 已完成段 CER | 整个固定集合 CER |
| -------------- | ------------- | --------------------- | ------------ | ---------------- |
| Paraformer GPU | 18/18         | 24/244                | 9.84%        | 9.84%            |
| Paraformer CPU | 18/18         | 24/244                | 9.84%        | 9.84%            |
| WhisperX GPU   | 15/18         | 34/216                | 15.74%       | 无法计算         |
| WhisperX CPU   | 14/18         | 28/201                | 13.93%       | 无法计算         |

WhisperX GPU 的失败为 `video_0005/0010`、`video_0007/0004`、`video_0009/0011`；CPU 另有 `video_0005/0002`。报告保留实际错误，没有补造词时间或删除失败段。本轮结束时尚未定位根因，后续诊断与修复另见页首链接。完成段 CER 使用不同子集，不能直接把 CPU/GPU 两个数作为整体优劣比较。

四份报告位于 `cache/asr-evaluation/film-worker-runs/`：

- `2026-10-21T07-30-11.306Z-paraformer-cuda/report.json`
- `2026-10-21T07-32-22.194Z-whisperx-cuda/report.json`
- `2026-10-21T07-36-18.922Z-paraformer-cpu/report.json`
- `2026-10-21T07-36-38.723Z-whisperx-cpu/report.json`

汇总为 `cache/asr-evaluation/film-summary-four-groups.json`。`python/film_summary.py` 从原始块重建文稿，与实际 worker 文稿和告警逐项比较，再计算编辑数；旧 v1 组件使用记录的绝对缓存根，现有连续参考的默认运行目录规则保持不变。汇总拒绝清单、入口快照、媒体身份或样本集合被更改，也拒绝覆盖已有结果。

两组 Paraformer 的 36 份文稿经现有 `asr:desktop:prepare` 导出并通过 `asr:validate` 格式、音频哈希和完整覆盖校验。本轮没有新增 M2 桌面操作结果；失败的 WhisperX 集合未作为完整成功运行导出。

## 适用边界与复验

这是一批短影视片段的局部诊断。源视频分组不是说话人身份；没有逐段音乐标签、连续对话关系或人工发音时间，模型训练重合未知。本项目未逐句听审发布方文本。它补充影视对白来源证据，不能据此完成背景音乐、多人重叠、广告、长书专名、同步精度或默认引擎验收。媒体与标签仅保留在忽略的本地缓存，不进入应用分发。

```powershell
python -B -X utf8 python/chsims_reference.py --source-root "<固定原始目录>" --output "<新清单目录>" --ffmpeg "<ffmpeg.exe>" --ffprobe "<ffprobe.exe>"
npm run asr:reference -- --component "<component.json>" --engine paraformer --film "<manifest.json>"
npm run asr:reference -- --component "<component.json>" --engine whisperx --film "<manifest.json>"
# CPU 两组在对应命令末尾加 --cpu，依次运行；失败保留。
python -B -X utf8 python/film_summary.py "<报告1>" "<报告2>" "<报告3>" "<报告4>" --output "<新汇总.json>"
```

普通测试仅使用虚构 CSV、媒体字节及检查点，不下载素材或模型。新增检查覆盖选择规则、原始标签/媒体/工具变化、重算哈希后的 PCM 篡改、失败分母、遗漏/重复样本、原始块变化，以及旧缓存根与默认运行目录兼容。产品代码、模型、0.8.4 基线及 dev.5 预览资源保持原版本；安装升级、干净设备和实际听审继续按 [开发计划](PLAN.md) 跟踪。

本轮 `npm run check` 的类型、lint、113 项逻辑及格式检查通过；`npm run test:worker` 的 9 项协议与 93 项 Python 检查通过，其中新增影视诊断测试 12 项。独立审计 `cache/asr-evaluation/film-verification/2026-10-21T07-44-33.132Z-sepOVq/verification.json` 核对四份报告、汇总代码、63 份产品源码、8 份预览输出、5 份原输出、9 份 ASR 分发资源及已有预览 ZIP，均保持一致。已有 dev.5 的 36 项桌面报告保留原验收范围。
