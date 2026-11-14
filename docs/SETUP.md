# 部署、配置与本地验证

## 这份发布包能直接做什么

可以阅读当前运行代码、运行隔离回归检查、研究星河和通道实现。它是经过脱敏的代码快照，不含生产账号、DSH 安装目录、QQ 二进制和完整服务配置；没有把新机器完整安装验证成一键运行。

建议先运行离线检查，再在独立环境配置宿主。不要把发布包直接覆盖正在工作的服务器。

## 本地检查

需要 Node.js 22+ 和 Python 3.10+：

```bash
npm test
```

命令依次检查 JS/Python/JSON 语法和发布文件，再运行星河与 QQ 的隔离测试。测试使用临时目录、虚构账号和模拟模型/原生接口，不需要 QQ 登录或模型凭证。

```bash
npm run test:xinghe
npm run test:qq
python tools/check_publication.py
```

## 原项目运行布局

```text
/srv/dsh-qq-bridge/           QQ 桥接与私人网页
/srv/dsh-qq-ext/              星河、记忆、人格、视觉等插件
/srv/dsh-cloud/home/          DSH_HOME：本机私有配置及状态，不在 Git 内
/srv/dsh-cloud/bin/           运维辅助脚本
/srv/dsh-voice/               语音服务连接
/srv/dsh-qwen-image/          可选图片服务连接
```

`runtime/srv/` 保留此目录关系，以免破坏插件间相对导入。部分宿主模块仍从 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 引用；部分组件支持 `DSH_HOST_MODULES`。本包没有将全部固定路径改造成跨平台安装器。

部署前先独立安装兼容的 DSH、所需 npm/Python 依赖和 QQ 通道。插件注册沿用各包的 `package.json` 与 `cordis.patch.yml`；不能把所有插件无差别同时启用，也不要直接套用别人的主会话绑定。已带本地修改的插件不应被自动更新覆盖。

## 配置示例与必须替换的内容

示例位于 `examples/`。编号均为虚构占位值；配置示例不是生产凭证。

| 项目 | 示例/配置位置 | 实际部署时填什么 |
| --- | --- | --- |
| 聊天路由 | home/model-routing.json | 已明确填为 deepseek-flash / max；后台 deepseek-flash |
| 星河策略 | home/tidal-state/policy.json | 九项默认参数、版本与自主调整开关已填 |
| 前置评估 | home/tidal-state/appraisal-policy.json | version=1、enabled=true、timeoutMs=8000 |
| 身份和主会话 | home/qq-bridge-config.example.json | 自己的主 QQ、独立 session id、OneBot 地址和本机凭证 |
| 情绪会话范围 | home/feiyu-mood/config.json | 与主会话相同的 session id，不能把群与私聊混在同槽位 |
| 人格 | home/persona.example.md | 自己的人设；不提供泡泡的私人原文 |
| QQ 实验 | qq/transport-config.example.json | 测试号、明确允许的目标、随机 64 位十六进制 token |
| 模型/语音/图片服务 | 对应提供方的本机配置 | 自己已有的合法账号及凭证；不上传 GitHub |
| 私人网页 | DSH_HOME/private-chat/config.json | 专用 tokenHash、主号和 session，独立于后台管理凭证 |

**模型路由示例必须显式配置。** 保留的旧组件源码中仍有 Pro 的缺省值；公开包没有更改生产组件的所有默认行为。读取 `model-routing.json` 后才采用 Flash/max。

私有 token 可用 `python -c "import secrets; print(secrets.token_hex(32))"` 在自己的终端生成。生成后只写入私有配置，不粘贴进 issue、README、截图或提交。

## 资源与部署验证

原环境约 1.64 GiB 物理内存，实验期间通过暂停原服务避免同时运行两套 QQ。这个记录不表示 1.64 GiB 足够任意部署，也不等于 QQ 的最低内存要求。

原主服务有 MemoryHigh=512 MiB、MemoryMax=768 MiB，JS 堆单独设为 320 MiB。QQ 实验容器限 512 MiB 内存、768 MiB 含交换、192 进程和 0.75 CPU。按自己的环境测量，不要取消上限来掩盖故障。

先备份、检查资源与源文件校验，再短步骤安装；恢复后应验证真实 QQ 在线、实际收发与同请求去重。容器 running、接口返回 accepted、文件生成和用户收到是不同状态。

## 回退与数据

保留每次代码和配置版本。回退星河功能开关可以保留新关系与表达记录；不要用旧整包覆盖新的人格、私聊、模型配置和单群静默要求。

本仓库不提供自动删除状态或重启生产的安装脚本。私聊、群聊、访客和维护会话需要独立标识；切换 QQ 账号也不能直接复用不属于它的主会话。
