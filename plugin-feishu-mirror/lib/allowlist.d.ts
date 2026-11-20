/**
 * Operator allowlist. The Feishu tenant's account system carries identity;
 * this gate is the authorization: every inbound message and (future) card
 * callback must pass `isOperator` before the bot acts on it. Non-operators are
 * ignored SILENTLY — no reply, no reaction — so the bot's existence leaks
 * nothing to strangers who find it.
 */
/**
 * Build the effective allowlist set from config + env. `DSH_FEISHU_OPERATORS`
 * (comma-separated open_ids) extends the config list — handy for quick local
 * tests without editing the patch file.
 */
export declare function buildAllowlist(configured: readonly string[], env?: NodeJS.ProcessEnv): ReadonlySet<string>;
/**
 * Whether one sender open_id may operate the bot. An empty allowlist authorizes
 * NOBODY — the caller must treat that as "bot inert", not "bot open".
 */
export declare function isOperator(openId: string | undefined, allowlist: ReadonlySet<string>): boolean;
