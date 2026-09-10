# TokenTide

A macOS menu-bar widget that shows how much of your **Codex** and **Claude Code** quota is left, how much of each weekly quota you actually use, and your usage history — all computed locally from the CLIs you are already signed in to. No accounts, no API keys, nothing leaves your Mac. The interface is in Chinese.

TokenTide 是一个 macOS 菜单栏小工具：随时看 Codex 和 Claude Code 还剩多少额度、每周额度用了多少，以及历史使用记录。数据全部来自你本机已登录的命令行工具，不需要账号或 API Key，也不会上传任何数据。

<p>
  <img src="docs/screenshot-quota.png" alt="额度页" width="330">
  <img src="docs/screenshot-history.png" alt="历史 · 使用率" width="330">
</p>

## 功能

- **菜单栏读数**：两行小字 `CX` / `CC`，分别是 Codex 和 Claude Code 当前窗口的剩余百分比。
- **额度页**：两个服务的当前窗口和每周剩余额度、重置倒计时；额度低于 20% 时提示；每 5 分钟自动刷新，打开面板时数据超过 1 分钟也会刷新。
- **历史 · 概览 / 模型**：参照 Claude Code 的 `/stats`，统计会话、消息、Token、活跃天数、连续天数、高峰时段、常用模型，附 26 周热力图。
- **历史 · 使用率**：每周额度实际用了多少——平均使用率、最高一周、用满次数、本周已用，以及每周柱状图。可以看过去 7 天、30 天、90 天和全部。
- **额度趋势**：最近几次检查的当前窗口剩余曲线。
- **设置页**：开机时启动、自动更新、自动刷新、低额度提醒。
- **自动更新**：发布新 Release 后，TokenTide 会自己下载、校验并安装。

## 系统要求

- macOS 13 或更新（在 macOS 26 上开发和测试），Apple 芯片或 Intel 都可以
- [Node.js](https://nodejs.org/) 20 或更新（TokenTide 的本机服务用 Node 运行）
- 已安装并登录的 [Codex CLI](https://github.com/openai/codex)（`codex`）和/或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`claude`）。Claude Code 需要用 claude.ai 订阅账号（Pro / Max）登录，API Key 账号没有套餐额度可读。只装了其中一个也能用，另一个会显示「不可用」。

## 安装

### 下载安装（推荐）

1. 到 [Releases](https://github.com/redbson/TokenTide/releases/latest) 下载 `TokenTide-x.y.z.zip`，解压后把 `TokenTide.app` 拖进「应用程序」。
2. 第一次打开：TokenTide 没有经过 Apple 公证，macOS 会提示无法验证开发者。打开 系统设置 → 隐私与安全性，在下方点「仍要打开」；或者在终端运行：

   ```bash
   xattr -dr com.apple.quarantine /Applications/TokenTide.app
   ```

3. 之后的新版本由 TokenTide 自己下载安装（见下面的「自动更新」），不会再出现这个提示。

想开机自动启动：在面板的「设置」里打开「开机时启动」。如果提示需要允许，点「打开『登录项』设置」，在系统设置里放行 TokenTide。

### 从源码构建

需要 Xcode 命令行工具（`xcode-select --install`）。

```bash
git clone https://github.com/redbson/TokenTide.git
cd TokenTide
npm install
npm run build:mac
ditto release/TokenTide.app /Applications/TokenTide.app
open /Applications/TokenTide.app
```

打包好的 app 自带界面和本机服务，装好之后可以随意移动或删除项目目录。

## 自动更新

- TokenTide 启动后和之后每 6 小时，会查询一次 GitHub 上的最新 Release。
- 发现新版本后：下载 zip，核对 SHA-256 校验值、程序包标识、版本号和代码签名，全部通过才替换 `TokenTide.app` 并自动重启。面板打开时不会安装，关闭面板后才进行。
- 在「设置 → 更新」里可以关闭自动更新（关闭后只提示，不自动安装），也可以手动「检查更新」「立即更新」。
- TokenTide 放在你没有写入权限的位置时无法自动替换，会提示你手动下载。

## 使用

- **左键**点菜单栏读数打开面板，点别处或按 Esc 关闭。
- **右键**：显示额度 / 立即刷新 / 退出。面板底部也有「退出」。
- **额度**标签：看两个服务的剩余额度和重置时间；右上角按钮立即刷新。
- **历史**标签：顶部切换 Codex / Claude Code，再选「概览 / 模型 / 使用率」和时间范围（全部 / 90 天 / 30 天 / 7 天）。
- **设置**标签：
  - **开机时启动**：登录 Mac 后自动出现在菜单栏，用的是 macOS 的「登录项」，也可以在 系统设置 → 通用 → 登录项 里关闭。
  - **自动更新**：见上面的「自动更新」。
  - **自动刷新**：每 5 分钟读取一次额度。
  - **低额度提醒**：当前窗口剩余低于 20% 时在面板里提示。

### 「使用率」怎么算

- 每个**每周额度周期**算一个数：该周期重置前记录到的最高使用率。
- 平均使用率、最高一周、用满次数只统计**已经结束**的周期；进行中的这一周单独显示为「本周已用」，在柱状图最右边用斜纹表示。
- **Codex** 的历史来自本机 Codex 会话记录里的额度快照，可以回溯到你最早的会话。
- **Claude Code** 本机不保存历史额度，只能由 TokenTide 每次刷新时记录下来。在那之前的周会**估算**（图中空心虚线柱，数字前带「≈」）：
  - 把本机 Claude Code 转录里每次回复的 token 用量，按 Anthropic API 价格折算成等价金额（模型越贵、输出越多，占用越多；缓存读取按 API 的缓存价格计，比普通输入便宜得多）。
  - 用 TokenTide 已记录的周算出「每 1 美元约占周额度的百分之几」，再套用到之前每一周；周期按记录到的重置时间每 7 天往前推。
  - 估算只能看到本机 Claude Code 的用量，claude.ai 网页、Claude App 和其他电脑的用量同样占用周额度，所以估算**偏低**；记录的周越多，校准越准。Claude Code 默认只保留约 30 天的转录，更早的周没法估算。
- 切换过账号时，不同账号的周期会各算一条。

## 数据来源与隐私

| 内容 | 来源 |
|---|---|
| Codex 额度 | `codex app-server` 的 `account/rateLimits/read` |
| Claude Code 额度 | 短暂启动 `claude -p`，发送结构化的 `get_usage` 请求（和 `/usage` 同源）。不发送任何提示词，不消耗额度。该接口上游标注为实验性，失败时会退回读取 `/usage` 界面 |
| 使用记录 | 本机转录文件：`~/.claude/projects/**/*.jsonl`、`~/.codex/sessions`、`~/.codex/archived_sessions` |
| 每周使用率 | Codex 会话记录里的额度快照 + TokenTide 自己的记录；Claude Code 更早的周按本机转录估算 |

- 转录文件只统计次数、Token 数、模型名和时间，**不读取、不返回对话内容**。
- 本机服务只监听 `127.0.0.1`，拒绝跨域请求；不读取、不记录任何令牌或账号标识。
- Claude Code 在服务端获取失败时，可能会沿用上一次的数值。

TokenTide 在本机写入的文件：

| 文件 | 用途 |
|---|---|
| `~/Library/Logs/TokenTide.log` | 本机服务日志 |
| `~/Library/Caches/TokenTide/usage-stats-v3.json` | 使用记录的统计缓存（只重新读取变化过的转录文件） |
| `~/Library/Application Support/TokenTide/quota-weeks.json` | 每周额度记录（Claude Code 的使用率历史全靠它） |

## 常见问题

- **面板显示「无法启动本机额度服务」**：确认装了 Node.js 20 或更新版本，并且 `node` 能在 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 或登录 shell 的 PATH 里找到。详细原因看 `~/Library/Logs/TokenTide.log`。
- **端口 4173 被占用**：TokenTide 固定使用 4173 端口，请先关掉占用该端口的程序。
- **自动更新失败**：「设置 → 更新」会显示原因；也可以随时到 [Releases](https://github.com/redbson/TokenTide/releases/latest) 手动下载，覆盖安装即可，设置和记录都会保留。
- **某个服务显示「不可用」**：在终端运行一次 `codex` 或 `claude`，确认已经登录。
- **Claude Code 显示「/usage 备用读取」**：说明 `get_usage` 请求失败，已退回读取 `/usage` 界面，数值仍然有效。

## 开发

```bash
npm run dev                          # 浏览器打开 http://127.0.0.1:5173/（带实时数据）
npm test                             # 单元测试
npm run build                        # 构建界面到 dist/client
npm run build:mac                    # 打包 release/TokenTide.app（本机架构）
npm run build:mac -- --universal     # 打包 Apple 芯片 + Intel 通用版
```

开发时 Vite 用 5173 端口，和装好的 TokenTide（4173）互不影响。在浏览器里面板会居中显示在深色背景上；在 app 里则铺满下拉面板。

### 发布新版本

1. 把 `package.json` 里的 `version` 改成新版本号并提交推送（可选，发布时会以标签为准）。
2. 在 GitHub 上发布一个标签为 `vX.Y.Z` 的 Release，或者运行：

   ```bash
   gh release create v0.3.1 --generate-notes
   ```

3. [Release 工作流](.github/workflows/release.yml) 会自动跑测试、打包通用版 app，并把 `TokenTide-X.Y.Z.zip` 和 `.sha256` 校验文件附加到这个 Release 上。已安装的 TokenTide 会在下次检查时自动更新。
4. 需要重新打包某个已发布的版本时，在 Actions 里手动运行 Release 工作流并填入标签。

| 目录 | 内容 |
|---|---|
| `src/` | 面板界面（React） |
| `server/` | 本机服务：额度读取、转录统计、每周额度记录；`main.mjs` 是打包进 app 的服务入口 |
| `macos/` | 菜单栏外壳（Swift / AppKit + WKWebView）和自动更新（`Updater.swift`） |
| `.github/workflows/` | 发布 Release 时自动打包 |
| `branding/`、`public/assets/` | 图标和 logo |
| `scripts/` | 打包 app（`build-macos.mjs`）、生成图标 |
| `tests/` | `node --test` 测试 |

## Logo

一个用两条额度条拼成的「T」：蓝色横条是 Codex，橙色竖条是 Claude Code，填满的部分是剩余额度。原始文件在 `branding/tokentide-icon.svg`，`npm run build:mac` 时自动生成 app 图标。

## 免责声明

TokenTide 是独立项目，与 OpenAI、Anthropic 没有关联。Codex、OpenAI、Claude、Claude Code 及相关标志是各自所有者的商标，仅用于标识所监控的服务。

## 许可证

[Apache License 2.0](LICENSE)
