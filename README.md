# dsh-session-ops

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-1f6feb.svg)](https://github.com/topics/dsh-plugin)
[![platform](https://img.shields.io/badge/platform-DSH%20Web-4c8bf5.svg)](https://github.com/deepseek-ai/deepseek-harness)

**DSH Web 会话管理插件** —— 在 **设置 → 会话管理** 加一页：一键归档、一键还原、一键删除。活动 / 已归档两个页签，支持单行操作与批量操作。

DSH 官方在侧栏只给了单个会话的归档入口，没有集中的管理页，也没有把「已归档」会话放回侧栏的 UI。本插件补上这三件事，并且**删除不抹盘**。

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
| 还原 | `POST /dsh-session-ops/restore` → 把 id 从 workspace 域的 `archivedSessionIds` 里摘掉，并把 `<DSH_HOME>/deleted-sessions/<会话 id>/` 里的日志目录搬回原位。只出现在「已归档」页签。 |
| 删除 | `POST /dsh-session-ops/delete` → 先归档（列表立刻更新），再把会话日志目录移到 `<DSH_HOME>/deleted-sessions/<会话 id>/`，并在回收目录里写 `.dsh-session-ops.json` 记录原始路径，供还原搬回。 |

批量操作顺序执行而不是并发：删除会动磁盘目录，并发只会让失败原因更难读。跑完只刷新一次会话列表。

## 还原是怎么做到的

解归档优先走官方接口：

```js
await ctx.workspaceRegistry.unarchiveSession(sessionId)
```

新版宿主的 `workspaceRegistry` 提供公开的 `unarchiveSession`：服务自己写域、更新内存状态并发广播，侧栏不用刷新就会恢复会话。

老版本宿主没有这个方法（早期版本只暴露 `archiveSession`，`archivedSessionIds` 是只读 getter），插件会退回存储层写法：

```js
ctx.storageDomain.get('workspace').global.set({ ...state, archivedSessionIds: 去掉这个 id })
```

这条路是官方广播链的上游 —— `global.set` 发 `domain/changed`，`workspace-controller` 的 feed 据此给所有页面推 `{ type: 'archived' }`。退回路径必须同时替换 `workspaceRegistry` 的私有内存缓存（它启动时读一次域状态、之后不回读），否则它的 `archivedSessionIds` 读数会停在旧值，下一次 `archiveSession` 会把旧集合整份写回磁盘、把刚还原的 id 复活。缓存字段是 TS private，插件**按形状认、不按名字认**：同时挂着 `workspaceIds` 和 `archivedSessionIds` 数组的那个自有属性；认不出来就返回 `registry-shape-unknown` 并且一个字节都不写。当前安装版已走官方接口，这段只是旧宿主的兜底。

## 删除、还原与回收目录

- **删除不是抹盘。** 会话目录被整体 `rename` 到 `<DSH_HOME>/deleted-sessions/<会话 id>/`，同时写一份元数据：

  ```json
  { "sessionId": "session-…", "originalPath": "<DSH_HOME>/sessions/--E-…--/session-…", "cwd": "E:\\…", "deletedAt": "2026-10-19T…Z" }
  ```

  `cwd` 从回收后的日志第一帧 header 解出，解不出就省略；元数据写失败不影响删除，但会提示「还原时可能找不到原位置」。
- **还原会把日志目录搬回原位。** 优先用元数据里的 `originalPath`；元数据缺失（老版本删除留下的回收目录）时，解回收日志第一帧 header 的 `cwd`，按官方 `projectKey()` 规则反推目标目录。目标已存在时返回 `already-present` 不覆盖；搬回失败返回 `move-failed` / `trash-metadata-missing` 并把原因显示在页面上，回收目录原样保留，不会出现「界面说还原成功、磁盘上还是没有日志」的静默半状态。
- **删除一个此前已回收的会话**（例如还原搬回失败、或旧版本留下的回收目录）会返回 `already-deleted`，页面明确写「此前已移入回收目录，无需重复搬运」，不再误报「磁盘上没有日志目录」。
- 回收目录不做容量上限，也不做自动清理；需要彻底清理时手工删 `<DSH_HOME>/deleted-sessions/`。
- **运行中的会话拒绝删除**（返回 `session-running`）。会话虽然不在跑但仍活在内存里时，归档照常生效，日志目录可能因为进程握着句柄而移不动 —— 此时接口返回 `moved: false, reason: "log-in-use"`，页面会提示重启后再删一次。

## 会话目录怎么找

在 `<DSH_HOME>/sessions/` 下扫一层项目目录，取 `<项目目录>/<sessionId>/`。目录名就是会话 id 本身（uuid 风格 id 经官方 `encodeSegment` 原样落地），所以不必复刻 cwd → 目录名的编码规则，会话换过工作区也照样命中。

日志根跟随 base bundle 给 `session-persistence-jsonl` 的 `root: dshHomePath('sessions')`；在 `cordis.patch.yml` 里改过那个 root 的部署要同步改本插件。

不走 `sessionPersistence`：`list()` 返回的是 `{ header, revision }` 快照（会话 id 在 `header.id`），`locate()` 是 JSONL 后端的 TS private 方法、不在服务基类上。早先版本写 `list().find(h => h.id === id)`，`.id` 永远 `undefined`，于是每次删除都是「归档成功、目录留在原地、报 `no-artifact`」。

扫不到目录时按情况区分：回收目录里已有该会话 → `moved: false, reason: "already-deleted"`（页面写「此前已移入回收目录，无需重复搬运」）；两边都没有 → `moved: false, reason: "no-artifact"`（附 `searched` = 实际扫过的日志根，页面写「磁盘上确实没有日志目录，无需回收」）。两种情况都不算失败。

还原搬日志目录时用同一套路径知识：元数据里的 `originalPath` 会先校验「必须是日志根下一级、目录名等于会话 id」；没有元数据才解 header 的 `cwd` 再用 `projectKey()` 推目录。`projectKey()` 是官方编码规则的逐字符复刻（分隔符折 `-`、其它非 `[A-Za-z0-9._-]` 转 `~XXXX`、包成 `--slug--`），DSH 升级改了编码规则时这里要同步。

## 接口

两个端点都只收 `{ sessionId }`，只接受 POST，最多 8 KiB 请求体。

| 端点 | 返回 |
|---|---|
| `POST /dsh-session-ops/delete` | `{ ok, moved, reason?, trash?, metadata?, originalPath? }`，或 `{ ok: false, error: 'session-running' \| 'bad-session-id' \| … }`。`reason` 为 `no-artifact` / `already-deleted` / `log-in-use`。 |
| `POST /dsh-session-ops/restore` | `{ ok, restored, moved, reason?, originalPath?, source?, registryStale? }`，或 `{ ok: false, error: 'registry-shape-unknown' \| 'workspace-domain-closed' }`。`reason` 为 `no-trash` / `not-archived` / `already-present` / `trash-metadata-missing` / `move-failed`；`source` 为 `metadata` / `header`。 |

会话 id 直接参与路径拼接，所以只放行 `^[A-Za-z0-9][A-Za-z0-9-]{7,127}$`。两个操作都会改写官方 workspace 域（删除还要 rename 目录），所以宿主侧串行化，一次只跑一个。

`ok: false` 用 HTTP 409 返回，请求体 / 方法错误用 400 / 405，未预期异常用 500。

## 已知限制

- 端点没有鉴权，和 DSH 其余本地 HTTP 面一致：任何能访问 `127.0.0.1:<端口>` 的进程都能调它。
- 删除后 `workspace.json` 里 `workspaces.*.sessionIds` 仍留着这个 id，只是被 `archivedSessionIds` 屏蔽。无害，但会一直累积。
- 新宿主走官方 `unarchiveSession`，不再依赖私有缓存；只有旧宿主（没有该接口）才会退回私有缓存形状识别，打碎时明确报 `registry-shape-unknown` 而不是静默写坏数据。
- 还原搬回日志目录后，宿主自己的会话列表是否立刻出现该会话取决于宿主的持久化缓存；个别情况下可能需要重启 DSH 才在侧栏看到（页面会如实显示「已搬回」）。
- 老版本删除留下的回收目录没有元数据，还原靠日志头 `cwd` 反推；日志损坏或 `cwd` 缺失时返回 `trash-metadata-missing`，只能手工搬目录。

## 结构

```
lib/index.js     宿主半边：/dsh-session-ops/delete 与 /dsh-session-ops/restore
lib/client.js    浏览器半边：settings.section 页面（id: dsh-session-ops）
cordis.patch.yml bundle 层，插入宿主行
```

## License

[MIT](./LICENSE)
