# 真实 EPUB 与单集跨章验收

日期：2026-10-21（America/New_York）。`0.10.0-dev.4` 用同作品的真实 43 分钟 MP3、冻结的实际识别稿和两种官方 EPUB，补齐单个音频跨多个原文章节的功能检查。人工转录与发音边界尚未提供，自动映射数不代表正确率。

## 输入与复现

原文来自 [Project Gutenberg《吶喊》27166](https://www.gutenberg.org/ebooks/27166)，保留官方 EPUB2/EPUB3 原始下载字节，没有用简体转换后的文件替换原书。音频为 [LibriVox《Call to Arms》](https://librivox.org/call-to-arms-by-xun-lu/) 的 Jing Li 朗读，第 10 轨《阿Q正传》第一部分；测试没有拼接多个分集。

| 输入                              | 大小/范围                                  | SHA-256                                                            |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `nahan-epub3.epub`                | 181,676 字节                               | `f953cde7e07fbfef77ff4a9147339dd233e1e6a1aa011195438f245db0626ecf` |
| `nahan-epub.epub`                 | 190,353 字节                               | `04e83cae40ac2c03bf9d4d192667ffbb4e12aa932cf94a1ee1e8aa97b0d8fc1c` |
| `calltoarms_10_lu.mp3`            | 41,505,070 字节，媒体时长 2,593,895.329 ms | `e2e1c7a405ddee08e50666d5dabc9b54d13ce169f528e2fb5d99a74b73e3119d` |
| `long-after-0.8.4.generated.json` | 冻结的实际 ASR 文稿，1,006 段              | `f191b930fabef08108ea8084eb86ad0526e09491666d09c1b6aba3bcf09f5197` |

下载清单为 `cache/asr-evaluation/original-epub-source/2026-10-21T05-18-31.736Z/manifest.json`。清单保留下载当时的旧解析统计；最新解析结果以实际运行报告为准。普通 CI 不下载原文、音频或模型。

```powershell
npm run original:prepare:epub -- --download
npm run build:preview -- --version 0.10.0-dev.4
npm run test:original:epub -- --app-root '<本轮 appRoot>' --old-app-root '<dev.3 appRoot>' --manifest '<EPUB manifest.json>' --audio-manifest 'cache/asr-evaluation/audiobook-source/manifest.json' --transcript 'cache/asr-evaluation/ctc-diagnostics/long-after-0.8.4.generated.json'
```

## 修正与界面

实际繁体书与简体识别稿暴露了原先只做 NFKC 规范化的不足。匹配规则 4 在 main/worker 中使用固定 `opencc-js@1.4.2` 的 `t → cn` 转换，再做大小写和标点规范化；全文搜索采用相同规则。原文展示、字幕导出的原文和保存的 ASR 文字均保留原样。字典随依赖离线提供，renderer 不加载字典。转换形成的重复原文仍须经过规则 3 的全书歧义检查，不能因繁简兼容而直接认定唯一。

EPUB 解析版本升至 3，跳过没有正文文字的图片封面；TXT 继续使用解析版本 2，已有 TXT 索引不因 EPUB 修正而失效。两个官方版本分别形成 16/21 个阅读分区、各 4,670 句。分区包含前言与版权信息，不代表出版章节数量；其他 EPUB 排版、加密及不支持格式的限制沿用[原文说明](ORIGINAL_TEXT.md)。

原文搜索和字幕菜单收在同一工具行，阅读区保留至少 180 px。手动滚轮、触摸、键盘浏览或操作原文表单暂停跟随；“跟随原文播放位置”恢复跟随并将当前句带入可见区域。最终真实 EPUB 截图已检查。

## 实际结果

最终构建：`cache/preview-builds/2026-10-21T05-46-29.003Z/app`。最终报告：`cache/asr-evaluation/original-epub-runs/2026-10-21T05-48-49.765Z/report.json`。

- 同一份实际 ASR 与同一份原文分别交给旧规则 3、新规则 4 的已构建 worker，两个 EPUB 版本均由 6/1,006 自动映射变为 276/1,006；730 段保留空缺，人工复核数为 0。此次没有重新运行 ASR。
- 单个原始 MP3 的映射涉及“第一章序、第二章優勝記略、第三章續優勝記略、第四章戀愛的悲劇、第五章生計問題”；在前三章分别执行了真实媒体跳转和原文定位。与[《青山》一章跨两集](ORIGINAL_SEQUENCE.md)共同补齐两个方向的功能证据。
- 简体“头发”能检索繁体原文；原文 SRT 保留繁体字及已有媒体坐标。版本切换恢复各自映射，重启保持原文/映射，ASR 文稿不变。
- 音频、两份原始 EPUB 及冻结文稿的内容、大小和修改时间保持不变；启动入口和构建摘要保存在运行目录。
- TypeScript、lint、110 项逻辑检查和格式检查通过；最终构建的 32 项实际 Electron 桌面回归通过，无跳过、失败或重试不稳定项。
- 《青山》前三集规则 4 的独立复验仍为 53/137、62/164、35/153，与规则 3 的已记录结果一致，没有新增或丢失自动映射。报告为 `original-sequence-rematch-runs/2026-10-21T05-40-25.681Z/report.json`，其中实际 worker 对照为旧规则 2 与新规则 4；真实长篇搜索/字幕复验为同时间戳的 `reading-tools-runs/`。这两项使用改布局前的 dev.4 构建，匹配 worker 与最终构建相同；最终界面另由本页 EPUB 及完整桌面回归覆盖。

目录打包与依赖/许可证静态检查见[预览包验收](PACKAGE_PREVIEW.md)。本页证明实际输入的功能和持久化流程，不证明 276 条均正确、未映射内容均为删改、逐字同步质量或默认引擎适用性。真实对话、专名、插话、删改与发音边界的人工验收仍保留；已准备的九段《青山》听审材料尚未得到人工反馈。

另按片段序号 15%、50%、85% 固定抽取本次 EPUB 音频的三段材料，目录为 `cache/asr-evaluation/original-review-packs/2026-10-21T06-03-54.324Z/`。`review.md` 可直接试听，`review-template.json` 的人工字段保持空白。摘录从书籍当前绑定的 EPUB 版本读取映射，冻结报告/数据库/原音频均核对摘要，未写入原数据库；不按映射是否成功选择样本，也不作为准确率结果。

同一摘录入口也在规则 4 的《青山》三集报告重验，通过九段导出，目录为 `original-review-packs/2026-10-21T06-04-40.916Z/`。两个新包合计 12 段，全部人工字段尚未填写。旧规则 3 的九段包保留，版本与来源不混用。
