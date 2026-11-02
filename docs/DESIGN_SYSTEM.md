# 界面参数与组件所有权

对外产品名统一来自 `src/shared/brand.ts`，窗口、托盘、应用信息及导航提示共用“听见书页 · PageEcho”；静态 HTML 标题和打包配置与其保持一致。内部应用身份与数据命名空间独立保留，不能用显示名替换，具体约定见 [品牌与兼容标识](BRANDING.md)。

界面颜色使用 `appearance.css` 中的 `--ui-*`，尺寸与间距使用 `src/renderer/src/design-tokens.css`。同一类页面共用组件及参数，不按有声书／电子书路由各写一套字号和头部高度。布局关系如 `0`、`100%`、网格列归属属于结构；可调整的视觉尺寸集中到对应参数组。

## 极简留白与材质

`0.30.0-dev.1` 提供独立的“极简留白／新拟态”视觉风格。未设置风格时默认新拟态，用户明确选择后单独保存在 `ralb:app:style:v1`，根节点为 `data-ui-style`。`light`／`dark`／`system` 仍使用原主题键；风格、明暗和正文纸色是独立维度。新拟态用近同色表面、左上高光／右下暗影与凹入的选中状态表达浮雕，具体范围见 [新拟态说明](NEUMORPHIC_STYLE.md)。以下 `0.29` 的材质保留为极简选项的基线。

`0.29.0-dev.1` 先以书架页面作为视觉预览，方向为暖灰留白与克制的新拟态。共享应用配色使用低饱和绿作动作强调；浅色为暖灰／纸白，深色为炭灰／灰绿。保留 `light`／`dark`／`system`、已有主题存储键和系统跟随行为，不自动把用户改成浅色；阅读正文纸色独立。

`appearance.css` 是应用颜色和材质的唯一来源。新增 `--ui-raised`、`--ui-raised-shadow`、`--ui-pressed-shadow`、`--ui-primary-shadow`、`--ui-cover-shadow`，分别承载浅浮起表面、柔和凸起、选中／按下内阴影、主要播放键与书封的短阴影；`--ui-cover-ink` 与 `--ui-cover-tone-0` 至 `4` 维护五种封面配色，正常封面与播放器小封面共用。组件引用变量，不按书籍格式复制光影值。共用几何参数、正文排版、书封内容及所有操作关系保持原样。

装饰性边界可以减弱：侧栏保留原边框占位但颜色透明，资源分类外层不再绘制胶囊底色。输入／选择框继续使用可辨认的 `--ui-control-line`；选中分类同时有填色和图标颜色，不能仅靠阴影表意。浮起效果仅用于导入、选中分类与主要播放控件，普通图标保持平面，不给整张书卡加框。键盘焦点沿用原描边；强制颜色模式为选中分类提供 `Highlight` 轮廓。此次不增加位移、缩放或新动画。

样式职责仍在原组件文件中：`shell-navigation.css` 负责导航表面，`shelf-header.css` 负责分类及导入，`library-shelf.css` 负责封面及书卡动作，`player-chrome.css` 负责播放键；不另建路由专属换肤覆盖层。诊断、对比范围与验证边界见 [本次视觉预览](MINIMAL_STYLE.md)。

## 书架头部与卡片

两类书架的根节点均为 `.app-shell[data-page-kind='shelf']`。`App` 只传入资源类型、状态与回调；`ShelfHeader` 统一“我的书架”、搜索和导入，`ShelfControls` 统一资源导航、排序和布局。它们实际定义在 `ShelfHeader.tsx`，几何规则由 `shelf-header.css` 负责。

此前电子书路由同时带有 `.reading`，会命中旧 `.reading .topbar` 的 76px 高度及 21px 标题规则，而有声书使用另一套头部。现在 `.reading` 只用于伴读页面，书架使用明确的页面种类；两个书架不再继承阅读页的头部规则。

| 参数                                                                        | 默认值                                          | 负责组件与行为                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `--shelf-header-height`                                                     | 94px；窄窗口 90px                               | `ShelfHeader` 的实际高度                             |
| `--shelf-title-size` / `--shelf-title-line-height` / `--shelf-title-weight` | 26px / 34px / 650                               | 两类书架相同的标题排版，窄窗口不再单独缩小电子书标题 |
| `--shelf-header-padding-start` / `--shelf-header-padding-end`               | 26px / 15px；窄窗口均 18px                      | 标题与工具按钮的垂直位置                             |
| `--shelf-page-inset`                                                        | 36px；≥1400 为 40px；≤950 为 26px；≤800 为 22px | 头部、资源导航与卡片的同一左边界                     |
| `--shell-control-size` / `--shell-icon-size`                                | 40px / 18px                                     | 顶部工具按钮的目标尺寸与图标尺寸                     |
| `--shelf-search-width`                                                      | 240px；≤950 为 175px；≤800 为 155px             | 展开的书架搜索框                                     |
| `--shelf-controls-height` / `--shelf-controls-bottom-gap`                   | 48px / 29px；窄窗口间距 25px                    | 资源导航下方卡片开始位置                             |
| `--shelf-sort-height` / `--shelf-sort-width` / `--shelf-layout-width`       | 36px / 36px / 36px                              | 图标排序选择框与布局按钮                             |
| `--shelf-card-width`                                                        | 152px；≥1400 为 160px；≤800 为 138px            | 两种格式的网格卡片宽度                               |
| `--shelf-grid-row-gap` / `--shelf-grid-column-gap`                          | 30px / 26px                                     | 两种格式相同的网格间距；断点值也只在参数文件定义     |
| `--shelf-cover-ratio`                                                       | 0.87                                            | 两种格式相同的封面比例                               |
| `--shelf-card-title-height` / `--shelf-card-title-size`                     | 36px / 15px                                     | 书名与更多菜单所在行                                 |
| `--shelf-card-meta-size` / `--shelf-card-meta-height`                       | 13px / 21px                                     | 格式／集数与实际位置                                 |
| `--shelf-card-info-gap` / `--shelf-card-cover-radius`                       | 12px / 8px                                      | 封面到书名的间距与封面圆角                           |
| `--shelf-card-cover-title-offset` / `--shelf-card-action-inset`             | 30px / 8px                                      | 封面书名位置与网格关联入口留边                       |
| `--shelf-card-source-size` / `--shelf-card-source-gap`                      | 16px / 7px                                      | 本地／在线来源图标及其与集数的间距                   |
| `--shelf-card-focus-width` / `--shelf-card-focus-offset`                    | 2px / 3px                                       | 书卡操作、书名及截断位置的键盘焦点                   |
| `--shelf-card-cross-size` / `--shelf-card-cross-icon-size`                  | 32px / 16px                                     | 已关联资源的阅读／收听小图标                         |
| `--shelf-list-cover-width` / `--shelf-list-card-height`                     | 64px / 114px                                    | 两种格式的列表卡片                                   |
| `--shelf-list-cross-size` / `--shelf-list-action-inset`                     | 24px / 4px                                      | 列表封面左下的跨模式入口，避免覆盖书名与播放按钮     |
| `--shelf-list-info-gap`                                                     | 18px                                            | 列表封面与书目信息的间距                             |

`ShelfBookCard` 定义在 `LibraryShelf.tsx`，是封面、书名、元信息、关联状态与更多菜单的唯一结构；`library-shelf.css` 使用上述参数。`NormalReading` 负责电子书加载、导入和移除数据，`App` 负责有声书动作与统一书架路由，两者不能另加覆盖头部的横幅或格式专属外边距。

卡片自身保留一个主要动作：有声书播放／暂停，电子书阅读。已关联的另一种资源使用封面上的小图标：有声书卡片使用书本图标进入电子书，电子书卡片使用耳机图标收听对应有声书。网格放在封面左上，列表放在左下，与右下主动作保持分离；标题行只保留书名和更多菜单。按钮具有包含书名的 `aria-label`，`Tooltip` 同时解释已关联状态与动作，支持悬浮和键盘焦点；不再另占一行重复“已关联”或“阅读电子书／收听有声书”。未关联书籍的关联入口、电子书系统朗读、移除及其他操作保留在更多菜单，不把系统朗读误标为已有有声书。

卡片文字按书名、集数／格式、实际位置三个层级排列。本地／在线音频用集数旁的来源图标与气泡保留信息，书名及截断的实际位置也可聚焦查看全文。共用封面不再重复展示装饰性英文和标语；封面尺寸、两类书架的共同几何、阅读进度和原有动作语义保持一致。

## 参数修改边界

应用导航共用 `--shell-rail-width`（80px，窄窗口 68px）、`--shell-nav-size`（44px）和 `--shell-control-radius`（10px），由 `shell-navigation.css` 应用。书架导入主按钮为 40px，附属菜单为 26px；资源分类、排序和布局使用图标，实际的选择值、菜单文字与键盘行为仍保留。常驻动作不重复显示图标旁文字。

- `--shell-*`、`--shelf-*`：书架与应用框架维护者负责；修改先确认 `ShelfHeader`、`ShelfControls` 和 `ShelfBookCard` 的共同表现。
- `--reader-*`：阅读界面维护者负责，应用到共用阅读工具栏、正文和阅读设置。阅读页不通过 `.reading` 给书架重新指定尺寸。
- `--ui-*`：应用主题维护者负责；浅色／深色改变颜色，不改变书架控件几何尺寸。
- 操作、会话与保存语义仍由播放器、原文映射及阅读数据模块负责，视觉参数不改变播放或阅读位置。

## 软件结构与数据流

来源页面由 `OnlineSourceBrowser`／`SourceCenterText` 维护，使用 `SourceCenterAction`、共享 `Tooltip` 和局部 `source-center.css` 参数。有声书、电子书、我的书库是互斥的实际面板，支持方向键与 Home／End；管理动作收在更多菜单。来源页面标题继续使用应用共用头部，导入正文后进入既有普通阅读器，不新增第二套阅读结构或状态栏。协议、导入身份及连接清单的边界见 [来源中心](SOURCE_CENTER.md)。

`source-session.ts` 保存当前进程内各来源的关键词、结果、详情、目录页与选章；互斥面板卸载时取消请求，已完成的界面状态留待返回恢复，不把所有面板同时挂载隐藏。`aggregate-search.ts` 负责三路并发的首批聚合发现，来源面板复用原有结果卡和取消入口，分源错误直接可读；聚合结果不能冒充单一来源的完整分页。

`BackupStoragePanel` 是应用设置中的独立模态面板，由局部 `backup-storage.css` 使用现有 `--app-info-*` 参数控制尺寸。备份／存储为互斥且支持键盘的真实页签；导出、选包、保存、清理预览使用共用图标和气泡，恢复摘要、真实空间、错误及最终“恢复并重启”明确显示。未保存的策略不能预览，处理中不能改动策略。备份偏好仅由 `backup-preferences.ts` 白名单读取，恢复在 `main.tsx` 挂载 App 前完成，失败保留待重试记录。它不拥有书架或阅读 chrome。

来源分章电子书的“获取下一章／取消”属于现有 `ReaderFooter`，不增加常驻横幅。追加完成只更新同一本书的文档版本和总量，`useEbookDocument` 按 hash 清空旧数据块缓存，再用现有锚点恢复，不把追加当作重新打开书籍或自动跳回开头。

`0.33.0-dev.1` 增加第四个互斥的“插件”面板，由 `SourcePluginManager` 与局部 `source-plugins.css` 负责；继续使用 `SourceCenterAction`／`Tooltip` 与既有尺寸参数。安装权限、实际版本、错误和测试结果可读，刷新／回滚／卸载使用准确图标，不复用带 15 秒标记的播放图标。音频及正文面板只选择已启用的插件来源，数据获取仍进入原有链路；不增加书架横幅、阅读工具栏或播放器状态栏。插件包与运行契约见 [SDK 说明](SOURCE_PLUGINS.md)。

| 层级           | 入口与职责                                                                                          | 不应承担的职责                             |
| -------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 渲染入口       | `main.tsx` 加载参数／主题／组件样式与 `ReaderDockProvider`                                          | 不按书籍格式注入第二套页面尺寸             |
| 路由与组织     | `App.tsx` / `app-navigation.ts` 选择书架、章节、录音伴读或独立电子书                                | 不复制头部、卡片、阅读设置结构             |
| 共用视觉组件   | `ShelfHeader` / `ShelfControls` / `ShelfBookCard` / `ReaderToolbar` / `ReaderFooter` / `ReaderDock` | 不猜测进度、音文映射或识别百分比           |
| 阅读偏好与测量 | `reader-settings.ts` / `reader-dom.ts` / `motion.ts` 与两种正文加载 hook                            | 不把窗口重排当作用户跳转音频或修改同步映射 |
| 持久声音会话   | `player.ts` 与电子书朗读服务                                                                        | 不因工具面板切换或控件布局移动而重建音频   |
| 字幕与原文任务 | preload 中明确的 IPC、主进程队列和数据库                                                            | 不把显示层的动画或本地计数作为真实任务状态 |

调整共用高度、字号或间距时先改参数；改变结构时先改对应共用组件。真正需要保留的模式差异是内容与动作，例如录音句子定位声音、电子书分页阅读和系统朗读，而不是同一个标题在两种路由上使用不同字号。新增模式差异应写在此文档，并让回归测试检查实际渲染后的几何与行为。

根目录 `AGENTS.md` 指向本规范，供后续修改持续遵循。参数表、组件实现和实际尺寸回归构成同一约定；只写文档而继续维护多份重复结构不能视为统一完成。

## 回归证据

`tests/desktop/shelf-ui.spec.ts` 保留导入、搜索、排序、菜单、移除取消焦点与关联能力检查，并新增读取真实 `getBoundingClientRect()` 和 `getComputedStyle()` 的对照。它在 1360px／720px、浅色／深色、网格／列表及搜索展开／收起下比较两类书架的头部、标题、导入、搜索、资源导航、排序、布局按钮、卡片起点与封面尺寸；同时检查跨模式入口只有图标且具备准确名称。该测试不是仅比较 class 名或设计参数的字符串。

本轮完整验证结果见本文件末尾的交付记录；运行中的检查不会提前记为通过。

## 阅读与单一控制栏

播放器主控行由 `PlayerBar`／`player-chrome.css` 统一负责：普通页面采用 84px 单排底栏，左侧只保留章节标题与书名，中间播放控件使用等宽左右列保持居中，右侧放工具图标。原生播放进度滑杆移到横贯底栏的上缘，阅读模式则位于来源／分页行与播放主控行之间，不与来源按钮叠放。进度只显示实际媒体位置，时间通过悬浮／聚焦提示和 `aria-valuetext` 提供，不常驻另一行时间文字，也不将字幕覆盖量冒充播放进度。

| 播放器参数                                                | 默认值     | 用途                           |
| --------------------------------------------------------- | ---------- | ------------------------------ |
| `--player-bar-height`                                     | 84px       | 普通页面底栏高度及主内容预留   |
| `--player-transport-width`                                | 160px      | 居中播放操作所在列，两侧等宽   |
| `--player-seek-hit-height` / `--player-seek-track-height` | 16px / 3px | 原生滑杆命中范围与可见细轨     |
| `--player-seek-thumb-size`                                | 10px       | 悬浮、聚焦或拖动时出现的进度柄 |

非阅读页面的 `SubtitleStatus` 使用 `icon` 变体放在右侧；入口不显示第三行字幕时长／领先秒数，完整覆盖区间、分段数、真实进度与待采用稿保留在原详情中。阅读底栏仍使用其 `player` 变体。加载、字幕等待、配置缺失、定时、书签提示和错误放在右侧的条件消息区，保留立即播放、配置和重试；不替换左侧书名，也不另外堆叠常驻通栏。所有拖动、5 秒方向键、Home／End、暂停与媒体会话仍使用原播放器接口。

`0.31.0-dev.1` 将普通后台字幕检查并入同一个右侧字幕入口：`PlayerBar` 仅在实际 `checking` 且没有字幕等待、配置缺失或音频加载时传入 `checkingNotice`，`SubtitleStatus` 的图标变体显示加载环和 `aria-busy`，悬浮／聚焦显示短说明，点击仍可查看已有覆盖详情。其他变体不受影响。减少动画时加载环静止；不使用虚构进度。内联消息不再重复后台检查文字，真实等待／配置／取消及其他操作提示仍保持可见并右对齐。检查与短集跳过提示共存时，内联行只显示跳过提示；可见文字与 Tooltip 共用同一字符串。

播放器不绘制另一条独立 `border-top`；实际 3px 进度与主内容边界重合。原生 WebKit track 盒与 16px 输入框等高，渐变仅以 `background-size` 在其顶端绘制 3px，不依赖默认居中或半像素位移。阅读模式仍位于来源行下边界，不能侵入来源控件。`player-chrome.spec.ts` 用实际 Electron 截图像素核对整条边界及旧偏移位置，并保留命中范围、可见控件和真实声音跳转检查。

`ReaderToolbar` 负责两种阅读页相同的顶部操作尺寸；正文排版仍由 `reader-settings.ts` 中的全局／本书偏好提供。`reader-dom.ts` 是可视句子／字符锚点、列步长和恢复位置的共同基础，`motion.ts` 是共同翻页动画基础。有声书的 `useCompanionPagination` 与电子书的 `useEbookDocument` 都使用这些函数，60 句只属于有界的数据窗口，不能把它显示为按屏幕排版后的“整书页数”。

| 参数                                                     | 默认值                               | 负责组件                 |
| -------------------------------------------------------- | ------------------------------------ | ------------------------ |
| `--reader-toolbar-height`                                | 60px                                 | `ReaderToolbar`          |
| `--reader-toolbar-inset` / `--reader-toolbar-gap`        | 22px / 20px；窄窗口 12px / 8px       | 两种阅读页的工具栏       |
| `--reader-control-size` / `--reader-icon-size`           | 38px / 17px                          | 工具栏按钮与图标         |
| `--reader-dock-height` / `--reader-dock-row-height`      | 124px / 34px；≤900px 为 144px / 54px | `ReaderDock` 与播放器    |
| `--reader-dock-control-size` / `--reader-dock-text-size` | 26px / 12px                          | 内联来源、进度和翻页操作 |
| `--reader-progress-height`                               | 5px                                  | 小型真实生成进度条       |
| `--reader-settings-width`                                | 340px                                | 紧凑设置面板             |
| `--reader-speech-dock-height`                            | 112px                                | 电子书朗读中的单一底栏   |

有声书正文上下不再添加独立的来源栏、进度卡和翻页状态栏。唯一底部 `PlayerBar` 同时承载播放、来源、字幕生成、跟随和分页：来源使用 `source` 插槽，实时生成使用 `activity` 插槽，当前正文分页／跟随使用 `navigation` 插槽。`ReaderDockProvider` 与 `ReaderDockSlot` 只负责 React 控件的布局；持久音频元素继续由 `player.ts` 唯一持有，切换文字来源、打开面板或移动控件都不能重新创建音频、重置进度或自行恢复播放。

`TranscriptionActivity` 的内联模式直接显示真实阶段、小进度条、分段数和取消按钮；未知总量使用不定进度。说明与完整任务细节在“字幕生成详情”弹层中按需打开，设置页仍可显示完整任务卡。取消／重试继续调用同一个会话与任务接口，布局压缩不改变取消和部分稿保留语义。

电子书只有一个 `ReaderFooter`，朗读状态、暂停／声音／语速／停止操作也放进该底栏；不在正文上方另加独立朗读面板。活动朗读时底栏保持可用，正文按实际底栏高度保留空间。

## 阅读设置与帮助提示

`ReaderPreferences.tsx` 是电子书与同步伴读共用的设置结构。两种阅读模式均提供“排版／外观／翻页”三个真实分类；方向键、Home、End 在分类之间移动焦点并选中对应面板。伴读的翻页选项连接真实分页与滚动行为，不能仅因存在音频而隐藏。设置值、全局与本书的覆盖关系、保存及恢复默认仍由 `reader-settings.ts` 负责。

`reader-page.css` 中的 preferences 样式负责设置密度：范围标签、短选项“全局／本书”和帮助按钮位于一行；滑杆以标签、控件、数值组成紧凑行；选择框、复选框沿统一行高排列。设置侧栏按内容缩短，并限制最大高度，内容在侧栏内滚动。窄窗口不应横向溢出，恢复默认和保存错误须保持可见。不要用字号缩小或删除功能来压缩面板。

预设阅读配色、面板透明度与应用主题直接可见。自定义颜色和个人配色置于原生 `details` 中按需展开；摘要保留方向标识和键盘焦点。个人配色名称草稿属于组件状态，切换设置分类不能清空。低对比度提示位于高级折叠内容之外；偏好、主题或个人配色保存失败也直接显示，不能转移到帮助提示中。

`HelpTip.tsx` 与 `help-tip.css` 承载可选解释，例如应用范围的覆盖规则、透明度含义、字体回退和翻页行为。触发器是带准确可访问名称的按钮：鼠标悬停、键盘聚焦或触屏点击均可阅读；按钮使用 `aria-describedby` 关联当前 `role="tooltip"` 内容。提示以原生 popover 的顶层显示，避免被滚动容器裁切，并限制在窗口内。Escape 优先关闭提示且保留触发器焦点，再次 Escape 才交给阅读面板；失焦、外部点击或触发器隐藏也会关闭提示。不能用仅鼠标可见的 `title` 替代这一交互。

常驻动作的短名称由 `Tooltip.tsx`／`tooltip.css` 统一提供：悬浮约 360ms 或键盘聚焦显示，点击仍直接执行原动作；提示不添加包装 DOM，不覆盖 ref、可访问名称或原生控件事件。气泡观察自身及触发器尺寸、保持窗口边界，菜单和原生下拉展开时不抢占 Escape。不要同时保留原生 `title` 气泡造成双重说明。设置主动帮助继续使用 `HelpTip`；菜单文字、正文信息和实际错误不能统一藏进提示。

`ReaderAction` 在 `ReaderToolbar.tsx` 中组合准确图标、原生按钮和共用提示，`reader-icon-actions.css` 分别使用工具栏与底栏已有尺寸参数。播放器的 `player-chrome.css` 只调整播放器本身的控件对齐；字幕摘要的详细语义继续属于 `UISubtitleStatus`，真实数值来源不变，长说明按需查看。视觉诊断及取舍见 [图标与视觉层级优化](UI_REFINEMENT.md)。

`tests/desktop/reader-settings-compact.spec.ts` 覆盖 1200px／720px 宽度、浅色／深色、面板高度与滚动、三个设置分类、键盘／悬停／触屏帮助提示、Escape 焦点、范围短选项、配色草稿及常显错误。既有 `reader-preferences.spec.ts` 和 `reader-blending.spec.ts` 仍验证配色持久化、透明度和真实绘制对比度；高级控件改为先展开后操作。此处列出验收范围，最终桌面结果由主任务统一运行记录。

## 来源与书架原封面

`SourceBookResult` 和 `SourceBookImage` 负责音频／正文来源搜索及详情中的相同封面结构，局部尺寸属于 `source-book-result.css` 的 `--source-result-cover-width`、`--source-detail-cover-width` 和比例参数，不改变 `ShelfBookCard`、书架标题或阅读 chrome。保留书名、作者与简介，封面按钮直接打开书籍；可访问名称和提示共用原动作，不另加重复箭头。结果封面为 96×137px，详情为 120×171px；≤800px 窗口两者宽度为 84px／96px，高度按同一 0.7 比例计算。两类来源共用这些参数，图片使用 `object-fit: cover`。

来源适配器只提供可选的原始 `coverUrl`。`SourceCoverPresenter` 在主进程 IPC 返回时注册候选地址，不修改来源缓存和数据库。`SourceCoverService` 按来源权限代理有界栅格图片，搜索渲染端仅接受 `readlisten://app/covers/` 的不透明地址；图片缺失或失败使用既有 `BookCover`。认证图片不借用个人书库密码。

入库后的原封面由 `PersistentBookCovers` 保存到应用数据目录的 `book-covers/`，按音频／电子书及本地书籍 ID 建立关联，以内容 SHA-256 去重。注册候选经过同一图片代理校验后才可持久保存，独立的 `readlisten://app/book-covers/<hash>` 只读本地图片，不发起网络请求。最多保存 512 个关联／64 MiB，按最近使用情况回收本模块生成的图片；不触碰其他文件。封面不依赖来源继续启用，重启和断网仍可读取已保存内容，图片失效／被配额回收时回退默认书封。

`BookCover` 是书架、章节页和播放器封面的唯一视觉组件，接收可选持久本地 `coverUrl`，拒绝 HTTP(S) 地址；原图片填满既有几何，不另改封面尺寸。`ShelfBookCard`、`App`、`NormalReading` 与 `PlayerBar` 传递相同字段；`player.updateLibrary` 只更新封面状态，不重建音频元素或修改播放位置。封面更新、配额及备份复制通过同一队列串行，保存索引后才发出更新通知。

`source-covers.spec.ts` 在实际 Electron 中验证原图解码、破损／越权图片回退、窄宽与明暗场景，并在正文搜索期间核对正在播放的音频元素、来源和进度保持连续。代理权限、重定向、尺寸、响应类型、预算与缓存由对应逻辑回归覆盖。

## 应用外观与信息

`AppInfo` 的 `appearance`／`about` 面板互斥，`App` 分别保存打开意图。外观设置提供应用主题和视觉风格，不混入版本、数据目录和旧导入；应用信息显示从主进程读取的实际版本、实际 Electron／Chromium 运行环境，以及按需展开的数据目录和旧音频记录，不放主题或风格选择框。两项选择各自持久化，保存失败各自直接显示，不能覆盖已保存值。阅读纸色继续由阅读设置负责。

`app-info.css` 使用 `--app-info-width`（520px）、`--app-info-gap`（16px）、`--app-info-label-width`（72px）控制两个面板的共同尺寸。关闭或 Escape 后恢复应用设置入口的焦点。主题保存失败和应用信息读取／旧导入失败应在对应面板直接可见；异步旧导入结果不能关闭后来打开的其他面板。

## 0.25.0-dev.8 历史交付记录

`0.25.0-dev.8` 的 529 项单元／模块检查、类型、lint、格式及最终 176 项桌面回归全部通过，无失败、跳过或不稳定重试。最终桌面结果为 `cache/compact-reader-validation/desktop-results.json`，截图位于 `cache/compact-reader-verified-tests/`；汇总为 `cache/compact-reader-validation/report.json`。最终构建的 192 个源码文件与当前实现一致，主 `out/` 的 8 个文件未变。

底栏回归在 1144×761 和 720×600 下测量实际控件边界：来源、生成阶段、小进度条、取消及分页均在唯一底栏范围内，按钮没有互相遮挡，正文占扣除工具栏和底栏后空间的 90% 以上。任务未知总量、取消中、已有部分稿、处理暂停与重启后恢复均使用真实主进程队列及受控 worker 验证；未据此宣称模型识别准确率。

最终自包含目录的 89 个文件与 90 个 ZIP 条目校验通过；复制到独立中文路径并在全新数据、仅系统 PATH 下完成 WAV 播放、TXT worker、系统声音实际播放及重启进度恢复。报告为 `cache/handoff-smoke/2026-10-27T01-36-09.530Z/report.json`，包路径及摘要见 [交付说明](DELIVERY.md)。本机隔离运行不等于干净设备或安装器验收。

## 0.26.0-dev.3 图标界面交付

529 项单元／模块检查、类型、lint 和格式检查通过。197 个源码文件与最终构建一致，主 `out/` 的 8 个文件未变。181 项桌面用例均验证：完整运行通过 180 项，唯一旧文案断言改为核对真实集名及时间后复验通过；书签、媒体坐标、重启和音频版本检查保持完整。原始完整报告与复验分别为 `cache/icon-ui-validation/desktop-results.json`、`recent-position-recheck.json`，汇总为同目录 `report.json`。

新增用例检查图标操作的准确名称、悬浮与焦点气泡、原生下拉和菜单的 Escape、真实导入与布局、媒体会话及字幕数值。最终目录通过独立路径、新数据、系统 PATH 下的 WAV／TXT worker／Windows 声音播放与重启恢复验证，报告为 `cache/handoff-smoke/2026-10-27T04-38-56.477Z/report.json`。截图位于 `cache/icon-ui-verified-tests/`，包路径及校验见 [交付说明](DELIVERY.md)。

## 0.27.0-dev.1 播放底栏与应用信息交付

529 项单元／模块测试、类型、lint 和格式检查通过；最终构建完整 185 项桌面回归一次通过，无失败、跳过或不稳定重试。198 个源码文件及字幕 Python 脚本与构建一致，根 `out/` 的 8 个文件保持原样。报告为 `cache/player-strip-validation/desktop-results.json`，汇总为同目录 `report.json`。

新增和扩展回归覆盖两个独立应用面板、真实版本／运行环境、主题保存与失败、焦点恢复；单排播放布局、上缘细轨与命中范围、时间提示、5 秒／毫秒／端点跳转、字幕右侧详情、媒体会话和减少动态效果。宽窄窗口与两种主题的底栏截图及两个面板均已视觉检查。最终自包含目录的独立路径、全新数据、仅系统 PATH 下运行、声音／文字处理及重启恢复也通过，报告为 `cache/handoff-smoke/2026-10-27T23-18-06.027Z/report.json`。发行摘要和完整边界见 [本版记录](releases/0.27.0-dev.1.md)。

## 0.28.0-dev.2 边界轨道修复

529 项逻辑测试、类型／lint／格式及 25 项相关桌面回归通过；真实截图像素验证轨道从边界立即绘制 3px，旧偏移位置恢复为底栏背景，覆盖浅深主题、宽窄窗口与阅读底栏。原生 16px 命中、拖动、悬浮提示、键盘跳转和媒体会话检查保留。最终程序目录的独立运行、声音／文字处理及重启恢复通过，198 个源码文件与构建一致，根 `out/` 的 8 个文件未变。

存储占用的重复性和保留范围已审计，但批量删除被自动审批拒绝，实际释放 0 字节，不能将软件修复通过表述为整个清理请求已完成。证据汇总为 `cache/storage-audit/delivery-report.json`，版本边界见 [本版记录](releases/0.28.0-dev.2.md)，清理状态见 [存储核对](STORAGE_CLEANUP.md)。
