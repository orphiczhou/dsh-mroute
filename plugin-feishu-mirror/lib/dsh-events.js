/**
 * Local structural types for session events whose declaring packages are not
 * part of the core `SessionEventMap`. The firehose delivers them regardless
 * (it is not scope-filtered — dsh-tui-pi folds them the same way), so this
 * module merges the foreign event types into the map via module augmentation
 * and narrows them with structural reads.
 *
 * `todo/write` moved OUT of dsh-session in dsh 0.1.2-alpha.3 — its
 * SessionEventMap entry now lives in @deepseek-ai/dsh-tool-todo, pulled in
 * by the type-only side-effect import below (erased at emit; the closure
 * linker provides the types, the host ships the code).
 */
export {};
//# sourceMappingURL=dsh-events.js.map