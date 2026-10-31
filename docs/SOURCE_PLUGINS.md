# 来源插件 SDK v1

`0.33.0-dev.1` 提供可安装的 JavaScript 来源插件。来源中心的插头图标进入插件管理；安装后，音频来源出现在耳机面板，正文来源出现在书本面板。普通书架、阅读器、播放器、字幕与人工关联继续由主程序管理。

这是 ReadAndListenBook 的 SDK v1。随身听书、其他阅读器的 ZIP／JS／JAR／DLL 有各自的宿主接口，不能仅凭扩展名直接互换；本版不执行 DLL 或 JAR。

## 用户操作

1. 插件页点击导入 ZIP，或点击网址导入并填写 ZIP 直链。
2. 检查名称、版本、来源和允许访问的域名；预览只读取包，不执行脚本。
3. 确认安装后，软件在受限运行环境检查注册和必需接口，再激活插件。
4. 回到有声书／电子书面板，在来源列表选择新增来源并搜索。
5. 插件卡片提供启停、回滚、卸载和逐源测试。图标悬浮或聚焦可查看名称；错误与实际测试步骤直接显示。

一个 ZIP 可以包含多个来源，最多 40 个；最多安装 20 个插件包。当前文件选择一次导入一个包，支持通过一个包批量注册来源。网址导入支持同源重定向；跨域下载跳转会拒绝，GitHub Release 等跳转到 CDN 的地址应改用可直接取得 ZIP 的直链，或先下载再选择文件。

同 ID 更新必须提高版本，已有来源的 ID 和类型须保留。检查失败保持旧版，成功更新可回滚上一版。正在进行的调用捕获启动时的版本与权限，插件更新不会把它切换到另一套解析逻辑。停用／卸载后不再启动该来源的新网络操作，已保存书籍、正文、进度和缓存仍保留；已缓存音频可继续播放。卸载只移除登记，版本包作为本机存档保留。

## 可直接导入的示例

源码位于 `examples/source-plugins/wikisource/`。它通过中文维基文库公开 API 搜索、读取目录、取得所选章节正文，不需要账户。安装后选择“中文维基文库（插件）”，搜索“呐喊”，打开《吶喊》，选择《狂人日记》等具体章节再导入。

`0.34.0-dev.1` 另提供用户指定网站的 [bqg631 示例与说明](../examples/source-plugins/bqg631/README.md)，支持原封面、搜索、目录及所选正文；本机导入包为 `release/SourcePlugin-Bqg631-1.0.0.zip`。网站制作流程见 [制作来源插件](MAKE_SOURCE_PLUGIN.md)。示例只验证过一部作品的一章，网站接口变化后需要更新解析规则。

```powershell
npm ci
npm.cmd run plugin:pack -- --directory examples/source-plugins/wikisource --output cache/plugin-examples/wikisource-1.0.0.zip
```

打包命令拒绝覆盖既有文件，重复打包时请使用新的输出名。生成器读取插件源码、创建 ZIP 并使用实际包解析器验证结构，不会把网站上的书籍打进包。

可选真实网络验证：

```powershell
node node_modules/tsx/dist/cli.mjs tests/model/source-plugin-public.ts cache/plugin-examples/wikisource-1.0.0.zip
```

示例目录仅表示当前页面中的链接，不保证代表整本作品的完整目录。网站响应、内容完整性及许可信息以原页面为准。

## 包结构与清单

```text
my-source.zip
├─ manifest.json
└─ main.js
```

也接受最外面多一层目录。内部路径只能是相对路径；重复、大小写冲突、链接、路径穿越、可执行文件或超限内容会拒绝。ZIP 压缩大小不超过 8 MiB，展开总量不超过 16 MiB，最多 128 个条目；单文件最多 2 MiB，入口脚本合计最多 4 MiB。

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "my.reader",
  "name": "我的网站插件",
  "version": "1.0.0",
  "main": "main.js",
  "sources": [
    {
      "id": "audio",
      "name": "示例音频来源",
      "kind": "audio",
      "baseUrl": "https://books.example/",
      "allowedOrigins": ["https://books.example"],
      "mediaOrigins": ["https://media.example"],
      "coverOrigins": ["https://images.example"]
    }
  ]
}
```

`main` 与 `scripts` 二选一。多个脚本用 `"scripts": ["common.js", "main.js"]`，按顺序加载。版本是 `主版本.次版本.补丁` 三段数字；插件和本地来源 ID 使用小写字母、数字、点、短横线或下划线，以字母或数字开头，最长 80 字符，发布后保持稳定。完整来源身份由主程序生成：`plugin:my.reader:audio`。

`kind` 为 `audio` 或 `text`。每个来源必须声明 `allowedOrigins`；音频可另声明 `mediaOrigins`，封面可另声明 `coverOrigins`，两者缺省分别沿用 `allowedOrigins`。三组权限独立，播放域不会自动获准加载图片。权限使用精确 origin，包括协议与非默认端口，不接受通配符。例如 `https://books.example` 与 `http://books.example` 是不同授权。

## 注册与返回值

```js
registerSource({
  id: 'audio',
  search: function (query, cursor) {
    return this.host.getJson('https://books.example/api/search?q=' + encodeURIComponent(query))
  },
  getBook: function (bookId) {
    return this.host.getJson('https://books.example/api/book/' + encodeURIComponent(bookId))
  },
  getEpisodes: function (bookId, cursor) {
    return this.host.getJson('https://books.example/api/chapters/' + encodeURIComponent(bookId))
  },
  resolveAudio: function (bookId, episodeId) {
    return this.host.getJson('https://books.example/api/audio/' + encodeURIComponent(episodeId))
  },
})
```

以上域名和 API 仅展示接口，实际网站返回结构需要插件转换。所有方法同步返回 JSON 数据，网络等待由宿主桥接处理；不要使用 `async`／Promise 返回值。每次调用使用新的运行环境，不能依赖上次调用留下的全局变量。

| 方法                                | 需要返回的内容                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `search(query, cursor)`             | `{items: 书籍数组, nextCursor: 字符串或null}`；每本书含 `id`、`title`，可含 `authors`、`narrators`、`description`、`pageUrl`、`coverUrl` |
| `getBook(bookId)`                   | 同上单本书籍对象，ID 必须与请求一致                                                                                                      |
| `getEpisodes(bookId, cursor)`       | 音频必需：`{items:[{id,title,order,pageUrl?}],nextCursor}`；order 为 0–100000 的整数，页内严格递增                                       |
| `resolveAudio(bookId, episodeId)`   | 音频必需：URL 字符串，或 `{url,pageUrl?,headers?,expiresAt?}`；本版播放完整 MP3                                                          |
| `getChapters(bookId, cursor)`       | 正文必需：`{items:[{id,title}],nextCursor}`                                                                                              |
| `getChapterText(bookId, chapterId)` | 正文必需：纯文本字符串                                                                                                                   |

正文与音频来源各自必须实现 `search`、`getBook` 以及对应的后两项方法。书籍／章节 ID 最长 512 字符，分页标识最长 2048 字符；单页最多 1000 项，目录 ID 不得重复。正文界面最多读取 10 页／1000 项目录，每次明确选择 1–20 项导入；这不代表整本作品已经完整下载。

音频返回地址和每次重定向都必须处于 `mediaOrigins`。允许站点返回带临时签名参数的媒体地址；不将该地址当成稳定章节 ID。附加请求头只接受 `Referer`、`User-Agent`、`Origin`、`Accept`，其中页面来源仍受批准域限制。不接受 Cookie／Authorization 等凭据头，也不把用户已有书库密码交给插件。

`coverUrl` 为可选 HTTP(S) 图片绝对地址。搜索和详情都应返回它；没有封面时省略或返回 `null`。主程序按 `coverOrigins` 逐跳检查并代理 PNG、JPEG、GIF、WebP，限制大小、尺寸、并发及内存缓存；不接受 SVG、HTML、凭据网址或授权域以外的跳转。渲染进程只接收不透明的本地图片地址，不直接请求网站。图片失败会显示默认书封，书目信息和阅读／播放仍可用。需要账户认证的图片目前回退默认封面；搜索封面尚不持久保存到书架。

## 宿主能力

| API                                    | 说明                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `this.host.getText(url, options?)`     | 取得文本，支持 GET 或 POST；options 可含 `method`、受限 `headers`、字符串 `body`  |
| `this.host.getJson(url, options?)`     | 取得并解析 JSON                                                                   |
| `this.host.select(html, selector)`     | CSS 选择器提取，返回 `{text,html,attributes}` 数组；仅解析 HTML，不执行其中的脚本 |
| `this.host.resolveUrl(relative, base)` | 解析相对网址；真正请求时仍重新校验权限                                            |

普通请求头允许 Accept、Accept-Language、Content-Type、Referer、User-Agent、X-Requested-With；Referer 也必须处于授权域。POST 不能经重定向把请求体发送到另一个 origin。宿主不带应用 Cookie、账户或环境凭据。

运行限制：QuickJS/WASM 实例位于可终止 worker 内，脚本不能使用 Node、Electron、文件系统、系统命令、浏览器对象或动态导入外部模块。默认调用时限 20 秒；单请求 15 秒；每次最多 32 个请求、累计 8 MiB 响应，单响应最多 2 MiB；JSON 输出最多 4 MiB。引擎内存限额为 32 MiB，另有栈与 worker 堆限制。取消或超时后终止 worker 并中止宿主网络请求。

插件代码与其授权站点仍需由使用者判断可信程度；这些能力边界不等于任意第三方代码已经通过审核。当前不提供浏览器渲染、登录会话、持久配置／缓存、远端订阅轮询、HLS 或随身听书兼容层。

## 实现与测试入口

- `shared/plugins.ts`：包清单、管理 IPC 和来源元数据契约。
- `main/plugins/{manifest,package,service,adapters}.ts`：有界 ZIP 解析、预览、版本激活／回滚、身份及输出校验。
- `main/plugins/{runtime,worker,http}.ts`：受限脚本引擎、网络代理、请求与资源预算。
- `SourcePluginManager`：独立管理面板；`OnlineSourceBrowser` 和 `SourceCenterText` 获取已启用来源。
- `AudioSourceRegistry` 与正文服务：插件与内置来源共享既有播放、书架及阅读链路。数据库 schema 17 保留旧来源身份并允许插件命名空间。
- `tests/unit/plugin-*.test.ts`、`tests/desktop/plugins.spec.ts`：实际 QuickJS、HTTP 合成站点、音频、正文、更新／取消与数据保留回归。

依赖版本与许可证见锁文件及 `THIRD_PARTY_NOTICES.md`。当前发行证据见 [0.34.0-dev.1](releases/0.34.0-dev.1.md)，插件引擎首次交付见 [0.33.0-dev.1](releases/0.33.0-dev.1.md)。
