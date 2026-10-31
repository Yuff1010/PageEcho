# 为网站制作来源插件

插件把网站的数据转换成本软件认识的书籍、章节和正文／音频。它包含网站地址、请求方法和解析规则；只输入网站首页，软件无法自动知道这些规则。插件在受限 JavaScript 环境中运行，网络由主程序代发，书架和播放器由主程序提供。

已有可导入的 bqg631 插件时，无需自己编程：来源中心 → 插头图标 → 导入 ZIP → 核对权限并安装 → 电子书面板选择“笔趣阁 bqg631”后搜索。完整作者接口见 [SDK v1](SOURCE_PLUGINS.md)。

## 1. 找到实际数据接口

在浏览器打开目标网站，按 F12 打开网络面板，分别执行搜索、打开书籍、打开目录和读取一个公开章节。查看 Fetch/XHR 请求的 URL、参数及响应结构。如果数据直接写在 HTML 中，可以使用宿主的 `select(html, selector)` 提取，不需要执行网页脚本。

用户提供的 `https://www.bqg631.xyz/#/` 是单页应用：首页只有框架，数据来自 `/api/search`、`/api/book`、`/api/booklist`。正文由该网站普通客户端编码参数后发送到 `https://apibi.cc/api/chapter`。具体已验证格式及当前限制见 [示例说明](../examples/source-plugins/bqg631/README.md)。不能把这个接口结构直接套给其他网站。

## 2. 从示例复制清单与脚本

正文插件可参考 `examples/source-plugins/wikisource/` 的简单例子，或 `examples/source-plugins/bqg631/` 的多脚本例子。为自己的插件设置唯一 `id`、名称、版本及稳定的来源 `id`。清单的页面域、音频域和图片域分别写入 `allowedOrigins`、`mediaOrigins`、`coverOrigins`；仅加入实际需要的域名。

例如 bqg631 的清单允许请求网站和正文 API，图片只允许网站本身。`crypto-js.js` 是随包提供的客户端编码库，`main.js` 是解析规则，`manifest.json` 指定加载顺序；没有给脚本新增系统加密或文件访问接口。保留第三方库的许可证和来源记录。

## 3. 实现四个方法

正文来源实现 `search`、`getBook`、`getChapters`、`getChapterText`。音频来源把后两项换为 `getEpisodes`、`resolveAudio`。用 `this.host.getJson/getText` 取得数据，按 SDK 返回结构转换；这些方法同步返回结果，不返回 Promise。

书籍最少含稳定的 `id` 和 `title`；有作者、简介、来源地址和原封面时一并返回。相对图片地址先用 `this.host.resolveUrl` 转成绝对地址，例如：

```js
return {
  id: String(item.id),
  title: item.title,
  authors: item.author ? [item.author] : [],
  coverUrl: item.cover ? this.host.resolveUrl(item.cover, this.website + '/') : null,
}
```

不要使用书名、当前页码或临时签名 URL 代替稳定身份。目录需要检查重复 ID、分页、空标题和响应错误；正文返回纯文本。bqg631 当前使用网站的一基章节序号，网站重排目录时需重新核对，这一限制已写在示例里。

## 4. 打包并预览权限

在仓库根目录执行：

```powershell
npm ci
npm.cmd run plugin:pack -- --directory examples/source-plugins/bqg631 --output cache/plugin-examples/bqg631-local-1.zip
```

输出文件必须尚不存在。命令会校验实际 ZIP 结构；包内放清单、脚本、许可和说明，不放账户、下载的书籍或音频。导入预览中确认名称、版本、来源类型、页面域和封面域符合预期，再安装。

## 5. 先验证少量内容

选择新增来源，搜索一部书，确认原封面、作者、目录顺序，明确选择一个章节导入并打开阅读。然后测试错误关键词、无封面、图片失效、取消和网络失败。搜索能返回不代表正文一定可读。

bqg631 提供合成回归 `tests/unit/bqg631-plugin.test.ts`，以及显式运行的 [单章联网验证](../examples/source-plugins/bqg631/README.md)。联网验证不纳入普通单元测试，不批量下载，不把正文写入测试夹具。

## 6. 网站变化后更新

保持插件和既有来源 ID，修改请求／解析规则，把 `version` 从 `1.0.0` 提高到 `1.0.1`，打包成新 ZIP 后重新导入。安装失败保留旧版，成功更新后可在插件卡片回滚上一版。更换域名时同时更新清单和脚本，让新的网络权限在预览中可见。

当前 SDK 不提供浏览器渲染、登录会话、随身听书插件兼容层或 HLS 播放。网站要求登录、验证或返回拒绝时，应显示实际失败；仅更换首页地址不能使不兼容的网站可用。
