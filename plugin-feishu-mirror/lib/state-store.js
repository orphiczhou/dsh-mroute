/**
 * Persisted bot state (bound session, think-display preference, last chat,
 * pairing admins) — a small JSON file in the dsh home
 * (`<dsh home>/dsh-feishu-state.json`).
 *
 * Why not the settings service (the pre-0.1.7 backend): dsh 0.1.7 replaced
 * the settings registry with plugin `static Config` projections where ONLY
 * user-editable `.volatile()` fields are writable at runtime — machine state
 * (pickers, cursors, pairing claims) is exactly what must NOT be volatile
 * (it would surface on the settings page and rewrite the profile patch on
 * every bot event). So the state moved to its own file: same in-memory
 * mirror + write-through semantics as before, zero settings dependency.
 *
 * Upgrade path: a fresh install (no state file yet) absorbs the 0.1.5-era
 * remnants from `<dsh home>/settings.yaml.imported` (or `settings.yaml`)
 * — the host renames the old document on first 0.1.7 boot — by reading the
 * `dsh-feishu:` section with a deliberately conservative flat-scalar parser
 * (anything nested, folded across lines or otherwise unexpected is skipped;
 * the decoders below fail closed). Without it, pairing claims would not
 * survive the upgrade and the bot would re-open pairing mode. The absorption
 * is one-shot and self-evidencing: what was absorbed (and what degraded)
 * is logged once, and the state file is written IMMEDIATELY — the upgrade
 * must not wait for the first mutation to become visible on disk.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
const DEFAULT_STATE = {
    boundSessionId: undefined,
    displayThink: true,
    lastChatId: undefined,
    picker: undefined,
    phoneModel: undefined,
    pairedOperators: [],
    chatBindings: {},
    sessionToChat: {},
};
/** On-disk shape: native JSON values (versioned for future migrations). */
const STATE_FILE_VERSION = 1;
/** The state file, relative to the resolved dsh home. */
export const STATE_FILENAME = 'dsh-feishu-state.json';
/** The old settings document the 0.1.5 host kept bot state in. */
const LEGACY_SETTINGS_FILENAME = 'settings.yaml';
/** What the host renames that document to on first 0.1.7 boot. */
const LEGACY_IMPORTED_FILENAME = 'settings.yaml.imported';
/** The silent logger a context without one degrades to. */
const NOOP_LOGGER = { info() { }, warn() { } };
/** Structural read of `ctx.logger` — absent in minimal hosts/tests. */
function contextLogger(ctx) {
    const candidate = ctx?.logger;
    if (candidate !== null && typeof candidate === 'object'
        && typeof candidate.info === 'function'
        && typeof candidate.warn === 'function') {
        return candidate;
    }
    return NOOP_LOGGER;
}
/**
 * Resolve the dsh home the same way the host does, without importing it:
 * the profile context's home when mounted (structural read — absent in
 * tests/minimal hosts), else `$DSH_HOME`, else `~/.dsh`.
 */
export function resolveDshHome(ctx) {
    const fromProfile = ctx?.profileContext?.home;
    if (typeof fromProfile === 'string' && fromProfile !== '')
        return fromProfile;
    const fromEnv = process.env.DSH_HOME;
    if (fromEnv !== undefined && fromEnv.trim() !== '') {
        return fromEnv === '~' ? homedir()
            : fromEnv.startsWith('~/') ? join(homedir(), fromEnv.slice(2))
                : fromEnv;
    }
    return join(homedir(), '.dsh');
}
/**
 * Decode a persisted picker payload. Defensive: the stored JSON is only as
 * trustworthy as the last writer — anything malformed, empty or missing its
 * expiry degrades to "no picker" rather than surfacing garbage rows. Accepts
 * the native object shape and the pre-0.1.7 JSON-string encoding alike.
 */
function decodePicker(raw) {
    const parsed = typeof raw === 'string' && raw !== ''
        ? tryParseJson(raw)
        : raw !== null && typeof raw === 'object' ? raw : undefined;
    if (parsed === undefined || typeof parsed !== 'object')
        return undefined;
    const record = parsed;
    if (typeof record.id !== 'string' || record.id === '' || !Array.isArray(record.rows) || typeof record.expiresAt !== 'number') {
        return undefined;
    }
    const rows = record.rows.filter((row) => row !== null && typeof row === 'object'
        && typeof row.index === 'number'
        && typeof row.sessionId === 'string');
    if (rows.length === 0)
        return undefined;
    return { id: record.id, rows, expiresAt: record.expiresAt };
}
/** tryParseJson: undefined on any failure — callers never see thrown syntax errors. */
function tryParseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** Decode a persisted phone-selected default model (effort optional). */
function decodePhoneModel(raw) {
    const parsed = typeof raw === 'string' && raw !== ''
        ? tryParseJson(raw)
        : raw !== null && typeof raw === 'object' ? raw : undefined;
    if (parsed === undefined || typeof parsed !== 'object')
        return undefined;
    const record = parsed;
    if (typeof record.provider === 'string' && record.provider !== '' && typeof record.model === 'string' && record.model !== '') {
        return {
            provider: record.provider,
            model: record.model,
            ...(typeof record.reasoningEffort === 'string' && record.reasoningEffort !== ''
                ? { reasoningEffort: record.reasoningEffort }
                : {}),
        };
    }
    return undefined;
}
/**
 * Decode the persisted pairing-admin list. Defensive: a malformed blob (not
 * JSON, not an array, junk entries, empty strings) degrades to a filtered
 * list or [] rather than surfacing garbage into the authorization gate.
 */
function decodePairedOperators(raw) {
    const parsed = typeof raw === 'string' && raw !== ''
        ? tryParseJson(raw)
        : Array.isArray(raw) ? raw : undefined;
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
}
function decodeMirrorMap(raw) {
    const parsed = typeof raw === 'string' && raw !== ''
        ? tryParseJson(raw)
        : raw !== null && typeof raw === 'object' ? raw : undefined;
    if (parsed === undefined || Array.isArray(parsed))
        return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof key !== 'string' || key === '')
            continue;
        if (typeof value === 'string' && value !== '') {
            out[key] = value;
            continue;
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            continue;
        out[key] = { ...value };
    }
    return out;
}
function fromSection(section) {
    const value = (section ?? {});
    return {
        boundSessionId: typeof value.boundSessionId === 'string' && value.boundSessionId !== ''
            ? value.boundSessionId
            : undefined,
        // Absent means the default (on) — only an explicit false turns it off.
        displayThink: value.displayThink !== false,
        lastChatId: typeof value.lastChatId === 'string' && value.lastChatId !== ''
            ? value.lastChatId
            : undefined,
        picker: decodePicker(value.picker),
        phoneModel: decodePhoneModel(value.phoneModel),
        pairedOperators: decodePairedOperators(value.pairedOperators),
        chatBindings: decodeMirrorMap(value.chatBindings),
        sessionToChat: decodeMirrorMap(value.sessionToChat),
    };
}
// ------------------------------------------------------------- legacy import --
/**
 * Decode one YAML scalar of the old settings document — the shapes the 0.1.5
 * writer actually produced for this section (plain strings, booleans, and
 * single-quoted JSON-string payloads). A value that opens a quote it does not
 * close on the same line is a FOLDED long scalar (the yaml package wraps at
 * 80 columns): unparseable here by design, so the key is skipped and the
 * decoder's own defaults apply — never a half-read value.
 */
function decodeLegacyScalar(raw) {
    const value = raw.trim();
    if (value === '' || value === 'null' || value === '~')
        return undefined;
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    const quote = value[0];
    const closed = value.length >= 2 && value[value.length - 1] === quote;
    if (quote === "'" || quote === '"') {
        if (!closed || value.length < 2)
            return undefined; // folded / unterminated — skip
        if (quote === '"')
            return tryParseJson(value); // JSON-compatible escapes; else undefined
        return value.slice(1, -1).replace(/''/g, "'");
    }
    const hash = value.indexOf(' #');
    return hash >= 0 ? value.slice(0, hash).trim() : value;
}
/**
 * Extract the top-level `dsh-feishu:` section of the old settings document.
 * Conservative on purpose: flat `key: value` lines only — nested maps,
 * lists, comments and blank-line runs never decode (the section this plugin
 * ever wrote WAS flat). undefined = no section found.
 */
export function legacyFeishuSection(text) {
    const lines = text.split('\n');
    const start = lines.findIndex(line => /^dsh-feishu:\s*(#.*)?$/.test(line));
    if (start < 0)
        return undefined;
    const section = {};
    for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() === '')
            continue;
        if (/^\S/.test(line))
            break; // the next top-level key ends the section
        if (/^\s*#/.test(line))
            continue;
        const match = /^\s+([A-Za-z][A-Za-z0-9_-]*):[ \t]?(.*)$/.exec(line);
        if (match === null)
            continue; // nested shape we do not model — skip the line
        section[match[1]] = decodeLegacyScalar(match[2]);
    }
    return section;
}
/** The section keys this plugin ever wrote, in report order. */
const KNOWN_SECTION_KEYS = [
    'pairedOperators', 'boundSessionId', 'displayThink', 'lastChatId', 'picker', 'phoneModel',
];
/**
 * Which of the section's PRESENT keys degraded to the default. A key the
 * section never mentions is not "skipped" (nothing was lost); a key it does
 * mention but whose decoded value is the default is (the operator wrote
 * something there the conservative reader could not carry).
 */
function skippedLegacyKeys(section, state) {
    const skipped = [];
    for (const key of KNOWN_SECTION_KEYS) {
        if (!(key in section))
            continue;
        const carried = key === 'pairedOperators' ? state.pairedOperators.length > 0
            : key === 'boundSessionId' ? state.boundSessionId !== undefined
                : key === 'lastChatId' ? state.lastChatId !== undefined
                    : key === 'picker' ? state.picker !== undefined
                        : key === 'phoneModel' ? state.phoneModel !== undefined
                            : true; // displayThink: absent-or-truthy means the default (on) — nothing to lose
        if (!carried)
            skipped.push(key);
    }
    return skipped;
}
/** One `key=value` pair per absorbed key, for the absorption summary line. */
function absorptionSummary(state) {
    const parts = [];
    if (state.pairedOperators.length > 0)
        parts.push(`pairedOperators=${state.pairedOperators.length}`);
    if (state.boundSessionId !== undefined)
        parts.push('boundSessionId=yes');
    if (state.lastChatId !== undefined)
        parts.push('lastChatId=yes');
    if (state.picker !== undefined)
        parts.push('picker=yes');
    if (state.phoneModel !== undefined)
        parts.push('phoneModel=yes');
    parts.push(`displayThink=${state.displayThink ? 'yes' : 'no'}`);
    return parts.join(', ');
}
/**
 * Best-effort read of the 0.1.5 state remnants: the imported (preferred —
 * the host renamed it there) then the live old settings document. Any
 * failure (absent file, unreadable, garbage) moves on silently — a bot
 * upgrade must never be blocked by a cleanup nicety. Resolves undefined
 * when no document carries a `dsh-feishu:` section at all.
 */
async function readLegacyState(home) {
    let shell;
    for (const name of [LEGACY_IMPORTED_FILENAME, LEGACY_SETTINGS_FILENAME]) {
        let text;
        try {
            text = await readFile(join(home, name), 'utf8');
        }
        catch {
            continue;
        }
        try {
            const section = legacyFeishuSection(text);
            if (section !== undefined) {
                const state = fromSection(section);
                const skipped = skippedLegacyKeys(section, state);
                // Only a section that decoded to SOMETHING counts; an empty shell
                // (e.g. the folded-everything edge) leaves defaults untouched —
                // but is remembered for the report.
                if (state.pairedOperators.length > 0 || state.boundSessionId !== undefined
                    || state.lastChatId !== undefined || state.picker !== undefined
                    || state.phoneModel !== undefined || state.displayThink === false) {
                    return { state, source: name, skipped };
                }
                shell ??= { state: undefined, source: name, skipped };
            }
        }
        catch {
            // Unreadable legacy document — treat as absent.
        }
    }
    return shell;
}
// -------------------------------------------------------------------- store --
/**
 * File-backed state store. Construction starts the load (state file first,
 * legacy settings remnants on a fresh install); `ready()` resolves once the
 * load settled so early reads see the persisted values. Every mutation
 * mirrors into memory immediately and writes the file through a serialized
 * tmp+rename queue — persistence failures degrade to the in-memory copy
 * (the bot still works, it just re-binds after a restart), exactly the old
 * no-settings-service behavior.
 */
export class StateStore {
    memory = { ...DEFAULT_STATE };
    path;
    /** The directory the state file (and the legacy document) live in. */
    home;
    logger;
    loading;
    writes = Promise.resolve();
    constructor(ctx, options = {}) {
        this.path = options.path ?? join(resolveDshHome(ctx), STATE_FILENAME);
        this.home = options.path !== undefined ? dirname(options.path) : resolveDshHome(ctx);
        this.logger = options.logger ?? contextLogger(ctx);
        this.loading = this.load();
    }
    /** Wait for the initial load (a file read — settles on its own) so first reads see disk. */
    async ready() {
        await this.loading;
    }
    /** Current snapshot. */
    get() {
        return { ...this.memory };
    }
    /** Merge a patch and persist it. Never throws. */
    async update(patch) {
        const next = { ...this.get(), ...patch };
        Object.assign(this.memory, next);
        await this.persist();
    }
    /**
     * The persisted pairing admins (OnboardStoreSeam shape): read fresh from
     * the store on every call so a claim lands in-process immediately.
     */
    getPairedOperators() {
        return this.get().pairedOperators;
    }
    /** Add a pairing admin (dedup-merge) and persist. Never throws. */
    async addPairedOperator(openId) {
        const value = openId.trim();
        if (value === '')
            return;
        const current = this.getPairedOperators();
        if (current.includes(value))
            return;
        await this.update({ pairedOperators: [...current, value] });
    }
    /**
     * Initial load: the state file, else one absorption pass over the legacy
     * document. An absorption persists IMMEDIATELY (before any mutation) — the
     * file must exist as soon as the state was taken over, so an operator (or
     * a support session) can SEE the claims survived the upgrade instead of
     * waiting for the first write to happen to land. Degraded keys and the
     * empty-shell edge each get one log line: the folded-scalar skips are
     * exactly the cases where the operator may need to re-pair.
     */
    async load() {
        let text;
        try {
            text = await readFile(this.path, 'utf8');
        }
        catch {
            text = undefined;
        }
        if (text !== undefined) {
            try {
                this.memory = fromSection(tryParseJson(text));
            }
            catch {
                // Corrupt state file — defaults apply; the next write replaces it.
            }
            return;
        }
        const legacy = await readLegacyState(this.home);
        if (legacy === undefined)
            return; // fresh install — nothing to absorb, nothing to say
        if (legacy.state !== undefined) {
            this.memory = { ...this.memory, ...legacy.state };
            this.logger.info('dsh-feishu: absorbed legacy settings state (%s): %s', legacy.source, absorptionSummary(legacy.state));
            await this.persist();
            if (legacy.skipped.length > 0) {
                this.logger.warn('dsh-feishu: legacy settings keys not absorbed from %s (folded across lines): %s — re-pairing may be required', legacy.source, legacy.skipped.join(', '));
            }
        }
        else {
            // Empty shell: the section existed but nothing survived the conservative
            // reader — one line naming the degenerated keys, not silence.
            this.logger.warn('dsh-feishu: legacy settings section in %s carried no readable state (folded/unparseable: %s) — re-pairing may be required', legacy.source, legacy.skipped.length > 0 ? legacy.skipped.join(', ') : 'no known keys');
        }
    }
    /** Serialized write-through: one tmp+rename at a time, failures swallowed. */
    persist() {
        const task = this.writes.then(() => this.writeNow());
        this.writes = task.then(() => undefined, () => undefined);
        return task;
    }
    async writeNow() {
        const value = this.memory;
        const payload = `${JSON.stringify({
            version: STATE_FILE_VERSION,
            boundSessionId: value.boundSessionId ?? null,
            displayThink: value.displayThink,
            lastChatId: value.lastChatId ?? null,
            picker: value.picker ?? null,
            phoneModel: value.phoneModel ?? null,
            pairedOperators: [...value.pairedOperators],
            chatBindings: value.chatBindings ?? {},
            sessionToChat: value.sessionToChat ?? {},
        }, null, 2)}\n`;
        const tmp = `${this.path}.tmp`;
        try {
            await writeFile(tmp, payload, 'utf8');
            await rename(tmp, this.path);
        }
        catch {
            // Persistence failed — the in-memory copy still serves this run.
        }
    }
}
//# sourceMappingURL=state-store.js.map