/**
 * dsh-session-ops —— 浏览器半边：设置 → 会话管理。
 *
 * 一页列表，支持勾选：
 *   归档 → 官方 ctx.workspaces.archiveSession（会话从侧栏消失，日志保留）
 *   还原 → POST /dsh-session-ops/restore（取消归档 + 把回收目录里的日志目录搬回原位）
 *   删除 → POST /dsh-session-ops/delete（归档 + 日志目录移入回收目录）
 * 单行动作和批量动作走同一条通道；批量是顺序执行（不并发），跑完只刷新一次会话列表。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-ops',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const STYLE_ID = 'dsh-session-ops-style'
    const STYLE = `
.dso-page{padding:16px 20px;max-width:860px;font-size:13px;color:var(--dsw-alias-label-primary,#111827)}
.dso-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.dso-title{font-size:14px;font-weight:600;margin:0}
.dso-count{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px}
.dso-tabs{display:flex;gap:6px;margin-left:auto}
.dso-tab{border:1px solid var(--dsw-alias-border-default,#d1d5db);background:transparent;color:inherit;
  border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
.dso-tab[data-on="1"]{border-color:var(--dsw-alias-state-business-primary,#2563eb);
  color:var(--dsw-alias-state-business-primary,#2563eb)}
.dso-bar{display:flex;align-items:center;gap:10px;padding:6px 10px;margin-bottom:8px;border-radius:8px;
  border:1px solid var(--dsw-alias-line-border,#e5e7eb);font-size:12px}
.dso-bar-info{color:var(--dsw-alias-label-secondary,#4b5563)}
.dso-bar-acts{display:flex;gap:6px;margin-left:auto}
.dso-check{width:14px;height:14px;flex:none;cursor:pointer;
  accent-color:var(--dsw-alias-state-business-primary,#2563eb)}
.dso-list{list-style:none;margin:0;padding:0}
.dso-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-line-border,#e5e7eb);margin-bottom:6px}
.dso-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dso-row[data-on="1"]{border-color:var(--dsw-alias-state-business-primary,#2563eb)}
.dso-main{flex:1;min-width:0}
.dso-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dso-meta{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dso-badge{font-size:10px;padding:1px 6px;border-radius:10px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-default,#d1d5db);color:var(--dsw-alias-label-secondary,#4b5563)}
.dso-btn{border:1px solid var(--dsw-alias-border-default,#d1d5db);background:transparent;color:inherit;
  border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
.dso-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dso-btn:disabled{opacity:.45;cursor:not-allowed}
.dso-btn.danger{border-color:var(--dsw-alias-state-danger-border,#dc2626);
  color:var(--dsw-alias-state-danger-border,#dc2626)}
.dso-empty{color:var(--dsw-alias-label-tertiary,#6b7280);padding:14px 2px}
.dso-notice{margin-top:10px;padding:8px 10px;border-radius:6px;font-size:12px;white-space:pre-wrap;
  border:1px solid var(--dsw-alias-line-border,#e5e7eb)}
.dso-notice[data-err="1"]{border-color:var(--dsw-alias-state-danger-border,#dc2626)}
.dso-hint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;margin:10px 0 0;line-height:1.6}
`

    /** 相对时间，够用就好。 */
    function ago(time) {
      if (typeof time !== 'number' || !isFinite(time)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
      if (seconds < 60) return '刚刚'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      return Math.round(hours / 24) + ' 天前'
    }

    function titleOf(row) {
      const raw = row.displayTitle
      return typeof raw === 'string' && raw.trim() !== '' ? raw : '(未命名会话)'
    }

    /**
     * 删除结果 → 一行结果备注。
     * 宿主把「搬进回收目录」「此前已回收」「磁盘上本来就没有」分成了不同 reason，
     * 这里逐条翻译，避免再把三种情况混成同一句「无需回收」。
     */
    function deleteNote(title, data) {
      if (data.moved === true) {
        return data.metadata === false
          ? title + '：日志目录已移入回收目录，但元数据写入失败，还原时可能找不到原位置'
          : title + '：日志目录已移入回收目录'
      }
      if (data.reason === 'already-deleted') return title + '：此前已移入回收目录，无需重复搬运'
      if (data.reason === 'no-artifact') return title + '：磁盘上确实没有日志目录，无需回收'
      return title + '：日志目录没有搬运'
        + (typeof data.reason === 'string' && data.reason !== '' ? '（' + data.reason + '）' : '')
    }

    /** 还原结果 → 一行结果备注；没碰到回收目录的普通还原不产生备注。 */
    function restoreNote(title, data) {
      if (data.moved === true) return title + '：日志目录已从回收目录搬回原位'
      if (data.reason === 'already-present') return title + '：日志目录已在原位，没有覆盖'
      if (data.reason === 'trash-metadata-missing') {
        return title + '：日志目录仍在回收目录（缺少元数据，也无法从日志头解出原始位置，需要手工搬回）'
      }
      if (data.reason === 'move-failed') {
        return title + '：日志目录仍在回收目录（搬回失败'
          + (typeof data.message === 'string' && data.message !== '' ? '：' + data.message : '') + '）'
      }
      return null
    }

    /** 结果面板：第一行是结论，之后每条备注单独一行，避免和结论粘成一句话。 */
    function noticeText(head, notes, failures) {
      const lines = [head]
      for (const note of notes) lines.push('· ' + note)
      if (failures.length > 0) {
        lines.push('以下操作失败：')
        for (const failure of failures) lines.push('· ' + failure)
      }
      return lines.join('\n')
    }

    function SessionOpsPage(props) {
      const list = props.useSessions((state) => state)
      const workspaces = props.useWorkspaces((state) => state)
      const [tab, setTab] = React.useState('live')
      const [picked, setPicked] = React.useState([])
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const archivedIds = workspaces && workspaces.archivedSessionIds ? workspaces.archivedSessionIds : []
      const archived = React.useMemo(() => new Set(archivedIds), [archivedIds])

      const rows = React.useMemo(() => {
        const ids = list && list.ids ? list.ids : []
        const byId = list && list.byId ? list.byId : {}
        const wanted = tab === 'archived'
        return ids
          .map((id) => byId[id])
          .filter((row) => row !== undefined && row !== null && !row.blank)
          .filter((row) => archived.has(row.id) === wanted)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      }, [list, archived, tab])

      // 勾选集合只保留当前页仍然存在的行：换页签、删除完成后不留幽灵选择。
      const chosen = React.useMemo(
        () => picked.filter((id) => rows.some((row) => row.id === id)),
        [picked, rows],
      )
      const chosenSet = React.useMemo(() => new Set(chosen), [chosen])

      const toggle = (id) => {
        setPicked((current) => (current.includes(id)
          ? current.filter((entry) => entry !== id)
          : current.concat([id])))
        setNotice(null)
      }
      const toggleAll = () => {
        setPicked(chosen.length === rows.length ? [] : rows.map((row) => row.id))
        setNotice(null)
      }

      /**
       * 顺序跑一批操作，逐个记结果，最后统一刷新一次会话列表。
       * 不用 Promise.all：删除会动磁盘目录，并发只会让失败原因更难读。
       */
      const run = React.useCallback(async (kind, victims) => {
        const label = kind === 'archive' ? '归档' : (kind === 'restore' ? '还原' : '删除')
        if (victims.length === 0) return
        if (kind === 'delete') {
          const preview = victims.length === 1
            ? '「' + titleOf(victims[0]) + '」'
            : '选中的 ' + victims.length + ' 个会话'
          if (!window.confirm(
            '删除' + preview + '？\n\n会话会从列表移除，日志目录移入 ~/.dsh/deleted-sessions/；'
            + '之后可在「已归档」页签点「还原」把会话和日志目录一起放回原位。此操作不提供撤销按钮。',
          )) return
        }
        setNotice(null)
        const failures = []
        const notes = []
        let done = 0
        for (let index = 0; index < victims.length; index += 1) {
          const row = victims[index]
          setBusy({ kind, id: row.id, index, total: victims.length })
          try {
            if (kind === 'archive') {
              await props.archiveSession(row.id)
            } else if (kind === 'restore') {
              const data = await props.restoreSession(row.id)
              if (data.registryStale === true) {
                notes.push(titleOf(row) + '：已写回磁盘，但宿主内存里的归档集合没同步，重启 DSH 后列表才一致')
              }
              const note = restoreNote(titleOf(row), data)
              if (note !== null) notes.push(note)
            } else {
              const data = await props.deleteSession(row.id)
              const note = deleteNote(titleOf(row), data)
              if (note !== null) notes.push(note)
            }
            done += 1
          } catch (error) {
            failures.push(titleOf(row) + '：' + String(error))
          }
        }
        setBusy(null)
        setPicked([])
        try {
          await props.refreshSessions()
        } catch (error) {
          failures.push('刷新会话列表失败：' + String(error))
        }
        const head = done === 0 ? '没有' + label + '成功任何会话' : '已' + label + ' ' + done + ' 个会话'
        setNotice({ text: noticeText(head, notes, failures), isError: failures.length > 0 })
      }, [props])

      const working = busy !== null
      const batchLabel = (kind, verb) => (working && busy.kind === kind
        ? verb + '中 ' + (busy.index + 1) + '/' + busy.total + '…'
        : verb + '选中')

      const tabButton = (id, text) => h('button', {
        key: id,
        type: 'button',
        className: 'dso-tab',
        'data-on': tab === id ? '1' : undefined,
        disabled: working,
        onClick: () => { setTab(id); setPicked([]); setNotice(null) },
      }, text)

      return h('div', { className: 'dso-page' }, [
        h('div', { className: 'dso-head', key: 'head' }, [
          h('h3', { className: 'dso-title', key: 't' }, '会话管理'),
          h('span', { className: 'dso-count', key: 'c' }, rows.length + ' 个会话'),
          h('div', { className: 'dso-tabs', key: 'tabs' }, [
            tabButton('live', '活动'),
            tabButton('archived', '已归档'),
          ]),
        ]),
        rows.length === 0 ? null : h('div', { className: 'dso-bar', key: 'bar' }, [
          h('input', {
            key: 'all',
            type: 'checkbox',
            className: 'dso-check',
            title: '全选 / 全不选',
            'aria-label': '全选',
            disabled: working,
            checked: rows.length > 0 && chosen.length === rows.length,
            // 部分选中是半选态，标准 checkbox 只能用命令式属性表达。
            ref: (node) => {
              if (node !== null) node.indeterminate = chosen.length > 0 && chosen.length < rows.length
            },
            onChange: toggleAll,
          }),
          h('span', { className: 'dso-bar-info', key: 'info' },
            chosen.length === 0 ? '勾选后可批量操作' : '已选 ' + chosen.length + ' 个'),
          h('div', { className: 'dso-bar-acts', key: 'acts' }, [
            tab === 'live' ? h('button', {
              key: 'archive',
              type: 'button',
              className: 'dso-btn',
              disabled: working || chosen.length === 0,
              onClick: () => { run('archive', rows.filter((row) => chosenSet.has(row.id))) },
            }, batchLabel('archive', '归档')) : null,
            tab === 'archived' ? h('button', {
              key: 'restore',
              type: 'button',
              className: 'dso-btn',
              disabled: working || chosen.length === 0,
              onClick: () => { run('restore', rows.filter((row) => chosenSet.has(row.id))) },
            }, batchLabel('restore', '还原')) : null,
            h('button', {
              key: 'delete',
              type: 'button',
              className: 'dso-btn danger',
              disabled: working || chosen.length === 0,
              onClick: () => { run('delete', rows.filter((row) => chosenSet.has(row.id))) },
            }, batchLabel('delete', '删除')),
          ]),
        ]),
        rows.length === 0
          ? h('div', { className: 'dso-empty', key: 'empty' },
            tab === 'archived' ? '还没有归档过的会话。' : '没有可管理的会话。')
          : h('ul', { className: 'dso-list', key: 'list' }, rows.map((row) => h('li', {
            className: 'dso-row',
            key: row.id,
            'data-on': chosenSet.has(row.id) ? '1' : undefined,
          }, [
            h('input', {
              key: 'pick',
              type: 'checkbox',
              className: 'dso-check',
              'aria-label': '选择 ' + titleOf(row),
              disabled: working,
              checked: chosenSet.has(row.id),
              onChange: () => { toggle(row.id) },
            }),
            h('div', { className: 'dso-main', key: 'main' }, [
              h('div', { className: 'dso-name', key: 'n' }, titleOf(row)),
              h('div', { className: 'dso-meta', key: 'm' },
                [ago(row.updatedAt), row.cwd].filter((part) => typeof part === 'string' && part !== '').join(' · ')),
            ]),
            row.running ? h('span', { className: 'dso-badge', key: 'run' }, '运行中') : null,
            row.id === (list && list.current) ? h('span', { className: 'dso-badge', key: 'cur' }, '当前') : null,
            h('button', {
              key: 'open',
              type: 'button',
              className: 'dso-btn',
              disabled: working,
              onClick: () => {
                props.openSession(row.id)
                // close 是 settings 拥有者提供的标准席位；缺席时只开会话不关面板。
                if (typeof props.close === 'function') props.close()
              },
            }, '打开'),
            tab === 'live' ? h('button', {
              key: 'archive',
              type: 'button',
              className: 'dso-btn',
              disabled: working,
              onClick: () => { run('archive', [row]) },
            }, '归档') : null,
            tab === 'archived' ? h('button', {
              key: 'restore',
              type: 'button',
              className: 'dso-btn',
              disabled: working,
              onClick: () => { run('restore', [row]) },
            }, working && busy.kind === 'restore' && busy.id === row.id ? '还原中…' : '还原') : null,
            h('button', {
              key: 'delete',
              type: 'button',
              className: 'dso-btn danger',
              disabled: working || row.running === true,
              onClick: () => { run('delete', [row]) },
            }, working && busy.kind === 'delete' && busy.id === row.id ? '处理中…' : '删除'),
          ]))),
        notice === null ? null : h('div', {
          className: 'dso-notice',
          key: 'notice',
          'data-err': notice.isError ? '1' : undefined,
        }, notice.text),
        h('p', { className: 'dso-hint', key: 'hint' },
          '归档只是把会话从侧栏隐藏，日志完整保留；「还原」把会话放回侧栏，并把已删除会话的'
          + '日志目录从回收目录搬回原位（官方没有还原接口，本插件直接改 workspace 存储域）。'
          + '删除不会立刻抹掉磁盘数据，而是把整个会话目录移到 ~/.dsh/deleted-sessions/<会话 id>/，'
          + '并在里面写 .dsh-session-ops.json 记录原位置。运行中的会话不能删除，先停止它。'),
      ])
    }

    return {
      name: 'dsh-session-ops',
      inject: ['slots', 'sessions', 'workspaces'],
      apply(ctx) {
        // apply 期的 ctx 才能读服务；slot 的 inject 回调里读 ctx.<service> 会抛。
        const sessions = ctx.sessions
        const workspaces = ctx.workspaces

        ctx.effect(() => {
          const previous = document.getElementById(STYLE_ID)
          if (previous !== null) previous.remove()
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = STYLE
          document.head.append(style)
          return () => { style.remove() }
        }, 'dsh-session-ops: stylesheet')

        /**
         * 宿主端点的共用调用壳：POST { sessionId }，把非 ok 的载荷翻成可读错误。
         * @param path - 端点路径。
         * @param sessionId - 目标会话 id。
         * @param explain - 把 `data.error` 翻成中文；返回 undefined 表示交给兜底。
         * @returns 端点返回的载荷。
         */
        const post = (path, sessionId, explain) => fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        }).then((response) => response.json().catch(() => ({})).then((data) => {
          if (!response.ok || data.ok !== true) {
            // 404 只有一种解释：宿主半边还是旧版本（新端点要重启 dsh web 才注册）。
            if (response.status === 404) throw new Error('宿主端点还没加载，重启 DSH 后再试')
            throw new Error(explain(data.error)
              || data.message || data.error || ('HTTP ' + response.status))
          }
          return data
        }))

        // 单个删除：只管这一个会话，不刷新列表（批量跑完由调用方统一刷一次）。
        const deleteSession = (sessionId) => post('/dsh-session-ops/delete', sessionId, (code) => (
          code === 'session-running' ? '会话正在运行，先停止它再删除' : undefined
        )).then((data) => {
          // 只有「目录在、但搬不动」才算删除没干完：日志文件还被进程握着，
          // 重启后可以再删一次。其它 moved: false 由调用方当提示处理。
          if (data.moved !== true && data.reason === 'log-in-use') {
            throw new Error('已从列表移除，但日志目录被占用、移不动，重启 DSH 后可再删一次')
          }
          return data
        })

        // 取消归档。宿主认不出 workspaceRegistry 的内部缓存时会整个拒绝，
        // 不留半状态，所以这里只需要把原因说清楚。
        const restoreSession = (sessionId) => post('/dsh-session-ops/restore', sessionId, (code) => {
          if (code === 'registry-shape-unknown') {
            return 'DSH 换了 workspaceRegistry 的内部结构，还原通道失效，需要更新插件'
          }
          return code === 'workspace-domain-closed' ? 'workspace 存储域没开着，重启 DSH 再试' : undefined
        })

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-session-ops',
          order: 55,
          label: () => '会话管理',
          inject: () => ({
            archiveSession: (sessionId) => workspaces.archiveSession(sessionId),
            deleteSession,
            restoreSession,
            refreshSessions: () => sessions.refresh(),
            openSession: (sessionId) => { sessions.open(sessionId) },
          }),
        }, SessionOpsPage)), 'dsh-session-ops: settings section')
      },
    }
  },
})
