# 来源中心与个人书库

`0.32.0-dev.1` 将来源选择从固定的单个有声网站拆成三类。侧栏地球图标进入来源中心，耳机、书本和文件夹图标分别选择有声书、电子书和我的书库；悬浮或键盘聚焦可查看说明。每次只显示当前面板。

`0.33.0-dev.1` 另增插头图标的“插件”面板，支持导入本软件 SDK v1 的 ZIP 脚本包、权限预览、启停、更新、回滚和逐源测试。一个包可注册多个音频／正文来源，安装后出现在相应来源列表。下文的 JSON 连接清单仍只管理个人书库地址；插件包的用法与完整边界见 [来源插件 SDK](SOURCE_PLUGINS.md)。

## 可以使用的来源

| 来源                    | 当前能力                                             | 内容边界                                                                        |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| 听十三                  | 沿用搜索、分集目录、加入书架、播放和缓存             | 现有适配器与已验证媒体线路；网站改变时会显示错误                                |
| LibriVox                | 官方 API 搜索、完整书目分集、实际 MP3 下载和缓存     | 以外文公版朗读为主；中文查询可能无结果                                          |
| 中文维基文库            | 搜索作品、查看当前页面目录、选择正文范围、导入并阅读 | 每次选择 1–20 项；目录是页面内链接，不保证代表整书完整目录                      |
| OPDS 个人书库           | 分类、分页、服务器提供的搜索、TXT／EPUB 获取         | 支持 OPDS 1.x Atom 和 OpenSearch 模板；不支持 OPDS 2 JSON、DRM 或购买／借阅流程 |
| WebDAV 个人书库         | 逐层浏览文件夹、当前目录筛选、TXT／EPUB 导入         | 只读配置目录；每层最多 5000 项、文件每页 80 项，不递归扫描整盘                  |
| Audiobookshelf 个人书库 | 书库导航、分页、服务器搜索、主电子书导入             | 本版接入 TXT／EPUB 主电子书；不创建远程音频会话、不同步远程听读进度             |

个人书库需要填写自己的服务地址。OPDS 填目录端点，例如 Calibre-Web 的 `/opds`；WebDAV 填允许浏览的文件夹地址；Audiobookshelf 填服务根地址，支持部署子路径。没有配置私人服务时，公共来源仍可独立使用。

## 操作与保存

有声书先选择来源再搜索；来源身份由 `sourceId + bookId + episodeId` 确定，同名、同编号的不同源不会覆盖已有进度或字幕。切换来源保留该面板已取得的结果；切换面板或取消会使旧请求失效，不在请求结束后意外播放。

正文先查看详情，再选择章节或可获取格式。导入后直接打开普通电子书阅读器，使用现有书架、阅读设置和锚点。相同来源端点、作品与选择范围再次导入会复用已保存书籍；不同章节范围和不同端点分开识别。移除来源连接不会删除已导入正文。相同书名不会自动关联另一种资源，原有人工关联及校正语义保留。

我的书库中，新增连接为加号；更多菜单提供编辑、启停、连接检查、移除、连接清单和刷新。可取消正在进行的搜索、目录读取及导入；导入取消在阅读事务提交前生效，已保存的书籍和阅读位置保留。错误与恢复操作直接显示，普通说明放在气泡中。

凭据使用 Electron `safeStorage` 加密后保存在当前用户数据的 `data/text-libraries.json`。渲染进程只收到 `hasCredentials`，不会回填密码或令牌；编辑时不填写表示保留，显式清空可移除。改变连接类型或域名会清除旧凭据。导出连接清单不含凭据。

## 连接清单与更新

本版采用可审查的声明式 JSON 连接清单。粘贴清单先预览新增／更新，明确应用后才保存；相同清单 ID 必须提高 `version` 才能更新。稳定的连接 ID 保持配置关联，连接端点改变不会把另一个库的同编号书误当成原书。

```json
{
  "schemaVersion": 1,
  "id": "my-libraries",
  "version": 1,
  "libraries": [
    {
      "id": "home-opds",
      "kind": "opds",
      "label": "家中书库",
      "baseUrl": "https://books.example.com/opds",
      "enabled": true
    }
  ]
}
```

清单只保存地址与公开配置，不执行脚本，也不兼容其他阅读器的 JS、JAR、DLL 或任意网页解析规则。本版没有自动轮询远端订阅；更新通过预览后应用新的清单完成。

## 结构与边界

- `shared/sources.ts` 和 `AudioSourceRegistry` 管理内置音频适配器；浏览与媒体下载各有独立实例，按照持久化来源身份路由。数据库 schema 16 保留既有 UUID、分集、进度、手工文稿及缓存哈希。
- `shared/text-sources.ts` / `text-source-api.ts` 定义正文、个人书库和明确的 IPC。`text-validation.ts` 拒绝未知字段、过长输入和无效标识，`text-source-ipc.ts` 仅接收可信主窗口请求。
- `TextSourceService` 管理连接、取消、导入身份和连接清单；`TextLibraryConnector` 管理各协议的浏览、详情与文件获取。`TextBookImporter` 使用独立原文 worker，不取消或占用人工原文匹配 worker。
- `TextHttpClient` 限制同源请求、每跳重定向、超时、体积与完整响应；连接凭据不放入地址或公开错误。正文文件最多 32 MiB；目录响应最多 2 MiB。XML 不允许 DTD／外部实体。WebDAV 每跳还限制在配置文件夹内。
- `SourceCenterAction` 使用共享 `Tooltip` 和原生按钮语义；`OnlineSourceBrowser` 负责面板、音频来源选择，`SourceCenterText` 负责正文与个人库。页面样式局限于 `source-center.css`，不覆盖共用书架、阅读工具栏或播放器尺寸。

## 参考与验证方法

研究参考了多个项目的接口与结构，具体实现为本项目新增适配器：

| 参考项目                                                      | 采用的思路                              |
| ------------------------------------------------------------- | --------------------------------------- |
| [随身听书](https://github.com/whykang/ssts)                   | 稳定来源标识、每源请求隔离、取消与超时  |
| [eprendre/tingshu](https://github.com/eprendre/tingshu)       | 来源元数据与版本清单；不执行其 JAR 插件 |
| [亦搜](https://github.com/mabDc/eso)                          | 搜索、详情、章节、正文的职责拆分        |
| [LNReader 插件](https://github.com/lnreader/lnreader-plugins) | 每源清晰契约、实际站点探测与失败状态    |
| [Readest](https://github.com/readest/readest)                 | OPDS 获取与文件传输分层                 |
| [Calibre-Web](https://github.com/janeczku/calibre-web)        | 用户自己管理的书库与 OPDS 入口          |
| [Audiobookshelf](https://github.com/advplyr/audiobookshelf)   | 私人媒体库的正式 API 与稳定资源身份     |
| [hectorqin/reader](https://github.com/hectorqin/reader)       | 私人文件库、OPDS 与只读内容入口分离     |

实际协议依据 [LibriVox API](https://librivox.org/api/info)、[MediaWiki API](https://www.mediawiki.org/wiki/API:Main_page)、[OPDS 1.2](https://specs.opds.io/opds-1.2)、[WebDAV RFC 4918](https://www.rfc-editor.org/rfc/rfc4918)、[Audiobookshelf API](https://api.audiobookshelf.org/) 实现。没有复制这些项目的应用代码或宣称兼容它们的全部扩展。

离线回归使用本机 HTTP 合成目录、文本与认证，不把 fixtures 当成任意私人服务器的兼容证明。公共网络探测独立运行：`npm run test:source:wikisource` 检查搜索、真实章节目录、所选正文和原文解析；音频探测验证实际 MP3、SHA-256 与第二次缓存命中。当前交付证据及未验证项见 [0.32 版本记录](releases/0.32.0-dev.1.md)。
