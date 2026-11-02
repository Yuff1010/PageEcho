# 依赖与字幕组件安全

2026-11-02 的 `0.37.0-dev.1` 更新兼容依赖并收紧模型加载。它不是无漏洞认证，Torch／Transformers 的引擎系列升级仍待完成。

## 本次审计与修复

| 清单              | 修改前                          | 修改后                                             | 统计范围                                                        |
| ----------------- | ------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| npm 完整锁文件    | 26 项 moderate                  | 15 项 moderate                                     | `npm audit --json` 的依赖节点统计；无 high／critical            |
| npm 生产依赖      | 0                               | 0                                                  | `npm audit --omit=dev --json`；不包含外置 Python 组件           |
| Python 两份锁文件 | 7 个受影响包版本、98 条原始记录 | 2 个受影响包版本、19 条原始记录、14 组别名归并公告 | OSV 全部 140 个公共包版本；CPU／CUDA 本地版本按公共发行范围核对 |

npm 锁定 `fast-uri@3.1.9`，只对原 `minimatch@^10.0.0` 消费者覆盖为 `11.0.4`。旧 3／5／9 系列仍有兼容与依赖链问题，不把不同调用接口强行替换，也未忽略告警。此处跨主版本覆盖需要锁定安装、实际打包和调用兼容验证，不能只看安装成功。

两份 Python 锁同步更新以下五项，模型与引擎版本保持固定：

| 包         | 原版本 | 新版本 |
| ---------- | ------ | ------ |
| filelock   | 3.32.3 | 4.2.1  |
| hydra-core | 1.3.7  | 1.3.8  |
| nltk       | 3.10.3 | 3.10.4 |
| pillow     | 12.3.0 | 13.0.0 |
| setuptools | 78.1.0 | 84.1.0 |

官方 wheel 的 URL、字节数与 SHA-256 固定在 `python/security-component-wheels.json`。构建器核对原可信组件、完整 wheel、ABI、RECORD、全部复制文件与最终清单，保留许可证；不向旧环境执行 pip，不删除或改写旧模型。CPU 构建器当前以修补后的通用组件为基础，其历史结果仍记录原输入。

## 加载与旧版处理

- 组件能力检查及 worker 启动都核对五项补丁门槛；仅修改组件配置不能绕过 worker 的检查。
- 旧 `0.7.0` 和 `0.7.1-cpu.1` 的可信记录保留，历史安装记录可读取。新导入在整包认证后拒绝，旧版启用／转写会提示升级。原文件不被删除，普通播放、已有字幕及人工文稿仍可使用。
- 应用自己的固定清单包含五个模型角色的 29 个文件，以及实际选中的 WhisperX 包内 Pyannote VAD 权重。worker 在原生模型加载前核对身份、精确文件集合、字节数与完整 SHA-256；同 revision 的替换文件和新增优先权重文件也拒绝。VAD 包含在发行依赖中，不在 `models/` 下，须单独验证。
- 固定清单的摘要和补丁契约进入结果缓存指纹；不会把旧引擎配置的结果误作本版新生成结果，已有人工文稿不因此重写。

该校验减少替换权重的输入风险；它不是对恶意 Python／原生组件代码的沙箱，也不能阻止同一用户权限的恶意进程修改应用或校验后替换文件。只使用可信组件，保留目录校验。不能将 `trust_remote_code=False` 或 `weights_only=True` 单独视为安全保证：[PyTorch 官方公告](https://github.com/pytorch/pytorch/security/advisories/GHSA-63cw-57p8-fm3p) 描述了恶意 checkpoint 在 `weights_only=True` 下的风险。

## 剩余工作

当前 Torch `2.8.0`、Transformers `4.57.6` 仍出现在审计中。WhisperX `3.8.6` 固定依赖 Torch／Torchaudio `~=2.8.0`、Torchvision `~=0.23.0`、旧 Hub／TorchCodec 范围；直接跳到修复版框架会违反现有兼容约束。后续应一起升级引擎与依赖，重新验收 CPU／CUDA、时间戳、取消、长音频和人工质量，再更换默认组件。本次不压低告警等级，也不将固定模型当成漏洞已修复。

开发依赖仍有 15 个 moderate 节点。后续按各工具链消费者的实际接口升级；不要使用不兼容的全局 override 或 `audit fix --force` 代替验证。

## 复现与记录

若 OSV 返回分页标记，当前审计明确失败并退出 2，不把首份结果标成完整扫描；后续可扩展有界分页。[OSV 官方说明](https://google.github.io/osv.dev/post-v1-querybatch/#pagination) 的响应阈值可能调整，因此有独立回归覆盖该边界。

```powershell
npm.cmd ci
npm.cmd audit --json
npm.cmd audit --omit=dev --json
npm.cmd run audit:python -- --output cache/python-audit-current.json
npm.cmd run test:worker
```

Python 审计只读取固定清单并查询 [OSV API](https://google.github.io/osv.dev/api/)，不导入模型。输出文件必须新建于忽略的 cache 范围；完成且有告警退出 1，审计失败退出 2，无告警退出 0。结果随公告数据库变化，不能把本页历史数字当成以后扫描的结果。Dependabot 分别检查 npm 和 `/python`，没有添加漏洞忽略项。

兼容补丁组件构建：

```powershell
npm.cmd run asr:patch -- --base release/asr-component-0.7.0-win-x64 --wheels cache/p0-python-security/wheels --output release/PageEcho-ASR-0.8.0-sec.1-win-x64 --version 0.8.0-sec.1 --archive release/PageEcho-ASR-0.8.0-sec.1-win-x64.zip
```

输入必须是固定可信基础包和上述官方完整 wheel；输出和归档必须尚不存在。CPU 补丁输入为原 `0.7.1-cpu.1`，本次交付目标为 `0.8.0-cpu-sec.2`。产物只保留在本机，未配置在线组件源或发布模型资产。真实运行、产物摘要及未验收范围见 [本版记录](releases/0.37.0-dev.1.md)。
