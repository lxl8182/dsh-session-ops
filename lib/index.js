/**
 * dsh-session-ops —— 宿主半边。
 *
 * 做两件官方没有的事：删除会话、取消归档（还原）。归档本身有官方 API，
 * 客户端直接调 `ctx.workspaces.archiveSession`，这里不碰。
 *
 * 删除 = 官方 archiveSession（会话立刻从侧栏消失，页面自动收到广播）
 *      + 把会话日志目录移到 <DSH_HOME>/deleted-sessions/<sessionId>/。
 * 不是真删文件：误删可以从那个目录把整个 <sessionId> 目录搬回
 * <DSH_HOME>/sessions/<编码后的 cwd>/ 下面。
 *
 * 还原 = 从 workspace 域的 archivedSessionIds 里摘掉这个 id。官方
 * workspaceRegistry 只给了 archiveSession，没有反向，所以走 storageDomain
 * 直接改域状态；细节见 restoreSession。
 *
 * @module dsh-session-ops
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dsh-session-ops'

export const inject = ['webServer', 'workspaceRegistry', 'storageDomain', 'agents']

/** 客户端 fetch 的两个端点。 */
const DELETE_ROUTE = '/dsh-session-ops/delete'
const RESTORE_ROUTE = '/dsh-session-ops/restore'

/** 会话 id 直接参与文件路径拼接，所以只放行 uuid 风格的字面量。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/

const MAX_BODY_BYTES = 8 * 1024

/** 与 @deepseek-ai/dsh-home-paths 的 resolveDshHome 同规则，避免多一个依赖。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(selected)
}

function trashRoot() {
  return join(dshHome(), 'deleted-sessions')
}

/** 会话日志根，与 base bundle 给 session-persistence-jsonl 的 `root: dshHomePath('sessions')` 一致。 */
function logRoot() {
  return join(dshHome(), 'sessions')
}

/**
 * 在日志根下找会话目录：`<root>/<项目目录>/<sessionId>/`。
 *
 * 不走 sessionPersistence：`list()` 返回的是 `{ header, revision }` 快照（会话 id 在
 * `header.id`，不在元素本身），`locate()` 是 TS private、不是可依赖的公开面。目录名
 * 就是 sessionId 本身（uuid 风格 id 经 encodeSegment 原样落地），所以扫一层项目目录
 * 比复刻 cwd → 目录名的编码规则可靠，会话换过工作区也照样找得到。
 *
 * @param sessionId - 目标会话 id，已由路由校验过字面量。
 * @returns 会话目录绝对路径；日志根不存在或没有这个会话时返回 undefined。
 */
async function findArtifactDir(sessionId) {
  const root = logRoot()
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    // 日志根还没建（全新 DSH_HOME）或读不了：都等价于「没有可搬的目录」。
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, sessionId)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      throw new Error('body too large')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 归档并把会话日志目录移入回收目录。
 * @param ctx - 宿主 Cordis 上下文。
 * @param sessionId - 目标会话 id。
 * @returns 结果载荷，`moved` 表明日志目录是否真的搬走了。
 */
async function deleteSession(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId)
  if (agent !== undefined && agent.status === 'running') {
    return { ok: false, error: 'session-running' }
  }

  // 先定位目录再归档：归档不动文件，但拿到路径后失败原因只剩「搬不动」一种。
  const artifactDir = await findArtifactDir(sessionId)

  // 官方归档是让侧栏列表立刻更新的那一步。会话既不在内存也不在持久化里时
  // archiveSession 会抛，此时整个删除失败，什么都不动。
  await ctx.workspaceRegistry.archiveSession(sessionId)

  if (artifactDir === undefined) {
    return { ok: true, moved: false, reason: 'no-artifact', searched: logRoot() }
  }

  const target = join(trashRoot(), sessionId)
  try {
    await mkdir(trashRoot(), { recursive: true })
    await rm(target, { recursive: true, force: true })
    await rename(artifactDir, target)
  } catch (error) {
    // 会话仍活在内存里时进程可能握着日志文件句柄（Windows 上 rename 报
    // EPERM/EBUSY）。归档已经生效，所以这不是失败，只是文件还留着。
    ctx.logger.warn('[dsh-session-ops] archived but could not move the log directory:', error)
    return { ok: true, moved: false, reason: 'log-in-use', message: String(error) }
  }
  return { ok: true, moved: true, trash: target }
}

/**
 * 找到 workspaceRegistry 内存里那份 workspace 域状态缓存的属性名。
 *
 * registry 在 init 时读一次 `domain.global` 就再也不回读（`setState` 是写域 +
 * 改这份缓存）。绕过它写域，它的 `archivedSessionIds` 读数会停在旧值 ——
 * 而 workspace-controller 的 feed baseline（每次页面重连都读一次）用的就是这个
 * 读数，之后任何一次 archiveSession 都会把旧集合整份写回磁盘，把刚还原的 id 复活。
 *
 * 这份缓存是 TS private，运行时按形状认而不是按名字认：同时挂着
 * `workspaceIds` 和 `archivedSessionIds` 数组的那个自有属性就是它。
 *
 * @param registry - 官方 workspaceRegistry 服务实例。
 * @returns 缓存字段名；认不出来时返回 undefined。
 */
function findStateCacheKey(registry) {
  for (const key of Object.keys(registry)) {
    const value = registry[key]
    if (value !== null && typeof value === 'object'
      && Array.isArray(value.workspaceIds) && Array.isArray(value.archivedSessionIds)) {
      return key
    }
  }
  return undefined
}

/**
 * 取消归档：把 id 从 workspace 域的 archivedSessionIds 里摘掉。
 *
 * 官方只有 `archiveSession`，没有反向接口，所以直接写域全局状态。这条路是官方
 * 广播链的上游：`global.set` 会发 `domain/changed`，workspace-controller 的 feed
 * 据此向所有页面推 `{ type: 'archived' }`，侧栏不用刷新就会恢复这个会话。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param sessionId - 目标会话 id。
 * @returns 结果载荷，`restored` 表明这次调用是否真的改了归档集合。
 */
async function restoreSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  const cacheKey = findStateCacheKey(registry)
  if (cacheKey === undefined) {
    // 认不出内存缓存就一个字节都不写：只改磁盘会留下「磁盘已还原、内存仍归档」
    // 的半状态，下一次归档就把还原抹掉。
    return { ok: false, error: 'registry-shape-unknown' }
  }
  const domain = ctx.storageDomain.get('workspace')
  if (domain === undefined) return { ok: false, error: 'workspace-domain-closed' }

  const state = domain.global.get()
  if (!state.archivedSessionIds.includes(sessionId)) {
    return { ok: true, restored: false, reason: 'not-archived' }
  }
  const next = {
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
  }
  // 先落盘再改内存：set 成功才广播，失败则两边都没动。
  await domain.global.set(next)
  registry[cacheKey] = next
  // 公开 getter 读的就是这份缓存；还能读到这个 id 说明认错了字段。
  if (registry.archivedSessionIds.includes(sessionId)) {
    return { ok: true, restored: true, registryStale: true }
  }
  return { ok: true, restored: true }
}

/**
 * 注册删除与还原两个端点。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  // 两个操作都改写官方 workspace 域（删除还要 rename 目录），一次只允许一个在跑。
  let tail = Promise.resolve()
  const serial = (operation) => {
    const run = tail.then(operation, operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 一个只收 `{ sessionId }` 的 POST 端点。
   * @param path - 端点路径。
   * @param label - 出错日志与 error 码用的操作名。
   * @param operate - 校验通过后执行的操作，返回响应载荷。
   * @returns webServer 路由声明。
   */
  const sessionRoute = (path, label, operate) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        respond(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      let sessionId
      try {
        const body = await readJsonBody(req)
        sessionId = body === null || typeof body !== 'object' ? undefined : body.sessionId
      } catch {
        respond(res, 400, { ok: false, error: 'bad-request' })
        return
      }
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        respond(res, 400, { ok: false, error: 'bad-session-id' })
        return
      }
      try {
        const result = await serial(() => operate(ctx, sessionId))
        respond(res, result.ok ? 200 : 409, result)
      } catch (error) {
        ctx.logger.warn('[dsh-session-ops] ' + label + ' failed:', error)
        respond(res, 500, { ok: false, error: label + '-failed', message: String(error) })
      }
    },
  })

  ctx.effect(
    () => ctx.webServer.register(sessionRoute(DELETE_ROUTE, 'delete', deleteSession)),
    'dsh-session-ops: delete route',
  )
  ctx.effect(
    () => ctx.webServer.register(sessionRoute(RESTORE_ROUTE, 'restore', restoreSession)),
    'dsh-session-ops: restore route',
  )
}
