# 自包含 Windows 目录版

`0.29.0-dev.1` 提供带完整 Electron 运行时、主程序、生产依赖、原文处理 worker 和字幕组件接口的目录版。程序无需工作区、Node.js 或系统 Python 即可进行普通听书、TXT/EPUB 阅读及已有字幕导入。纯电子书朗读调用 Windows 已安装的本地声音，无需模型组件；AI 录音字幕仍需另行选择离线组件，模型没有嵌入主程序，也不会在启动时自动下载。播放行为见 [播放与朗读流程](PLAYBACK_FLOW.md)。

保留 `0.25.0-dev.8` 对书架头部尺寸漂移的修正，使用同一个头部组件和设计参数；卡片去除重复阅读／收听文字按钮，已关联资源只保留准确的小图标，完整能力仍在更多菜单。阅读方面把来源、生成进度、取消、跟随及分页合入单一底部播放器，保留正文空间；伴读与电子书共用正文测量、锚点与动画基础，按实际屏幕排版翻页，数据加载窗口不冒充整书页数。阅读设置改为紧凑的三个真实分类，可选解释移入可访问的帮助提示，高级配色按需展开，错误继续直接显示。共用参数与组件所有权见 [设计规范](DESIGN_SYSTEM.md)，后续维护入口为根目录 [AGENTS.md](../AGENTS.md)。

保留 `0.24.0-dev.5` 的界面统一与页签语义：设置切换保留草稿与任务状态；听读切换提示约 4 秒后自动消失，可立即关闭，离开目标阅读路由后清除。历史说明见 [统一书架、阅读界面与设置页签](UNIFIED_BOOK_UI.md)。

保留 `0.23.0-dev.2` 的自动字幕实时阶段、真实分段进度和直接取消：尚无任务的组件检查、排队、加载模型及已生成部分字幕时都可操作；停止确认后保留已有字幕和声音进度，普通播放继续。设置折叠组与选择框通过标题区、箭头位置、展开／收起文字、边框和缩进区分，保留键盘语义，见 [字幕进度、取消与设置层级](SUBTITLE_PROGRESS.md)。

## 启动与现有数据

最新 `0.29.0-dev.1` 先交付极简留白与轻新拟态的书架预览，保留共同几何及功能。529 项逻辑检查与 15 项相关桌面回归通过；8 个相同合成数据的前后场景确认几何、内容与播放位置一致。对比预览为 `cache/minimal-style/2026-10-28T05-07-52.851Z/index.html`，视觉范围见 [说明](MINIMAL_STYLE.md)。

本版构建：`cache/preview-builds/2026-10-28T05-06-18.330Z/app`。最新目录及同名 ZIP：`release/ReadAndListenBook-0.29.0-dev.1-2026-10-28T05-06-44.933Z-win-x64`，ZIP SHA-256 为 `c3b6197631df9889391cdca5cfa875ec93325dd0c190394b55bc30950584c059`。89 个目录文件与 90 个 ZIP 条目逐项校验、独立运行与重启恢复通过，报告为 `cache/handoff-smoke/2026-10-28T05-07-32.771Z/report.json`。198 个源码文件与构建一致，根 `out/` 的 8 个文件未变。启动及验证边界见 [本版记录](releases/0.29.0-dev.1.md)。

历史 `0.28.0-dev.2` 修复播放轨道与主内容边界的双线：移除独立顶边框，在 16px 原生轨道盒的顶端绘制 3px 实际进度，保留点击、拖动、时间提示和键盘行为。529 项逻辑检查及类型／lint／格式通过，25 项相关桌面回归一次通过，包括宽窄窗口、浅深主题及实际截图像素核对。

该历史版构建为 `cache/preview-builds/2026-10-28T03-34-54.698Z/app`，目录及 ZIP 为 `release/ReadAndListenBook-0.28.0-dev.2-2026-10-28T04-11-20.353Z-win-x64`（ZIP 同名加 `.zip`）。89 个目录文件、90 个 ZIP 条目校验通过，ZIP SHA-256 为 `c75427677ec66bccace84291cf9c3ccf8dc87685989fbc1654fa20671b0ef871`。独立路径、新数据、系统 PATH 下声音／文字处理及重启恢复通过，报告为 `cache/handoff-smoke/2026-10-28T04-15-19.586Z/report.json`；198 个源码文件与构建一致，根 `out/` 的 8 个文件未变。

工作区约 89GB 的占用已核对出 37 个可清理目标，约 51.45 GiB；**批量删除被自动审批以 `blocked by policy` 拒绝，未执行删除，释放 0 字节**。清单与保护范围见 [存储清理核对](STORAGE_CLEANUP.md)，不能将该清理计为已完成。软件修复的构建与完整验证边界见 [本版记录](releases/0.28.0-dev.2.md)。

历史 `0.27.0-dev.1` 分开外观设置与应用信息，并将播放器改为单排主控：左侧只显示章节标题和书名，字幕时长与覆盖情况从右侧图标查看；媒体进度使用上缘横贯细轨，时间在悬浮／聚焦时显示。等待字幕时立即播放、配置、定时及错误重试继续可用。普通底栏高 84px，阅读底栏保留原有来源／分页行。记录见 [本版说明](releases/0.27.0-dev.1.md)。

构建为 `cache/preview-builds/2026-10-27T23-10-22.792Z/app`，目录与 ZIP 为 `release/ReadAndListenBook-0.27.0-dev.1-2026-10-27T23-11-36.684Z-win-x64`（ZIP 同名加 `.zip`）。89 个发行文件、90 个 ZIP 条目校验通过，ZIP SHA-256 为 `0d655a8233b8b962a6f6689a1217a7f849e21f70ae5320b5e67155c97661b67d`，打包报告为 `cache/handoff-builds/2026-10-27T23-11-36.684Z/report.json`。

本轮类型、lint、格式及 529 项单元／模块测试通过；最终构建完整 185 项桌面回归一次通过，无失败、跳过或不稳定重试。198 个源码文件及 Python 脚本与构建一致，根 `out/` 的 8 个文件未变。最终目录的独立路径、全新数据、系统 PATH 下 WAV／TXT worker／Windows 系统声音播放和重启恢复通过，发行文件摘要未变。汇总为 `cache/player-strip-validation/report.json`，桌面报告为同目录 `desktop-results.json`，隔离运行报告为 `cache/handoff-smoke/2026-10-27T23-18-06.027Z/report.json`。

历史 `0.26.0-dev.3` 将侧栏、书架、播放器与阅读页的常驻动作统一为图标，鼠标悬浮与键盘聚焦显示气泡；点击直接执行原动作。侧栏收为共用窄导航，书卡去掉重复装饰和关联行，播放器保留图标与真实关键数值，完整字幕信息仍可按需打开。错误、重试、书名、实际位置及设置值继续可见。视觉问题及修改优先级见 [界面优化](UI_REFINEMENT.md)。

历史构建为 `cache/preview-builds/2026-10-27T04-32-00.637Z/app`，目录及 ZIP 为 `release/ReadAndListenBook-0.26.0-dev.3-2026-10-27T04-32-42.478Z-win-x64`（ZIP 同名加 `.zip`）。89 个发行文件及 90 个 ZIP 条目逐项校验通过，报告为 `cache/handoff-builds/2026-10-27T04-32-42.478Z/report.json`，ZIP SHA-256 为 `f16ddd5c86ff7731397d56a0edea8842afcce0ade8d5a9af9627b5472a5f4734`。

该历史版本的 529 项单元／模块检查、类型、lint 和格式检查通过，197 个源码文件与最终构建一致，主 `out/` 的 8 个文件未变。181 项桌面用例均已验证：完整运行中 180 项通过，唯一剩余项仍查找被精简的“上次听到”前缀；该断言改为核对真实集名及 `00:00:01` 位置后单独复验通过，原书签、媒体坐标、重启与音频版本检查全部保留。原始报告为 `cache/icon-ui-validation/desktop-results.json`，复验为同目录 `recent-position-recheck.json`；不将两份报告描述为一次全绿运行。截图位于 `cache/icon-ui-verified-tests/`，汇总为同验证目录 `report.json`。

最终发行目录也通过本机隔离运行：独立中文路径、全新数据、仅系统 PATH，实际 WAV 播放、TXT worker、Windows 系统声音播放和退出重启进度恢复均通过，发行文件摘要未变。报告为 `cache/handoff-smoke/2026-10-27T04-38-56.477Z/report.json`。下方较早的构建和验证条目保留为历史证据。

解压 ZIP 后保留完整目录，双击 `start.cmd`。该入口使用 `%APPDATA%\ReadAndListenBook-standalone` 保存书架、进度、设置和缓存。不要只复制 `runtime/electron.exe`，它需要同目录的运行时资源和 `resources/app.asar`。

继续已有开发预览时，先退出旧预览并备份 `%APPDATA%\ReadAndListenBook-preview-0.13`，再运行 `continue-preview.cmd`。这个入口直接使用原来的预览数据目录，不另行复制或覆盖它。新版会按自身支持的 schema 读取或升级数据库；备份后不要让只支持旧 schema 的程序打开已升级的数据。

两个启动入口使用不同的数据目录。首次看到空书架时，先确认使用的是 `start.cmd` 还是 `continue-preview.cmd`，不应重复导入来代替核对。移除或移动程序目录不会删除 APPDATA 中的书架数据；若另行移动了离线组件目录，需要在应用中重新选择组件位置。

## 发行内容与校验

- `runtime/electron.exe` 保留官方文件名和原始字节，不使用重新命名的 EXE。
- `runtime/resources/app.asar` 包含本轮构建输出、完整生产依赖及第三方声明。
- `runtime/resources/asr/` 保存与构建清单相同的字幕脚本和模型配置。
- `SHA256.json` 记录程序目录内每个发行文件的 SHA-256；不包含日常用户数据。
- ZIP 通过纯 Node.js 写入 UTF-8 条目、deflate 数据和 CRC32，再独立读取全部条目，按 SHA-256 核对没有遗漏、重复或额外文件。

构建命令：

```powershell
npm.cmd run pack:handoff -- --app-root '<独立预览 appRoot>'
```

脚本先核对独立构建的所有输出，复制完整生产依赖树，核对官方 EXE、ASAR 内的构建输出及字幕脚本，生成目录与 ZIP。它不覆盖工作区 `out/`，不运行 NSIS，不修改系统策略。每轮构建报告保存在 `cache/handoff-builds/<时间>/report.json`，输出在 `release/`。

官方未重命名的 `electron.exe` 会报告 `app.isPackaged=false`。目录版按实际应用路径位于 `resources/app.asar` 识别自包含资源模式，不能把该属性伪造为 `true` 或用它声称已经完成 NSIS 安装。

## 本机隔离验证

验证入口：

```powershell
node node_modules/tsx/dist/cli.mjs tests/model/handoff-smoke.ts --directory '<完整发行目录>'
```

测试把完整目录复制到新的中文、空格临时路径，另建空白用户数据目录。子应用的 PATH 仅含 Windows System32，Node/Python/虚拟环境及开发入口变量清除；运行的是发行副本里的官方 EXE，没有引用工作区 Electron。

验证包括：

1. 核对应用版本、实际 `app.asar`、执行文件和独立用户数据路径，记录真实 `app.isPackaged` 值。
2. 通过真实文件选择 IPC 导入本地 WAV，检查播放、暂停、跳转和毫秒进度保存。
3. 使用真实原文 worker 导入 TXT，读取章节与正文并保存电子书位置。
4. 正常退出后从同一独立目录重启，核对音频和电子书位置恢复、音频保持暂停。
5. 使用真实 Windows 系统声音生成非静音 WAV，并在 renderer 实际播放；保持原有 CSP 不变。
6. 检查没有 renderer 异常，且运行前后全部发行文件摘要一致。

上一轮交付构建为 `cache/preview-builds/2026-10-27T01-33-35.500Z/app`，目录及 ZIP 为 `release/ReadAndListenBook-0.25.0-dev.8-2026-10-27T01-35-34.730Z-win-x64`（ZIP 同名加 `.zip`）。89 个发行文件及 90 个 ZIP 条目逐项校验通过，报告为 `cache/handoff-builds/2026-10-27T01-35-34.730Z/report.json`，ZIP SHA-256 为 `264269ca57770899e5867183de6d20fba2d13e521dbe65b1451c6be2f020ef95`。

历史 `0.25.0-dev.8` 的 529 项单元／模块检查、类型、lint、格式及最终 176 项桌面回归全部通过，无失败、跳过或不稳定重试。最终桌面报告为 `cache/compact-reader-validation/desktop-results.json`，截图位于 `cache/compact-reader-verified-tests/`。192 个源码文件与最终构建一致，主 `out/` 的 8 个文件未变；校验与汇总分别为 `cache/compact-reader-validation/source-integrity.json` 和同目录 `report.json`。

该历史发行目录也通过本机隔离冒烟：复制到含中文和空格的独立路径，使用全新数据，仅保留系统 PATH，移除开发环境变量；真实 WAV 播放、TXT 原文 worker、Windows 系统声音生成与实际播放、退出重启后的音频及阅读位置恢复均通过，发行文件摘要未变。报告为 `cache/handoff-smoke/2026-10-27T01-36-09.530Z/report.json`。这属于本机 Windows 隔离验证，未执行干净系统或 NSIS 安装器验收，也不代表真实模型识别质量。书架尺寸、控件边界、正文空间、分页、进度取消及紧凑设置的验证范围见 [设计规范](DESIGN_SYSTEM.md)。

历史 `0.24.0-dev.5` 的交付构建为 `cache/preview-builds/2026-10-26T23-34-37.623Z/app`，目录及 ZIP 为 `release/ReadAndListenBook-0.24.0-dev.5-2026-10-27T00-24-39.808Z-win-x64`（ZIP 同名加 `.zip`）。89 个发行文件及 90 个 ZIP 条目逐项校验通过，报告为 `cache/handoff-builds/2026-10-27T00-24-39.808Z/report.json`，ZIP SHA-256 为 `62c5616704635c51bb3b75aff68368dd95786f5b621e5522d85edba873957ce7`。

该历史版本的 529 项单元／模块检查及完整检查命令通过，164 项桌面回归全部通过，无失败、跳过或不稳定重试，报告为 `cache/reader-unification-validation/desktop-results.json`。182 个源码文件与最终构建清单完全一致，主 `out/` 的 8 个文件未变，见同目录 `source-integrity.json`。

该历史发行目录的本机隔离复验通过，报告为 `cache/handoff-smoke/2026-10-27T00-29-57.213Z/report.json`：中文与空格临时目录、新用户数据、PATH 仅含 System32、清除开发环境变量，真实 WAV 播放、TXT 原文 worker、Windows 系统声音生成非静音 WAV 并实际播放、退出重启恢复音频与阅读位置，以及运行前后全部发行文件摘要均通过。`app.isPackaged=false` 如实记录。汇总报告为 `cache/reader-unification-validation/report.json`；此历史结果不替代当前包验证，也不扩大真实识别质量、NSIS 安装或干净设备的验收范围。

历史 `0.23.0-dev.2` 的交付构建为 `cache/preview-builds/2026-10-26T04-47-48.586Z/app`，目录及 ZIP 为 `release/ReadAndListenBook-0.23.0-dev.2-2026-10-26T04-48-27.490Z-win-x64`（ZIP 同名加 `.zip`）。89 个发行文件及 90 个 ZIP 条目逐项校验通过，报告为 `cache/handoff-builds/2026-10-26T04-48-27.490Z/report.json`，ZIP SHA-256 为 `b39c124f5cba88eeef6b3bb0d672c3516a494620c7e50de4e61825be307d773b`。

该历史版本的 527 项逻辑检查及完整检查命令通过，77 项桌面回归全部通过，0 失败、0 跳过、0 不稳定重试，报告为 `cache/subtitle-progress-validation/desktop-results.json`。其中包括普通组件检查未返回时排入主动生成、随后取消不得重新启动，以及之后新的明确重试可以生成。`cache/subtitle-progress-validation/source-integrity.json` 核对该轮 175 个源码文件与构建清单完全一致，主 `out/` 的 8 个文件未变化。

该历史目录的本机隔离复验通过，报告为 `cache/handoff-smoke/2026-10-26T04-51-16.716Z/report.json`：在独立中文与空格目录、新用户数据、PATH 仅含 System32 且移除开发环境变量的条件下，真实 WAV 播放、TXT 原文 worker、Windows 本地声音生成非静音 WAV 并实际播放、退出重启恢复音频及阅读位置，以及运行前后完整发行文件摘要均通过。实际 `app.isPackaged=false` 如实记录。该验证未运行真实识别模型，不替代当前包验证、NSIS 安装或干净设备验收。

历史 `0.22.0-dev.3` 交付构建为 `cache/preview-builds/2026-10-26T03-59-46.872Z/app`，目录及 ZIP 为 `release/ReadAndListenBook-0.22.0-dev.3-2026-10-26T04-00-27.998Z-win-x64`。89 个发行文件及 90 个 ZIP 条目逐项校验通过，报告为 `cache/handoff-builds/2026-10-26T04-00-27.998Z/report.json`，ZIP SHA-256 为 `51b5558a13fc8557839797a8798e729687a61d512e9f31b0b099186b136301bf`。

该历史版本本机隔离复验通过，报告为 `cache/handoff-smoke/2026-10-26T04-02-16.355Z/report.json`：普通 WAV 播放、TXT worker、原阅读及音频进度恢复、真实 Windows 声音生成及媒体播放、运行前后摘要通过。字幕模型推理不属于这次隔离验证。新增语音验证的首轮测试曾因 renderer CSP 禁止 fetch 而失败；检查改在 main 进程读取 WAV，renderer 只做原有许可内的媒体播放，未放宽 CSP。

历史 `0.21.0-dev.1` 构建为 `cache/preview-builds/2026-10-25T14-34-11.892Z/app`，目录与 ZIP 位于 `release/ReadAndListenBook-0.21.0-dev.1-2026-10-25T14-34-41.900Z-win-x64`（ZIP 使用同名加 `.zip`）。89 个发行文件和 90 个 ZIP 条目逐项校验通过，构建报告为 `cache/handoff-builds/2026-10-25T14-34-41.900Z/report.json`，ZIP SHA-256 为 `b8f375325eba9624523fd9f8e3bb90f873b57cc174ea9f88369045c03a0c9725`。

该历史目录曾在新的中文、空格临时目录完成本机隔离复验，报告为 `cache/handoff-smoke/2026-10-25T14-34-54.648Z/report.json`：应用名称、版本和资源路径正确，真实 WAV 导入、暂停与 12,345 毫秒进度、TXT worker 导入与阅读位置 3、退出重启恢复，以及运行前后文件摘要全部通过。模型推理不属于这次隔离测试。首轮构建与复验报告保留在 `14-11-14.897Z` 和 `14-14-51.978Z` 对应目录；各版本证据分别保留，以明确标注的当前版结果为准。

早期归档尝试因 `yazl` 未安装和 PowerShell 禁止执行 `.ps1` 而停止，未修改执行策略。最终归档改为纯 Node.js，不依赖未安装的模块、PowerShell 脚本或额外打包 EXE。首轮运行曾把 `app.isPackaged=true` 当成必要条件而失败；实际程序已启动并正常退出，之后改为核对真实资源边界，没有更改或伪造 Electron 属性。

## 验收范围

本机隔离通过证明目录已包含所需运行时和上述流程所需资源，不等于一台从未安装过开发环境的 Windows 设备已经验收。未执行真实模型推理、未量化 AI 字幕准确率，也没有新增干净设备、安装升级或卸载验收结论。

本机既有 Code Integrity 对重命名程序及 NSIS 临时卸载器的限制保留；没有重复执行这些已知受限程序或更改安全设置。NSIS 安装包与干净 Windows 设备仍需独立测试，不能用此目录版的运行结果替代。
