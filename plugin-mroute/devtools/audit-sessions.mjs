#!/usr/bin/env node
/**
 * audit-sessions.mjs — DSH 多模型会话审计器（只读，零依赖，Node ≥ 22）
 *
 * 作用：从 DSH 会话日志（session.v4.jsonl.zstd，多帧 zstd 压缩 JSONL）还原
 *   「哪些会话派发了子会话、用了哪些模型、派发前有没有查 mroute 推荐、有没有按清单走」，
 *   产出机读 JSON + 人读 Markdown 摘要 + 控制台统计。
 *
 * 只读红线：本脚本只读 ~/.dsh 下文件，写操作只发生在 --json / --md 指定路径
 *（默认 <本脚本目录>/out/）。绝不修改 ~/.dsh 任何文件。
 *
 * 用法：
 *   node audit-sessions.mjs [--workspace <slug 或路径子串>] [--limit N] [--days N | --since <ISO>]
 *                           [--json <out.json>] [--md <out.md>]
 *                           [--root <sessions 根>] [--decisions <dir>] [--patch <yml>]
 *                           [--top N] [--quiet]
 *
 * 输出内容不含 prompt/消息正文、密钥、token、cookie；session id 一律截断前 8 位。
 */

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ZSTD_MAGIC = 0xfd2fb528; // 28 B5 2F FD（小端读法）
const ZSTD_MAGIC_BYTES = Buffer.from('28b52ffd', 'hex');

// ---- 审计口径常量 -----------------------------------------------------------
const DISPATCH_TOOLS = ['subagent', 'subagent_fork', 'tree_dispatch', 'workflow', 'ralph', 'flow_run', 'subagent_openclaw'];
const PREFLIGHT_TOOLS = ['mroute_dispatch_plan', 'model_route_query'];
const MROUTE_TOOLS = [...PREFLIGHT_TOOLS, 'model_route_alias_suggest', 'model_route_sync_models'];
const GATE_ERROR_TEXT = 'child LLM route';           // 宿主策略门拒绝原文前缀
const LINK_WINDOW_MS = 120_000;                      // 派发调用 ↔ 子会话创建时间关联窗口
const DEFAULT_TOP_N = 3;                             // 「清单前几项」口径
const SID_LEN = 8;                                   // session id 截断长度（红线）

// ---- 小工具 ---------------------------------------------------------------
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const nowMs = () => Date.now();
const pad = (n) => String(n).padStart(2, '0');

/** ms epoch → 本地时间字符串（审计报告用，精确到秒） */
function fmtTime(ms) {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** ms epoch → 本地日期 YYYY-MM-DD（时间线分组用） */
function fmtDay(ms) {
  if (!ms || !Number.isFinite(ms)) return 'unknown';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** session id 规范化：去掉可选的 `session-` 前缀，便于父子互认 */
function canonId(v) {
  if (!v) return null;
  return String(v).trim().replace(/^session-/, '');
}
/** 截断 session id（红线：报告/输出只放前 8 位） */
function sid8(v) {
  const c = canonId(v) || v || '';
  return String(c).slice(0, SID_LEN);
}
/** 截断任意文本用于异常清单（防长文本/正文入档） */
function clip(s, n = 96) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
}
/** 模型族：优先按模型名归类，退化到 provider */
function modelFamily(provider, model) {
  const m = String(model || '').toLowerCase();
  const fams = ['deepseek', 'glm', 'qwen', 'mimo', 'longcat', 'kimi', 'gpt', 'claude', 'gemini', 'llama', 'mistral'];
  for (const f of fams) if (m.startsWith(f)) return f;
  if (provider) return String(provider).toLowerCase();
  return 'unknown';
}

// ---- 参数解析 -------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    workspace: null, limit: 0, days: 0, since: null, json: null, md: null,
    root: join(homedir(), '.dsh', 'sessions'),
    decisions: join(homedir(), '.dsh', 'mroute', 'decisions'),
    patch: join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    topN: DEFAULT_TOP_N, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--workspace': out.workspace = next(); break;
      case '--limit': out.limit = Number(next()) || 0; break;
      case '--days': out.days = Number(next()) || 0; break;
      case '--since': out.since = next(); break;
      case '--json': out.json = next(); break;
      case '--md': out.md = next(); break;
      case '--root': out.root = next(); break;
      case '--decisions': out.decisions = next(); break;
      case '--patch': out.patch = next(); break;
      case '--top': out.topN = Math.max(1, Number(next()) || DEFAULT_TOP_N); break;
      case '--quiet': out.quiet = true; break;
      case '-h': case '--help':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 28).join('\n'));
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) throw new Error(`未知参数 ${a}（--help 查看用法）`);
    }
  }
  if (!out.json) out.json = join(SCRIPT_DIR, 'out', 'summary.json');
  if (!out.md) out.md = join(SCRIPT_DIR, 'out', 'audit-summary.md');
  if (out.since) {
    const ts = Date.parse(out.since);
    if (!Number.isFinite(ts)) throw new Error(`--since 取值无法解析为时间：${out.since}（示例 2026-11-13T00:00:00Z）`);
    out.sinceTs = ts;
  } else {
    out.sinceTs = null;
  }
  return out;
}

// ---- 工作区 slug 解析 -----------------------------------------------------
/**
 * DSH 会话目录的 slug 形态：`--D-Codes-DSH~5C0F~63D2~4EF6--`。
 * 规则：路径分隔符/冒号 → '-'，非 ASCII 字符 → '~XXXX~'（大写十六进制），首尾各补 '--'。
 * 这里只做「解码成可比较的字符段」，不追求逆向出精确盘符。
 */
function slugSegments(slug) {
  const s = String(slug).replace(/^-+/, '').replace(/-+$/, '');
  return s.split('-').filter(Boolean).map((p) =>
    // 转义段形如 `~5C0F~63D2~4EF6`：相邻转义共用一个 '~'，故先解所有 ~XXXX 再清残 '~'
    p.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/~/g, ''));
}
function pathSegments(p) {
  return String(p).split(/[\\/:]+/).filter(Boolean);
}
/** 候选 slug 是否匹配用户给的 workspace 值（全路径段序列，或末段子串） */
function matchesWorkspace(slug, wanted) {
  const segs = slugSegments(slug);
  const want = pathSegments(wanted);
  if (!segs.length || !want.length) return false;
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  // 1) 完整段序列
  if (segs.length === want.length && segs.every((s, i) => eq(s, want[i]))) return true;
  // 2) 用户给的是路径尾部（如 'DSH小插件'）：要求 want 是 segs 的后缀
  if (want.length <= segs.length) {
    const tail = segs.slice(segs.length - want.length);
    if (tail.every((s, i) => eq(s, want[i]))) return true;
  }
  // 3) 兜底：任一含 CJK 的段做包含匹配
  return segs.some((s, i) => CJK_RE.test(s) && (want.some((w) => s.includes(w)) || want.some((w) => w.includes(s))));
}
function resolveWorkspaceSlug(rootDir, wanted) {
  const dirs = readdirSync(rootDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (wanted) {
    const hit = dirs.find((d) => matchesWorkspace(d, wanted));
    if (!hit) {
      throw new Error(`未找到匹配 --workspace "${wanted}" 的会话目录。可用目录：\n  ${dirs.join('\n  ')}`);
    }
    return hit;
  }
  const cwd = process.cwd();
  const cwdSegs = pathSegments(cwd);
  const hit = dirs.find((d) => {
    const segs = slugSegments(d);
    return segs.length === cwdSegs.length && segs.every((s, i) => s.toLowerCase() === cwdSegs[i].toLowerCase());
  });
  if (hit) return hit;
  // 退化：按 cwd 尾段（如插件目录名）匹配
  const tailHit = dirs.find((d) => matchesWorkspace(d, cwdSegs[cwdSegs.length - 1] || ''));
  if (tailHit) return tailHit;
  throw new Error(`无法从当前目录 "${cwd}" 推断会话 slug，请显式传 --workspace。可用目录：\n  ${dirs.join('\n  ')}`);
}

// ---- zstd 多帧读取 --------------------------------------------------------
/**
 * 计算从 off 开始的 zstd 帧长度（RFC 8878：帧头 + block 链 + 可选 checksum）。
 * 失败返回 -1，由调用方走 magic 回退。
 */
function zstdFrameLength(buf, off) {
  if (off + 6 > buf.length || buf.readUInt32LE(off) !== ZSTD_MAGIC) return -1;
  let p = off + 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6;              // Frame_Content_Size flag
  const singleSegment = (fhd >> 5) & 1;
  const hasChecksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  p += singleSegment ? 0 : 1;            // Window_Descriptor
  p += [0, 1, 2, 4][dictFlag];           // Dictionary_ID
  p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]; // Frame_Content_Size
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const bh = buf.readUIntLE(p, 3);
    p += 3;
    const last = bh & 1;
    const type = (bh >> 1) & 3;          // 0 raw / 1 RLE / 2 compressed / 3 reserved
    const size = bh >> 3;
    if (type === 3) return -1;
    p += type === 1 ? 1 : size;          // RLE block 只有 1 字节实际数据
    if (p > buf.length) return -1;
    if (last) break;
  }
  if (hasChecksum) p += 4;
  return p - off;
}

/**
 * 逐帧解压一个会话日志。会话日志是「每行一个 zstd 帧」的拼接体，
 * 直接 zstdDecompressSync 整个 buffer 只解出第一帧，所以必须按帧走。
 * @returns {{lines: string[], warnings: string[]}}
 */
function readSessionLines(file) {
  const warnings = [];
  const raw = readFileSync(file);
  const parts = [];
  let off = 0;
  let fallbacks = 0;
  while (off < raw.length) {
    const len = zstdFrameLength(raw, off);
    if (len > 0) {
      try {
        parts.push(zstdDecompressSync(raw.subarray(off, off + len)));
        off += len;
        continue;
      } catch (e) {
        warnings.push(`帧解压失败@${off}: ${e.code || e.message}`);
      }
    }
    // 回退：跳到下一个 magic（坏帧/未知前缀时尽量保住后续帧）
    fallbacks++;
    const next = raw.indexOf(ZSTD_MAGIC_BYTES, off + 4);
    if (next < 0) {
      warnings.push(`字节 ${off} 之后无可识别帧尾（共 ${raw.length} 字节），放弃剩余`);
      break;
    }
    off = next;
  }
  if (fallbacks) warnings.push(`走 magic 回退 ${fallbacks} 次`);
  return { lines: Buffer.concat(parts).toString('utf8').split('\n'), warnings };
}

// ---- 注册表（cordis.patch.yml）轻量只读解析 --------------------------------
/**
 * 只解析审计需要的三段：channels[]（id/routeProvider/models/channel_type/tier/priority/status）、
 * model_aliases（渠道 → 渠道模型 → 规范名）。YAML 结构固定且缩进稳定，逐行状态机即可。
 */
function parseRegistry(patchPath) {
  const reg = { ok: false, error: null, channels: {}, aliases: {}, top: {} };
  let text;
  try { text = readFileSync(patchPath, 'utf8'); } catch (e) { reg.error = `读取失败: ${e.code || e.message}`; return reg; }
  const lines = text.split(/\r?\n/);
  let mode = null;      // 'channels' | 'aliases'
  let chan = null;
  let aliasChannel = null;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (indent === 4 && t === 'channels:') { mode = 'channels'; continue; }
    if (indent === 4 && t === 'model_aliases:') { mode = 'aliases'; chan = null; continue; }
    if (indent === 4 && /^[a-z_]+:\s*$/.test(t) && t !== 'channels:' && t !== 'model_aliases:') { mode = null; continue; }
    if (mode === 'channels') {
      if (indent === 6 && t.startsWith('- id:')) {
        chan = { id: t.slice('- id:'.length).trim(), models: [], channel_type: null, tier: null, priority: null, routeProvider: null, status: null };
        reg.channels[chan.id] = chan;
        continue;
      }
      if (!chan) continue;
      if (indent === 8 && t.startsWith('routeProvider:')) chan.routeProvider = t.slice(14).trim();
      else if (indent === 8 && t.startsWith('channel_type:')) chan.channel_type = t.slice(13).trim();
      else if (indent === 8 && t.startsWith('tier:')) chan.tier = t.slice(5).trim();
      else if (indent === 8 && t.startsWith('priority:')) chan.priority = Number(t.slice(9).trim()) || null;
      else if (indent === 8 && t === 'models:') chan.inModels = true;
      else if (indent === 8 && t.startsWith('status:')) chan.status = t.slice(7).trim();
      else if (indent === 2 + 1 && t === 'manual:') { /* 保持当前 chan */ }
      else if (indent === 10 && chan.inModels && t.startsWith('- ')) chan.models.push(t.slice(2).trim());
      else if (indent <= 8 && t !== 'models:') chan.inModels = false;
    } else if (mode === 'aliases') {
      if (indent === 6 && t.endsWith(':') && !t.startsWith('-')) { aliasChannel = t.slice(0, -1); reg.aliases[aliasChannel] = {}; continue; }
      if (indent === 8 && aliasChannel && t.includes(':')) {
        const idx = t.indexOf(':');
        reg.aliases[aliasChannel][t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
      }
    }
  }
  reg.ok = Object.keys(reg.channels).length > 0;
  if (!reg.ok) reg.error = '未解析到 channels[]（可能被改名/结构变化）';
  return reg;
}

// ---- 计划文本解析（从 mroute 工具结果里取推荐清单） ------------------------
/**
 * mroute_dispatch_plan 结果行形如：
 *   `1. zai-coding-cn / glm-5.3  [monthly · domestic_sota · priority 90]  🌕 ...`
 * model_route_query 结果行形如：
 *   `1. zai-coding-cn → provider=zai-coding-cn models=[glm-5.3, glm-5.3-flash] | monthly/...`
 * 只取第一段从 rank=1 开始的连续编号块（后面的「匹配模型」「能力匹配推荐」等分段不算）。
 */
function parsePlanText(tool, text) {
  const ranked = [];
  let expect = 1;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    // 两种工具的行格式不同，但都是「顶格编号行 + 缩进续行（理由/备注/⚠）」；
    // 只看顶格行，续行天然被跳过（否则 rank2 会被 "   理由: …" 截断）。
    if (/^\s/.test(rawLine)) continue;
    const line = rawLine.trim();
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (!m) {
      if (ranked.length) break;             // 编号块结束（脚注/用法/其他段落）
      continue;                             // 块前的表头（标题、当前会话路由等）
    }
    const rank = Number(m[1]);
    if (rank !== expect) break;             // 编号不连续 → 另一段列表开始
    // 去掉行首标注符号（如 `4. ⚠ deepseek-account → …`），只留渠道/模型正文
    const rest = m[2].replace(/^[^\w\u4e00-\u9fa5]+/u, '').trim();
    let entry = null;
    if (tool === 'model_route_query') {
      const q = rest.match(/^(\S+)\s+→\s+provider=([^\s|]*)\s+models=\[([^\]]*)\]/);
      if (q) {
        entry = {
          rank,
          provider: (q[2] || q[1]).trim(),
          models: q[3].split(',').map((s) => s.trim()).filter(Boolean),
        };
      }
    } else {
      // `mroute_dispatch_plan`：`1. zai-coding-cn / glm-5.3  [monthly · …]  🌕 5h 32% …`
      const d = rest.match(/^(\S+)\s*\/\s*([^\s\[]+)/);
      if (d) entry = { rank, provider: d[1].trim(), models: [d[2].trim()] };
    }
    if (!entry) break;
    ranked.push(entry);
    expect++;
  }
  return ranked;
}

// ---- 单会话扫描 -----------------------------------------------------------
/**
 * 逐行处理一个会话文件（不把全部事件留在内存）。
 * 采集：会话头、模型、派发调用、预检调用、策略门拒绝、unknown tool、mroute 报错、
 *       派发前工具直方图。
 */
function scanSession(dirName, file) {
  const s = {
    dir: dirName,
    sid: null, sid8: null, parentRaw: null, parentSid8: null,
    origin: null, depth: null, cwd: null, createdAt: null,
    firstEventAt: null, lastEventAt: null, eventCount: 0,
    models: [], mainModel: null, lastModel: null,
    dispatches: [], preflights: [], gateRejections: [], otherDispatchErrors: [],
    unknownTool: 0, unknownToolNames: {}, mrouteErrors: 0, mrouteErrorSamples: [],
    toolCalls: {}, toolsBeforeDispatch: {}, toolsBeforeDispatchCalls: 0,
    warnings: [],
  };
  const { lines, warnings } = readSessionLines(file);
  s.warnings.push(...warnings);

  const callNames = new Map();       // callId → tool name
  const preflightByCall = new Map(); // callId → preflight 记录
  let firstDispatchT = null;

  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { s.warnings.push('坏 JSON 行已跳过'); continue; }
    s.eventCount++;
    if (typeof ev.time === 'number') {
      if (s.firstEventAt === null) s.firstEventAt = ev.time;
      s.lastEventAt = ev.time;
    }
    const type = ev.type;

    if (type === 'session') {
      s.sid = ev.id || s.sid;
      s.parentRaw = ev.parentSession || null;
      s.origin = ev.origin || null;
      s.depth = ev.delegationDepth ?? null;
      s.cwd = ev.cwd || null;
      s.createdAt = ev.createdAt || s.createdAt;
      continue;
    }

    // 会话自身模型：request/header 的 config.{provider,model}（每 step 一条，可能换档）
    if (type === 'request/header') {
      const cfg = ev.data?.header?.config;
      if (cfg && cfg.model) {
        const key = `${cfg.provider || '?'}/${cfg.model}`;
        if (!s.models.includes(key)) s.models.push(key);
        if (!s.mainModel) s.mainModel = key;
        s.lastModel = key;
      }
      continue;
    }
    if (type === 'request/context' && !s.mainModel) {
      if (ev.data?.model) {
        const key = `${ev.data.provider || '?'}/${ev.data.model}`;
        s.models.push(key); s.mainModel = key; s.lastModel = key;
      }
      continue;
    }

    if (type === 'tool/call') {
      const name = ev.data?.name || '?';
      const callId = ev.data?.callId || null;
      if (callId) callNames.set(callId, name);
      s.toolCalls[name] = (s.toolCalls[name] || 0) + 1;

      let args = {};
      try { args = JSON.parse(ev.data?.arguments || '{}'); } catch { args = {}; }

      if (DISPATCH_TOOLS.includes(name)) {
        const action = args.action || null;
        let provider = null;
        let model = null;
        if (name === 'tree_dispatch') {
          provider = args.assignee?.provider || null;
          model = args.assignee?.model || null;
        } else if (name === 'workflow' || name === 'flow_run' || name === 'ralph') {
          provider = args.provider || null;
          model = args.model || null;
        } else {
          provider = args.provider || null;
          model = args.model || null;
        }
        const rec = {
          t: ev.time || null, tool: name, callId, action,
          provider: provider || null, model: model || null,
          explicit: Boolean(provider || model),
          ok: null, errorKind: null, childSid8: null,
        };
        s.dispatches.push(rec);
        if (name === 'tree_dispatch' && action && action !== 'start') rec.cancelled = true; // cancel 不是派发
        else if (firstDispatchT === null) firstDispatchT = rec.t;
      } else if (PREFLIGHT_TOOLS.includes(name)) {
        const rec = { t: ev.time || null, tool: name, callId, ok: null, ranked: [], error: null };
        s.preflights.push(rec);
        if (callId) preflightByCall.set(callId, rec);
      } else if (name === 'mroute_dispatch_plan' || name === 'model_route_query') {
        // 已在上一个分支覆盖；保留以防御工具名变体
      }

      // 「派发前最常调用的工具」：首次派发尝试之前的全部 tool/call
      if (firstDispatchT === null || (ev.time && ev.time < firstDispatchT)) {
        if (!DISPATCH_TOOLS.includes(name)) {
          s.toolsBeforeDispatch[name] = (s.toolsBeforeDispatch[name] || 0) + 1;
          s.toolsBeforeDispatchCalls++;
        }
      }
      continue;
    }

    if (type === 'tool/result') {
      const msg = ev.data?.message || {};
      const text = Array.isArray(msg.content) ? msg.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n') : '';
      const callId = msg.source?.callId || msg.toolCallId || null;
      const name = (callId && callNames.get(callId)) || '';
      const isError = Boolean(msg.isError);

      if (isError && text.includes(GATE_ERROR_TEXT)) {
        // 策略门拒绝：只留「被拒路由」这种可结构化信息，不留正文
        const route = (text.match(/child LLM route "([^"]+)"/) || [])[1] || null;
        s.gateRejections.push({ t: ev.time || null, tool: name || '?', route });
        const rec = findLatestDispatch(s.dispatches, callId);
        if (rec) { rec.ok = false; rec.errorKind = 'gate'; }
      } else if (isError && /unknown tool/i.test(text)) {
        s.unknownTool++;
        const tn = (text.match(/unknown tool "?([\w.-]+)"?/i) || [])[1] || name || '?';
        s.unknownToolNames[tn] = (s.unknownToolNames[tn] || 0) + 1;
      } else if (isError && DISPATCH_TOOLS.includes(name)) {
        const rec = findLatestDispatch(s.dispatches, callId);
        const kind = /E_PORTS_PROTOCOL/.test(text) ? 'ports' : 'error';
        s.otherDispatchErrors.push({ t: ev.time || null, tool: name, kind, head: clip(text, 80) });
        if (rec) { rec.ok = false; rec.errorKind = kind; }
      }

      if (MROUTE_TOOLS.includes(name)) {
        const rec = preflightByCall.get(callId);
        if (isError && !/unknown tool/i.test(text)) {
          // 只统计 mroute 自己的校验失败；`unknown tool` 属宿主工具面缺失，单列到 unknownTool
          s.mrouteErrors++;
          if (s.mrouteErrorSamples.length < 3) s.mrouteErrorSamples.push({ t: ev.time || null, tool: name, head: clip(text, 90) });
          if (rec) { rec.ok = false; rec.error = clip(text, 90); }
        } else if (rec && rec.ranked.length === 0) {
          rec.ok = true;
          rec.ranked = parsePlanText(name, text);
        }
      } else if (DISPATCH_TOOLS.includes(name) && !isError) {
        const rec = findLatestDispatch(s.dispatches, callId);
        if (rec && rec.ok === null) rec.ok = true;
      }
      continue;
    }
  }

  s.sid = s.sid || dirName.replace(/^session-/, '');
  s.parentRaw = s.parentRaw || null;
  s.sid8 = sid8(s.sid);
  s.parentSid8 = s.parentRaw ? sid8(s.parentRaw) : null;
  s.createdAt = s.createdAt || s.firstEventAt;
  s.endedAt = s.lastEventAt || s.createdAt;
  return s;
}

/** 用 callId 精确回填派发记录；callId 缺失时退化到最近一条未定结果的记录 */
function findLatestDispatch(list, callId) {
  if (callId) {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].callId === callId) return list[i];
  }
  for (let i = list.length - 1; i >= 0; i--) if (list[i].ok === null) return list[i];
  return null;
}

// ---- 主流程 ---------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = nowMs();
  const warnings = [];

  // 1) 定位工作区 slug
  const slug = resolveWorkspaceSlug(args.root, args.workspace);
  const wsDir = join(args.root, slug);

  // 2) 会话目录清单（按目录 mtime 降序；--limit 取最近 N 个）
  let dirs = [];
  for (const d of readdirSync(wsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = join(wsDir, d.name, 'session.v4.jsonl.zstd');
    let stat = null;
    try { stat = statSync(file); } catch { continue; }
    dirs.push({ name: d.name, file, mtime: stat.mtimeMs, size: stat.size });
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  const totalFound = dirs.length;
  if (args.limit > 0) dirs = dirs.slice(0, args.limit);

  // 3) 逐会话扫描（单文件失败只记 warning）
  const sessions = [];
  const failedFiles = [];
  for (const d of dirs) {
    try {
      sessions.push(scanSession(d.name, d.file));
    } catch (e) {
      failedFiles.push({ dir: d.name, error: clip(e.code || e.message, 90) });
      warnings.push(`会话 ${sid8(d.name)} 读取失败：${clip(e.code || e.message, 90)}`);
    }
  }

  // 4) 时间过滤（--since 固定起点优先；否则 --days 保留近 N 天创建的会话）
  let filtered = sessions;
  const cutoff = args.sinceTs !== null ? args.sinceTs
    : (args.days > 0 ? nowMs() - args.days * 86_400_000 : null);
  if (cutoff !== null) filtered = sessions.filter((s) => !s.createdAt || s.createdAt >= cutoff);

  // 5) 父子关联：child.parentRaw → 父会话；按创建时间差最近匹配父侧的派发调用
  const bySid = new Map();
  for (const s of filtered) bySid.set(canonId(s.sid), s);
  const pending = [];
  for (const s of filtered) {
    if (!s.parentRaw) continue;
    const p = bySid.get(canonId(s.parentRaw));
    if (!p) { s.linkNote = 'parent-out-of-scope'; continue; }
    s.isChild = true;
    p.childCount = (p.childCount || 0) + 1;
    pending.push({ parent: p, child: s });
  }
  // 时间差最近优先，一调用只配一个子会话
  pending.sort((a, b) => {
    const da = a.child.createdAt && a.parent.dispatches.length ? minDelta(a.parent.dispatches, a.child.createdAt) : Infinity;
    const db = b.child.createdAt && b.parent.dispatches.length ? minDelta(b.parent.dispatches, b.child.createdAt) : Infinity;
    return da - db;
  });
  let linked = 0;
  const unlinked = [];
  for (const { parent, child } of pending) {
    const cand = parent.dispatches
      .filter((d) => !d.cancelled && !d.childSid8 && d.t && child.createdAt)
      .map((d) => ({ d, delta: Math.abs(child.createdAt - d.t) }))
      .filter((x) => x.delta <= LINK_WINDOW_MS)
      .sort((a, b) => a.delta - b.delta);
    if (!cand.length) { unlinked.push(child.sid8); continue; }
    cand[0].d.childSid8 = child.sid8;
    cand[0].d.childModel = child.mainModel || 'unknown';
    child.viaDispatch = cand[0].d.callId || null;
    linked++;
  }

  // 6) 有效 assignee：显式参数 > 被关联子会话实际模型 > null（继承且未关联）
  for (const s of filtered) {
    for (const d of s.dispatches) {
      d.effective = d.explicit ? `${d.provider || '?'}/${d.model || '?'}` : (d.childModel ? `inherit→${d.childModel}` : (d.cancelled ? 'cancel' : 'inherit?'));
    }
    s.dispatchAttempts = s.dispatches.filter((d) => !d.cancelled);
    s.dispatchCount = s.dispatchAttempts.length;
  }

  // 7) 合规分类
  for (const s of filtered) s.classification = classify(s, args.topN);

  // 8) 聚合
  const agg = aggregate(filtered, args, { slug, totalFound, failedFiles, linked, unlinked, warnings });

  // 9) 决策文件（只读参考：只有 model_route_query 会写，无 session 维度）
  agg.meta.decisions = readDecisions(args.decisions);

  // 10) 注册表（只读，用于把派发模型挂到渠道语义上）
  agg.meta.registry = parseRegistry(args.patch);

  // 11) 写输出
  const elapsed = nowMs() - t0;
  const summary = {
    meta: {
      generated_at: new Date().toISOString(),
      tool: 'plugin-mroute/devtools/audit-sessions.mjs',
      node: process.version,
      elapsed_ms: elapsed,
      workspace: { slug, decoded_segments: slugSegments(slug) },
      sessions_root: args.root,
      sessions_total_on_disk: totalFound,
      sessions_scanned: sessions.length,
      sessions_after_filter: filtered.length,
      limit: args.limit, days: args.days, since: args.since, top_n: args.topN, link_window_ms: LINK_WINDOW_MS,
      failed_files: agg.meta.failed_files,
      warnings: agg.meta.warnings,
      decisions: agg.meta.decisions,
      registry: {
        ok: agg.meta.registry.ok,
        error: agg.meta.registry.error,
        channels: Object.keys(agg.meta.registry.channels).length,
        channel_ids: Object.keys(agg.meta.registry.channels),
        aliased_channels: Object.keys(agg.meta.registry.aliases).length,
      },
      redaction: '不含 prompt/消息正文/密钥；session id 截断前 8 位',
    },
    summary: agg.summary,
    sessions: filtered.map(publicSession),
  };
  mkdirSync(dirname(args.json), { recursive: true });
  mkdirSync(dirname(args.md), { recursive: true });
  writeFileSync(args.json, JSON.stringify(summary, null, 2), 'utf8');
  const md = renderMd(summary);
  writeFileSync(args.md, md, 'utf8');

  // 12) 控制台摘要
  if (!args.quiet) printConsole(summary, elapsed);
  console.log(`\n输出：${resolve(args.json)}`);
  console.log(`      ${resolve(args.md)}`);
}

function minDelta(dispatches, t) {
  let best = Infinity;
  for (const d of dispatches) {
    if (d.cancelled || !d.t) continue;
    const delta = Math.abs(t - d.t);
    if (delta < best) best = delta;
  }
  return best;
}

/** 合规分类（任务书 6 档 + 1 档 deviation：查过但选了清单外模型，报告里单列） */
function classify(s, topN) {
  const attempts = s.dispatchAttempts || [];
  if (!attempts.length) return { cls: 'no_dispatch', reason: '无派发调用（tree_dispatch 仅 cancel 不算）' };
  const firstT = Math.min(...attempts.map((d) => d.t || Infinity));
  const okPre = s.preflights.filter((p) => p.ok !== false);
  // 「派发前查过」= 存在一次成功的推荐工具调用，且其时间早于首次派发（任务书 §2 口径）
  const before = okPre.filter((p) => p.t && p.t < firstT && p.ranked.length > 0);
  if (!okPre.length) return { cls: 'no_preflight', reason: '派发前从未成功调用 mroute 推荐工具（mroute_dispatch_plan / model_route_query）' };
  if (!before.length) {
    const firstP = okPre.reduce((a, p) => (!a || (p.t && a.t && p.t < a.t) ? p : a), null);
    return { cls: 'preflight_late', reason: `首次派发 ${fmtTime(firstT)} 之后才查推荐（${firstP ? `${firstP.tool} @ ${fmtTime(firstP.t)}` : '无有效清单'}）` };
  }
  const plan = before[before.length - 1];
  const top = plan.ranked.slice(0, topN);
  // 统一出口：顺带记录「本次判定用的是哪个预检工具」（dispatch_plan 不写决策日志，此字段是唯一来源）
  const R = (cls, reason) => ({ cls, reason, plan_tool: plan.tool });

  // 判定单次派发落在清单第几位：strict=渠道+模型双命中；provider=仅渠道命中（清单未列该模型）
  const judge = (d) => {
    let prov = (d.provider || '').toLowerCase();
    let mod = (d.model || '').toLowerCase();
    if (!d.explicit && d.childModel && d.childModel !== 'unknown') {
      const [p, m] = String(d.childModel).split('/');
      prov = (p || '').toLowerCase(); mod = (m || '').toLowerCase();
    }
    if (!prov) return { d, kind: 'undetermined' };
    const hit = top.find((e) => e.provider.toLowerCase() === prov);
    if (!hit) return { d, kind: 'off' };
    const rank = top.indexOf(hit) + 1;
    const strict = hit.models.length === 0 || !mod || hit.models.map((x) => x.toLowerCase()).includes(mod);
    return { d, kind: strict ? 'strict' : 'provider', rank };
  };
  const judged = attempts.map(judge);
  const inPlan = (j) => j.kind === 'strict' || j.kind === 'provider';
  const firstOkIdx = judged.findIndex((j) => j.d.ok !== false);
  const firstOk = firstOkIdx >= 0 ? judged[firstOkIdx] : null;
  const priorRejected = firstOkIdx < 0 ? [] : judged.slice(0, firstOkIdx).filter((j) => j.d.ok === false);
  const rejectedRoutes = [...new Set(s.gateRejections.map((r) => r.route).filter(Boolean))].slice(0, 4);
  const rejectNote = priorRejected.length
    ? `先被策略门拒绝 ${priorRejected.length} 次（${rejectedRoutes.join(', ') || 'route 未明'}）`
    : '';

  if (firstOk && firstOk.kind === 'off') {
    const later = judged.slice(firstOkIdx + 1).filter(inPlan);
    if (later.length && priorRejected.length) {
      return R('compliant_fallback', `${rejectNote}，改填清单内 ${later[0].d.effective}（前 ${topN} 第 ${later[0].rank} 位）`);
    }
    const offList = judged.filter((j) => j.kind === 'off').map((j) => j.d.effective).slice(0, 3);
    return R('deviation', `查过推荐（${plan.tool}）但派发 ${offList.join(', ')} 不在前 ${topN}（清单 ${top.map((e) => e.provider).join(' > ')}）`);
  }
  if (firstOk) {
    const head = `前 ${topN} 第 ${firstOk.rank} 位${firstOk.kind === 'provider' ? '（同渠道异模型）' : ''}`;
    if (priorRejected.length) return R('compliant_fallback', `${rejectNote}，改填清单内 ${firstOk.d.effective}（${head}）`);
    return R('compliant', `派发 ${firstOk.d.effective} 命中清单（${head}）`);
  }
  if (judged.some(inPlan)) return R('compliant', `首个派发无法判定（继承未关联子会话），后续派发命中清单前 ${topN}`);
  if (judged.every((j) => j.kind === 'undetermined')) return { cls: 'unknown', reason: '派发全部为继承且未能关联到子会话模型' };
  return { cls: 'unknown', reason: '派发全部失败，无成功派发可判定合规' };
}

/** 聚合统计 */
function aggregate(sessions, args, ctx) {
  const withDispatch = sessions.filter((s) => s.dispatchCount > 0);
  const byClass = {};
  for (const c of ['compliant', 'compliant_fallback', 'preflight_late', 'no_preflight', 'deviation', 'unknown', 'no_dispatch']) byClass[c] = 0;
  for (const s of sessions) byClass[s.classification.cls] = (byClass[s.classification.cls] || 0) + 1;
  const good = byClass.compliant + byClass.compliant_fallback;
  const rate = withDispatch.length ? good / withDispatch.length : 0;
  // 「查过推荐率」：有派发的会话中，首次派发前确实成功查过清单（不要求命中）
  const preflightBefore = withDispatch.filter((s) => s.classification.cls !== 'no_preflight' && s.classification.cls !== 'preflight_late').length;
  const preflightRate = withDispatch.length ? preflightBefore / withDispatch.length : 0;
  // 判定所用预检工具：mroute_dispatch_plan 不写决策日志，只能从这里看「谁用了工具 B」
  const planToolCounts = {};
  for (const s of withDispatch) {
    const k = s.classification.plan_tool || 'none';
    planToolCounts[k] = (planToolCounts[k] || 0) + 1;
  }
  const sameChannel = withDispatch.filter((s) => /同渠道异模型/.test(s.classification.reason || '')).length;
  // 近 7 天窗口（DoD 要求给出近 7 天真实响应率）；--since 指定时用固定起点，便于复现
  const cutoff7 = args.sinceTs !== null ? args.sinceTs : Date.now() - 7 * 86400000;
  const recent = sessions.filter((s) => s.createdAt && s.createdAt >= cutoff7);
  const recentDispatch = recent.filter((s) => s.dispatchCount > 0);
  const recentGood = recentDispatch.filter((s) => ['compliant', 'compliant_fallback'].includes(s.classification.cls)).length;
  const recentClasses = {};
  for (const s of recentDispatch) recentClasses[s.classification.cls] = (recentClasses[s.classification.cls] || 0) + 1;
  const recentPreflight = recentDispatch.filter((s) => s.classification.cls !== 'no_preflight' && s.classification.cls !== 'preflight_late').length;

  // 按模型族
  const fam = new Map();
  for (const s of sessions) {
    const [prov, mod] = String(s.mainModel || 'unknown/unknown').split('/');
    const family = modelFamily(prov, mod);
    if (!fam.has(family)) fam.set(family, { family, sessions: 0, with_dispatch: 0, compliant: 0, fallback: 0, classes: {} });
    const f = fam.get(family);
    f.sessions++;
    if (s.dispatchCount > 0) f.with_dispatch++;
    if (s.classification.cls === 'compliant') f.compliant++;
    if (s.classification.cls === 'compliant_fallback') f.fallback++;
    if (s.dispatchCount > 0) f.classes[s.classification.cls] = (f.classes[s.classification.cls] || 0) + 1;
  }
  const byFamily = [...fam.values()].map((f) => ({
    ...f,
    response_rate: f.with_dispatch ? (f.compliant + f.fallback) / f.with_dispatch : null,
  })).sort((a, b) => b.with_dispatch - a.with_dispatch || b.sessions - a.sessions);

  // 按天
  const days = new Map();
  for (const s of sessions) {
    const d = fmtDay(s.createdAt);
    if (!days.has(d)) days.set(d, { day: d, sessions: 0, with_dispatch: 0, compliant: 0, fallback: 0, gate_rejections: 0, dispatches: 0 });
    const day = days.get(d);
    day.sessions++;
    if (s.dispatchCount > 0) day.with_dispatch++;
    if (s.classification.cls === 'compliant') day.compliant++;
    if (s.classification.cls === 'compliant_fallback') day.fallback++;
    day.gate_rejections += s.gateRejections.length;
    day.dispatches += s.dispatchCount;
  }
  const byDay = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));

  // 派发前最常调用工具（只在有派发的会话里统计）
  const top = new Map();
  for (const s of withDispatch) for (const [n, c] of Object.entries(s.toolsBeforeDispatch)) top.set(n, (top.get(n) || 0) + c);
  const topTools = [...top.entries()].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls).slice(0, 15);

  // 异常
  const gate = [];
  const unknownTool = [];
  const mrouteErr = [];
  const dispatchErr = [];
  for (const s of sessions) {
    if (s.gateRejections.length) gate.push({ sid8: s.sid8, count: s.gateRejections.length, routes: [...new Set(s.gateRejections.map((r) => r.route).filter(Boolean))] });
    if (s.unknownTool) unknownTool.push({ sid8: s.sid8, count: s.unknownTool, tools: s.unknownToolNames });
    if (s.mrouteErrors) mrouteErr.push({ sid8: s.sid8, count: s.mrouteErrors, samples: s.mrouteErrorSamples });
    if (s.otherDispatchErrors.length) dispatchErr.push({ sid8: s.sid8, count: s.otherDispatchErrors.length, kinds: [...new Set(s.otherDispatchErrors.map((e) => e.kind))] });
  }
  const unknownModel = sessions.filter((s) => !s.mainModel).map((s) => s.sid8);

  // 派发画像：显式 assignee vs 继承、子会话模型分布、渠道分布、全局工具直方图
  const split = { attempts: 0, succeeded: 0, failed: 0, explicit: 0, inherit: 0 };
  const childModels = new Map();
  const channels = new Map();
  for (const s of sessions) {
    for (const d of s.dispatchAttempts) {
      split.attempts++;
      if (d.ok === false) split.failed++; else split.succeeded++;
      if (d.explicit) split.explicit++; else split.inherit++;
      if (d.ok === false) continue;
      const eff = d.explicit ? `${d.provider}/${d.model}` : (d.childModel && d.childModel !== 'unknown' ? `inherit→${d.childModel}` : 'inherit→?');
      childModels.set(eff, (childModels.get(eff) || 0) + 1);
      const ch = String(eff).replace(/^inherit→/, '').split('/')[0];
      channels.set(ch, (channels.get(ch) || 0) + 1);
    }
  }
  const toolHist = new Map();
  for (const s of sessions) for (const [n, c] of Object.entries(s.toolCalls)) toolHist.set(n, (toolHist.get(n) || 0) + c);
  const sortMap = (m, n) => [...m.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count).slice(0, n);

  return {
    meta: { failed_files: ctx.failedFiles, warnings: ctx.warnings, linked: ctx.linked, unlinked: ctx.unlinked, registry: {} },
    summary: {
      sessions: sessions.length,
      sessions_with_dispatch: withDispatch.length,
      dispatches: sessions.reduce((a, s) => a + s.dispatchCount, 0),
      child_sessions: sessions.filter((s) => s.isChild).length,
      linked_children: ctx.linked,
      unlinked_children: ctx.unlinked.length,
      response_rate: Number(rate.toFixed(4)),
      response_rate_pct: `${(rate * 100).toFixed(1)}%`,
      preflight_before_count: preflightBefore,
      preflight_rate: Number(preflightRate.toFixed(4)),
      preflight_rate_pct: `${(preflightRate * 100).toFixed(1)}%`,
      plan_tool_usage: planToolCounts,
      same_channel_diff_model: sameChannel,
      good,
      last7d: {
        cutoff: new Date(cutoff7).toISOString(),
        sessions: recent.length,
        sessions_with_dispatch: recentDispatch.length,
        dispatches: recentDispatch.reduce((a, s) => a + s.dispatchCount, 0),
        good: recentGood,
        preflight_before: recentPreflight,
        preflight_rate_pct: recentDispatch.length ? `${((recentPreflight / recentDispatch.length) * 100).toFixed(1)}%` : 'n/a',
        response_rate_pct: recentDispatch.length ? `${((recentGood / recentDispatch.length) * 100).toFixed(1)}%` : 'n/a',
        by_class: recentClasses,
      },
      by_class: byClass,
      dispatch_profile: {
        ...split,
        by_child_model: sortMap(childModels, 12),
        by_channel: sortMap(channels, 10),
      },
      tool_histogram: sortMap(toolHist, 25),
      by_family: byFamily,
      by_day: byDay,
      top_tools_before_dispatch: topTools,
      anomalies: {
        gate_rejections: { calls: gate.reduce((a, x) => a + x.count, 0), sessions: gate.length, detail: gate },
        unknown_tool: { calls: unknownTool.reduce((a, x) => a + x.count, 0), sessions: unknownTool.length, detail: unknownTool },
        mroute_tool_errors: { calls: mrouteErr.reduce((a, x) => a + x.count, 0), sessions: mrouteErr.length, detail: mrouteErr },
        dispatch_errors: { calls: dispatchErr.reduce((a, x) => a + x.count, 0), sessions: dispatchErr.length, detail: dispatchErr },
        unknown_model_sessions: unknownModel,
      },
    },
  };
}

/** 决策文件只读统计（说明：只有 model_route_query 会写，且无 session id） */
function readDecisions(dir) {
  const out = { dir, exists: false, files: [], records: 0, by_day: [], has_session_id: false, note: '只有 model_route_query 写决策；mroute_dispatch_plan 不写' };
  let names = [];
  try { names = readdirSync(dir).filter((f) => /^decisions-\d{6}\.jsonl$/.test(f)).sort(); } catch { return out; }
  out.exists = true;
  out.files = names;
  const days = new Map();
  for (const n of names) {
    let lines = [];
    try { lines = readFileSync(join(dir, n), 'utf8').split('\n').filter((l) => l.trim()); } catch { continue; }
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      out.records++;
      if (rec.session || rec.sessionId || rec.session_id) out.has_session_id = true;
      const d = String(rec.ts || '').slice(0, 10) || 'unknown';
      days.set(d, (days.get(d) || 0) + 1);
    }
  }
  out.by_day = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, records]) => ({ day, records }));
  return out;
}

/** 单会话对外投影（红线：只留 8 位 id、工具名、模型名、时间、计数） */
function publicSession(s) {
  return {
    sid8: s.sid8,
    parent_sid8: s.parentSid8,
    is_child: Boolean(s.isChild),
    origin: s.origin, depth: s.depth,
    created_at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
    ended_at: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    events: s.eventCount,
    models: s.models,
    main_model: s.mainModel || 'unknown',
    model_unknown: !s.mainModel,
    dispatch_count: s.dispatchCount,
    children: s.childCount || 0,
    dispatches: s.dispatchAttempts.map((d) => ({
      t: d.t ? new Date(d.t).toISOString() : null,
      tool: d.tool,
      provider: d.provider, model: d.model, explicit: d.explicit,
      effective: d.effective, ok: d.ok, error_kind: d.errorKind,
      child_sid8: d.childSid8,
    })),
    preflights: s.preflights.map((p) => ({
      t: p.t ? new Date(p.t).toISOString() : null,
      tool: p.tool, ok: p.ok, ranked: p.ranked.slice(0, 5),
    })),
    gate_rejections: s.gateRejections,
    unknown_tool: s.unknownTool,
    mroute_errors: s.mrouteErrors,
    other_dispatch_errors: s.otherDispatchErrors.length,
    classification: s.classification.cls,
    classification_reason: s.classification.reason,
    tools_before_dispatch_calls: s.toolsBeforeDispatchCalls,
    warnings: s.warnings.slice(0, 5),
  };
}

/** 控制台摘要（DoD 要求能直接看到统计） */
function printConsole(summary, elapsed) {
  const m = summary.meta, s = summary.summary;
  const lines = [];
  lines.push('多模型会话审计（只读）');
  lines.push(`工作区 slug: ${m.workspace.slug}  →  ${m.workspace.decoded_segments.join('/')}`);
  lines.push(`扫描: ${m.sessions_scanned}/${m.sessions_total_on_disk} 会话 · 事件 ${sessionsEventTotal(summary)} · 失败文件 ${m.failed_files.length} · 耗时 ${elapsed}ms`);
  lines.push(`派发: ${s.sessions_with_dispatch} 个会话有派发调用 · ${s.dispatches} 次派发 · ${s.child_sessions} 个子会话（关联 ${s.linked_children}，未关联 ${s.unlinked_children}）`);
  const bc = s.by_class;
  lines.push(`分类: compliant ${bc.compliant} · fallback ${bc.compliant_fallback} · late ${bc.preflight_late} · no_preflight ${bc.no_preflight} · deviation ${bc.deviation} · unknown ${bc.unknown} · no_dispatch ${bc.no_dispatch}`);
  lines.push(`响应率: ${s.response_rate_pct}（${s.good}/${s.sessions_with_dispatch}）· 查过推荐率 ${s.preflight_rate_pct}（${s.preflight_before_count}/${s.sessions_with_dispatch}）`);
  const l7 = s.last7d;
  lines.push(`近 7 天: ${l7.sessions} 会话 · ${l7.sessions_with_dispatch} 个有派发 · 响应率 ${l7.response_rate_pct}（${l7.good}/${l7.sessions_with_dispatch}）`);
  const pt = Object.entries(s.plan_tool_usage).map(([k, v]) => `${k} ${v}`).join(' · ');
  lines.push(`判定工具: ${pt || '—'}（同渠道异模型 ${s.same_channel_diff_model} 会话）`);
  const fam = s.by_family.filter((f) => f.with_dispatch > 0).slice(0, 6)
    .map((f) => `${f.family} ${f.response_rate === null ? '—' : (f.response_rate * 100).toFixed(0) + '%'}(${f.compliant + f.fallback}/${f.with_dispatch})`).join(' · ');
  lines.push(`按模型族: ${fam || '—'}`);
  const a = s.anomalies;
  lines.push(`异常: 策略门拒绝 ${a.gate_rejections.calls} 次/${a.gate_rejections.sessions} 会话 · unknown tool ${a.unknown_tool.calls} 次/${a.unknown_tool.sessions} 会话 · mroute 报错 ${a.mroute_tool_errors.calls} 次 · 其他派发失败 ${a.dispatch_errors.calls} 次 · 模型未知 ${a.unknown_model_sessions.length} 会话`);
  lines.push(`派发前工具 Top: ${s.top_tools_before_dispatch.slice(0, 8).map((t) => `${t.tool} ${t.calls}`).join(' · ') || '—'}`);
  lines.push(`时间线: ${s.by_day.map((d) => `${d.day.slice(5)} ${d.sessions}会话/${d.with_dispatch}派发`).join(' · ')}`);
  lines.push(`决策日志: ${m.decisions.records} 条（${m.decisions.files.join(',') || '无'}；无 session 维度，仅全局参考）`);
  for (const l of lines) console.log(l);
}
function sessionsEventTotal(summary) {
  return summary.sessions.reduce((a, s) => a + s.events, 0);
}

/** Markdown 摘要（人读；报告正文 docs/09 另行撰写，这里只产机读摘要表） */
function renderMd(summary) {
  const m = summary.meta, s = summary.summary, bc = s.by_class;
  const rows = [];
  rows.push(`# 会话审计摘要（自动生成）`, '');
  rows.push(`生成时间：${m.generated_at}　工作区：\`${m.workspace.slug}\`（${m.workspace.decoded_segments.join('/')}）`);
  rows.push(`扫描会话 ${m.sessions_scanned} / 盘上 ${m.sessions_total_on_disk}，事件 ${sessionsEventTotal(summary)}，失败文件 ${m.failed_files.length}，耗时 ${m.elapsed_ms}ms。`, '');
  rows.push(`## 合规分类`, '', '| 分类 | 会话数 |', '|---|---|');
  for (const [k, v] of Object.entries(bc)) rows.push(`| ${k} | ${v} |`);
  rows.push('', `响应率：**${s.response_rate_pct}**（${s.good}/${s.sessions_with_dispatch}）；查过推荐率（有派发会话中派发前成功查过清单）：**${s.preflight_rate_pct}**（${s.preflight_before_count}/${s.sessions_with_dispatch}）。`, '');
  rows.push('', `判定所用预检工具：${Object.entries(s.plan_tool_usage).map(([k, v]) => `\`${k}\` ${v}`).join(' · ')}；同渠道异模型（渠道命中但模型≠清单建议）${s.same_channel_diff_model} 会话。`, '');
  rows.push('', `近 7 天窗口（≥${s.last7d.cutoff}；滑动窗口，可用 --since 固定）：${s.last7d.sessions} 会话，${s.last7d.sessions_with_dispatch} 个有派发，${s.last7d.dispatches} 次派发，响应率 **${s.last7d.response_rate_pct}**（${s.last7d.good}/${s.last7d.sessions_with_dispatch}），派发前查过推荐 ${s.last7d.preflight_rate_pct}（${s.last7d.preflight_before}/${s.last7d.sessions_with_dispatch}）。`, '');
  rows.push(`## 按模型族`, '', '| 模型族 | 会话 | 有派发 | compliant | fallback | 响应率 |', '|---|---|---|---|---|---|');
  for (const f of s.by_family) rows.push(`| ${f.family} | ${f.sessions} | ${f.with_dispatch} | ${f.compliant} | ${f.fallback} | ${f.response_rate === null ? '—' : (f.response_rate * 100).toFixed(1) + '%'} |`);
  rows.push('', `## 时间线`, '', '| 日期 | 会话 | 有派发 | compliant | fallback | 策略门拒绝 | 派发数 |', '|---|---|---|---|---|---|---|');
  for (const d of s.by_day) rows.push(`| ${d.day} | ${d.sessions} | ${d.with_dispatch} | ${d.compliant} | ${d.fallback} | ${d.gate_rejections} | ${d.dispatches} |`);
  rows.push('', `## 派发前最常调用的工具`, '', '| 工具 | 调用数 |', '|---|---|');
  for (const t of s.top_tools_before_dispatch) rows.push(`| ${t.tool} | ${t.calls} |`);
  rows.push('', `## 异常`, '');
  const a = s.anomalies;
  rows.push(`- 策略门拒绝：${a.gate_rejections.calls} 次 / ${a.gate_rejections.sessions} 会话`);
  rows.push(`- unknown tool：${a.unknown_tool.calls} 次 / ${a.unknown_tool.sessions} 会话`);
  rows.push(`- mroute 工具报错：${a.mroute_tool_errors.calls} 次 / ${a.mroute_tool_errors.sessions} 会话`);
  rows.push(`- 其他派发失败：${a.dispatch_errors.calls} 次 / ${a.dispatch_errors.sessions} 会话`);
  rows.push(`- 模型未知会话：${a.unknown_model_sessions.length}（${a.unknown_model_sessions.join(', ') || '无'}）`);
  rows.push('', `> 红线：本文件不含 prompt/消息正文、密钥、token、cookie；session id 截断前 8 位。`);
  return rows.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { parsePlanText, readSessionLines, resolveWorkspaceSlug, slugSegments };
