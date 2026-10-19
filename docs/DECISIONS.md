# 技术决策记录

更新日期：2026-10-18（America/New_York）

## 已确定

### D001：Windows 优先

用户目前只需要 Windows。首先验证 Windows x64；其他平台与架构不作为第一版验收条件。业务与数据模块保持可拆分，但不为尚未确定的平台投入实现工作。

### D002：Electron + React + TypeScript

用于桌面主程序和界面。React 负责书架、目录和伴读交互，Electron 提供文件、窗口、托盘与任务进程管理，TypeScript 描述 UI 状态和 IPC 契约。

接受 Electron 自带 Chromium 与 Node.js 的运行时开销。安装体积、启动与内存表现通过原型记录，不使用未经本项目测试的性能数字。此次选择不依赖复用第三方项目代码。

## 采用默认方案，等待实现验证

### D003：先本地播放与转写伴读，再在线书源

先用人工文稿验证时间同步，再接入识别模型，便于区分播放器、时间轴与模型识别的问题。后续通过共享媒体和转写服务服务所有书源。

### D004：HTMLAudioElement 作为初始播放器

使用媒体时间、倍速、跳转和结束事件实现听书基础功能。需验证实际文件编码、长音频 seek、倍速音质、后台播放以及受控本地协议。播放器接口保持可替换；不预设所有格式都兼容。

### D005：Python 独立转写进程

便于使用开发者已有 Python 基础以及语音识别工具。通过结构化消息与 Electron 通信，避免阻塞 UI。代价是增加运行时分发、模型管理和进程恢复工作。

FunASR 与 WhisperX 均为候选，不预先认定中文识别或对齐胜出。也可在同一评估接口下增加其他引擎。云转写不作为第一版必需项。

### D006：SQLite + 文件缓存

SQLite 存储书架、进度、文稿索引和任务；媒体与模型存于文件系统。驱动在 M0 根据所选 Electron 版本、打包兼容性和维护成本确定。避免在 UI 更新路径进行长时间同步数据库工作。

### D007：electron-vite 与 electron-builder

分别作为开发构建与 Windows 打包的默认候选。M0 就执行首次安装包验证，尽早发现路径、原生依赖和资源分发问题。创建应用骨架时锁定经过核对的兼容版本。

### D008：先实现书源适配接口

首个在线来源采用内置适配模块；验证多个来源的共同能力后再确定可安装插件格式。没有决定兼容已有 DLL 或 JavaScript 插件，不将第三方插件文档当成已验证协议。

## 尚未决定

- 默认识别模型、量化方式、是否启用 GPU，以及资源/速度/质量目标。
- 第一个在线书源及登录方式。
- UI 组件库、应用状态库和 SQLite 驱动。
- Python/模型的具体分发方案、更新渠道和代码签名方式。
- 是否公开仓库以及采用何种许可证。

## 参考依据

下列资料用于验证框架能力和研究模块设计；不代表项目已集成、运行或达到参考项目的效果。

- [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [HTMLMediaElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement)
- [electron-vite](https://electron-vite.org/guide/)
- [electron-builder](https://www.electron.build/)
- [Koodo Reader：Electron / React / TypeScript 参考](https://github.com/koodo-reader/koodo-reader)
- [随身听书：书源和桌面播放参考](https://github.com/whykang/ssts)
- [read-along：音频转写与时间戳伴读参考](https://github.com/Ceasar369/read-along)
- [Book-Sync：转写与 EPUB 原文对齐参考](https://github.com/jlafuenti/Book-Sync)
- [Readest：EPUB Media Overlays 伴读参考](https://github.com/readest/readest/blob/main/apps/readest-app/docs/read-along-narration.md)
- [FunASR](https://github.com/modelscope/FunASR)
- [WhisperX](https://github.com/m-bain/whisperX)
