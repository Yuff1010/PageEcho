# 工作区结构与维护

更新：2026-10-30。维护版本 `0.34.0-dev.2`；可运行程序继续使用 `0.34.0-dev.1`。

## 目录职责

```text
ReadAndListenBook/
├─ src/
│  ├─ main/                  Electron 主进程、书库、来源、字幕任务
│  ├─ preload/               受限 IPC 桥
│  ├─ renderer/              React 界面、共用组件与设计参数
│  └─ shared/                主进程／界面共同契约
├─ python/                   转写运行模块、组件构建及现存诊断工具
├─ scripts/
│  ├─ build/                 主程序构建、目录打包与插件打包
│  ├─ asr/                   字幕组件准备与构建
│  ├─ maintenance/           只读空间清点
│  └─ *.ts / *.py            现存验收／诊断脚本，待删除范围
├─ examples/source-plugins/  可打包的网站插件源码和许可
├─ docs/                     使用、设计、架构及版本记录；archive/ 保留早期草案
├─ tests/                    现存测试源码，删除被审批拦截
├─ out/                      既有开发输出，保持不变
├─ release/                  本机程序目录、ZIP 与离线组件，Git 忽略
└─ cache/                    构建、测量、模型及报告，Git 忽略
```

根目录保留入口说明和构建配置。根 README 介绍当前功能和常用操作；文档导航放在 `docs/README.md`，逐版历史放在 CHANGELOG 和 `docs/releases/`。根目录原有的中文需求草案原样归档至 `docs/archive/initial-requirements.md`；不迁移仍被文档引用的历史验收材料。

## 常用命令

原 npm 命令保持兼容，只调整生产脚本所在目录：

| 命令                                                         | 职责／实际入口                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `npm run dev`                                                | 开发启动                                                      |
| `npm run check`                                              | 当前仍包含类型、lint、单元检查和格式                          |
| `npm run build:preview -- --version 0.34.0-dev.1`            | `scripts/build/build-preview.ts`，新 cache 目录隔离构建       |
| `npm run pack:handoff -- --app-root <路径>`                  | `scripts/build/package-handoff.ts`，自包含目录与 ZIP          |
| `npm run plugin:pack -- --directory <路径> --output <新ZIP>` | `scripts/build/pack-source-plugin.ts`                         |
| `npm run asr:component` / `asr:bundle`                       | `scripts/asr/` 中的组件准备／构建入口                         |
| `npm run workspace:inventory`                                | 清点空间，写入 `cache/maintenance/inventory.json`，不删除文件 |

`workspace:inventory` 使用 Node.js 读取元信息，跳过链接，不读取文件内容、不扫描工作区外目录，报告仅允许写入 `cache/maintenance/*.json`。占用是文件逻辑字节总量，不等同于文件系统实际分配空间。

## 用户要求的删除及当前状态

用户明确选择删除测试源码和生成物。已审计源码候选 252 个文件、3,270,739 字节，包括 `tests/`、Python 测试／诊断、专用验收脚本及 Playwright 配置。删除命令在启动前被自动审批以 `blocked by policy` 拒绝，实际删除 0 文件、释放 0 字节。没有改用其他工具、移动测试目录或拆分同一删除请求来绕过拦截。

因此测试命令、依赖、配置仍保留，避免出现源码还在而入口已断开的状态。获得可执行条件并重新检查清单后，删除需要同步修改 package scripts、锁文件、TS／ESLint／Playwright 配置和示例中的测试命令；不能只删目录。历史测试可从 `v0.34.0-dev.1` 标签恢复。

本机精确源码清单为 `cache/maintenance/source-removal-candidates.json`；占用快照和生成物候选清单也在 `cache/maintenance/`，均不进入 Git。

## 应保留的本机内容

- 应用数据、书架、阅读／播放位置、人工字幕、原书籍与音频。
- 两套完整离线组件、当前配置引用的运行环境和模型。
- `cache/asr-evaluation/` 的环境、模型、输入与人工参考，以及组件构建来源和完整 wheel。
- 当前交付程序、上一版回退程序及两种示例插件。
- 根 `out/` 和 Git 历史。

清理候选主要是旧发行程序、重复压缩包、重复组件安装测试副本、旧构建和测试截图。候选不等于已删除；实际结果以 [存储清理记录](STORAGE_CLEANUP.md) 为准。
