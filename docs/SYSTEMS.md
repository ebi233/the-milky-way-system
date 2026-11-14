# 系统目录与主要功能

| 子系统 | 保存/处理的内容 | 对外作用 | 主要目录 |
| --- | --- | --- | --- |
| 星河核心 | 状态、事件、关系、候选、来源、参数版本 | 每轮有限参考与行为选择 | dsh-tidal |
| 情绪观测 | 可见原话、活动轴、评估结果、小快照 | 更新有证据的持续状态 | dsh-feiyu-mood |
| 长期记忆 | 事实、偏好、纠正、近期对话、归档来源 | 按需检索；会话隔离 | dsh-long-memory |
| 表达积累 | 对话例子、明确认可/否定、自主选择 | 当前话题取最多一个表达参考 | dsh-long-memory/lib/expression-* |
| 原有记忆界面 | 社区记忆插件与配套界面 | 保留原系统的记忆管理入口 | dsh-fish-memory |
| 人格自主编辑 | 原版、完整版本、修改原因和校验值 | 主私聊可修改、查看和回滚 | dsh-persona-integrity/self-persona-store.mjs |
| 上下文完整性 | 摘要来源、当前任务、维护记录、回复诊断 | 防止维护信息和旧任务污染正常聊天 | dsh-persona-integrity |
| 聊天桥接 | 私聊/群/访客来源、附件、发送回执 | QQ 收发与通道健康 | dsh-qq-bridge |
| 群行为 | 会话封印、发言门槛、独立主动禁令 | 真实来信回应与空闲主动行为分别控制 | dsh-qq-bridge/lib/group-* |
| 主动活动 | 持久调度、随机候选、话题与目的回执 | 可继续话题、探索或选择安静 | dsh-speak-up、bridge/private-proactive.mjs |
| 模型分流 | 主聊天/后台模型与推理档位 | 显式模型路由，示例 Flash/max | dsh-creative-sampling |
| token 管理 | 按需工具、摘要/压缩策略 | 控制上下文规模 | dsh-token-economy、dsh-token-optimizer-* |
| 图像理解 | 图片来源、动图抽帧、会话附件注册 | 识图和屏幕辅助，防跨会话读取 | dsh-vision |
| 图片生成交接 | 需求、候选、审图、成图和送达回执 | 区分已生成、审定与已发送 | dsh-draw、dsh-qwen-image |
| 语音 | 转写、TTS 提供方适配、语音发送 | 语音输入输出 | dsh-voice、bridge/lib/voice.mjs |
| QQ 资料 | 名片、公开表情、语音选择、空间辅助接口 | 有范围的 QQ 表达与资料操作 | dsh-qq-profile |
| 公开内容 | B站资料、浏览历史、兴趣线索 | 内容阅读和自主兴趣探索 | dsh-public-social、dsh-bili-subagent |
| 短媒体辅助 | 受控浏览器节点、登录检查、结果中继 | 可选的本地浏览器辅助能力 | dsh-short-media |
| 工具保护 | 子进程资源、超时、失败状态 | 避免维护/工具挤占主服务 | dsh-tool-runtime-guard |
| 私人网页 | 主会话专用鉴权、可见历史、图片、请求账本 | 非 QQ 的备用聊天入口 | bridge/lib/private-chat* |
| QQ 原生实验 | 固定原生适配、有限消息账本、媒体存储 | 独立于 NapCat 的备用号实验服务 | experimental/qq-cloud |

除特别标明外，插件位于 `runtime/srv/dsh-qq-ext/`，桥接位于 `runtime/srv/dsh-qq-bridge/`。云端运维脚本在 `runtime/srv/dsh-cloud/bin/`。

## 依赖和边界

DSH 提供 agent、模型、会话与插件宿主；本仓库不包含 DSH 二进制或依赖安装目录。部分模块仍通过固定 Linux 宿主路径引用 DSH 包，部署时需要对应目录布局及兼容版本。

QQ 正式桥接使用 OneBot/NapCat；独立原生服务是单独实验，不自动取得主会话权限。腾讯 QQ 客户端、模型账号、图片/语音提供方、浏览器登录及本地节点均是外部依赖。没有部署对应外部服务时，这些模块不能仅凭源码提供完整功能。

图片审图由实际可用的执行者和模型完成；代码队列本身不能保证全天候唤醒 Codex 或自动生成图片。网页部署与鉴权接口检查也不等于手机访问、推送及真人对话都已验收。

## 建议阅读顺序

1. `dsh-tidal/state-kernel.mjs`、`core.mjs`：状态和当前参考。
2. `dsh-tidal/appraisal-core.mjs`、`appraisal.mjs`：事件、关系与调用去重。
3. `dsh-tidal/memory.mjs`、`association.mjs`：来源与关联。
4. `dsh-long-memory/lib/expression-library.mjs`、`expression-observer.mjs`：表达积累。
5. `dsh-qq-bridge/lib/channel-transport.mjs`：通道边界。
6. `tests/` 与 `experimental/qq-cloud/test-*.cjs`：可复跑的隔离行为检查。
