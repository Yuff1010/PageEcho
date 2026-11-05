# 安装升级验证

安装器与目录版是不同的启动渠道。安装版保留 `com.readandlistenbook.desktop` 身份、`PageEcho.exe` 和默认 `%APPDATA%\ReadAndListenBook`；现有目录版的两个启动入口及其数据目录见 [交付说明](DELIVERY.md)。本流程不会自动搬迁目录版资料，也不使用重定向数据目录来替代安装身份验证。

## 隔离构建

```powershell
npm.cmd run build:preview -- --version 0.41.0-dev.1
# 取上一步输出的 appRoot；本机只检查计划，不运行 NSIS。
npm.cmd run pack:installer -- --app-root '<冻结预览appRoot>' --plan-only
```

预览清单、完整输出摘要、Python 资源、法律文件、内部身份和依赖必须匹配。新入口在独立受管 cache 目录准备有限文件的项目，固定原 appId、当前用户安装、不提权、不自动启动和卸载保留资料配置，实际使用 `--win nsis --x64 --publish never`。根 `out/` 与冻结输入在前后复核，程序、安装器和模型不发布到 Release。

本机历史 NSIS 构建曾被 Code Integrity 拦截，见 [原记录](M4_VALIDATION.md)。新入口不会换路径或降低系统策略重试；实际 NSIS 构建只在显式启用的 Windows Actions runner 执行。`--plan-only` 的 `planned` 状态不代表安装器已生成。

## 真实生命周期

[Installer lifecycle 工作流](../.github/workflows/installer-lifecycle.yml) 分别检出固定 0.39 基线提交和待验收提交，按各自锁文件安装依赖并构建实际版本。共享打包入口在各自工作目录运行，报告记录实际源码提交、预览、入口、配置、锁及产物摘要。

验收器先确认没有该应用的安装、注册项、快捷方式、默认资料或进程；发现既有资料立即停止，不接管或删除。随后执行：

1. 安装真实旧版到新建中文／空格路径，启动实际安装的 `PageEcho.exe`；核对 `isPackaged`、版本、程序路径及默认 APPDATA。
2. 经真实应用 IPC 写入合成音频记录、播放位置／倍速／音量、书签、手工文稿、电子书与阅读位置，保存外观／阅读偏好并正常退出。
3. 运行新版安装器，在相同位置升级，核对安装摘要及全部资料语义一致。
4. 执行真实注册项的 `QuietUninstallString`，不用 `/KEEP_APP_DATA`。等待程序与注册项真正消失，再核对默认 APPDATA 所有文件仍在且摘要不变。
5. 重装新版，重新核对资料；再执行真实卸载。失败时保留状态，不手工删除残留来制造成功。

NSIS 的 `/D=` 参数必须最后且路径值不加引号，调用使用进程参数而非拼接 shell 命令，依据 [NSIS 官方参数说明](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusagecommon)。卸载子进程可能晚于启动器退出，验收等待实际移除完成。

## 关键桌面 CI

普通 [Checks 工作流](../.github/workflows/ci.yml) 使用相同冻结预览，增加 worker／Python 逻辑和 `test:desktop:critical`。当前 28 项覆盖多格式实际解码、播放状态与退出恢复、首段在线 MP3、完整哈希移交、字幕检查／排队／加载／部分结果取消、电子书分页及阅读锚点恢复、有界书架／目录、跨页连播、工具按需完整单书、正文续页交错，以及字幕工具宽窄／明暗、真实部分稿取消和播放会话。禁止 focused tests、重试、跳过和缺少预期项；使用合成媒体、受控 Python 协议进程和本机 HTTP，不下载真实书籍或识别模型。

CI 只上传合成报告、日志和截图，保留 14 天；不上传应用资料数据库、安装程序、ZIP 或模型。自动化检查证明应用流程，不替代 [固定模型质量](QUALITY_REGRESSION.md) 和人工听审。

## 验收边界

GitHub 的 Windows runner 预装开发工具，以管理员运行且关闭 UAC，见 [官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)。即使本流程通过，也只能称为开发 runner 的真实当前用户安装／升级／保留资料验收，不能称干净 Windows 11、标准用户无提权、签名或 SmartScreen 验收。本机 `--plan-only`、本机桌面结果和远程实际结果按版本分别记录。

本流程的基线和新版支持相同资料 schema；不证明未来任意 schema 升降级兼容，也不证明目录版资料自动迁移。程序目前没有自动更新服务、可信更新 feed 或签名发行链，插件更新不等于主程序更新。当前仍沿用显式下载／核对／退出后升级流程；发布程序资产、建立更新源和实际干净设备验证另行实施。
