# M3 独立转写组件

状态：Python worker、Node 控制器、SQLite 队列和阅读界面已接通，支持逐块文稿、取消/重试、重启续接、生成稿预览和小范围纠错。组件可独立运行，也可从应用内使用。0.4.0 整首歌曲流程见 [应用验收](M3_APP_VALIDATION.md)；产品默认引擎仍未确定。

## 运行与验证

模型准备与独立 Python 环境见 [首轮评估](M3_EVALUATION.md)。准备命令现在也补齐 WhisperX 需要的 NLTK punkt_tab 资源。worker 仅使用本地已准备组件，不在任务期间下载模型或缺失资源。

```powershell
# 无模型、无私有音频：Node 进程协议测试 + Python 分块/缓存测试
npm run test:worker
# 将这些检查加入统一验证，仍不下载模型
npm run verify -- --asr
# 使用准备清单中的真实歌曲、CUDA int8_float16、每块 30 秒
npm run asr:worker
# 使用原创中文对照，验证完整 CPU int8 worker 路径
npm run asr:worker -- --cpu --control-only
```

真实模型验收逐块接收文稿，重复任务检查所有分块命中缓存，再重启 worker 检查缓存复用，最后提交取消请求确认不发布成功结果。报告、文稿和日志保存在 `cache/asr-evaluation/worker-runs/<运行时间>/`；媒体和用户数据不提交 Git。

```powershell
npm run asr:validate -- 'cache/asr-evaluation/worker-runs/某次运行'
npm run asr:desktop -- 'cache/asr-evaluation/worker-runs/某次运行' song-1
```

上述命令分别验证独立组件和导入流程。应用内任务与退出恢复使用下节的独立验收命令。

## 应用内配置与使用

0.7.0 用户可完整解压独立离线组件包，然后选择其 `component.json`，无需安装开发环境，见 [组件包说明](ASR_COMPONENT_BUNDLE.md)。以下保留开发环境 v1 的准备方式：先完成评估文档中的 Python 环境、固定依赖、模型和样本准备，再运行：

```powershell
npm run asr:component  # 从本机准备清单生成 cache/asr-evaluation/component.json
npm run build
npm start
# 可选：真实整首歌曲的生成、退出恢复、纠错、预览采用与取消验收
npm run asr:app
```

进入“伴读阅读 → 生成转写稿 → 选择本地组件配置”，选择生成的 JSON。它仅包含以下六个字段；相对路径以 JSON 所在目录为基准，不接受自定义脚本或命令：

```json
{
  "version": 1,
  "python": "venv/Scripts/python.exe",
  "models": "models.json",
  "cache": ".",
  "ffmpeg": "tools/ffmpeg.exe",
  "ffprobe": "tools/ffprobe.exe"
}
```

选择器验证组件文件及目录，并将标准化路径保存在用户数据根目录 `asr-component.json`。选择成功只表示路径有效；依赖、模型和设备在任务启动时检查。worker 固定为应用自带脚本，应用资源附带 `resources/asr/`。独立包 v2 将 `cache` 字段替换为只读 `resources`，缓存由应用放在用户目录 `cache/asr/`；模型清单内相对路径以其所在目录解析，移动包后重新选择配置即可。普通播放不启动模型进程，组件配置读取也不阻塞主窗口。

明确选择引擎与 CPU/GPU 后生成，未预选产品默认引擎。无文稿时逐块应用；已有文稿时独立预览，只有“使用生成稿”才替换。导入或纠错关闭当前任务的自动覆盖；修订号冲突时保留较新内容。生成中自动刷新的稿件暂不编辑，可先取消；小范围纠错保留 ID、起止时间和覆盖区间，超范围修改拒绝。

SQLite 保存 `queued/running/canceling/completed/failed/canceled` 和递增 attempt。重启将 running 重新排队并增加 attempt，将 canceling 记为 canceled；正常退出先保存续接状态，再确认拥有的进程退出。切换章节取消其他章节任务。失败或取消保留完成片段，重试重新检查配置和缓存；组件版本改变时拒绝旧任务续接，可创建新任务。旧 attempt、音频内容变化或取消后的迟到结果不会覆盖文稿。

`asr:app` 使用独立用户数据和新的 checkpoint 目录，复用本机已准备模型；只替换系统文件选择器的返回值，真实执行 preload、IPC、SQLite、FFmpeg 和模型。报告及截图保存在 `cache/asr-evaluation/app-runs/`，不提交私有媒体或文稿。

## 进程与协议

`src/main/asr-process.ts` 使用参数数组、关闭 shell、隐藏窗口启动 `python/asr_worker.py`。Python、模型、缓存与 FFmpeg 的绝对路径由主进程配置；renderer 不能提交路径或命令。每个进程一次只处理一个 attempt，完成后复用已加载模型。

stdin/stdout 使用 UTF-8 JSON Lines。stdout 仅写协议，库的打印与诊断写 stderr；Node 只保留 64 KiB 日志尾部。请求最多 1 MiB，单个结果消息与缓存文件最多 16 MiB，文稿最多 100,000 段。Node 使用真实 M2 校验器验证音频哈希、顺序、覆盖范围和时长；不接受未经校验的模型文稿。

提交示例（路径与哈希须替换为真实资产）：

```json
{"protocolVersion":1,"type":"submit","jobId":"2ea382ae-8a70-45c5-9db3-65dce30309c3","attempt":1,"audioPath":"C:/books/chapter.flac","audioHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","range":{"startMs":30000,"endMs":90000}}
{"protocolVersion":1,"type":"cancel","jobId":"2ea382ae-8a70-45c5-9db3-65dce30309c3","attempt":1}
```

`endMs: null` 表示处理到 ffprobe 读取的音频末尾。range 始终采用原媒体毫秒，不修改片头、广告或章节坐标。

| 消息            | 主要字段与含义                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| ready           | configuration：依赖、模型 revision、设备、参数和解码/断句资源摘要；不等于模型已加载                             |
| accepted        | jobId、attempt：已接收任务                                                                                      |
| progress        | stage、processedUntilMs：validating / decoding / loading / recognizing / punctuation                            |
| partial         | document、processedUntilMs、completedChunks、totalChunks、cacheKey、cacheHits、issues：可替换当前前缀的完整快照 |
| result          | 最终 document、durationMs、processedUntilMs、cacheKey、cacheHits、totalChunks、issues                           |
| cancel-accepted | 已收到取消请求，尚非终态                                                                                        |
| canceled        | 已停止这个 attempt，不再发布其结果                                                                              |
| error           | jobId、attempt、code、message：任务失败；已完成分块可复用                                                       |
| fatal           | 组件无法启动，例如 Python 依赖、模型或解码工具未就绪                                                            |

任务消息携带稳定 jobId 与递增 attempt。Node 只接受当前 attempt，忽略旧任务和已取消任务的迟到输出。上层调度器在写 SQLite 前检查任务状态、资产哈希和用户文稿修订，原子应用完整前缀快照；重复快照不增加文稿修订。

## 分块、文字与时间轴

- 默认核心块 30 秒，左右各保留 2 秒上下文；窗口限制在用户请求范围内。FFmpeg 有界解码为 16 kHz 单声道 PCM，每次只加载一个窗口。
- 字/词按时间中点归属一个核心块，再加回 decodeStartMs。跨越切点的词保留完整原生区间，不按固定秒数截掉文字。
- 相邻块的相同后缀/前缀必须同时在时间上重叠且接近，才去重；不删除不同时间的正常重复。时间相交但文字不一致时，两段文字均保留、合为有效阅读区间，并记录 BOUNDARY_CONFLICT。原始输出留在 checkpoint，供人工校正。
- WhisperX 后使用已准备的 ct-punc 在 CPU 恢复中文标点，再按标点、停顿或过长文本拆成阅读段。文字只附着于原有字/词时间，不生成虚构的字符时间。标点模型若改变文字或在不可分词内部插入标点，则保留原文并记录 PUNCTUATION_REJECTED；英文撇号、连字符与 C++ 等符号保留。
- 缺失字/词对齐、无效原生时间或超过边界均使该块失败，不裁剪后假装成功。正常停顿可以没有文字；处理过的空区域仍以 coverage 表示。

上述策略可处理重复和冲突，不保证模型在边界处不会错字或漏字。真实歌曲已出现边界冲突，须人工参考才能判断识别质量；完整质量验收仍未完成。

## 缓存与取消

缓存 key 包含音频 SHA-256、处理范围、引擎/依赖与模型版本、设备/计算精度、分块/重叠参数、解码二进制摘要、NLTK 断句资源摘要、后处理与文稿版本。每个目录有 manifest.json 和原子写入的分块 JSON，保留原始输出、时间、文字及问题标记。

重试或重启后，先复查 checkpoint 的版本、key、窗口、有效时间和归属，再复用完成块。损坏块重新计算，未损坏块不重跑。模型按需加载，完全命中时无需再次加载模型。音频在任务前后计算哈希，解码/推理期间检查大小与修改时间；源版本变化拒绝结果。

Python 的协议读取与计算分开，取消检查覆盖哈希、解码、模型操作之间、缓存写入前及结果发送前。原生推理调用期间不强行注入异常；Node 默认等待 3 秒，未终止则停止它拥有的 Python/FFmpeg 进程树，并在确认进程退出后返回取消。启动期间也能取消。已经完成且有效的 checkpoint 保留供重试复用。

Windows 测试发现：后台线程阻塞读取 stdin 时，NumPy 原生模块首次导入停滞；仅改成主线程计算仍未解决。进程堆栈确认了停滞位置。现由唯一协议读取线程先检查匿名管道可读字节，仅在有数据时读取，模型和原生库操作在主线程执行；真实任务随后完成。API 依据见 [Microsoft PeekNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-peeknamedpipe)。这不是已证明的所有 Windows 环境兼容性结论。

Windows worker 在启动 ML/解码之前创建匿名 Job Object，设置 KILL_ON_JOB_CLOSE 并将自身加入。唯一句柄不继承给子进程，保留到 OS 进程退出；worker 意外崩溃也会回收其后代。不能建立该机制时组件明确启动失败，普通播放仍可用。真实 stdlib 子进程夹具验证崩溃后子进程退出；依据见 [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。未修改系统进程策略。

推理进程启用本地离线约束：Python audit hook 拒绝外部 DNS、TCP、UDP 请求，保留回环/本地 IPC；FFmpeg/ffprobe 输入协议仅允许 file,pipe。准备/下载组件的独立命令继续允许网络。该限制记入 configuration 指纹，旧分块不混用；这是进程约束，不是系统防火墙或原生库沙箱。源码界面同时用 Playwright offline 验证，未断开本机网络适配器。

缓存原子写入失败只清理本次 UUID 临时文件，不删除旧块；ENOSPC/EDQUOT 显示磁盘空间不足，权限/只读错误显示缓存不可写，其他 I/O 错误显示缓存写入失败。音频移走单独提示恢复原路径或重新导入。startup fatal 的有限长度错误会保留至界面；保存有效快照时发生的 SQLite 错误不会误报为模型协议损坏。

SQLite FULL 可能自动回滚，应用只在事务仍活动时回滚，保留原始错误。若连任务终态也无法写入，主进程停止队列并在阅读器/任务列表显示暂存的失败状态；这不冒充持久化成功。释放空间或恢复权限后点击重试，先补存终态再递增 attempt。退出不因中断状态保存失败而漏关 worker；重启根据数据库最后保存的状态及前缀恢复。

## 独立组件的首轮验收结果

2026-10-19（America/New_York），后处理版本 2：

- 真实歌曲 GPU worker：`cache/asr-evaluation/worker-runs/2026-10-20T03-52-48.307Z/report.json`，三首各产生两次前缀快照，最终分别为 14 / 24 / 10 个阅读段。每首重复任务命中 2/2 块，进程重启后再次命中 2/2 块；取消没有发布成功结果。前两首各记录一个边界冲突，第三首无该标记。
- 原创中文对照 CPU worker：`cache/asr-evaluation/worker-runs/2026-10-20T03-55-39.435Z/report.json`，生成 4 个阅读段，重复和重启均命中 1/1 块，取消验证通过。
- 两次运行的已导出文稿均通过 M2 TypeScript 校验器。GPU 三首文稿又分别通过源码桌面播放、原偏移点段跳转、高亮、保持暂停及重启文稿复用，结果为同目录的 song-N.desktop.json。
- `npm run verify -- --asr` 报告 `cache/verification/2026-10-20T03-57-12-640Z/report.json`：22 项基础单元/模块、6 项 Node 进程协议、14 项 Python 指标/分块/缓存测试，开发窗口、生产构建与 15 项源码桌面测试全部通过。真实模型测试是独立的本地验收，不在这个无模型测试数量内。

这轮独立组件验收没有构建安装包，播放器测试使用生成 JSON 导入。后续 0.4.0 已完成应用内生成和安装包脚本资源配置，见 [应用验收](M3_APP_VALIDATION.md)；源码测试不能代替受 Device Guard 限制的打包 EXE 运行验收。

## 尚待完成

0.8.4 后处理版本 3 保存完整 `contextUnits` 并校验缓存归属，利用唯一且时间一致的共有文字位置恢复归属丢字、保护真实叠字。只复制完整原生 unit，无法确定则记录 `BOUNDARY_CONTEXT_UNRESOLVED`。原任务若处理契约变化需重新生成，已有文稿仍保护。115 项逻辑/模块、29 项桌面及真实长篇只读/离线流程通过，证据与待复核位置见 [窗口拼接验收](ASR_OVERLAP.md)。

0.8.3 已修正实际 M4B 暴露的 CTC 长句时间压缩：仅在固定 WhisperX 3.8.6 文件摘要匹配时，给本次调用绑定完整波形目标，不改组件文件或全局函数。WhisperX 与 Paraformer 按需 CTC 共享此路径；`ctcAlignmentObjective` 进入缓存指纹，旧任务运行时契约变化需重新生成，既有文稿仍受预览/采用保护。数值证明、真实样本与质量边界见 [CTC 验收](CTC_ALIGNMENT.md)。

2026-10-20 的 [原始人工参考诊断](HUMAN_REFERENCE_BASELINE.md) 暴露 Paraformer 13/15 段时间越界。0.8.1 已修正参数并对无效原生时间使用中文 CTC 重新对齐，同批 CPU/GPU 适配器与 worker 均完成，完整只读/离线应用流程通过，见 [修复验收](PARAFORMER_TIMESTAMPS.md)。CTC 禁用插值，原始结果与复核标记保留；整体听书质量和默认引擎仍待验收。

M3 继续补齐歌曲人工参考、代表性听书质量、时间偏差与较长音频的资源稳定性，再选择默认引擎。M4 已提供独立组件、缓存管理和首轮源码异常环境测试；干净设备安装、目标设备异常环境及受 Device Guard 限制的打包 EXE 运行验收仍保留。
