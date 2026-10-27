# 官方 CPU 运行库组件

`python/build_cpu_component.py` 是开发者离线打包器，不调用 pip，不修改评估虚拟环境、原组件或系统 Python，也不在运行时下载依赖。原 0.7.0 组件继续保留。

## 输入与替换规则

基础输入是 `release/asr-component-0.7.0-win-x64`，其 `bundle-manifest.json` 固定 SHA-256 为 `870f19478ef78a0070882e5498c73f438c0291f567948cd1911ac41556d22454`。构建先校验该摘要，再核对原组件全部文件的大小、SHA-256 和文件集合，拒绝 BUILDING、链接或额外文件。

`python/requirements-cpu.txt` 是原 140 项固定依赖清单，仅替换以下三项；其余 137 项版本和文件保持原样。wheel 来源及下载校验记录位于 `cache/optimization/cpu-wheels-2026-10-23/verified-wheels.json`。

| 官方 cp312 Windows x64 wheel                     |      字节数 | SHA-256                                                            |
| ------------------------------------------------ | ----------: | ------------------------------------------------------------------ |
| torch-2.8.0+cpu-cp312-cp312-win_amd64.whl        | 619,352,539 | `2be20b2c05a0cce10430cc25f32b689259640d273232b2de357c35729132256d` |
| torchaudio-2.8.0+cpu-cp312-cp312-win_amd64.whl   |   2,495,725 | `9b302192b570657c1cc787a4d487ae4bbb7f2aab1c01b1fcc46757e7f86f391e` |
| torchvision-0.23.0+cpu-cp312-cp312-win_amd64.whl |   1,600,844 | `a651ccc540cf4c87eb988730c59c2220c52b57adc276f044e7efb9830fa65a1d` |

索引为 PyTorch 官方 [Torch CPU](https://download.pytorch.org/whl/cpu/torch/)、[Torchaudio CPU](https://download.pytorch.org/whl/cpu/torchaudio/)、[Torchvision CPU](https://download.pytorch.org/whl/cpu/torchvision/)。固定摘要写在打包器中，输入目录里的自述摘要文件不会成为新的信任依据。曾因 512 MiB 下载上限留下的 Torch `.partial` 文件不参与构建；使用完成并通过摘要的 619,352,539 字节 `.whl`。

构建器按原三份 distribution 的 RECORD 移除全部所属文件，包括 `functorch`、`torchgen`、`torio` 与 dist-info，不按“文件名含 CUDA”删除 DLL。随后验证 CPU wheel 整包 SHA、ABI、完整 RECORD 文件集合；解压时逐项验证 RECORD SHA-256、大小及 ZIP CRC，保留完整 wheel 的许可证、静态 `.lib` 等文件。官方 torchvision wheel 的 RECORD 使用反斜杠，构建器仅在解析 RECORD 时规范化；ZIP 文件名仍必须是安全的正斜杠相对路径。

`--engine both|paraformer|whisperx` 可以选择模型角色，不裁剪 Python 依赖。Paraformer 保留 paraformer / vad / punctuation / alignment；WhisperX 保留 whisper / punctuation / alignment。模型 revisions、FFmpeg、断句资源保持原版本。

## 本次构建

```powershell
python -B -X utf8 python/build_cpu_component.py `
  --base release/asr-component-0.7.0-win-x64 `
  --wheels cache/optimization/cpu-wheels-2026-10-23 `
  --output release/asr-component-0.7.1-cpu.1-win-x64 `
  --version 0.7.1-cpu.1 --engine both `
  --archive release/ReadAndListenBook-ASR-0.7.1-cpu.1-win-x64.zip `
  --report cache/optimization/cpu-component-build-0.7.1-cpu.1.json
```

输出目录、ZIP、`.partial` 及报告目标必须是新路径。复制后的新目录再次全量校验，再生成 ZIP64；构建失败会保留 BUILDING 标志，压缩失败可能保留 `.partial`，均不当作完成产物。输入验证失败时不会创建新输出目录。

这次包含全部五种模型角色的组件有 35,427 个清单文件，payload 为 9,159,714,680 字节，另有 7,360,277 字节 manifest。Python 与依赖从 8,329,846,560 降至 4,062,226,465 字节。新 manifest SHA-256：`f88c9095ddacc33ad2d1c21a19a6c073c064833481a4bfef85e54d5662ef2cbe`。

最终 ZIP 为 5,719,989,091 字节，SHA-256：`6b17c282ab0db7deb9aeee6705a60ae93b7e9f4099702ead98faaba0ff19d0f5`。完成报告为 `cache/optimization/cpu-component-build-0.7.1-cpu.1.json`，完整日志为同名 `.log`。构建器 SHA-256 为 `1938d6cfc9263903981f6d8646d391a09a611ed1932d1d6d010e9000c006bdfe`，CPU 锁文件为 `f79a881e4bc8d2b6702cd8936573f20dca1379ce78f4ff337e5094cd620de17a`。

完整 CPU Torch wheel 仍含约 2.3 GB 的 `dnnl.lib` 等静态开发资源，因此本次没有宣称是最小运行时，也没有声称降低模型权重内存。新包只支持 CPU；`runtime-profile.json` 与 `build-provenance.json` 记录该约束、组件版本、原包摘要、官方 wheels、锁文件及打包器摘要。`component.json` 仍是兼容的六字段 v2。应用受管安装目录的可信 catalog 应同样限定 `devices: ['cpu']`，在创建安装计划和启用前拒绝 CUDA；仅靠包内自述不能授权新的能力。

替换后的 Torch / Torchaudio 版本进入现有 worker 配置摘要，CPU 包具有独立缓存身份。旧组件创建的任务不能静默放宽配置检查或借重试跨版本复用结果。

## 验证边界

新增 5 项小单测覆盖完整所属文件替换、其它内容只读保留、静态库与许可证、模型选择、独立 ZIP、Windows RECORD 分隔符、ABI/路径/SHA/锁文件异常、失败 BUILDING 及输出不覆盖；原有 6 项组件包测试也通过。

本次构建的输入与输出均进行了全文件哈希校验。构建过程不导入 Torch、不执行 wheel 内代码、不加载模型。运行库导入、模型推理和主程序安装各自独立验收，不能由打包成功推断。公开组件 feed 尚未发布或配置，本地 ZIP 的存在不代表远程更新已可用。

后续独立导入阶段已通过，见 `cache/optimization/cpu-component-acceptance-2026-10-23/imports.report.json`。只保留 Windows 系统 PATH、清除 PYTHONHOME/PYTHONPATH 后，嵌入式解释器 `isolated=1`，初始 sys.path 仅有 CPU 组件路径；Torch / Torchaudio / Torchvision 实际均为上述 `+cpu` 版本，`torch.version.cuda=null`、`cuda.is_available=false`。默认 prerequisite probe 的两项 CPU capability 可用、两项 CUDA capability 不可用。阶段结束后组件 35,427 个文件的全部大小及 SHA-256 不变。

独立模型阶段也已通过，见同目录 `models.report.json`。使用已有 AISHELL-4 连续人工参考样本 `continuous-solo-first.wav` 原媒体 0–30000 ms，音频 SHA-256 为 `0153ed14924506d1139bdb6695c0236734f4d3e5068f181f7b958cf765838868`。两个引擎顺序执行，各使用新缓存、1 CPU 线程、低进程优先级、进程离线限制及固定 FFmpeg 工具。实际 Torch intra-op / inter-op 均为 1；ready 配置记录 Torch / Torchaudio `2.8.0+cpu`，由生产 Node 协议解析器验证结果。

| 本机单次观测         | Paraformer CPU |  WhisperX CPU |
| -------------------- | -------------: | ------------: |
| 一次 30 秒片段冷生成 |       36.260 s |      41.437 s |
| 同配置缓存重放       |          82 ms |         85 ms |
| 缓存命中             |            1/1 |           1/1 |
| 所属 worker PID      |  13800，已退出 | 10768，已退出 |

重放不再进入解码、加载或识别阶段，文字、时间和 segment ID 完全相同。Paraformer 新 CPU 包的缓存键与旧 cu128 包同音频、同范围、同 1 线程键不同，未跨版本复用。原生 stdout JSONL、stderr、请求、配置和 runner/source SHA 保留在各引擎子目录及 `sources/`。

模型结束后，CPU 新包 35,427 文件 / 9,159,714,680 字节和原 0.7.0 包 35,468 文件 / 13,427,330,601 字节均全量哈希通过，两个原 manifest 摘要仍等于固定值。`acceptance-binding.json` 绑定 28 份执行证据，SHA-256 为 `58e81a998528f66beb4529f1b3cdea43b3b6f7654ea58820f7e7f0e1ef66387d`。

这些数据只证明新 CPU artifact 的依赖、两引擎有界执行、缓存及只读输入保护。没有新增人工识别质量分母，没有对不同引擎或设备作基准排名；未清系统文件缓存，也未关闭用户的其他应用。应用内完整安装、启用、回滚和干净设备仍由对应 Main 流程另行验收。
