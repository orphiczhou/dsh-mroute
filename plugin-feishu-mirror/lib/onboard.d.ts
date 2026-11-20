/**
 * /feishu-onboard core — one-shot Feishu bot setup.
 *
 * Three pillars, all exported for the command wiring and tests:
 *
 * - `verifyCredentials` — raw-HTTP credential check (tenant token + bot info),
 *   deliberately NOT through the SDK client so error shapes stay decidable;
 * - `registerBotApp` — QR scan-to-create via the SDK's `registerApp` (device
 *   flow), pre-filling bot capability, long-connection events and preset
 *   scopes through `addons`; the platform may ignore addons behind a gradual
 *   rollout, which is NOT an error — `verifyCredentials` is the backstop;
 * - `runOnboard` — the interactive orchestration (ask seam in, report out).
 *
 * Security contract: the app secret never reaches `log()` nor report text,
 * with exactly one exception — when the credentials service is unavailable
 * the report must carry a manual-write YAML block (with a rotation warning),
 * because the user has no other way to persist what the scan just created.
 *
 * @module
 */
/** Feishu (default) or Lark (international). */
export type Domain = 'feishu' | 'lark';
/** A plaintext app-id/app-secret pair. */
export interface CredentialsPair {
    appId: string;
    appSecret: string;
}
/**
 * Scopes pre-selected for the freshly created app (bot messaging + the read
 * side the plugin actually uses). Exported so tests and docs cannot drift
 * from what the QR link requests.
 */
export declare const ONBOARD_SCOPE_PRESET: readonly string[];
/** Events pre-subscribed (long-connection mode). */
export declare const ONBOARD_EVENT_PRESET: readonly string[];
/** Card callbacks pre-subscribed (ask-user cards ride on this). */
export declare const ONBOARD_CALLBACK_PRESET: readonly string[];
/**
 * Permission pre-select deep link: opens the open-platform auth page with the
 * preset scopes already ticked (`op_from=openapi` is what the platform's own
 * deep links carry).
 */
export declare function scopeGrantDeepLink(appId: string, domain: Domain): string;
/** Outcome of one credential-verification pass. */
export type VerifyOutcome = {
    readonly status: 'ok';
    readonly botName: string | undefined;
    readonly botOpenId: string | undefined;
}
/** Tenant-token endpoint answered a non-zero code (wrong id/secret). */
 | {
    readonly status: 'bad-credentials';
}
/** Credentials pair is valid but the app has no bot capability (code 11205). */
 | {
    readonly status: 'no-bot';
} | {
    readonly status: 'network';
    readonly detail: string;
} | {
    readonly status: 'other';
    readonly code: number | undefined;
    readonly msg: string;
};
/**
 * Verify one credentials pair against the open platform. Uses raw fetch (not
 * the SDK client) so non-zero codes stay plain to classify. Transport-level
 * failures (reject, non-2xx, non-JSON) map to `network`; business non-zero
 * codes decide between `bad-credentials` (token step) and `other`.
 */
export declare function verifyCredentials(creds: CredentialsPair, domain: Domain, deps?: {
    fetchImpl?: typeof fetch;
}): Promise<VerifyOutcome>;
export type RegisterOutcome = {
    readonly status: 'ok';
    readonly appId: string;
    readonly appSecret: string;
    readonly operatorOpenId: string | undefined;
} | {
    readonly status: 'aborted';
} | {
    readonly status: 'failed';
    readonly detail: string;
};
export interface RegisterDeps {
    readonly domain: Domain;
    readonly signal?: AbortSignal;
    /** QR/link presentation (terminal rendering). */
    readonly showQr?: (url: string, expireIn: number) => void;
    /** Test seam; defaults to the SDK `registerApp`. */
    readonly registerAppImpl?: (options: unknown) => Promise<{
        client_id: string;
        client_secret: string;
        user_info?: {
            open_id?: string;
        };
    }>;
}
/**
 * Render the one-click-creation QR in the desktop terminal: ASCII QR plus the
 * plain URL (the command only ever runs on a desktop where the URL is a
 * usable fallback). The SDK itself prints nothing, so this callback owns the
 * entire presentation.
 */
export declare function printQrToTerminal(url: string, expireIn: number): void;
/**
 * Drive the SDK device-flow registration: shows the QR, polls until the user
 * confirms on the phone, and resolves with the created app credentials.
 * `createOnly` hides the "bind existing app" entry — updating someone's
 * existing app config behind their back is the scan branch's one forbidden
 * move (users with an app take the manual-input branch instead).
 */
export declare function registerBotApp(deps: RegisterDeps): Promise<RegisterOutcome>;
/** Structured ask seam (mirrors the host `ctx.userQuestions.ask` shape). */
export interface OnboardQuestion {
    readonly id: string;
    readonly question: string;
    readonly detail?: string;
    readonly header?: string;
    readonly options?: ReadonlyArray<{
        readonly label: string;
        readonly description?: string;
    }>;
    readonly multiSelect?: boolean;
}
export interface AskSeam {
    ask(request: {
        questions: OnboardQuestion[];
        signal?: AbortSignal;
        /**
         * The calling agent (live runtime root). The host requires it for
         * agent-scoped dispatch — the ONLY path the web UI's answerer (which
         * registers per agent scope and receives forwarded scoped waterfalls)
         * actually sees; an agent-less request dies as NO_PROVIDER there.
         * Structural: mirrors `AskUserQuestionRequest.agent`.
         */
        agent?: unknown;
    }): Promise<{
        answers: Array<{
            id: string;
            selected: string[];
            custom?: string;
        }>;
    }>;
}
/** Credentials service seam — the host handles file locking and chmod. */
export interface CredentialsWriteSeam {
    resolve(ref: string): Promise<{
        value: string;
    } | undefined>;
    set?(ref: string, value: string): Promise<void>;
}
/** Operator allowlist storage seam. */
export interface OnboardStoreSeam {
    getPairedOperators(): readonly string[];
    addPairedOperator(openId: string): Promise<void>;
}
export type CredentialsSource = 'config' | 'env' | 'refs' | 'none';
export interface OnboardDeps {
    readonly domain: Domain;
    /** Credentials resolved at command start (undefined when none). */
    readonly existingCredentials: CredentialsPair | undefined;
    readonly credentialsSource: CredentialsSource;
    /** Host ask service; undefined or throwing degrades to guide-only mode. */
    readonly ask: AskSeam | undefined;
    /**
     * The invoking command's receiving agent (live runtime root), threaded into
     * every ask request. With it, asks ride the agent-scoped waterfall and the
     * web profile's browser answerer receives them (its bridge declines
     * agent-less requests). An ask that fails WITH the agent is retried once
     * without it — the fallback path global-only answerers (e.g. this plugin's
     * own phone cards) can still claim.
     */
    readonly agent?: unknown;
    readonly credentials: CredentialsWriteSeam | undefined;
    readonly store: OnboardStoreSeam | undefined;
    readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
    readonly signal?: AbortSignal;
    /** Scan-branch: how long to wait for the launcher link (default 60s). */
    readonly scanUrlWaitMs?: number;
    /** Scan-branch: grace after the confirm click before giving up (default 120s). */
    readonly scanConfirmGraceMs?: number;
    /** Scan-branch: QR presentation (defaults to terminal rendering). */
    readonly showQr?: (url: string, expireIn: number) => void;
    readonly verifyImpl?: typeof verifyCredentials;
    readonly registerImpl?: typeof registerBotApp;
}
export interface OnboardReport {
    readonly ok: boolean;
    /**
     * Multi-line markdown for the command result. NEVER contains the app
     * secret — the one exception is the missing-credentials-service fallback,
     * which must carry the YAML block plus a rotation warning.
     */
    readonly text: string;
    readonly credentialsWritten: boolean;
    readonly operatorsPaired: readonly string[];
    readonly appId: string | undefined;
}
/**
 * The manual 6-step application guide (also the guide-only fallback text).
 * User-visible copy is Chinese per repo convention.
 */
export declare function guideText(domain: Domain, prefix?: string): string;
/**
 * Run the /feishu-onboard orchestration. Never throws: every seam failure
 * degrades (ask → guide-only, store/credentials → notes in the report), and
 * the secret is confined to the one documented fallback.
 */
export declare function runOnboard(deps: OnboardDeps): Promise<OnboardReport>;
