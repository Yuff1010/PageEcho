# M4 日常功能验收

2026-10-21 dev.6 补充：冻结生产项目与原 0.7.0 便携组件已在只读目录、隔离 PATH 和进程级断网条件下通过真实 43 分钟 MP3 的 WhisperX 九阶段应用检查。87 块完成、中断续接、重放/清理后重新生成、纠错保护、取消及重启标记通过；三次正常退出，十项写入探测拒绝，ACL 已恢复。662 个生成段与原始块重建一致，完整组件 35,468 文件摘要在运行后复核通过，见 [dev.6 长篇证据](WHISPERX_AUDIO_BOUNDS.md)。61 条复核标记完整保留，人工质量及安装/干净设备仍待验收。

2026-10-21 补充：0.8.4 的完整 50 分钟 M4A 和 4 小时 38 分钟 M4B 自然播放、切集、正常退出与暂停重启均已通过，见 [整书终态](LONG_PLAYBACK.md)。0.10.0-dev.4 已生成可交接的 Windows 目录预览 ZIP，ASAR/依赖/许可证及 84 个 ZIP 条目静态核对通过，见 [预览包验收](PACKAGE_PREVIEW.md)。未运行打包 EXE，未生成该版 NSIS；安装、升级、干净设备与人工声音质量仍待验收。

0.8.4 保存完整重叠上下文并修复拼接丢字/叠字误去重，见 [窗口拼接验收](ASR_OVERLAP.md)。最终回归 `cache/verification/2026-10-20T09-32-28-367Z/report.json` 的 115 项逻辑/模块、29 项源码桌面检查通过；真实 43 分钟章节在只读应用/组件、隔离 PATH 和进程级离线下完成 87 块及九阶段流程。报告 `cache/asr-runtime-source/readonly-offline-20261020T093350.json` 为 passed、ACL 已恢复。当前资源核对 `cache/asr-runtime-source/package-0.8.4.json` 确认 5 个 out 文件、9 个 ASR 资源与构建/源码一致；安装版、干净设备及人工声音质量仍未验收。

0.8.3 修正 CTC 完整波形路径评分，见 [CTC 验收](CTC_ALIGNMENT.md)。最终完整回归 `cache/verification/2026-10-20T09-01-08-003Z/report.json` 的 107 项逻辑/模块和 29 项源码桌面检查通过，另有组件 Torch 的 5 项数值检查通过。资源核对 `cache/asr-runtime-source/package-0.8.3.json` 为当前 5 个 out 文件和 9 个 ASR 资源；没有运行受限 EXE/NSIS，安装版与干净设备验收继续保留。

0.8.3 的真实 43 分钟章节在只读应用/组件、隔离 PATH 与进程级离线条件下完成九阶段应用检查，87 块通过时间/标点审计。报告 `cache/asr-runtime-source/readonly-offline-20261020T090619.json` 的九项 AccessDenied 探测通过，ACL 已恢复；应用报告 `cache/asr-evaluation/app-runs/2026-10-20T09-06-24.047Z/report.json`。仍保留 41 个跨块冲突等复核标记，不据此宣称人工听书质量通过。

0.8.2 补充实际中文 MP3/M4B 和长章节转写，并修复重复补标点，见 [有声书验收](AUDIOBOOK_VALIDATION.md)。完整回归 `cache/verification/2026-10-20T08-34-16-946Z/report.json` 的 104 项逻辑/模块及 29 项源码桌面检查全部通过；开发窗口和生产构建通过。资源核对 `cache/asr-runtime-source/package-0.8.2.json` 确认 5 个 out 文件、8 个 ASR 资源与当前构建/源码一致。没有再次运行受限 EXE/NSIS，主程序安装、安装版异常环境和干净设备仍待验收。

0.8.0 当前增加人工片段标注和折叠，schema 升至 v6，迁移保留 v5 数据。说明与本轮回归见 [片段标注](TRANSCRIPT_REGIONS.md)。以下各历史版本报告保持原范围；主程序安装/干净设备门槛仍未完成。

0.8.0 最终回归：`cache/verification/2026-10-20T06-33-30-582Z/report.json`，88 项逻辑/模块和 29 项桌面全部通过。源码只读/离线真实歌曲的标注保留记录为 `cache/asr-evaluation/app-runs/2026-10-20T06-30-08.760Z/report.json`；本机 ACL 已恢复。最终资源核对为 `cache/asr-runtime-source/package-0.8.0.json`，5 个 out 文件与构建、7 个 ASR 资源与源码一致。仅生成 win-unpacked，未再尝试已知受限的 NSIS/打包 EXE。

日期：2026-10-20（America/New_York）。0.5.0 完成日常收听，0.6.0 增加缓存管理，0.7.0 提供独立离线组件，SQLite schema 仍为 v5。下文保留各版实际报告；M3 质量、完整异常环境及最终发布仍有未完成项目。

## 功能与规则

- 最近播放：只显示已有播放位置的书，保存后实时更新顺序、集名与位置，可直接继续。
- 书签：原始媒体位置绑定具体音频 SHA-256，支持备注、跳转、删除、跨集打开和重启保留；重复添加同一位置不复制。每书最多 2,000 条，每页 20 条。音频变化后旧书签保留备注并禁止跳转，删除书籍级联移除记录，原文件保留。
- 定时停止：1–180 分钟，或当前集结束。分钟定时暂停、托盘隐藏时也按实际经过时间计时；到点阻止自动下一集及待加载音频的迟到自动播放。定时仅本次运行有效，重启不恢复。
- 单书片头/片尾：各 0–3,600 秒，打开章节跳过片头，播放到片尾起点先保存再切集。短于或等于跳过总时长的单集完整播放。书签、进度、转写及点句定位始终使用原媒体时间。
- 片尾检测和原生结束共用完成标记，重复事件不重复切集；手动暂停、定位或加载使旧完成动作失效。进度写入失败时停止切集，显示“重试保存”。

从播放器“收听工具”进入；章节目录的“本书设置与书签”也可在播放之前配置。工具使用模态窗口，关闭后返回原阅读或书架位置。

## 验证

`npm run verify -- --asr` 全部通过，报告：`cache/verification/2026-10-20T04-49-54-599Z/report.json`。TypeScript、lint、格式、36 项基础单元/模块、6 项 Node 进程协议、14 项 Python 测试、开发窗口、生产构建和 23 项源码桌面场景均通过。新增四项逻辑/模块测试：原始位置与音频版本、短单集范围、v4 数据迁移、IPC 边界。迁移测试保留播放位置、倍速、文稿修订和未完成转写任务；原 v3 迁移检查继续保留。

五项新增源码桌面场景使用真实 Electron、preload、IPC、SQLite 和媒体播放：

1. 书签重复添加、备注纯文本、重启、片头设置后的原坐标跳转、最近播放过滤/排序、不同书的设置隔离、音频变化后的禁止跳转与删除。
2. 原时间跳过、重复片尾事件只切集一次、本集结束定时优先、过短单集完整播放。
3. 媒体加载尚未完成时定时到期，后续真实 metadata 到达仍保持暂停。为重现迟到加载，该例仅暂存媒体 URL 赋值再释放；未替换 IPC 或存储。
4. SQLite 更新触发器注入进度写入失败，确认保留当前集、显示错误，移除故障后可重试保存再继续。没有填满磁盘或破坏日常数据目录。
5. 两倍速真实播放、隐藏托盘、推进测试墙上时钟至一分钟截止，确认暂停并保存真实媒体位置；重启后不恢复定时。

三个正常流程仅替换系统文件选择器返回值；时间测试使用 Playwright 时钟，不累计虚构媒体时间。故障注入边界在上述条目明确说明。合成 WAV 和临时用户目录不接触日常书架、模型或原歌曲。书签界面截图已查看。

`npm run asr:app` 在 0.5.0 再次通过真实整首歌曲生成、部分文稿退出、同任务重启续接、缓存复用、纠错保护、预览采用及 CPU 取消不打断播放。报告：`cache/asr-evaluation/app-runs/2026-10-20T04-50-52.450Z/report.json`，状态 passed；同目录截图已查看。该例使用独立临时用户数据和新的 checkpoint 目录，原歌曲及模型保持原处。

## 构建与剩余验收

`npm run dist:win` 成功，安装包为 `release/ReadAndListenBook-0.5.0-win-x64-setup.exe`，112,366,281 字节，未签名。SHA-256：`2AAF78298F57713A2077D87B66930980D6B98B2A40837B3FF462718E1A3B1BFF`。

核对报告：`cache/asr-evaluation/package-0.5.0.json`，构建日志为同目录 `package-0.5.0.log`。`resources/asr/` 的 6 个 Python 模块及 1 个模型 revision 清单与源码 SHA-256 一致，无多余文件。`app.asar` 版本为 0.5.0，未包含 cache、models、media、venv、tests 或 python 开发目录。

此前打包 EXE 受本机 Device Guard 限制（4551）；本轮未修改系统策略或重复启动已知受限程序，构建成功不能代替安装程序和打包程序运行验收。

## 0.6.0 管理功能

已接入分块占用/清理、组件和模型位置、每页 25 条的任务历史、活动过滤、取消/重试、最新本机日志及固定目录入口。清理前预览、确认后重查，排队或运行任务阻止清理；清理与生成、重试、组件配置及退出互斥。未知数据和链接保留，文稿与模型不删除，规则见 [缓存管理](CACHE_MANAGEMENT.md)。

`npm run verify -- --asr` 全部通过，最终报告：`cache/verification/2026-10-20T05-07-31-134Z/report.json`。TypeScript、lint、格式、45 项基础单元/模块、6 项 Node 进程协议、14 项 Python 测试、开发窗口、生产构建及 25 项源码桌面场景均通过。新增 9 项逻辑/模块与 2 项桌面流程覆盖目录和内容替换、junction、未知文件、指纹伪造、组件配置变化、维护租约、任务分页和日志。管理界面截图已查看。

真实歌曲报告 `cache/asr-evaluation/app-runs/2026-10-20T05-03-29.592Z/report.json` passed：完整保留生成、退出续接、纠错、预览及取消验收，再新增活动任务阻止清理、界面清理不改文稿、清理后重新计算且缓存命中 0。清理仅发生在本次测试新建的隔离 checkpoint 目录，未删除日常模型或原歌曲。同目录 `maintenance.png` 已查看。

0.6.0 的 `npm run dist:win` 在 NSIS 生成卸载器时失败，输出 `spawn UNKNOWN`。Windows Code Integrity/Operational 于本地 2026-10-20 01:08:58 的 3033/3077 事件，明确记录 node.exe 尝试启动构建临时程序时因企业签名/完整性策略被拦截。读取构建工具源码确认该阶段需要执行临时安装程序写出卸载器；没有修改系统策略、换路径重试执行或绕过限制。

**没有可用的 0.6.0 NSIS 安装包。** 189,878 字节的临时产物已改名为 `release/ReadAndListenBook-0.6.0-win-x64-setup.incomplete`，避免被误认为最终安装程序。构建日志：`cache/asr-evaluation/package-0.6.0.log`；策略事件：`package-0.6.0-policy.json`；状态报告：`package-0.6.0.json`（blocked，usableInstaller=false）。

`win-unpacked/resources/asr/` 的 6 个 Python 模块和 1 个模型 revision 清单与源码 SHA-256 一致；app.asar 版本为 0.6.0，主进程及 preload 与本次构建一致，未包含私有 cache/media/models/venv/tests/python 开发目录。这只验证打包资源，不代表安装、卸载或打包程序运行成功。

## 0.7.0 独立离线组件

已构建 8,654,001,336 字节的 ZIP64，35,468 个清单文件、13,427,330,601 字节的展开资源。Python 官方 ZIP 摘要与发布方 HTTPS digest 一致，python.exe Authenticode Valid；140 项依赖、模型及解码工具随包提供。内容、摘要及使用方法见 [独立组件](ASR_COMPONENT_BUNDLE.md)。

Windows 自带 Expand-Archive 解压至 C 盘中文/空格目录后，全文件摘要通过；从该目录启动的 Python isolated=1、sys.path/torch 全在包内，PATH 仅保留 Windows 系统目录，PYTHONHOME/PYTHONPATH 为空。源码应用用该组件完成整首歌曲、重启续接、纠错保护、取消、清理和重新计算；报告为 `cache/asr-evaluation/app-runs/2026-10-20T05-32-07.046Z/report.json`。同目录截图已查看。运行后全量文件摘要再次通过，资源未发生变化。

WhisperX 包内 CPU 对照、重复/重启复用和取消报告：`cache/asr-evaluation/worker-runs/2026-10-20T05-23-09.912Z/report.json`。Paraformer 使用迁移后的同一包也通过 CPU 对照和相同协议检查：`2026-10-20T05-40-51.936Z/report.json`。仅为已知 TTS 对照，默认引擎和真实听书质量仍未确定。

`npm run verify -- --asr` 全部通过，最终报告 `cache/verification/2026-10-20T05-43-17-685Z/report.json`：TypeScript、lint、格式、47 项基础单元/模块、6 项 Node 协议、20 项 Python 检查、开发窗口、生产构建及 25 项源码桌面测试。新增检查包含 v2 资源/缓存分离、迟到读取不能覆盖新配置、包校验、未完成/篡改/额外文件、路径越界和跨目录解压。真实模型检查独立于这些无模型测试。

`npm run pack:win` 成功，资源核对为 `cache/asr-runtime-source/package-0.7.0.json`；7 个 Python/模型清单资源与源码摘要一致，app.asar 版本、main 和 preload 与构建一致，未混入私有媒体、模型、测试或开发目录。没有重复尝试受限的 NSIS 卸载器生成或打包 EXE 运行；没有可用的 0.7.0 主程序安装包。

WhisperX 和 Paraformer 全部验证后，35,468 个文件再次通过完整清单检查，见 `cache/asr-runtime-source/relocated-integrity-final.json`。

原生依赖探测记录本机使用 System32 的 MSVCP140/UCRT，部分 VC DLL 来自 Python 包；运行库隔离不等于不依赖 Windows 系统组件。微软官方 x64 Redistributable 已下载至忽略的诊断目录，签名 Valid、主体 Microsoft Corporation，版本 14.51.36247.0，未执行安装。记录为 `cache/asr-runtime-source/vcredist-info.json`。干净设备须另行验收该前置条件，未修改/卸载本机系统 DLL 来制造缺失场景。

仍须完成完整异常环境与干净设备主程序安装升级。真实听书的人工识别质量、时间偏差及实际来源 MP3/M4A/M4B 仍按原计划跟踪，未以合成样本或源码测试替代。

## 0.7.0 异常环境首轮

源码生产构建已补齐首轮异常检查，并修复缓存错误分类、SQLite FULL 自动回滚被二次回滚掩盖、保存错误误报为模型协议损坏、终态写入失败导致队列悬挂，以及退出时保存失败阻止 worker 关闭的问题。安装版异常环境仍未验收。

| 场景                 | 实际验证与边界                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 中文、空格和只读目录 | 将最终 out、固定 worker 脚本及 package.json 复制到新建临时应用目录；该目录和此前迁移的独立组件均施加当前账户的继承 Deny 写入 ACL。对 main、worker、Python EXE、Torch 模块、NLTK 资源打开写句柄均真实 AccessDenied；使用外部用户数据目录完成实际歌曲全流程。测试后原 ACL 恢复，未限制项目、系统或日常数据目录。是源码应用副本，不是安装版 EXE。 |
| 离线                 | Chromium context offline；真实 worker 的 Python 外部 DNS/TCP/UDP 被 audit hook 拒绝，回环 IPC 可用；FFmpeg/ffprobe 仅 file,pipe。本地 WhisperX GPU 整首歌及 Paraformer CPU 对照均通过。未关闭网络适配器或改变防火墙，不宣称原生库网络沙箱。                                                                                                    |
| SQLite 空间不足      | 在独立测试数据库把 max_page_count 限制到当前页数，再提交更大的有效文稿，真实得到 errcode 13 / SQLITE_FULL。原事务自动回滚，旧前缀、修订和播放位置保留；解除限额后重试完成。没有填满用户磁盘。                                                                                                                                                  |
| 缓存写入失败         | 第二块临时写入先写部分内容再注入 ENOSPC；只清理本次临时文件，保留第一块，重试命中 1 块。另检查替换失败、权限和只读错误保留原 checkpoint；这些 OS 错误为定点注入。                                                                                                                                                                              |
| 终态也无法保存       | 桌面测试在配置后把空缓存目录换成同名普通文件，真实运行生产 Python worker 得到缓存写入失败；SQLite 触发器再拒绝失败终态。阅读器/任务页显示暂存失败状态并暂停队列，已有 3 句人工文稿、真实媒体播放不受影响。移除数据库故障后可重试，attempt 增至 2，界面保留具体缓存错误。没有加载或模拟识别模型。                                               |
| 音频移动             | 分块夹具在首个前缀后真实 rename 临时音频；下一块明确 FILE_UNAVAILABLE，恢复原路径后命中第一块并完成。既有桌面缺失/变化/损坏音频用例继续通过。原歌曲未移动。                                                                                                                                                                                    |
| worker 崩溃          | 真实 stdlib worker 先创建子进程、输出有效前缀再 os._exit；生产 Job Object 辅助函数确保该子进程退出。Node 报 WORKER_EXITED，前缀保留。另验证无响应取消、应用保存异常停止进程，以及退出保存失败仍关闭 worker、重启按最后持久化前缀续接。                                                                                                         |

最终源码回归 `npm run verify -- --asr` 通过：50 项基础单元/模块、9 项 Node 进程、24 项 Python 检查（共 83 项逻辑/模块），开发窗口、生产构建及 26 项桌面流程。报告：`cache/verification/2026-10-20T06-09-30-502Z/report.json`。新故障桌面例需要 stdlib Python，仅源码执行；无 Python 或打包 EXE 模式显式 skip，不把普通播放变成依赖 Python。最终源码测试本机无跳过。

最终只读/离线应用报告：`cache/asr-evaluation/app-runs/2026-10-20T06-10-25.337Z/report.json`；ACL 与恢复记录：`cache/asr-runtime-source/readonly-offline-20261020T061022.json`。七个阶段包含整首歌生成、首块后退出、重启复用、纠错保护/预览采用、取消不中断播放、活动任务阻止清理和清理后零命中重算。截图及新增故障界面均已查看。可复现入口：

```powershell
# 仅对本任务已解压到临时目录的组件施加临时 ACL；退出时恢复。
./tests/model/readonly-offline.ps1 -Component 'C:/临时组件/component.json'
```

脚本会检查输入确为本任务此前记录的临时解压目录；示例路径须替换。原 ACL 在更改前另存为 `.acl.json`，便于测试 shell 被外部强制结束时恢复。

Paraformer 离线 CPU 对照、重复/重启缓存及取消报告：`cache/asr-evaluation/worker-runs/2026-10-20T06-05-22.024Z/report.json`。只读/离线首轮后，35,468 个组件文件再次通过完整摘要清单，见 `cache/asr-runtime-source/relocated-integrity-adverse.json`；原独立 ZIP 无需重建，worker 脚本由主应用提供。

`npm run pack:win` 已刷新最终应用资源，7 个 Python/模型清单与源码摘要一致，main/preload 与最终构建一致，asar 无私有 cache/media/models/venv/tests/python 目录。报告：`cache/asr-runtime-source/package-0.7.0-adverse.json`。未重复受限的 NSIS/打包 EXE 执行，没有新增可用主程序安装包。真实目标设备安装、升级、物理存储/断网环境和缺失系统运行库仍须复核；本轮故障注入不替代这些检查。

## 0.8.1 Paraformer 修复后的复核

时间戳参数修正与按需 CTC 重新对齐随主程序脚本提供，独立组件仍为原 0.7.0 ZIP。使用同场真实会议连续前 120 秒，在只读应用/组件、隔离 PATH、Chromium offline 和 worker 离线策略下完成 9 阶段 UI 生成验收；包括任务中断重启、纠错保护、取消、缓存清理/零命中重生成及测试范围标记保留。新增检查对兼容脚本与 FunASR 模块实际拒绝写入，原 ACL 最后精确恢复。报告：`cache/asr-runtime-source/readonly-offline-20261020T075220.json`，关联应用报告 `cache/asr-evaluation/app-runs/2026-10-20T07-52-25.337Z/report.json`。

35,468 个组件文件在 CPU/GPU 与 UI 测试后再次通过摘要清单，FunASR 模块仍为原 wheel；见 `cache/asr-evaluation/timestamp-audit/component-integrity-0.8.1.json`。主程序仅生成 `--dir` 资源，asar 5 个构建文件、外部 8 个 ASR 文件与源码摘要匹配，见 `cache/asr-runtime-source/package-0.8.1.json`。这不是主程序 EXE 运行、NSIS 安装、干净设备或系统运行库缺失环境的验收，仍无可用 0.8.1 主程序安装包。模型与质量范围见 [时间戳修复](PARAFORMER_TIMESTAMPS.md)。
