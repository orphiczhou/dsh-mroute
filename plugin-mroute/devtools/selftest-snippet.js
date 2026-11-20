/**
 * mroute 渲染内自测片段（dev-only，不随插件发布）。
 *
 * 用途：在没有自动化 UI 驱动通道时，用插件自己的 client 半驱动真实设置面板做端到端自测。
 * 用法：
 *   1) 把本文件内容整段粘回 plugin-mroute/client.js，位置在 styles 字符串之后（同一层作用域）。
 *   2) apply() 末尾加一行：if (SELFTEST) runSelftest(ctx)
 *   3) 临时把 inject 加宽为：['slots','remote','remote.settings','remote.credentials','layout','locale']
 * 读取结果：
 *   cordis_inspect_query { platform:'client', provider:'Regions', method:'snapshot',
 *     input:{ selector:'.mroute-selftest-line' } }
 *   每行文本形如：名字|PASS/FAIL|细节
 * 环境事实：
 *   - plugin_manager set_bundle enabled:false→true 即热重载 client 模块，无需刷新页面。
 *   - client.js 若短暂语法错误，渲染器加载失败但旧模块实例继续运行并往旧盒子写结果；
 *     读回前先核对行集合属于当前源码。
 *   - 盒子固定右上角、默认收起、可拖动、可关闭，避免遮挡宿主界面。
 */
    // ── 临时：渲染内自测（lead 真机闭环用；验收后整段删除）─────────────────────────
    const SELFTEST = true

    function parseRgb(text) {
      const m = /rgba?\(([^)]+)\)/.exec(String(text || ''))
      if (!m) return null
      const parts = m[1].split(',').map((v) => parseFloat(v))
      if (parts.length < 3 || parts.some((v) => Number.isNaN(v))) return null
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
    }

    function luminance(c) {
      if (!c) return null
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }

    function runSelftest(ctx) {
      if (typeof document === 'undefined' || !document.body || typeof document.body.append !== 'function') return
      Array.from(document.querySelectorAll('#mroute-selftest')).forEach((node) => node.remove())
      const results = []
      const check = (name, ok, detail) => { results.push([name, ok ? 'PASS' : 'FAIL', detail === undefined ? '' : String(detail)]) }
      const box = document.createElement('div')
      box.id = 'mroute-selftest'
      // 只占右上角一个小条：默认收起只有标题行，点标题展开；标题行可拖动（记住位置），不看时可点 × 隐藏。
      box.setAttribute('style', 'position:fixed;top:8px;right:8px;width:300px;background:rgba(10,12,16,.92);color:#e9edf5;border:1px solid #3a4250;border-radius:8px;font:11px/1.5 ui-monospace,Consolas,monospace;z-index:2147483000;box-shadow:0 4px 14px rgba(0,0,0,.35)')
      const head = document.createElement('div')
      head.className = 'mroute-selftest-head'
      head.setAttribute('style', 'display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:move;user-select:none')
      const title = document.createElement('span')
      title.className = 'mroute-selftest-title'
      title.textContent = '自测 · 运行中…'
      title.setAttribute('style', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')
      head.append(title)
      const hideBtn = document.createElement('button')
      hideBtn.textContent = '×'
      hideBtn.setAttribute('style', 'all:unset;cursor:pointer;padding:0 2px;color:#9aa4b2')
      head.append(hideBtn)
      const body = document.createElement('div')
      body.className = 'mroute-selftest-body'
      body.setAttribute('style', 'display:none;padding:0 8px 6px;max-height:40vh;overflow:auto')
      box.append(head, body)
      document.body.append(box)
      hideBtn.addEventListener('click', (event) => { event.stopPropagation(); box.remove() })
      head.addEventListener('click', () => { body.style.display = body.style.display === 'none' ? 'block' : 'none' })
      let drag = null
      head.addEventListener('pointerdown', (event) => {
        if (event.target === hideBtn) return
        drag = { x: event.clientX, y: event.clientY, left: box.getBoundingClientRect().left, top: box.getBoundingClientRect().top }
        box.setAttribute('style', box.getAttribute('style').replace(';right:8px', ''))
        try { head.setPointerCapture(event.pointerId) } catch (err) {}
      })
      head.addEventListener('pointermove', (event) => {
        if (!drag) return
        box.style.left = Math.max(0, drag.left + (event.clientX - drag.x)) + 'px'
        box.style.top = Math.max(0, drag.top + (event.clientY - drag.y)) + 'px'
      })
      head.addEventListener('pointerup', () => { drag = null })
      const out = document.createElement('pre')
      out.className = 'mroute-selftest-out'
      out.setAttribute('style', 'display:none;margin:0;white-space:pre-wrap;word-break:break-all')
      out.textContent = '{"phase":"boot"}'
      body.append(out)
      const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
      const report = (extra) => {
        out.textContent = JSON.stringify(Object.assign({ at: new Date().toISOString(), results }, extra || {}))
        const fails = results.filter((row) => row[1] !== 'PASS').length
        title.textContent = '自测 ' + (results.length - fails) + '/' + results.length
          + (fails > 0 ? ' · FAIL ' + fails : ' · 全通过')
          + (extra && extra.waiting ? ' · 等待面板' : '')
        let lines = document.getElementById('mroute-selftest-lines')
        if (!lines) {
          lines = document.createElement('div')
          lines.id = 'mroute-selftest-lines'
          body.insertBefore(lines, out)
        }
        lines.textContent = ''
        results.forEach((row) => {
          const line = document.createElement('div')
          line.className = 'mroute-selftest-line'
          line.textContent = row[0] + '|' + row[1] + '|' + String(row[2] || '').slice(0, 70)
          lines.append(line)
        })
      }

      function findClickable(text) {
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], a'))
        const exact = nodes.filter((el) => (el.textContent || '').trim() === text)
        const loose = exact.length > 0 ? exact : nodes.filter((el) => (el.textContent || '').trim().indexOf(text) >= 0)
        return loose.length > 0 ? loose[0] : null
      }

      const fire = (el) => {
        const opts = { bubbles: true, cancelable: true, view: window }
        try { el.dispatchEvent(new PointerEvent('pointerdown', opts)) } catch (err) {}
        el.dispatchEvent(new MouseEvent('mousedown', opts))
        try { el.dispatchEvent(new PointerEvent('pointerup', opts)) } catch (err) {}
        el.dispatchEvent(new MouseEvent('mouseup', opts))
        el.dispatchEvent(new MouseEvent('click', opts))
      }

      function byLabel(words) {
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], a, [aria-label], [title]'))
          .filter((el) => !(el.closest && el.closest('#mroute-selftest')))
        for (const word of words) {
          // 只认 aria-label/title 包含，或 textContent 精确等于（避免点中「mroute M3 设置面板开发」这类工作区条目）。
          const hit = nodes.find((el) => {
            const aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '')) || ''
            const text = (el.textContent || '').trim()
            return aria.indexOf(word) >= 0 || text === word
          })
          if (hit) return { el: hit, word }
        }
        return null
      }

      function menuItem(words) {
        const nodes = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="dialog"] button, button, [role="button"]'))
          .filter((el) => !(el.closest && el.closest('#mroute-selftest')))
        for (const word of words) {
          const hit = nodes.find((el) => (el.textContent || '').trim() === word)
            || nodes.find((el) => (el.textContent || '').trim().indexOf(word) >= 0)
          if (hit) return { el: hit, word }
        }
        return null
      }

      async function openPanel() {
        // 真实入口：左下角 button[aria-label="账号菜单"]（slot settings.launcher）→ 菜单项「设置」→ 导航「模型路由」。
        const launcher = document.querySelector('button[aria-label="账号菜单"]')
          || document.querySelector('[data-slot="settings.launcher"] button')
        check('open.launcher', !!launcher, launcher ? (launcher.getAttribute('aria-label') || launcher.tagName) : 'none')
        if (!launcher) return document.querySelector('.mroute-set')
        try { fire(launcher) } catch (err) {}
        await sleep(500)
        const settingsItem = menuItem(['设置', 'Settings', '首选项'])
        check('open.menu.settings', !!settingsItem, settingsItem ? settingsItem.word + '@' + settingsItem.el.tagName : 'none')
        if (settingsItem) {
          try { fire(settingsItem.el) } catch (err) {}
          await sleep(900)
        }
        const hitNow = document.querySelector('.mroute-set')
        if (hitNow) return hitNow
        const nav = menuItem(['模型路由'])
        check('open.menu.nav', !!nav, nav ? nav.word + '@' + nav.el.tagName : 'none')
        if (nav) {
          try { fire(nav.el) } catch (err) {}
          await sleep(900)
        }
        return document.querySelector('.mroute-set')
      }

      async function waitForSection(timeout) {
        const started = Date.now()
        while (Date.now() - started < timeout) {
          const hit = document.querySelector('.mroute-set')
          if (hit) return hit
          await sleep(1500)
        }
        return null
      }

      async function run() {
        try {
          // 程序化打开：账号菜单 → 设置 → 模型路由（不碰 openSettingsDocument：那只会在本地文本编辑器里打开配置文件）。
          let sec = null
          try { sec = await openPanel() } catch (err) { check('open.crash', false, String(err && err.message)) }
          if (!sec) {
            report({ waiting: 'panel' })
            sec = await waitForSection(60000)
          }
          check('section.render.cards', !!sec && !!sec.querySelector('.mroute-card'))
          if (!sec) { report({}); return }
          const qa = (sel) => Array.from(sec.querySelectorAll(sel))
          const q = (sel) => sec.querySelector(sel)
          const cards = qa('.mroute-card').length
          check('cards.count', cards >= 7, 'count=' + cards)
          const selects = qa('.mroute-select-wrap').length
          check('default.collapsed', selects === 0, 'selects=' + selects)
          const chips = qa('.mroute-chip').length
          check('chips.present', chips >= 25, 'count=' + chips)
          const biLabel = qa('.mroute-field-label').map((el) => el.textContent).find((t) => t.indexOf('·') >= 0)
          check('labels.bilingual', !!biLabel, biLabel)
          const overflowing = qa('.mroute-card').filter((el) => el.scrollWidth > el.clientWidth + 1).length
          check('layout.no_overflow', overflowing === 0, 'overflowing_cards=' + overflowing)
          const toggle = q('.mroute-card-toggle')
          check('toggle.exists', !!toggle, toggle ? toggle.tagName : 'none')
          if (toggle) toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          const opened = await until(() => q('.mroute-select-wrap'), 4000)
          check('expand.body', !!opened)
          const opt = q('.mroute-select-wrap option')
          const selEl = q('.mroute-select-wrap select')
          const oc = opt ? getComputedStyle(opt) : null
          const sc = selEl ? getComputedStyle(selEl) : null
          const bg = parseRgb(oc && oc.backgroundColor)
          const fg = parseRgb(oc && oc.color)
          const delta = bg && fg ? Math.abs(luminance(bg) - luminance(fg)) : null
          check('option.readable', delta !== null && delta > 0.35, JSON.stringify({
            optionBg: oc && oc.backgroundColor, optionColor: oc && oc.color,
            selectBg: sc && sc.backgroundColor, selectColor: sc && sc.color, delta,
          }))
          const saveBtn = q('.mroute-primary')
          check('save.button', !!saveBtn, saveBtn ? saveBtn.textContent : 'none')
          if (saveBtn) saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await sleep(1400)
          const errTexts = qa('.mroute-error').map((el) => el.textContent)
          check('save.click_no_error', errTexts.length === 0, JSON.stringify(errTexts))
          try {
            const raw = await ctx.remote.settings.mutate(NS, [{ op: 'set', path: ['low_balance_threshold_cny'], value: 10 }], 1)
            const code = raw && raw.error && raw.error.code
            check('conflict.detected', raw && raw.ok === false && code === 'settings/conflict', JSON.stringify({ ok: raw && raw.ok, code }))
          } catch (err) {
            check('conflict.detected', false, 'threw:' + (err && (err.code || err.message)))
          }
          if (ctx.locale && typeof ctx.locale.setLocale === 'function') {
            let original = 'zh'
            try { const snap = ctx.locale.getLocale(); original = (snap && (snap.id || snap.locale)) || 'zh' } catch (err) { original = 'zh' }
            const zhLabel = qa('.mroute-field-label').map((el) => el.textContent).find((t) => t.indexOf('·') >= 0) || ''
            try {
              ctx.locale.setLocale('en')
              await sleep(160)
              const enLabel = qa('.mroute-field-label').map((el) => el.textContent).find((t) => t.indexOf('·') >= 0) || ''
              ctx.locale.setLocale(original)
              await sleep(120)
              const back = qa('.mroute-field-label').map((el) => el.textContent).find((t) => t.indexOf('·') >= 0) || ''
              check('locale.flip', !!enLabel && enLabel !== zhLabel && back === zhLabel, JSON.stringify({ locale: original, zh: zhLabel, en: enLabel, back }))
            } catch (err) {
              check('locale.flip', false, 'threw:' + (err && err.message))
            }
          } else {
            check('locale.flip', false, 'ctx.locale unavailable')
          }
          if (toggle) toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          const closed = await until(() => !q('.mroute-select-wrap'), 4000)
          check('collapse.body', !!closed)
          const panelCopies = () => Array.from(document.querySelectorAll('.mroute-set')).filter((node) => !node.closest('.mroute-selftest-holder'))
          check('panel.open', panelCopies().length > 0, 'copies=' + panelCopies().length)
          const panelSet = panelCopies()[0]
          if (panelSet) {
            const overflowingPanelCards = Array.from(panelSet.querySelectorAll('.mroute-card')).filter((el) => el.scrollWidth > el.clientWidth + 1).length
            check('panel.no_overflow', overflowingPanelCards === 0, JSON.stringify({
              cards: panelSet.querySelectorAll('.mroute-card').length,
              overflowing: overflowingPanelCards,
              width: panelSet.clientWidth,
              scrollWidth: panelSet.scrollWidth,
            }))
            const collapsedInPanel = panelSet.querySelectorAll('.mroute-select-wrap').length === 0
            check('panel.default_collapsed', collapsedInPanel, 'toggles=' + panelSet.querySelectorAll('.mroute-card-toggle').length)
            // M4.7：统一模型名能力档位编辑器必须在「模型归并」卡内（不在渠道卡），且四维下拉含「无」
            const aliasToggle = Array.from(panelSet.querySelectorAll('.mroute-card-toggle'))
              .find((el) => (el.textContent || '').includes(copy().aliasTitle))
            if (aliasToggle) {
              aliasToggle.click()
              await sleep(320)
              const aliasCard = aliasToggle.closest('.mroute-card')
              const editor = aliasCard ? aliasCard.querySelector('.mroute-modelcaps') : null
              const ratingRows = editor ? editor.querySelectorAll('.mroute-modelcap').length : 0
              const ratingSelects = editor ? editor.querySelectorAll('select').length : 0
              const ratingOptions = editor && editor.querySelector('select')
                ? Array.from(editor.querySelector('select').options).map((option) => option.value).join(',')
                : ''
              const inChannelCard = panelSet.querySelectorAll('.mroute-fields .mroute-modelcaps').length
              check('ratings.in_alias_card', !!editor && inChannelCard === 0, JSON.stringify({
                rows: ratingRows,
                selects: ratingSelects,
                options: ratingOptions,
                inChannelCard,
              }))
              check('ratings.none_option', ratingOptions === ',excellent,good,fair,none', ratingOptions)
              // M4.9：能力维度 4→6（world_knowledge/orchestration），每行 6 个下拉。
              check('ratings.all_dims', ratingRows > 0 && ratingSelects === ratingRows * 6, JSON.stringify({
                rows: ratingRows,
                selects: ratingSelects,
              }))
            } else {
              check('ratings.in_alias_card', false, 'alias toggle not found')
            }
          }
          report({})
        } catch (err) {
          check('harness.crash', false, err && (err.stack || err.message))
          report({})
        }
      }

      async function until(fn, timeout = 8000) {
        const started = Date.now()
        while (Date.now() - started < timeout) {
          const value = fn()
          if (value) return value
          await sleep(80)
        }
        return null
      }

      try {
        window.addEventListener('error', (event) => {
          check('window.error', false, String((event && (event.message || (event.error && event.error.message))) || 'unknown'))
          report({})
        })
      } catch (err) {}
      try {
        window.addEventListener('unhandledrejection', (event) => {
          const reason = event && event.reason
          check('window.unhandled', false, String((reason && (reason.stack || reason.message)) || reason || 'unknown'))
          report({})
        })
      } catch (err) {}
      void run()
    }
