# AuraLife · 住在 DSH 里的数字生命插件

![warn](./warn.png)

[![DSH 插件](https://img.shields.io/badge/DeepSeek%20Harness%20Plugin-0078d6)]()
[![平台](https://img.shields.io/badge/Linux-Windows-fcc624)]()

DeepSeek Harness（DSH）插件。数字生命——内分泌三激素、体力、执念、自我、冲动、器官，有一条不按会话隔离的命；记忆会生长、会联想、会遗忘

## Ta 是什么

- **一条命**：三激素（多巴胺/皮质醇/血清素）慢变量决定 Ta 的状态和话风；体力只按作息走；执念池驱动 Ta 主动开口。这些只能由 Ta 自己调节，用户不能干预。
- **一段会生长的记忆**：聊天自动长成「事件」，事件里抽「事实」，事实带来源和置信度、有版本链。承诺和底线是「硬档」，接近永不遗忘；普通记忆按遗忘曲线淡出。
- **一个会自己长能力的生命**：发现能力缺口（「我没法查天气」）就现场给自己写一个器官——写完即生效、热加载，还能热卸载、坏了自动熔断。
- **人格自己演化**：出厂人设只是底色种子，Ta 会在上面叠加「Ta 自己认定的自己」。
- **多模态**：双向文字/图片/表情/语音/文件；Ta 会主动搭话、自己设闹钟跨天叫醒自己、在空间写日记回留言。

## 特性一览

| 板块 | 内容 |
| --- | --- |
| 生命 | 三激素 · 体力（纯作息）· 执念池 · 主动搭话 · 闹钟（自己设、到点醒）· 作息（自己调） |
| 记忆 | 事实版本链 · 事件 · 联想边 · 遗忘曲线 · 硬档烙印 · 每天重放 · 自我演化 |
| 器官 | 10 个内置器官 + 自写器官 |
| 多模态 | 文字 / 图片 / 表情 / 语音（TTS 四档 · STT 三档）· 任意文件上传 |
| 生图 | 关 / 代码画 / 自定义接口（SD WebUI · ComfyUI · OpenAI 兼容……） |
| 空间 | 日记（想写就写）· 留言 · 串门回访 |
| 跨平台 | Windows · Linux |

## 安装

需要 [DeepSeek Harness 官方版](https://www.deepseek.com/en/harness/)（第三方未测试，无法保证）。

1. 把整个目录放到你放插件的位置，比如 `D:\dsh-auralife`。
2. 在 DSH 的 profile 里登记成依赖（路径换成你自己的）：

   ```json
   {
     "dependencies": {
       "dsh-auralife": "file:D:/dsh-auralife"
     }
   }
   ```

3. 重启 DSH。侧栏会出现「AuraLife」入口，或者用浏览器打开 `http://127.0.0.1:2332/`。
4. 也可以更省事：把项目链接丢给 DSH 让它帮你装。

> 想让 Ta 在 DSH 里用工具（改文件、跑命令），需要在 DSH 那边给完全权限；只想聊天一般不需要；但为了避免出现兼容性问题，强烈建议给 **主人会话** 完整权限。

5.安装客户端(可选)

[Windows](https://github.com/hsushjk/auralife-client-win)

[Android](https://github.com/hsushjk/auralife-client-android)

## 首次使用

> [!IMPORTANT]
> 使用即代表您同意：
>
> - 不用该插件污染任意社区（例如到处评论刷屏）
> - 不用该插件污染任意媒体平台（例如开低质直播圈钱）

## 其它文档

| 文档 | 内容 |
| --- | --- |
| `DEV.md` | 二次开发：架构、模块、数据模型、生命周期、API、调试 |
| `Interface.md` | 自定义接入 TTS / STT / 生图 |
| `clientdev.md` | 客户端开发：HTTP API、SSE |

## 端口与反代

默认监听 `0.0.0.0:2332`（设置里可改）。nginx 反代示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:2332;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_set_header Host $host;
    client_max_body_size 32m;
}
```

`proxy_pass` 末尾不要带 `/`；必须 `proxy_buffering off`。

注意：**麦克风、剪贴板功能需要 SSL**（`127.0.0.1` 和 `localhost` 除外）；DSH 桌面版侧栏内嵌页拿不到麦克风，发语音请走浏览器。

## 数据

全部落在 `~/.dsh/plugins-data/auralife/`（Windows：`C:\Users\<你>\.dsh\plugins-data\auralife\`）：一条命的状态、记忆（按月追加的 JSONL）、聊天分片、媒体文件、Ta 自己写的器官、出厂人设。不联网也能跑，配本地模型就是全程离线。

## 常见问题

**Ta 听不见我说话？** 确认宿主是 DSH 桌面版，并在「设置 → 插件 → 实验性插件」里开「语音输入」；浏览器麦克风需要 https 或 localhost/127.0.0.1。

**模型不回话？** 看「日志」页有没有报错；确认 DSH 那边模型可用、插件有权限起会话，非 Deepseek 模型使用了正确的思考强度。

**客人能看到别人的聊天吗？** 不能。每个账号只有自己的会话，空间动态按由模型可见性过滤。
