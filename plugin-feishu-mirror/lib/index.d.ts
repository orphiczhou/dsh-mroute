/**
 * dsh-feishu — drive an existing dsh session from Feishu/Lark.
 *
 * A companion cordis plugin (independent package + own bundle patch): it
 * holds the ONLY outbound Lark WebSocket, attaches to EXISTING sessions via
 * the /resume picker (it never calls agents.create), and renders one status
 * card per turn (in-place updates on a 30s beat, assistant body on turn/end).
 * Designed to coexist with dsh-tui-pi in the same profile — it never touches
 * the terminal — and to work without it.
 *
 * Startup is SILENT by design: the bot connects and listens, but sends
 * nothing until the operator writes first.
 *
 * @module @aiwayds/dsh-feishu
 */
import type { Context } from '@deepseek-ai/cordis';
import { buildAllowlist } from './allowlist.ts';
import { FeishuBot } from './bot.ts';
import { SessionBinder } from './binder.ts';
import { Config, resolveConfig, type ResolvedConfig } from './config.ts';
import { LarkClient } from './lark-client.ts';
import { StateStore } from './state-store.ts';
export declare const name = "dsh-feishu";
/** Seams consumed: the agent service that drives sessions, plus the skill
 *  registry that serves the bundled usage/config guide. */
export declare const inject: string[];
export { Config, resolveConfig };
export type { ResolvedConfig };
export { FeishuBot, SessionBinder, StateStore, LarkClient, buildAllowlist, releaseLock };
/** Lock file path: one bot instance per machine (cluster mode has no broadcast). */
export declare function lockFilePath(): string;
/**
 * Acquire the single-instance lock (returns the open fd, or undefined when
 * another live instance holds it). A stale lock (dead pid) is stolen; a live
 * one means another dsh process runs this bot — this instance stays dormant,
 * because Lark's long-connection mode would otherwise randomly split events
 * between the two clients.
 */
export declare function acquireLock(path?: string): number | undefined;
declare function releaseLock(fd: number | undefined, path?: string): void;
/**
 * Resolve the Lark app credentials. Priority: static config/env (already
 * merged into the resolved config) → dsh credentials service refs. Returns
 * undefined when nothing supplies a complete pair — the plugin stays dormant
 * rather than retrying a connection that cannot authenticate.
 */
export declare function resolveAppCredentials(ctx: Context, config: ResolvedConfig): Promise<{
    appId: string;
    appSecret: string;
} | undefined>;
/**
 * Strip a leading YAML frontmatter block (`---` / body / `---`) from a skill
 * markdown file. `SkillDefinition.content` must be the instruction body after
 * metadata removal — the same shape the filesystem provider serves — so the
 * bundled SKILL.md, which keeps its frontmatter for the GitHub/manual install
 * paths, has the block removed when served through {@link skillProvider.get}.
 * Tolerant by design: input that does not open with a `---` line, or whose
 * frontmatter block is never closed, is returned unchanged. Mirrors the
 * delimiter semantics of the upstream skill-filesystem provider.
 */
export declare function stripFrontmatter(raw: string): string;
export declare function apply(ctx: Context, config?: Config): void;
