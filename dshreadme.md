# 给 AI 看的安装说明

这份文档是给 AI 助手执行用的：请照着做，把当前目录里的 AuraLife 装成 DeepSeek Harness（DSH）插件。

读完请先确认自己能改文件、能读 `~/.dsh`（Windows 是 `C:\Users\<用户名>\.dsh`）。

## 0. 先确认几件事

- 目标机器上装了 **DSH 桌面版**（`dsh` 命令或桌面 App 都可以）。
- 知道 DSH 的 home 目录：默认 `~/.dsh`；如果环境变量 `DSH_HOME` 存在，用它。
- 知道当前平台（Windows / macOS / Linux），后面的路径写法按平台来。

## 1. 找 DSH 的 profile

```bash
ls ~/.dsh/profiles
```

通常只有 `desktop`（桌面版）或 `web`。记住要装的那个，下面用 `<profile>` 指代。

profile 目录里有 `package.json`，形如：

```json
{
  "name": "...",
  "dependencies": { ... },
  "dsh": { "profile": { "bundles": [ ... ] } }
}
```

## 2. 把插件放进去

把本目录（就是有 `package.json`、`src/`、`public/` 的那一层）挪到你想放的位置，例如：

- Windows：`D:\dsh-plugins\dsh-auralife`
- macOS / Linux：`~/dsh-plugins/dsh-auralife`

下面用 `<插件路径>` 指代这个绝对路径，**注意 JSON 里写正斜杠**。

## 3. 登记成依赖

编辑 `~/.dsh/profiles/<profile>/package.json`：

1. `dependencies` 里加一项：

   ```json
   "dsh-auralife": "file:<插件路径>"
   ```

2. 如果文件里存在 `dsh.profile.bundles` 数组，把 `"dsh-auralife"` 加进去。
   （没有这个字段就不用管，插件会通过包名自动发现。）

改完保持 JSON 合法，别动其它字段。

## 4. 让 node_modules 认得它

在 `~/.dsh/profiles/<profile>/` 下执行：

```bash
pnpm install
```

如果 pnpm 报 lockfile 相关错误（例如 `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`），退而求其次，在 `node_modules/` 里建一个指向插件目录的符号链接，名字必须是 `dsh-auralife`：

```bash
# macOS / Linux
ln -s <插件路径> ~/.dsh/profiles/<profile>/node_modules/dsh-auralife
```

```powershell
# Windows（管理员或开发者模式）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-auralife" -Target "<插件路径>"
```

## 5. 重启 DSH

插件只在启动时装载。完全退出 DSH 再打开（不是只关窗口）。

## 6. 验证

1. 侧栏应出现 AuraLife 入口；也可以直接开 `http://127.0.0.1:2332/`。
2. 第一次打开是五步向导：名字和签名 → 怎么称呼你 → 人设和头像 → 模型和思考强度 → 主人账号（密码至少 6 位）。
3. 设完会自动登录。发一句话，能回就说明整条链路通了。

如果打不开 2332：

- 看 DSH 的日志有没有 `auralife` 相关报错；
- 确认端口没被别的程序占用（`设置 → 网页入口` 里可以改端口和监听地址）；
- 确认 profile 的 `package.json` 是合法 JSON。

## 7. 可选：语音

- **朗读（TTS）**：`设置 → 语音` 选后端。微软 edge-tts 有「安装」按钮，会建一个插件自己的 Python 环境；Windows 自带语音离线可用；其它后端填地址即可。
- **听写（STT）**：用 DSH 自带的 SenseVoice，`设置 → 听语音` 打开开关就行，不需要填地址，不需要联网。第一次录音会先加载模型，慢几秒正常。

## 8. 数据在哪

`~/.dsh/plugins-data/auralife/`（配置、账号、消息、记忆、日记、人设都在这里）。备份就是拷走这个目录；想重来就删掉它再重启 DSH。

日志只在内存里，不落盘。

## 9. 卸载

1. 从 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 和 `bundles` 里删掉 `dsh-auralife`。
2. 删掉 `node_modules/dsh-auralife` 链接（或跑一次 `pnpm install`）。
3. 如果想连数据一起清掉，删 `~/.dsh/plugins-data/auralife/`。
4. 重启 DSH。

## 出问题的话，把这些给维护者

- 平台 + DSH 版本；
- `~/.dsh/profiles/<profile>/package.json` 的内容；
- DSH 日志里含 `auralife` 的行；
- 「日志」页里红色（error）的几行。

版本号写在 `package.json` 的 `version` 字段里，日志页右上角也能看到。
