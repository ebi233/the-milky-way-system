# 来源、许可与修改说明

星河/泡泡是基于 DSH 与社区插件构建的集成和扩展项目。仓库作者 ebi233 不主张第三方组件为自己原创。源文件中的版权、作者、package 元数据和已有 LICENSE/NOTICE 保留。

| 组件 | 原来源/作者 | 本快照的主要修改 |
| --- | --- | --- |
| QQ bridge | [Yuuyuko-uu/dsh-qq-bridge](https://github.com/Yuuyuko-uu/dsh-qq-bridge) | 会话隔离、群规则、主动调度、消息回执、可替换通道与私人网页 |
| Speak up | [Yuuyuko-uu/dsh-speak-up](https://github.com/Yuuyuko-uu/dsh-speak-up) | 持久调度、安静决策执行、星河状态与活动结果接线 |
| Feiyu mood | [Yuuyuko-uu/dsh-feiyu-mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood) | 可见原话证据、逐轴校验、持续状态快照与事件关联 |
| Fish memory | [Yuuyuko-uu/dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory) | 保留既有记忆入口，与范围限定的记忆体系配合 |
| Bili subagent | [Yuuyuko-uu/dsh-bili-subagent](https://github.com/Yuuyuko-uu/dsh-bili-subagent) | 公开内容与子任务调用的集成；同时保留其上游声明 |
| Token optimizer | [Zoria-Lind/dsh-token-optimizer](https://github.com/Zoria-Lind/dsh-token-optimizer) | 作为配套组件保留；不是星河原创 |
| Bili duty 上游 | [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | 声明保留在 Bili 插件 LICENSE |
| Bilibili MCP vendor | AGI_Ananas | vendor 内保留完整许可，不改写作者 |
| Garden vendor | CyanCat22 | garden-upstream 内保留 LICENSE 与 NOTICE |
| Screen capture vendor | see-now vendor | 保留 Apache-2.0 LICENSE、NOTICE、SOURCE.md |

本项目集成层新增/扩展：星河七模块、事件评估与长期关系分离、可追溯记忆与联想、个人表达积累、人格版本与上下文保护、资源受限运维、接入实验等。各项实际状态见 STATUS.md；不把这些扩展等同于重写 DSH、QQ 或全部社区模块。

## 许可处理

已部署快照中自带的 MIT / Apache-2.0 等许可保持原样。`dsh-speak-up` 已部署目录缺少 LICENSE，本次从其公开原仓库补入完整《Yuuyuko-uu 插件许可 1.2》，并在首页第一屏列出派生来源和修改范围。项目整体衍生发布遵循根目录同份许可；嵌入的第三方材料仍保留其自身许可及通知，不以根许可证替换原版权声明。

DSH 和腾讯 QQ 是外部运行依赖，未将其二进制、账号数据或模型权重放入本仓库。独立 QQ 目录是本项目的运行时适配代码，仍调用腾讯原生实现；不称独立 QQ 网络协议实现。

## 公开版与生产版的区别

公开版保留算法和运行逻辑；账号、私有服务器地址、真实会话标识已改为虚构示例。群人格和具体关系文本替换为通用规则；旧实例特有表达匹配替换为示例。未携带任何聊天或语料库内容。逐文件变化类别见 PUBLICATION_CHANGES.json。

这份代码包不会修改正在运行的泡泡；不是新模型、新人格或全量数据迁移。
