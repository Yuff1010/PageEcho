# ReadAndListenBook

面向 Windows 的听书、电子书阅读与音文同步伴读软件。

当前目录版为 **0.35.0-dev.1**：支持本地音频、TXT/EPUB、自动字幕、原文关联、来源中心和 SDK v1 网站插件；本版补齐来源状态保留、多源搜索、原封面离线保存、来源章节续读、插件维护和备份恢复。当前范围与验证见 [版本记录](docs/releases/0.35.0-dev.1.md)。

## 使用

退出旧程序后，在最新发行目录双击 `continue-preview.cmd`，沿用既有书架和进度；`start.cmd` 使用独立数据。完整路径、校验及数据说明见 [交付说明](docs/DELIVERY.md)。保留完整程序目录，数据库当前为 schema 17。

来源中心 → 插件 → 导入 ZIP，安装后选择对应音频／电子书来源再搜索。提供 [bqg631 示例](examples/source-plugins/bqg631/README.md) 与中文维基文库示例；自己制作可查 [分步教程](docs/MAKE_SOURCE_PLUGIN.md)。

应用设置 → 备份与存储，可导出书架资料、预览恢复和设置未来生成物的保留策略。备份排除原音频、模型和凭据，恢复前保留原数据；详细范围见 [备份与存储](docs/BACKUP_STORAGE.md)。

电子书阅读无需模型。纯电子书朗读使用 Windows 已安装的本地声音；AI 音频字幕需另行选择离线组件，程序启动时不自动下载模型。阅读、字幕、关联与组件说明统一从 [文档入口](docs/README.md) 查阅。

## 开发与构建

Windows x64，Node.js 24.19+（24.x），依赖由 `package-lock.json` 固定。

```powershell
npm ci
npm run dev
npm run check
npm run build:preview -- --version 0.35.0-dev.1
npm run workspace:inventory
```

隔离构建写入新 cache 目录，保留根 `out/`。主程序打包入口位于 `scripts/build/`，字幕组件准备位于 `scripts/asr/`，常用 npm 命令保持兼容。目录职责和保留范围见 [工作区结构](docs/WORKSPACE_STRUCTURE.md)，界面修改先读 [设计规范](docs/DESIGN_SYSTEM.md)。

## 维护状态

此前完成目录分组与占用清点。用户要求的历史文件及测试源码删除被自动审批以 `blocked by policy` 拒绝，**尚未删除，释放 0 字节**；测试命令与依赖仍保留。本版仅为今后登记的生成物增加独立策略，不把历史未知目录自动纳入清理。范围见 [存储记录](docs/STORAGE_CLEANUP.md)。

每个完成的维护版本提交、推送并创建 `v<版本>` 标签。历史功能、验收数据和已知限制保留在 [CHANGELOG](CHANGELOG.md) 与 [版本记录](docs/releases/)。历史 ASR 人工质量、安装器与干净设备验收不因本轮结构整理而变为已完成。
