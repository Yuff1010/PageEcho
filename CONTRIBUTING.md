# 参与开发

欢迎通过 Issue 和 Pull Request 改善听见书页（PageEcho）。提交内容按仓库的 [MIT 许可证](LICENSE) 授权；第三方依赖和外部资源仍遵循各自许可。

## 本地环境

当前开发与构建流程面向 Windows x64，使用 Node.js `>=24.19.0 <25` 和随附的 npm。克隆仓库后，在项目根目录运行：

```powershell
npm.cmd ci
npm.cmd run runtime:install
npm.cmd run dev
```

普通界面开发不需要下载语音模型。涉及本地转写、GPU 或真实网站的功能，需要另行配置相应环境；请勿把模型、网站凭据或真实书籍当作通用测试前提。

## 结构与共同规则

- `src/main/`：Electron 主进程、存储、来源与任务服务。
- `src/preload/`：受限的桌面通信接口。
- `src/renderer/`：React 界面。
- `src/shared/`：跨进程类型、校验和公共逻辑。
- `scripts/`：构建、打包与维护脚本；`tests/`：自动化验证。

先阅读 [AGENTS.md](AGENTS.md)。调整布局前还需阅读 [设计系统](docs/DESIGN_SYSTEM.md)，复用书架、阅读器和设置组件及设计参数。界面修改应保留音频会话、阅读锚点、手工字幕与原文匹配语义，并验证相关流程。

显示名称统一来自共享品牌配置，既有数据目录、应用标识和存储协议保持兼容；改名时先阅读 [品牌与兼容标识](docs/BRANDING.md)，不要全局替换内部名称。

## 验证

提交前运行类型检查、静态检查、单元测试和格式检查：

```powershell
npm.cmd run check
```

验证构建时使用隔离预览，保留已有根目录 `out/`：

```powershell
New-Item -ItemType Directory -Force -Path out | Out-Null
npm.cmd run build:preview -- --version 0.36.0-dev.1
```

此命令把新产物放入 `cache/managed-generated/`。`package.json` 中的 `0.8.4` 是构建内核基线；预览程序版本由构建参数指定，发布记录以 `CHANGELOG.md` 和 `docs/releases/` 为准。

GitHub CI 在 Windows 上执行依赖锁定安装、`check` 和隔离预览构建。它不验证桌面交互、真实网站可用性、模型识别效果或 GPU；修改这些部分时，请在 PR 中记录实际完成的验证及未验证范围。

## 提交改动

一个 PR 聚焦一个问题，说明触发条件、修改后的行为和验证结果。修复逻辑问题时补充有意义的回归用例；小型合成夹具应说明用途，避免引入真实用户数据。

不要提交凭据、Cookie、个人路径日志、用户数据库、下载的书籍和音频、模型权重、缓存或构建包。保留 `package-lock.json`，依赖变更同时更新锁文件。不要为了验证而清空 `out/` 或用户、模型目录。

版本号、交付记录、标签和发布同步由维护者统一处理。安全问题请按 [安全报告说明](SECURITY.md) 私密提交。
