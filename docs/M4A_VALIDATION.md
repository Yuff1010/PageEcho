# 原始 M4A 播放验收（0.8.4）

日期：2026-10-20（America/New_York）。使用两份发布方原始 M4A 朗读文件补充格式检查。它们是英文录音，只作为播放器输入，不进入中文模型准确率评估。

## 来源与编码

来源为 [Audiobook Sample](https://archive.org/details/AudiobookSample)（Nicolette Chinomona）和 [Hard Speed](https://archive.org/details/HardSpeed)（Chris Uphues 著，Mike Fleming 朗读）。发布页分别标记 Public Domain Mark 1.0 和 CC0；具体原文件大小、SHA-1、MD5、`source: original` 来自各自的 [Sample 文件元数据](https://archive.org/metadata/AudiobookSample)和 [Hard Speed 文件元数据](https://archive.org/metadata/HardSpeed)。

| 发布方原文件           | 大小（字节） | 容器时长  | 实际音频编码             |
| ---------------------- | -----------: | --------- | ------------------------ |
| `Audiobook Sample.m4a` |    2,865,118 | 05:50.505 | AAC LC，44.1 kHz，单声道 |
| `HardSpeed.m4a`        |   98,713,356 | 50:25.305 | AAC LC，44.1 kHz，双声道 |

Archive 的格式标签是 `Apple Lossless Audio`，但文件内容探测结果均为 AAC LC，因此本次没有验证 ALAC。没有转码或更换扩展名。

本地清单为 `cache/asr-evaluation/m4a-source/manifest.json`，SHA-256 为 `29f34045091e8345ffaabd93df97dd7897c7228afbe2c3d2269af7494001234b`。两份媒体的 SHA-256 分别为：

- Sample：`1aa6eebbf2333ba9ab462e10b730771abcf588e69c248f4eace206fca9c48256`。
- Hard Speed：`f1bce5a6db2e9da6339ee69e0a844916e43aa9c487741f786250fbcecd6410cd`。

`python/prepare_m4a_samples.py` 只在显式指定 `--download` 时获取固定文件；下载及缓存读取均核对发布方大小/SHA-1/MD5。再次准备不会修改已有清单；不一致时报错并保留旧文件。元数据快照与准备审计保存在 `cache/asr-evaluation/m4a-source-discovery/`。原有《呐喊》来源清单与历史报告保持原样。

## 播放检查

报告 `cache/asr-evaluation/audiobook-playback/2026-10-20T10-18-11.679Z/report.json` 通过，独立核对见同目录 `m4a-audit.json`。检查使用隔离用户目录、原文件副本和真实 Electron 媒体协议；渲染进程离线，PATH 仅包含 Windows 系统目录，播放音量为 0.02。普通播放不调用 FFmpeg 或 Python。

检查范围：两份 M4A 和原有四份 MP3/M4B 的解码、0.75/1.5/2 倍速与 5%/50%/95% 定位；长 M4A 远距离位置的暂停重启恢复；短 M4A 和短 MP3 从头自然播完后自动进入 M4B；原生窗口隐藏/恢复；末集重启及原文件大小、修改时间、SHA-256 不变。测试不改媒体时钟或人为触发 EOF。

实际结果：

- 六个原始文件均通过解码、倍速和定位。M4A 的 HTML 媒体时长分别为 350,505.215 ms 和 3,025,304.671 ms。
- 长 M4A 暂停于 2,874,691.49 ms（47:54.691），重启恢复到同一位置并保持暂停。
- M4A 和短 MP3 在 1 倍速下依次自然播完，真实触发两次 `ended`，进入 M4B 至 10.100 秒。总观察 623.785 秒，即约 10 分 24 秒；两次 `ended` 到下一文件 `playing` 分别为 23/56 ms。
- 原生窗口确认为不可见约 30.290 秒后恢复；此间媒体时间继续推进。页面报告的 `document.visibilityState` 本轮均为 `visible`，不将 IPC 数据称为页面隐藏状态的分类测量。
- 1216 次观察的最大间隔 516 ms，无超过 1.5 秒的未观察区间，未采样到持续媒体时钟停顿或倒退。同应用无活动推理时 IPC p95 为 0.5 ms。采样不能证明声音没有短暂听感问题。
- 显式退出后恢复末集、位置和暂停状态，六份原文件的大小、修改时间及 SHA-256 均不变。截图 `natural-transition.png` 已检查。

主进程、预加载与全部 renderer 构建文件摘要仍与已核对的 0.8.4 资源报告一致；本轮只增加测试、样本准备与记录。TypeScript、该测试入口的 ESLint 和相关文件格式检查通过；准备脚本实际下载/探测及缓存幂等复核通过，没有重复运行无关的模型评估或整套桌面检查。首次预检因测试摘要收集使用了错误的预加载文件后缀，在应用启动前退出；修正为实际的 `index.cjs` 后运行本报告，预检错误保存在 `m4a-source-discovery/playback-preflight-initial.json`。

## 重复运行

```powershell
python -B -X utf8 python/prepare_audiobook_samples.py --download --ffprobe "<ffprobe.exe>"
python -B -X utf8 python/prepare_m4a_samples.py --download --ffprobe "<ffprobe.exe>"
npm run build
npm run test:audiobook -- --m4a
```

不带 `--m4a` 的旧播放入口仍只使用原有《呐喊》清单。准备媒体时需要 ffprobe；播放检查本身只需要源码应用及已准备的原文件。

上述短测没有覆盖完整 50 分钟 M4A 或 4 小时 38 分钟 M4B。后续 M4A 完整终态见下节；人工声音听感、中文转写和发音边界仍未评定。M4B 仍按单个音频处理；未新增内嵌章节功能。主程序安装及干净设备验收继续保留。

后续在独立数据目录补充完整 50:25.305 的 M4A 自然播放、切集及重启检查，最新终态见下节和 [整书检查](LONG_PLAYBACK.md)。它与 M4B 长检查并发，两个实例的资源与进度证据分别保存。

## 完整 50 分钟重跑状态更新

用户已确认在长测窗口操作过暂停或静音，原 `2026-10-21T00-02-45.619Z-m4a` 保留为中断，最后暂停位置 31:27.402。第二轮 `2026-10-21T00-42-33.284Z-m4a` 在 37:50.533 暂停，用户确认“操作过暂停或媒体键”，runner 正常退出，原失败证据保留。

`2026-10-21T01-29-43.885Z-m4a` 已于 02:20:21.487 UTC 完整通过，独立审计也通过全部检查：原 M4A 从零、音量 0、1 倍速自然播完 50:25.305，真实 ended 后 55 ms 自动进入 MP3，继续约 10 秒，正常暂停/退出并重启恢复。3,001 次观察、最大间隔 1,076 ms，没有观察到中途暂停或时间跳变；原文件与构建不变。仅测试页面锁定了播放控件/媒体动作，不改变音频时钟或正常产品。静音结果不代表人工听感或物理媒体键验收；M4B 完整长测也已于 06:08 UTC 完成并通过独立审计，见 [长测记录](LONG_PLAYBACK.md)。
