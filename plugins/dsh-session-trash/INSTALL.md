# 通用安装说明 / Portable install

这个插件不依赖任何第三方 npm 包，也不在本机写死任何路径，可以直接复制到别的电脑
安装。需要目标电脑已经装有 **DeepSeek Harness（Web UI 或桌面版）**。

> 已在 DSH `0.2.2-rc.1`（Windows 桌面版）上实测；DSH 运行时自带 Node.js ≥ 22。
> 插件本身没有网络请求，删除操作只作用于目标电脑的 `~/.dsh`。

- npm 包名：`dsh-session-trash-bin`（`dsh-session-trash` 已被另一个 npm 包占用）
- GitHub 源码：`https://github.com/QLX-Hub/dsh-config/tree/main/plugins/dsh-session-trash`
- 插件显示名：**会话回收站**

## 分发包怎么选

| 文件 | 用途 |
| --- | --- |
| `dsh-session-trash-bin-0.1.0.zip` | Windows / macOS 都能解压。解压出 `dsh-session-trash-bin/` 目录后安装。 |
| `dsh-session-trash-bin-0.1.0.tgz` | `npm pack` 格式的包，可以作为一个文件直接安装；也适合上传到 npm 或内部制品库。 |
| `SHA256SUMS.txt` | 两个包的 SHA-256 校验值。 |

## 安装方式一：从 zip（推荐给手动传文件）

1. 解压 `dsh-session-trash-bin-0.1.0.zip`，得到 `dsh-session-trash-bin/` 目录。
   建议放到一个固定位置，例如：
   - Windows：`C:\Tools\dsh-session-trash-bin`
   - macOS / Linux：`~/Tools/dsh-session-trash-bin`
2. 在 DSH 里让 agent 执行（把路径换成解压后的实际路径）：
   ```
   plugin_manager install_bundle C:/Tools/dsh-session-trash-bin
   ```
   或在 GUI 中打开 **插件 → 安装 → 本地目录**，选择该目录。
3. 看到 `application: applied` 即可用。如果侧栏没有出现「会话回收站」，刷新一次页面。

> 注意：zip 方式安装的是 **目录链接**，之后不要删除或移动这个目录；要移动的话，
> 先在插件管理器里卸载，移动到新位置后重新安装。

## 安装方式二：从 tgz（单文件）

把 `dsh-session-trash-bin-0.1.0.tgz` 传到目标电脑，然后：

```
plugin_manager install_bundle C:/path/to/dsh-session-trash-bin-0.1.0.tgz
```

pnpm / DSH 插件管理器可以直接安装 tarball。安装后文件会被放进 profile 的
`node_modules`，原始 tgz 可以删掉。

## 安装方式三：直接从 GitHub 安装

```
plugin_manager install_bundle github:QLX-Hub/dsh-config#path:/plugins/dsh-session-trash
```

## 安装方式四：发布到 npm 后

```
plugin_manager install_bundle dsh-session-trash-bin
```

## 生效与验证

- DSH 默认开启 HMR：安装后 **即时生效**，浏览器会自动加载插件；如果侧栏没变化，
  刷新页面（Ctrl/Cmd + Shift + R）一次。
- 目标 profile 没有 HMR 时：重启 DSH 后生效。
- 到 **插件** 页面确认 `dsh-session-trash-bin` 是「已启用」。
- 验证：在侧栏「工作区」下的任意会话条目上点右键，应出现
  「删除会话（放入回收站）」和「彻底删除会话」；侧栏应出现「会话回收站」。

## 卸载

```
plugin_manager remove_bundle dsh-session-trash-bin
```

卸载 **不会** 删除已经移入回收站的会话；它们仍在
`<DSH home>/storages/session-trash/` 里。卸载前请先在「会话回收站」里恢复需要保留的
会话，或清空回收站。

## 兼容性说明

- 需要 DSH 提供 Web Client 模块、`contextMenus` 服务和插件管理器；标准的
  `dsh web` / 桌面版 profile 都满足。
- 插件只依赖 DSH 内置的 Client 模块（`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-context-menu`），没有自己的 `dependencies`。
- 删除行为基于 DSH 当前的磁盘布局（`sessions/`、`storages/session_projcache/`、
  `storages/workspace.json`）。如果未来 DSH 大版本改了存储格式，需要同步更新
  `lib/store.js`。
