# bqg631 网站插件示例

此目录展示如何为 `https://www.bqg631.xyz/#/` 编写听见书页（PageEcho）的 SDK v1 插件。它是可安装的正文来源，不是浏览器扩展，也不内置任何书籍正文。原 ReadAndListenBook 的 SDK v1 格式保持兼容。

## 打包与导入

```powershell
npm.cmd run plugin:pack -- --directory examples/source-plugins/bqg631 --output cache/plugin-examples/bqg631-1.0.0.zip
```

在软件的来源中心 → 插头图标 → 从 ZIP 导入插件，核对域名后确认安装。随后回到电子书页签，选择“笔趣阁 bqg631”，搜索书名，查看目录并勾选本次需要的章节。

需要单独检查网站兼容性时，可运行以下可选网络探测；它只在内存中读取《反三国演义》的第一章，输出目录数量、字节数与 SHA-256，不保存或打印正文，不加入用户书架：

```powershell
node node_modules/tsx/dist/cli.mjs tests/model/source-plugin-bqg631.ts cache/plugin-examples/bqg631-1.0.0.zip
```

一个插件由清单和脚本组成。修改此插件时保持 `id`／来源 `id` 稳定，提高 `version`，重新打包后导入即可更新。网址是 hash 路由，首页 HTML 只有框架；实际书籍数据从它公开网页使用的 API 读取，所以仅复制首页地址并不能生成解析规则。

## 公开客户端协议

兼容性检查日期为 2026-10-29。插件只请求以下已检查的地址：

- `https://www.bqg631.xyz/api/search?q=...`：书名／作者搜索，响应的 `data` 是书籍数组。
- `https://www.bqg631.xyz/api/book?id=...`：书籍信息；目录可能另用其 `dirid`。
- `https://www.bqg631.xyz/api/booklist?id=...`：按网站顺序返回章节标题，章节编号为其一基序号。
- `https://www.bqg631.xyz/bookimg/{floor(id/1000)}/{id}.jpg`：网站原封面。
- `https://apibi.cc/api/chapter?token=...`：正文请求。参数按网站公开 `/js/read.js` 中的普通客户端协议生成：公共短语的 MD5 十六进制串前半段作为 UTF-8 IV、后半段作为 UTF-8 AES key，AES-CBC／PKCS7 编码 `{id,chapterid}` 并转 Base64。

最后一项只是网站公开客户端要求的请求编码，不提供登录、会员、付费或验证码权限。插件不注入 Cookie／Authorization、不伪造账户状态、不自动轮换备用域名；服务器拒绝访问时照常显示失败。只对搜索、目录及一次公开章节做过兼容性检查，不承诺全站、所有作品或未来版本可用。

网站的首页 hash 导航地址暂未直接保留为插件 `pageUrl`，当前来源链接指向首页。自 `0.35.0-dev.1` 起，软件按每块不超过 1000 项的有界目录继续加载，不再只展示前 1000 项；每次仍需明确选择 1–20 项导入，后续章节追加到同一本来源电子书。网站章节顺序以后若改变，插件序号身份可能随之变化，应重新核对目录，不把新顺序当作既有人工映射。

## CryptoJS 许可与来源

`crypto-js.js` 为官方 npm 包 `crypto-js@4.2.0` 的浏览器构建，仅在插件的受限 QuickJS 环境中作公共客户端请求编码，不增加主程序依赖或宿主加密权限。只加了来源／lint 注释及格式化；MIT 原许可保存在 `LICENSE.txt`。

- 上游项目：<https://github.com/brix/crypto-js>
- 官方包：<https://registry.npmjs.org/crypto-js/-/crypto-js-4.2.0.tgz>
- npm 归档完整性：`sha512-KALDyEYgpY+Rlob/iriUtjV6d5Eq+Y191A5g4UqLAi8CyGP9N1+FdVbkc1SxKc2r4YAYqG8JzO2KGL+AizD70Q==`
- 原始 `package/crypto-js.js`：219,092 字节，SHA-256 `ee02257ffbaf0a9b481c7039b0f3bb20c360c9674fe4be8b38ae709b2ea59bbe`。

CryptoJS 已停止维护；这里以锁定版本复现网站既有客户端协议，不将其旧协议作为保存账户秘密或新密码系统的建议。
