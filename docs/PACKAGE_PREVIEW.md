# 预览目录包与 Windows 设备验收

## 最新 dev.6 目录包

`0.10.0-dev.6` 的独立构建为 `cache/preview-builds/2026-10-21T07-51-12.632Z/app`，目录包位于 `cache/package-previews/2026-10-21T07-54-06.914Z/output/win-unpacked/`，同级 `report.json` 静态核对通过。包含 WhisperX 末端修复及新缓存契约，见 [修复记录](WHISPERX_AUDIO_BOUNDS.md)。ASAR 为 180 个条目，八个输出文件及九份 ASR 资源与预览一致；原 `out` 五个文件未变。

ASAR SHA-256 为 `9800359bb4616fb1ef1d86ffff97a38e71cdc2df8fe513b4053defc201083583`。EXE 只读签名检查为 `NotSigned`；未运行打包 EXE，未生成 NSIS，安装升级和干净设备仍待执行。dev.6 源码预览的 36 项桌面回归及两组实际模型应用检查通过，不作为打包运行证据。以下各版保留各自构建、摘要和检查结果。

dev.6 交接 ZIP 为 `release/ReadAndListenBook-0.10.0-dev.6-win-x64-preview.zip`，167,574,567 字节，SHA-256 为 `d839379b0f4f10d95e0b7bd812d14d29c62c7440e9411c313e608b78806f5f0d`。84 个 ZIP 条目的长度和解压流摘要全部核对通过，见本轮 `handoff-report.json`；包含完整目录包、冻结设备清单、打包报告和逐文件清单，不包含影视诊断素材或模型。

## dev.5 目录包记录

`0.10.0-dev.5` 的独立构建为 `cache/preview-builds/2026-10-21T06-34-52.520Z/app`，目录包位于 `cache/package-previews/2026-10-21T06-39-29.301Z/output/win-unpacked/`，同级运行目录的 `report.json` 已通过。ASAR 含 180 个条目，八个输出文件与构建清单一致，包括新增的同源搜索 worker；生产依赖、许可证及九份 ASR 资源通过核对，原 `out` 五个文件未变。

ASAR SHA-256 为 `0d15be20c7bfead520dab894aad5f13dba26c84a1a0a92f74caee6669c4be2d3`。EXE 的只读 Authenticode 结果为 `NotSigned`；没有执行打包 EXE，没有生成 NSIS 或完成目标设备验收。功能与 113/36 项检查见[转写稿搜索](TRANSCRIPT_SEARCH.md)。以下 dev.4 路径、摘要及历史失败记录保留各自版本范围；设备清单适用于两版。

dev.5 交接 ZIP 为 `release/ReadAndListenBook-0.10.0-dev.5-win-x64-preview.zip`，167,573,619 字节，SHA-256 `fb18a7a08e200dd746aef2c0d7196dfb1e0dbd354e902110142cd226982973f7`。84 个 ZIP 条目的长度和解压流摘要全部核对通过，见本轮 `handoff-report.json`；入口为 `win-unpacked/ReadAndListenBook.exe`，包含冻结设备清单及逐文件清单。归档自身的静态通过不代表其中 EXE 已运行。

## dev.4 目录包记录

日期：2026-10-21（America/New_York）。`0.10.0-dev.4` 已在独立目录生成 Windows x64 目录包并完成静态检查。没有运行打包 EXE，没有生成或测试 NSIS 安装包；安装、升级和干净设备使用仍待验收。本机 Code Integrity/Device Guard 限制保持原样，不重复执行已知受限程序。

## 已生成的包

构建为 `cache/preview-builds/2026-10-21T05-46-29.003Z/app`，目录包为 `cache/package-previews/2026-10-21T05-48-49.497Z/output/win-unpacked/`，报告在该运行目录的 `report.json`。可复制整个目录到测试设备；不能只复制其中的 EXE。

已另生成可交接 ZIP：`release/ReadAndListenBook-0.10.0-dev.4-win-x64-preview.zip`，167,569,841 字节，SHA-256 `2ad9c9e065789f34d7647d389e496b3512e953c2dc0775a7ead8e845adf56ab8`。归档含完整 `win-unpacked/`、冻结验收清单、打包报告和逐文件摘要清单；84 个 ZIP 条目的长度和解压流 SHA-256 已逐项核对，见本轮目录下 `handoff-report.json`。入口为 `win-unpacked/ReadAndListenBook.exe`。只读 Authenticode 检查为 `NotSigned`；未在本机执行它，目标设备若拦截则记录实际结果。

```powershell
npm run pack:preview -- --app-root '<独立预览 appRoot>'
```

该入口先核对预览七个输出文件及原 `out` 五个文件，再复制完整生产依赖树、输出和 Python 脚本到新的 `cache/package-previews/<时间>/project`。它读取仓库的 electron-builder 配置，只更改独立输出目录和固定 Electron 版本，使用 `--win dir --x64 --publish never`。没有覆盖正在长测的 `out`。

最终报告确认：

- ASAR 包含 179 个条目，顶层仅为 `out`、`node_modules`、`package.json` 和 `THIRD_PARTY_NOTICES.md`，七个预览输出与构建清单逐字节一致。
- 生产依赖包括 `@xmldom/xmldom`、`opencc-js`、`react`、`react-dom`、`scheduler`。OpenCC 实际导入文件 `dist/esm/t2cn.js`、实现/数据许可证与第三方说明均存在且摘要相符。
- 九份 ASR 脚本/模型配置资源与预览一致，原 `out` 的五份文件未变。模型与 Python 运行时沿用可选[独立组件包](ASR_COMPONENT_BUNDLE.md)，不嵌入主程序。
- `app.asar` SHA-256 为 `3e5fa819122f1db57bd1e9ca915f73f7473cdd00af2c6a1eafa369f46fc1f4ac`。

早期目录检查的两次失败保留在 `2026-10-21T05-37-06.195Z` 和 `05-38-37.246Z`：分别是校验入口使用了不适合 Windows 的 ASAR 内部路径，以及把 electron-builder 正常删除的依赖 `scripts/keywords/bugs` 元数据误认为内容损坏。最终检查对运行所需元数据逐字段核对，对代码、字典和许可证继续严格核对字节。静态通过不证明依赖已在打包程序中成功执行。

## 干净设备检查清单

需要一台没有开发用 Node.js/Python 的 Windows x64 设备。记录 Windows 版本、用户权限、硬件和实际包摘要，保存日志与截图，每项分别标记通过、失败或未验证。

1. 复制完整目录包，在带中文和空格的普通用户路径启动；核对显示版本。若系统阻止运行，记录提示和系统事件，不修改安全策略或将拦截计为应用通过。
2. 在没有配置 ASR 组件时导入真实 MP3/M4A/M4B，检查播放、倍速、远距离跳转、书架切换、书签、定时、托盘恢复及退出重启后的进度。断网时本地播放仍应可用。
3. 按组件文档配置独立离线包，在不使用系统 Python 的条件下完成真实中文音频转写、取消/重试、文稿保留及重启复用。记录模型、设备、耗时、失败提示和日志，不以“任务完成”代替文字/同步质量判断。
4. 导入同作品 TXT/EPUB，检查简繁检索、原文与转写切换、手动浏览后返回跟随、人工校正、字幕保存及重启保持。音频和原书应保留原样。
5. 在设备的实际权限/存储条件下复核应用目录只读、文件移走后恢复、网络不可用及任务异常退出；磁盘空间不足应使用隔离测试卷或受控配额，避免填满用户系统盘。

以上目录包检查不替代安装验收。随后仍须在获准构建/运行的环境产出 NSIS，并单独检查首次安装、旧版升级保留数据库/书签/纠错/进度、卸载行为说明和重新安装恢复。当前尚无该预览版本的安装包，也没有干净设备结果。

源码桌面回归、长期播放和实际音文检查分别见[开发计划](PLAN.md)、[整书记录](LONG_PLAYBACK.md)、[真实 EPUB](ORIGINAL_EPUB.md)。它们不能替代本页尚未执行的目标设备步骤。
