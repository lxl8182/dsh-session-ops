# dsh-session-ops

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-1f6feb.svg)](https://github.com/topics/dsh-plugin)
[![platform](https://img.shields.io/badge/platform-DSH%20Web-4c8bf5.svg)](https://github.com/deepseek-ai/deepseek-harness)

**DSH Web 会话管理插件** —— 在 **设置 → 会话管理** 加一页：一键归档、一键还原、一键删除。活动 / 已归档两个页签，支持单行操作与批量操作。

DSH 官方在侧栏只给了单个会话的归档入口，没有集中的管理页，也没有取消归档的接口。本插件补上这三件事，并且**删除不抹盘**。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:lxl8182/dsh-session-ops

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-session-ops
```

然后**重启 dsh web**。零构建、零依赖：两个文件都是手写的普通 JavaScript，宿主只用 Node 内置模块，浏览器只 `require('react')`。

## 它做什么

| 动作 | 实现 |
| --- | --- |
| 归档 | 浏览器端直接调官方 `ctx.workspaces.archiveSession(id)`。会话从侧栏消失，日志完整保留。 |
| 还原 | `POST /dsh-session-ops/restore` → 把 id 从 workspace 域的 `archivedSessionIds` 里摘掉。只出现在「已归档」页签。 |
| 删除 | `POST /dsh-session-ops/delete` → 先归档（列表立刻更新），再把会话日志目录移到 `<DSH_HOME>/deleted-sessions/<会话 id>/`。 |

批量操作顺序执行而不是并发：删除会动磁盘目录，并发只会让失败原因更难读。跑完只刷新一次会话列表。

## 还原是怎么做到的（官方没有这个接口）

`workspaceRegistry` 只暴露 `archiveSession`，没有反向方法，`archivedSessionIds` 是只读 getter。所以还原走存储层：

```js
ctx.storageDomain.get('workspace').global.set({ ...state, archivedSessionIds: 去掉这个 id })
```

这条路是官方广播链的上游 —— `global.set` 发 `domain/changed`，`workspace-controller` 的 feed 据此给所有页面推 `{ type: 'archived' }`，侧栏不刷新就会恢复这个会话。

一个必须一起处理的坑：`workspaceRegistry` 在启动时把域状态读进一个私有缓存，之后再也不回读（它的 `setState` 是「写域 + 改缓存」）。只写域会让它的 `archivedSessionIds` 读数停在旧值，而 feed 的 baseline（每次页面重连都读一次）用的就是这个读数 —— 更糟的是下一次 `archiveSession` 会把旧集合整份写回磁盘，把刚还原的 id 复活。

所以还原会同时替换那份内存缓存。缓存字段是 TS private，插件**按形状认、不按名字认**：同时挂着 `workspaceIds` 和 `archivedSessionIds` 数组的那个自有属性。认不出来就返回 `registry-shape-unknown` 并且一个字节都不写 —— 宁可整个失败，也不留「磁盘已还原、内存仍归档」的半状态。DSH 升级后如果还原按钮开始报这个错，就是这里需要跟着改。

## 明确不做的事

- **删除不是抹盘。** 会话目录被整体 `rename` 到 `<DSH_HOME>/deleted-sessions/`。误删时把整个 `<会话 id>/` 目录搬回 `<DSH_HOME>/sessions/<编码后的 cwd>/` 即可恢复，然后重启 DSH。回收目录不做容量上限，也不做自动清理。
- **还原不搬日志目录。** 它只管归档集合。已删除的会话在列表刷新后就不在会话列表里了，也就没有可以按「还原」的那一行；那种恢复只能手工搬目录。
- **运行中的会话拒绝删除**（返回 `session-running`）。会话虽然不在跑但仍活在内存里时，归档照常生效，日志目录可能因为进程握着句柄而移不动 —— 此时接口返回 `moved: false, reason: "log-in-use"`，页面会提示重启后再删一次。

## 会话目录怎么找

在 `<DSH_HOME>/sessions/` 下扫一层项目目录，取 `<项目目录>/<sessionId>/`。目录名就是会话 id 本身（uuid 风格 id 经官方 `encodeSegment` 原样落地），所以不必复刻 cwd → 目录名的编码规则，会话换过工作区也照样命中。

日志根跟随 base bundle 给 `session-persistence-jsonl` 的 `root: dshHomePath('sessions')`；在 `cordis.patch.yml` 里改过那个 root 的部署要同步改本插件。

不走 `sessionPersistence`：`list()` 返回的是 `{ header, revision }` 快照（会话 id 在 `header.id`），`locate()` 是 JSONL 后端的 TS private 方法、不在服务基类上。早先版本写 `list().find(h => h.id === id)`，`.id` 永远 `undefined`，于是每次删除都是「归档成功、目录留在原地、报 `no-artifact`」。

扫不到目录时返回 `moved: false, reason: "no-artifact"`（附 `searched` = 实际扫过的日志根），页面按成功计入并附一句「磁盘上没有日志目录，无需回收」：磁盘上本来就没有可搬的东西，不算失败。

## 接口

两个端点都只收 `{ sessionId }`，只接受 POST，最多 8 KiB 请求体。

| 端点 | 返回 |
|---|---|
| `POST /dsh-session-ops/delete` | `{ ok, moved, trash? }`，或 `{ ok: false, error: 'session-running' \| 'bad-session-id' \| … }` |
| `POST /dsh-session-ops/restore` | `{ ok, restored, registryStale? }`，或 `{ ok: false, error: 'registry-shape-unknown' \| 'workspace-domain-closed' }` |

会话 id 直接参与路径拼接，所以只放行 `^[A-Za-z0-9][A-Za-z0-9-]{7,127}$`。两个操作都会改写官方 workspace 域（删除还要 rename 目录），所以宿主侧串行化，一次只跑一个。

`ok: false` 用 HTTP 409 返回，请求体 / 方法错误用 400 / 405，未预期异常用 500。

## 已知限制

- 端点没有鉴权，和 DSH 其余本地 HTTP 面一致：任何能访问 `127.0.0.1:<端口>` 的进程都能调它。
- 删除后 `workspace.json` 里 `workspaces.*.sessionIds` 仍留着这个 id，只是被 `archivedSessionIds` 屏蔽。无害，但会一直累积。
- 还原依赖 `workspaceRegistry` 私有缓存的形状（见上），是本插件唯一一处会被 DSH 升级打碎的地方；打碎时会明确报错而不是静默写坏数据。

## 结构

```
lib/index.js     宿主半边：/dsh-session-ops/delete 与 /dsh-session-ops/restore
lib/client.js    浏览器半边：settings.section 页面（id: dsh-session-ops）
cordis.patch.yml bundle 层，插入宿主行
```

## License

[MIT](./LICENSE)
