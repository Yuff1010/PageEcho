# 合成音频夹具

这些文件由项目生成，为 20 秒单声道静音，不包含第三方录音，可随项目提交。

- `tone.mp3`：MP3，22,050 Hz，32 kbps。
- `tone.m4a`：AAC LC，22,050 Hz，MP4 容器。
- `tone.m4b`：AAC LC，含 0–10 秒与 10–20 秒的两个内嵌章节；应用当前按一集播放。

首次生成使用 `imageio-ffmpeg 0.6.0` Windows wheel 内的 FFmpeg 7.1 构建。FFmpeg 仅用于开发时生成夹具，不是应用或测试执行的依赖，不随安装包分发。普通桌面测试直接使用已提交的文件；两小时 WAV 则由测试在临时目录生成。

重新生成：设置 `RALB_FFMPEG` 为 FFmpeg 可执行文件的绝对路径，再运行 `npm exec -- tsx tests/fixtures/generate.ts`。结果是静音，测试验证的是媒体解码、时间推进、倍速、跳转与持久化，不验证演播音质。

## M2 中文伴读样本

`第32集-伴读样本.wav` 是 Microsoft Huihui Desktop 以 16 kHz/16-bit 单声道合成的三句项目原创文字；`reading-manual.json` 按独立合成片段的起止位置标注，含句间停顿和一段未覆盖区间。二者可直接在应用内导入。章节编号故意不一致：音频名为第 32 集，文字从第十九章开始。

在安装有该系统语音和 Python 的 Windows 开发设备上，运行 `tests/fixtures/generate-reading.ps1` 可重新生成。生成依赖不进入应用或普通测试运行时；中文脚本通过 Python UTF-8 模式执行。重新生成后 JSON 会写入新音频的 SHA-256。
