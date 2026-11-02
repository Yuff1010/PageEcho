# 独立转写组件包

当前 `0.37.0-dev.1` 使用兼容补丁组件 `0.8.0-sec.1`／`0.8.0-cpu-sec.2`。旧 `0.7.0`／`0.7.1-cpu.1` 的新导入与能力检查因已知依赖问题停用，原目录和历史记录保留。剩余框架告警与模型加载边界见 [依赖安全](DEPENDENCY_SECURITY.md)。当前没有远程组件 feed。入口及范围见 [按需安装](COMPONENT_INSTALLATION.md) 与 [CPU 组件](CPU_COMPONENT_BUILD.md)。

以下保留原通用包的构建与兼容历史，其中旧版本“兼容”不代表当前已通过安全门槛。

dev.6 兼容补充：当前应用的 WhisperX 音频末端修复继续使用原 0.7.0 ZIP。真实 43 分钟 MP3 已在只读应用/组件、隔离 PATH 和进程级离线条件下完成 87 块、续接、纠错保护、取消、缓存清理及重启九阶段检查；系统 Python 不参与。运行后 35,468 个文件的大小和 SHA-256 全量核对通过，见 [dev.6 长篇回归](WHISPERX_AUDIO_BOUNDS.md)。这仍是开发设备上的组件独立性验证，主程序安装、干净设备及人工质量未因此通过。

兼容更新：0.8.1 主程序可继续使用此 0.7.0 ZIP。Paraformer 时间戳兼容与按需中文 CTC 重新对齐随主程序 worker 脚本提供；所需模型/依赖已在包中，组件文件不变，完整摘要和只读/离线应用验证通过，见 [修复验收](PARAFORMER_TIMESTAMPS.md)。

0.7.0，2026-10-20，Windows x64。组件是可选 ZIP，主程序与组件分别准备；普通播放和人工文稿不需要它。主程序 NSIS/运行仍受本机 Code Integrity 限制，独立组件验证不代表主程序安装或干净设备验收已通过。

## 使用

1. 完整解压 `release/ReadAndListenBook-ASR-0.7.0-win-x64.zip`，保留整个目录。ZIP 为 8,654,001,336 字节（约 8.1 GiB），解压资源为 13,427,330,601 字节（约 12.5 GiB），请为压缩包和解压内容预留空间。
2. 在 0.7.0 应用“缓存与任务 → 选择组件配置”中选择解压目录的 `component.json`；无需安装 Python、Node.js、pip 或激活虚拟环境。
3. 选择引擎和 CPU/GPU 后生成。GPU 路径需要兼容 NVIDIA 驱动，CPU 路径在本机已实测；任务期间不下载模型。移动组件后重新选择配置。

目标 Windows 还需要兼容的 Microsoft Visual C++ x64 运行库。本机探测确认 MSVCP140 来自 System32，包内只带部分基础 VC DLL；这项系统依赖没有被 Python 路径隔离消除。缺少时使用[微软官方运行库入口](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)获取 x64 Redistributable，离线设备需预先备好安装器。没有复制系统 DLL 或在本机重复安装；实际加载位置记录为 `cache/asr-runtime-source/native-runtime-probe.json`，官方下载和签名记录为 `vcredist-info.json`。干净设备安装该前置条件仍待验收。

包包含 Python 3.12.10、140 项固定依赖、Paraformer/WhisperX 候选模型、FFmpeg/ffprobe 和 NLTK 资源。当前依赖使用已评估的 PyTorch 2.8.0+cu128，因此包也包含 CUDA 相关库；不将其宣称为最小 CPU 专用包。默认引擎仍未选择。

ZIP SHA-256：`e4f569493844546e8cc5ee4c420e54e6987dbc9b36194170cab5e33188ebc0fd`。ZIP64 已使用 Windows 自带 `Expand-Archive` 实际解压。没有向组件包放入原歌曲、转写稿、用户数据库、任务缓存、开发虚拟环境启动器或 pip。

## 配置与运行边界

```json
{
  "version": 2,
  "python": "python/python.exe",
  "models": "models.json",
  "resources": "resources",
  "ffmpeg": "tools/ffmpeg.exe",
  "ffprobe": "tools/ffprobe.exe"
}
```

v2 仍为六个字段，资源位置相对配置文件解析。主进程把任务缓存固定到自己的用户数据目录 `cache/asr/`；模型、依赖及断句资源留在组件目录。旧 v1 的显式 cache 配置保留支持，不接收任意 worker 脚本。

Python 使用官方嵌入式发行版和固定 `_pth`，仅搜索自身标准库、根目录和私有 site-packages。应用用 `-B` 避免写字节码，worker 只补入应用自带脚本目录，不补入调用者 cwd。模型路径以 models.json 所在目录解析。启动时组件配置异步加载，缺失或缓慢组件不阻塞主窗口；迟到加载不能覆盖用户的新选择。

分发方案依据 [Python 嵌入式包说明](https://docs.python.org/3.12/using/windows.html#the-embeddable-package)。第三方依赖由开发侧按已验证版本随包提供，用户不在运行时调用 pip。官方 ZIP 来源和固定摘要记在 `python/embedded-python.json`，与 Python 官方 HTTPS 发布的 [Sigstore 文件中的 artifact digest](https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip.sigstore)一致；没有声称完成 Sigstore 证书链的独立验证。解出的 python.exe Authenticode 为 Valid，签名主体 Python Software Foundation。系统 UCRT/兼容驱动等仍是目标设备环境条件。

## 构建与验证

开发者先按首轮评估准备并固定环境、模型及工具，再运行：

```powershell
npm run asr:bundle
# 可选 --component、--output、--archive；输出必须是新目录/新文件，不覆盖已有组件
```

构建器只取锁定依赖的已安装文件，排除原虚拟环境启动器、外部 console entry points、pip 和诊断工具；模型 snapshot 链接复制为普通文件。依赖自带许可证和模型说明保留。每个文件有大小和 SHA-256 清单，未完成构建保留 BUILDING 标志，未完成压缩包保留 .partial，不当成完成产物。

实测包有 35,468 个清单文件，构建日志为 `cache/asr-runtime-source/build-0.7.0.log`。已通过：

- 在只保留 Windows 系统 PATH、清除 PYTHONHOME/PYTHONPATH 后运行包内解释器；isolated=1，sys.path 和 torch 模块全部位于包内，见 `runtime-probe.json`。
- 包内 CPU 完成中文对照转写、重复/重启缓存复用和取消，报告 `cache/asr-evaluation/worker-runs/2026-10-20T05-23-09.912Z/report.json`。
- 迁移后 Paraformer CPU 也完成上述对照及协议检查，报告 `cache/asr-evaluation/worker-runs/2026-10-20T05-40-51.936Z/report.json`；该引擎实际 float32 写入配置摘要，未将 WhisperX 的 int8 参数当作其精度。
- ZIP 迁移到 C 盘中文和空格目录，35,468 文件逐一摘要核对通过，见 `cache/asr-runtime-source/relocated-integrity.json`。
- 迁移目录组件在真实源码应用中，通过整首歌曲生成、部分退出、同任务恢复、纠错保护、预览采用、CPU 取消不打断播放、清理以及零缓存命中的重新生成；报告 `cache/asr-evaluation/app-runs/2026-10-20T05-32-07.046Z/report.json`。
- WhisperX 和 Paraformer 验证后，全部文件再次通过摘要核对，见 `cache/asr-runtime-source/relocated-integrity-final.json`。缓存写入独立用户目录，组件资源保持不变。

以上环境仍是同一台有开发工具和 NVIDIA 驱动的电脑；隔离搜索路径与文件迁移是具体的独立性证据，不能替代真实无开发环境设备上的主程序安装和长期使用验收。应用内下载/更新器、完整异常环境及 M3 人工质量检查继续按计划跟踪。
