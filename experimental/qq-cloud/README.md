# 独立云端 QQ 接入实验

当前为固定 Linux QQ 3.2.32-52194 的实验适配器。通信由腾讯原版 QQ 完成；本目录不加载 NapCat，也不包含腾讯客户端、账号登录状态或独立重写的 QQ 协议。

已实测：备用账号自身设备文字、指定好友文字与 PNG/JPEG 图片、不同新图首次下载、指定群文字、重启登录及短时停机补收。尚未完成：泡泡正式桥接切换、长期稳定、群图片验收和其他 QQ 版本兼容。

发布版账号已改为虚构的 `10002`，主号示例 `10001`，群示例 `20001`。实际部署须把 adapter.cjs 的 ACCOUNT 与私有 transport-config.json.account 设为同一测试账号；目标 allowlist 默认留空。不要拿示例值登录，也不要直接绑定主聊天会话。真实账号通过官方客户端扫码登录，不提供账号密码。

运行结构：官方 QQ → boot-service.cjs 加载原入口 → service.cjs → adapter/media/recovery。boot-service.cjs 读取同目录的 paopao-original-main.json，该文件需在安装时保存官方 package.json 的原 main/version；不能伪造。服务文件位于容器 /home/qq/lab，使用受限容器，数据卷只挂测试号自己的目录。

固定接口：GET /health、/events?after=N、/requests/<id>、/media/<id>、/groups；POST /send-text、/media、/send-image、/fetch-image、/recover。所有接口要求 Bearer 令牌，服务端口 9229 只应映射主机回环 127.0.0.1:19229。不得同时开启 Node Inspector 或任意执行入口。

事件分页使用 nextCursor；pending 图片需等待 ready 并验证校验值。群发送必须引用该群最近 10 分钟真实来信。请求先落盘，同一编号不重发，结果未知不自动重试。恢复最多最近 64 条，缺锚点明确报告 gap。

测试：在仓库根目录运行 npm run test:qq。测试使用虚构账号、临时目录和模拟原生接口，不发送真实 QQ 消息。新机器一键安装尚未验收，因此不附带历史探索版 Dockerfile、Inspector 引导器或生产停启脚本。
