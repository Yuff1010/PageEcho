# 品牌与兼容标识

从 `0.36.0-dev.1` 开始，软件显示名称采用 **听见书页 · PageEcho**，GitHub 仓库地址约定为 `Yuff1010/PageEcho`。原名“听读 · ReadAndListenBook”只保留在兼容标识、已有文件夹和历史记录中。仓库实际更名与同步结果以本版交付记录为准。

| 用途                   | 当前约定                                     | 修改入口                                                                               |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| 中文显示名             | 听见书页                                     | [共享品牌配置](../src/shared/brand.ts) 的 `APP_NAME`                                   |
| 英文产品名             | PageEcho                                     | 同文件的 `APP_PRODUCT`                                                                 |
| 窗口与应用标题         | 听见书页 · PageEcho                          | 同文件的 `APP_TITLE`，界面与主进程复用                                                 |
| 当前源码仓库           | `https://github.com/Yuff1010/PageEcho`       | README、贡献与安全入口                                                                 |
| 新程序目录与安装包前缀 | `PageEcho-<版本>`                            | 构建脚本复用 `APP_PRODUCT`；electron-builder 的 productName／artifactName 与其保持一致 |
| Windows 快捷方式       | 听见书页                                     | `electron-builder.yml` 的 `shortcutName`                                               |
| npm 包内部名称         | `read-and-listen-book`                       | 保留在 package 元数据中，不随品牌改名                                                  |
| 安装／应用标识         | `com.readandlistenbook.desktop`              | 保留原 appId，继续识别已有安装                                                         |
| Electron 内部名称      | `ReadAndListenBook`／`ReadAndListenBook-dev` | 保留主进程 `app.setName`，避免改变默认用户数据路径                                     |

electron-builder 目录版使用 `PageEcho.exe`。手工自包含目录版继续使用 `runtime/electron.exe`，保留官方运行时文件名与原字节；用户从 `start.cmd` 或 `continue-preview.cmd` 启动。历史发行目录不跟随新前缀重命名。

## 数据与协议保持兼容

本次只调整对外名称与新发行物名称。`RALB_USER_DATA` 等环境变量、`ralb:` 设置键、IPC／来源插件／备份格式以及数据库身份保持原样。既有程序使用的数据目录继续沿用，包括 `%APPDATA%\ReadAndListenBook-standalone` 与 `%APPDATA%\ReadAndListenBook-preview-0.13`；不创建“新品牌空书架”，不搬动书籍、字幕、模型或缓存。

已存在的本机源码文件夹可以继续叫 `ReadAndListenBook`，不必为了仓库改名而搬动工作区。新克隆命令使用 `PageEcho`；历史版本文档中的目录、ZIP 名、源码链接和校验值记录的是当时产物，不做追溯替换。README 截图也保留其捕获时的版本与来源说明。

调整名称时先区分显示文字与持久身份。自然语言中的“听读”仍可表示边听边读的活动；不要把这类描述机械替换成产品名。改变持久身份、数据位置或插件协议属于单独的迁移工作，需要明确迁移方案与验证。
