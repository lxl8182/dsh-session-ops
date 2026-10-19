/**
 * dsh-session-ops —— 宿主半边。
 *
 * 做两件官方没有的事：删除会话、取消归档（还原）。归档本身有官方 API，
 * 客户端直接调 `ctx.workspaces.archiveSession`，这里不碰。
 *
 * 删除 = 官方 archiveSession（会话立刻从侧栏消失，页面自动收到广播）
 *      + 把会话日志目录移到 <DSH_HOME>/deleted-sessions/<sessionId>/，
 *        并在回收目录里写 `.dsh-session-ops.json` 记录原始路径。
 * 不是真删文件：误删可以从那个目录把整个 <sessionId> 目录搬回
 * <DSH_HOME>/sessions/<编码后的 cwd>/ 下面。
 *
 * 还原 = 从 workspace 域的 archivedSessionIds 里摘掉这个 id，并把回收目录里的
 * 日志目录搬回原位：优先用元数据里的 originalPath，元数据缺失时解回收日志第一帧
 * header 的 cwd，按 projectKey 反推目标路径。解归档优先用官方
 * workspaceRegistry.unarchiveSession；老版本宿主没有这个接口时才退回
 * storageDomain + 私有缓存的旧路径（细节见 unarchiveSession）。
 *
 * @module dsh-session-ops
 */
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as zlib from 'node:zlib'

export const name = 'dsh-session-ops'

export const inject = ['webServer', 'workspaceRegistry', 'storageDomain', 'agents']

/** 客户端 fetch 的两个端点。 */
const DELETE_ROUTE = '/dsh-session-ops/delete'
const RESTORE_ROUTE = '/dsh-session-ops/restore'

/** 会话 id 直接参与文件路径拼接，所以只放行 uuid 风格的字面量。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/

const MAX_BODY_BYTES = 8 * 1024

/** 回收目录里记录原始路径的元数据文件。 */
const META_FILENAME = '.dsh-session-ops.json'

/** 会话日志文件名；与 session-persistence-jsonl 的 generationLogFilename 对齐。 */
const LOG_FILENAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl']

/** 读日志头只需要第一个 zstd frame；header 行通常只有几百字节。 */
const HEADER_READ_BYTES = 64 * 1024

/** zstd frame 魔数，用于从多 frame 拼接的日志里切出第一个 frame。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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
 * 把 cwd 编码成日志根下的项目目录名。
 *
 * 与 session-persistence-jsonl 的 projectKey() 逐字符一致：`/`、`\\`、`:`
 * 的连续段折成单个 `-`，其它非 `[A-Za-z0-9._-]` 字符转 `~XXXX`（大写十六进制），
 * 去掉开头的 `-`，包成 `--slug--`，slug 截断到 251 字符。
 *
 * @param cwd - 会话的工作目录，必须是绝对路径。
 * @returns 单个文件系统安全的项目目录名。
 */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * 由 header.cwd 推出会话日志目录；cwd 缺失时官方会落到 `_no-cwd`。
 * @param cwd - header 里的绝对工作目录，可能缺失。
 * @param sessionId - 目标会话 id。
 * @returns 会话日志目录绝对路径。
 */
function sessionDirFor(cwd, sessionId) {
  if (cwd === undefined) return join(logRoot(), '_no-cwd', sessionId)
  return join(logRoot(), projectKey(cwd), sessionId)
}

/** 回收目录：`<DSH_HOME>/deleted-sessions/<sessionId>/`。 */
function trashDirFor(sessionId) {
  return join(trashRoot(), sessionId)
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

/**
 * 校验元数据里的 originalPath：只接受日志根下、目录名正好是 sessionId 的一级路径。
 * 元数据是插件自己写的，但回收目录可能被手工改过，搬回前不能盲信。
 *
 * @param value - 元数据里的 originalPath 原始值。
 * @param sessionId - 目标会话 id。
 * @returns 规范化后的绝对路径；不合法时返回 undefined。
 */
function validOriginalPath(value, sessionId) {
  if (typeof value !== 'string' || !isAbsolute(value)) return undefined
  const candidate = resolve(value)
  if (basename(candidate) !== sessionId) return undefined
  const root = resolve(logRoot())
  const parent = dirname(candidate)
  if (parent === root) return undefined
  if (!parent.startsWith(root + sep)) return undefined
  const rest = relative(root, parent)
  if (rest === '' || rest.startsWith('..') || rest.includes(sep)) return undefined
  return candidate
}

/**
 * 读回收目录里的元数据。
 * @param sessionId - 目标会话 id。
 * @returns 校验过的元数据；文件缺失、损坏或字段不合法时返回 undefined。
 */
async function readTrashMetadata(sessionId) {
  try {
    const raw = await readFile(join(trashDirFor(sessionId), META_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (parsed.sessionId !== sessionId) return undefined
    const originalPath = validOriginalPath(parsed.originalPath, sessionId)
    if (originalPath === undefined) return undefined
    return {
      sessionId,
      originalPath,
      ...(typeof parsed.cwd === 'string' && isAbsolute(parsed.cwd) ? { cwd: parsed.cwd } : {}),
      ...(typeof parsed.deletedAt === 'string' ? { deletedAt: parsed.deletedAt } : {}),
    }
  } catch {
    // 文件不存在、不是 JSON、读不了都等价于「没有可用元数据」，由调用方走 header 降级。
    return undefined
  }
}

/**
 * 在会话目录里找日志文件：先试当前 generation 的标准文件名，再退回扫描 `.jsonl`。
 * @param dir - 会话目录（或回收目录）。
 * @returns 日志文件绝对路径；目录里没有日志时返回 undefined。
 */
async function findLogFile(dir) {
  for (const filename of LOG_FILENAMES) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
  }
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // 目录读不了：和「没有日志」一样，交给调用方降级。
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) return join(dir, entry.name)
  }
  return undefined
}

/**
 * 把多 frame 拼接的 zstd 日志里的第一个 frame 解出来。
 * 从第 4 字节起找下一个 frame 魔数，切到那里再解；候选位置解不开就继续往后找
 * （魔数可能偶然出现在压缩数据里）。
 *
 * @param buffer - 日志文件开头的一段字节。
 * @returns 第一个 frame 的解压结果；zstd 不可用或解不开时返回 undefined。
 */
function decodeFirstFrame(buffer) {
  const decompress = zlib.zstdDecompressSync
  if (typeof decompress !== 'function') return undefined
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZSTD_MAGIC)) return undefined
  let cut = buffer.indexOf(ZSTD_MAGIC, 4)
  if (cut < 0) cut = buffer.length
  while (cut > 0) {
    try {
      return decompress(buffer.subarray(0, cut))
    } catch {
      // 这个候选位置不是帧边界（魔数碰巧出现在压缩数据里），继续找下一个。
      cut = buffer.indexOf(ZSTD_MAGIC, cut + 4)
      if (cut < 0) break
    }
  }
  return undefined
}

/**
 * 解析日志第一行的 header。
 * @param text - 第一个 frame 解出来的文本（或明文 .jsonl 的开头）。
 * @returns header 对象；不是合法的 `type: 'session'` 行时返回 undefined。
 */
function parseHeaderLine(text) {
  const line = text.split('\n', 1)[0].trim()
  if (line === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    // 第一行不是完整 JSON：日志损坏，按「解不出 header」处理。
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.type !== 'session') return undefined
  return parsed
}

/**
 * 从会话目录的日志头里解出 cwd，供还原时反推原始路径。
 * @param dir - 回收目录（或会话目录）。
 * @returns header 里的绝对 cwd；日志缺失、损坏或 header 没有 cwd 时返回 undefined。
 */
async function readSessionCwd(dir) {
  const logPath = await findLogFile(dir)
  if (logPath === undefined) return undefined
  let handle
  try {
    handle = await open(logPath, 'r')
  } catch {
    // 日志打不开：还原时按「没有可用元数据」处理，由调用方给出明确 reason。
    return undefined
  }
  try {
    const chunk = Buffer.alloc(HEADER_READ_BYTES)
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0)
    if (bytesRead === 0) return undefined
    const raw = chunk.subarray(0, bytesRead)
    let text
    if (logPath.endsWith('.zstd')) {
      const decoded = decodeFirstFrame(raw)
      if (decoded === undefined) return undefined
      text = decoded.toString('utf8')
    } else {
      text = raw.toString('utf8')
    }
    const header = parseHeaderLine(text)
    if (header === undefined) return undefined
    const cwd = header.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 || cwd.includes('\0')) return undefined
    return cwd
  } catch {
    // 读/解日志失败都按「解不出 cwd」处理。
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * 往回收目录写还原元数据（记录原始路径）。写失败只记日志，不改变删除结果。
 * @param ctx - 宿主 Cordis 上下文（用 logger）。
 * @param trashDir - 回收目录绝对路径。
 * @param sessionId - 目标会话 id。
 * @param originalPath - 搬运前的会话目录绝对路径。
 * @returns 写入结果，`written` 表明元数据是否落盘。
 */
async function writeTrashMetadata(ctx, trashDir, sessionId, originalPath) {
  const cwd = await readSessionCwd(trashDir)
  const metadata = {
    sessionId,
    originalPath,
    deletedAt: new Date().toISOString(),
    ...(cwd === undefined ? {} : { cwd }),
  }
  try {
    await writeFile(join(trashDir, META_FILENAME), JSON.stringify(metadata, null, 2) + '\n', 'utf8')
    return { written: true }
  } catch (error) {
    ctx.logger.warn('[dsh-session-ops] moved the log directory but could not write restore metadata:', error)
    return { written: false, message: String(error) }
  }
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
 *
 * 三种「没搬东西」要分清楚：`already-deleted`（回收目录里已经有了，这次只补元数据）、
 * `no-artifact`（日志根和回收目录都没有这个会话）、`log-in-use`（目录在、但被进程
 * 握着搬不动）。前两种是正常结果，最后一种页面会提示重启后再试。
 *
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
  const trashDir = trashDirFor(sessionId)
  const alreadyDeleted = existsSync(trashDir)

  // 官方归档是让侧栏列表立刻更新的那一步。会话既不在内存也不在持久化里时
  // archiveSession 会抛，此时整个删除失败，什么都不动。
  await ctx.workspaceRegistry.archiveSession(sessionId)

  if (artifactDir === undefined) {
    if (alreadyDeleted) {
      // 老版本（或上次还原没搬走）留下的回收目录可能没有元数据：顺手补上，
      // 这样以后还原还能按 originalPath 搬回，而不是只剩 header 降级一条路。
      const existing = await readTrashMetadata(sessionId)
      let originalPath = existing === undefined ? undefined : existing.originalPath
      if (originalPath === undefined) {
        const cwd = await readSessionCwd(trashDir)
        if (cwd !== undefined) {
          originalPath = sessionDirFor(cwd, sessionId)
          await writeTrashMetadata(ctx, trashDir, sessionId, originalPath)
        }
      }
      return {
        ok: true,
        moved: false,
        reason: 'already-deleted',
        trash: trashDir,
        ...(originalPath === undefined ? {} : { originalPath }),
      }
    }
    return { ok: true, moved: false, reason: 'no-artifact', searched: logRoot() }
  }

  const target = trashDir
  try {
    await mkdir(trashRoot(), { recursive: true })
    // 同名回收目录只可能是上次还原没搬走留下的旧副本；当前还在日志根下的这份
    // 才是列表正在用的会话，以它为准。
    await rm(target, { recursive: true, force: true })
    await rename(artifactDir, target)
  } catch (error) {
    // 会话仍活在内存里时进程可能握着日志文件句柄（Windows 上 rename 报
    // EPERM/EBUSY）。归档已经生效，所以这不是失败，只是文件还留着。
    ctx.logger.warn('[dsh-session-ops] archived but could not move the log directory:', error)
    return { ok: true, moved: false, reason: 'log-in-use', message: String(error) }
  }

  const meta = await writeTrashMetadata(ctx, target, sessionId, artifactDir)
  if (!meta.written) {
    return { ok: true, moved: true, trash: target, metadata: false, metaError: meta.message }
  }
  return { ok: true, moved: true, trash: target, metadata: true }
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
 * 取消归档：优先用官方 `workspaceRegistry.unarchiveSession`。
 *
 * 新版本宿主已经提供公开的反向接口，它自己负责写域、更新内存状态并广播；
 * 老版本没有这个接口，只能退回到「storageDomain 直接改域 + 替换 registry
 * 私有缓存」的旧路径（见 findStateCacheKey 的说明）。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param sessionId - 目标会话 id。
 * @returns `{ wasArchived, registryStale }`，或 `{ error }`。
 */
async function unarchiveSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  if (typeof registry.unarchiveSession === 'function') {
    const wasArchived = registry.archivedSessionIds.includes(sessionId)
    await registry.unarchiveSession(sessionId)
    return { wasArchived, registryStale: registry.archivedSessionIds.includes(sessionId) }
  }

  const cacheKey = findStateCacheKey(registry)
  if (cacheKey === undefined) {
    // 认不出内存缓存就一个字节都不写：只改磁盘会留下「磁盘已还原、内存仍归档」
    // 的半状态，下一次归档就把还原抹掉。
    return { error: 'registry-shape-unknown' }
  }
  const domain = ctx.storageDomain.get('workspace')
  if (domain === undefined) return { error: 'workspace-domain-closed' }

  const state = domain.global.get()
  const wasArchived = state.archivedSessionIds.includes(sessionId)
  let registryStale = false
  if (wasArchived) {
    const next = {
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    }
    // 先落盘再改内存：set 成功才广播，失败则两边都没动。
    await domain.global.set(next)
    registry[cacheKey] = next
    // 公开 getter 读的就是这份缓存；还能读到这个 id 说明认错了字段。
    registryStale = registry.archivedSessionIds.includes(sessionId)
  }
  return { wasArchived, registryStale }
}

/**
 * 取消归档并把回收目录里的日志目录搬回原位。
 *
 * 解归档由 {@link unarchiveSession} 负责；官方 `global.set` 会发
 * `domain/changed`，workspace-controller 的 feed 据此向所有页面推
 * `{ type: 'archived' }`，侧栏不用刷新就会恢复这个会话。
 *
 * 搬回日志目录是第二步：优先用回收目录元数据里的 originalPath；元数据缺失时解
 * 回收日志第一帧 header 的 cwd，按 projectKey 反推目标目录。搬不动或推不出目标
 * 时返回明确的 reason，不会静默成功。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param sessionId - 目标会话 id。
 * @returns 结果载荷，`restored` 表明归档集合是否被改动，`moved` 表明日志目录是否搬回。
 */
async function restoreSession(ctx, sessionId) {
  const unarchived = await unarchiveSession(ctx, sessionId)
  if (unarchived.error !== undefined) return { ok: false, error: unarchived.error }
  const { wasArchived, registryStale } = unarchived

  const base = {
    ok: true,
    restored: wasArchived,
    ...(registryStale ? { registryStale: true } : {}),
  }
  const trashDir = trashDirFor(sessionId)
  if (!existsSync(trashDir)) {
    return { ...base, moved: false, reason: wasArchived ? 'no-trash' : 'not-archived' }
  }

  const metadata = await readTrashMetadata(sessionId)
  let originalPath
  let source
  if (metadata !== undefined) {
    originalPath = metadata.originalPath
    source = 'metadata'
  } else {
    const cwd = await readSessionCwd(trashDir)
    if (cwd === undefined) {
      return {
        ...base,
        moved: false,
        reason: 'trash-metadata-missing',
        trash: trashDir,
        message: '回收目录里没有可用元数据，也无法从日志头解出原始 cwd',
      }
    }
    originalPath = sessionDirFor(cwd, sessionId)
    source = 'header'
  }

  if (existsSync(originalPath)) {
    // 目标目录已经在了（例如上次已经搬回、只是没来得及清归档）：不覆盖。
    return {
      ...base,
      moved: false,
      reason: 'already-present',
      trash: trashDir,
      originalPath,
      source,
    }
  }

  try {
    await mkdir(dirname(originalPath), { recursive: true })
    await rename(trashDir, originalPath)
  } catch (error) {
    return {
      ...base,
      moved: false,
      reason: 'move-failed',
      message: String(error),
      trash: trashDir,
      originalPath,
      source,
    }
  }

  // 元数据文件跟着目录一起搬过去了，清掉，别污染会话目录。
  try {
    await rm(join(originalPath, META_FILENAME), { force: true, recursive: true })
  } catch (error) {
    ctx.logger.warn('[dsh-session-ops] restored the log directory but could not remove stale metadata:', error)
  }
  return {
    ...base,
    moved: true,
    trash: trashDir,
    originalPath,
    source,
  }
}

/**
 * 注册删除与还原两个端点。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  // 两个操作都改写官方 workspace 域（删除/还原还要 rename 目录），一次只允许一个在跑。
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
