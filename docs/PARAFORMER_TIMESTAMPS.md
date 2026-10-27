# Paraformer 时间戳修复与验收

版本：0.8.1，日期：2026-10-20（America/New_York）。旧版 0.8.0 的失败记录保留在 [人工参考基线](HUMAN_REFERENCE_BASELINE.md)。

后续 0.8.2 修复已有标点被任务层重复补写，并补充实际 43 分钟章节；时间戳兼容逻辑保持本节规则。新证据见 [有声书验收](AUDIOBOOK_VALIDATION.md)，以下保留 0.8.1 原始结果与范围。

## 问题与实现

原先 15 段真实人声中，Paraformer 识别完成但 13 段的原生时间戳超过实际音频 17–73 ms，应用以 `ALIGNMENT_FAILED` 终止。

核对 PyPI 原始 `funasr-1.4.16-py3-none-any.whl` 后，确认独立组件的 Paraformer 模块与 wheel 逐字节一致：模块 SHA-256 为 `c7c1da94015ef48ea2d25a493fb272378c3f9ec9893cf1d638caedb74ef33d0e`。wheel 为 999,588 字节，SHA-256 `f95943f6a8111349a1b08907363b048a49e9cb9caa1e3afd8c92970d08bf450d`。本机查询时 PyPI 最新版仍为 1.4.16，其调用颠倒了 CIF alpha 和 peak 两个参数；上游已有 [1878d61 修复](https://github.com/modelscope/FunASR/commit/1878d61dbe8942587acb1f5543ec77dc1ca1e73c)。

应用在固定版本、模块哈希和模型类型均匹配时，只给当前模型实例绑定修正调用的 inference 方法；复制该方法的 globals 后以正确的关键字调用原 helper。类、模块 helper、安装文件及其他模型实例不变，重复初始化不会再次交换。未知的 1.4.16 实现拒绝套用兼容逻辑并提示准备固定组件；其他版本保持原生调用，仍须通过同样的时间校验。

只修正参数后，仍有 10 段出现负起点或末端越界。因此原生时间无效时，额外使用已在组件中的固定中文 CTC 模型，对相同识别文字和实际输入音频重新对齐。有效原生区间直接使用；对齐模型按需加载并复用。CTC 禁用插值，缺失字符时间、越界、乱序或文字不一致仍报 `ALIGNMENT_FAILED`。

重新对齐不裁剪原生时间或改写识别文字。原生结果完整保留在块缓存的 raw 中，CTC 结果放在 `alignmentFallback`；每个使用重新对齐的块记录 `NATIVE_REALIGNED` 复核标记。若后续块仍失败，已保存的前缀保留，允许重试。

Paraformer 的缓存配置增加时间戳适配契约、CTC 处理方式、对齐模型 revision 与断句资源哈希。旧参数生成的块不会按新配置复用。已有文稿仍保留；旧任务若提示运行时版本变化，可重新生成新任务。独立 0.7.0 ZIP 已包含所需权重和依赖，可以继续使用；本次修复随主程序的 `asr_*.py` 发布，不修改组件资源。

## 同批实际语音

使用原清单的 5 位说话人、15 段、610 个参考字，选段与人工参考均未改变。

- 参数修正单独试验：`runs/public-2026-10-20T07-39-08Z-paraformer-cuda/`，仍为 failed，保留中间证据。
- 完整适配器 GPU：`runs/public-2026-10-20T07-42-24Z-paraformer-cuda/`，15/15 时间检查通过。
- 完整适配器 CPU：`runs/public-2026-10-20T07-44-21Z-paraformer-cpu/`，15/15 时间检查通过。
- 应用同一 worker GPU：`public-worker-runs/2026-10-20T07-44-52.444Z-paraformer-cuda/`，15/15 完成，逐段缓存重放及新 worker 重启复用通过。
- 应用同一 worker CPU：`public-worker-runs/2026-10-20T07-47-23.130Z-paraformer-cpu/`，15/15 完成，缓存及重启复用通过。

路径相对于 `cache/asr-evaluation/`。CPU/GPU 的原始识别和最终 worker 文稿均为 37/610 个编辑（CER 6.07%），识别文字未因重新对齐改变；10/15 段使用 CTC，另外 5 段直接采用有效原生时间。四个新结果均通过，历史失败和仅修正参数的中间结果仍保留在 `timestamp-audit/comparison-0.8.1.json`。

| 适配器 | 识别+对齐总时长 / 音频时长 | 初始引擎加载 | 采样 Python RSS 峰值 |
| ------ | -------------------------: | -----------: | -------------------: |
| CPU    |                     0.1050 |   约 10.59 s |          约 6.33 GiB |
| GPU    |                     0.0295 |   约 10.76 s |          约 7.64 GiB |

比值不含初始引擎加载、解码或全部进程开销；首次 CTC 加载计入 alignmentMs。RSS 是主机单进程采样，含共享页，可能漏掉瞬时峰值。固定片段、每段一次、顺序运行，OS/模型缓存可能已预热；这不是稳定吞吐或首段伴读延迟承诺。重新对齐增加资源和处理成本。

仅 2/15 个整段文字精确匹配参考，本轮粗粒度起点最大绝对差约 218 ms、末端约 116 ms。这是条件选样的整段端点比较，不能给出全局发音时间精度或据此确定默认引擎。长篇听书、广告和专名等原计划质量验收继续保留。

## 完整应用、缓存与只读组件

0.8.1 源码生产构建，对同场会议连续前 120 秒原始片段（第 0 声道、无拼接）执行完整应用验收：生成中退出/重启复用、句子纠错保护、显式采用预览、取消后普通播放、活动任务阻止清理、清理后零命中重生成、人工范围测试标记及重启保存均通过。测试标记不代表真实广告识别通过。

本次应用与组件目录对当前 SID 实际拒绝写入，PATH 仅保留 Windows 系统目录，Chromium offline，worker 保留进程级离线策略。对应用 worker/兼容脚本、嵌入式 Python、FunASR 模块等七处进行了真实 AccessDenied 探测，最终 ACL 精确恢复。它仍是源码应用验收，不替代安装版或目标设备系统运行库验证。

- 应用报告：`cache/asr-evaluation/app-runs/2026-10-20T07-52-25.337Z/report.json`，9 个阶段通过。
- 权限报告：`cache/asr-runtime-source/readonly-offline-20261020T075220.json`，passed、aclRestored=true。
- `timestamp-audit/ui-sample.json` 保存连续片段来源、时长与哈希。
- `timestamp-audit/cache-key-check.json`：旧/新两个实际 worker 运行的 15 个相同音频，其配置缓存键全部不同。
- `timestamp-audit/component-integrity-0.8.1.json`：35,468 个文件、13,427,330,601 字节再次通过完整摘要清单，FunASR 模块仍为原 wheel 哈希。
- 共享的字符结果转换函数亦通过真实 WhisperX GPU worker 15/15 检查，CER 仍为 103/610，逐段缓存和重启复用通过；报告为 `public-worker-runs/2026-10-20T07-53-46.008Z-whisperx-cuda/`（相对于 `cache/asr-evaluation/`）。

只读/离线复现使用本任务拥有的临时组件，见 `tests/model/readonly-offline.ps1`；新增 `-Engine paraformer -Audio <连续片段路径>` 可选择本次分支。脚本在 finally 恢复原 ACL。

## 复现与自动检查

```powershell
npm run asr:reference -- --component '组件/component.json' --engine paraformer
npm run asr:reference -- --component '组件/component.json' --engine paraformer --cpu
npm run verify -- --asr
```

参考数据准备和原始适配器命令见 [人工参考基线](HUMAN_REFERENCE_BASELINE.md)。新增无模型测试验证实例隔离、alpha/peak 身份与偏移、重复初始化、未知源文件拒绝、原生路径不加载 CTC、原生证据保留、禁用插值、缺失时间失败，以及复核标记/已完成前缀的缓存与失败重试。

完整自动检查通过 57 项基础、9 项 Node、36 项 Python（合计 102），开发窗口与生产构建正常，29 项桌面测试通过。报告由 `npm run verify -- --asr` 保存到 `cache/verification/`。`cache/asr-runtime-source/package-0.8.1.json` 核对 asar 的 5 个构建文件和外部 8 个 ASR 资源与源码摘要，无私有资源目录；仅为 `--dir` 资源核对，未运行打包 EXE 或 NSIS，仍无可用 0.8.1 主程序安装包。

最终代码的完整回归报告：`cache/verification/2026-10-20T08-00-32-531Z/report.json`。报告保留原计划尚未完成的 22 项，不因本次修复和测试通过而自动勾选。

原始 wheel 和上游提交说明保存在 `cache/asr-evaluation/timestamp-audit/`。实现只使用已有固定依赖；没有执行上游网络脚本或修改系统策略。
