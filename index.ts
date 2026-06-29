import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type SessionEntry,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-jump-tree";
const LEGACY_WIDGET_KEY = "pi-jump-tree-info";
const MAX_SELECT_MATCHES = 60;
const MAX_COMPLETIONS = 80;

type NotifyLevel = "info" | "warning" | "error";
type MatchReason = "id" | "mark";

interface EntryMatch {
    entry: SessionEntry;
    reason: MatchReason;
}

interface CompletionItem {
    value: string;
    label: string;
    description?: string;
}

interface QualifiedJumpTarget {
    sessionSelector: string;
    targetSelector: string;
}

interface SessionTarget {
    current: boolean;
    cwd?: string;
    id: string;
    name?: string;
    path?: string;
}

function notify(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
}

function stripForOneLine(value: string, maxLength = 96): string {
    const normalized = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function stringifyContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((block) => {
            if (!block || typeof block !== "object") return "";
            const typed = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown };
            if (typed.type === "text" && typeof typed.text === "string") return typed.text;
            if (typed.type === "thinking" && typeof typed.thinking === "string") return typed.thinking;
            if (typed.type === "toolCall" && typeof typed.name === "string") return `[tool call: ${typed.name}]`;
            if (typed.type === "image") return "[image]";
            return "";
        })
        .join(" ");
}

function entryKind(entry: SessionEntry): string {
    if (entry.type === "message") return `message:${entry.message.role}`;
    if (entry.type === "custom_message") return `custom_message:${entry.customType}`;
    if (entry.type === "custom") return `custom:${entry.customType}`;
    return entry.type;
}

function entryPreview(entry: SessionEntry): string {
    switch (entry.type) {
        case "message":
            return stripForOneLine(stringifyContent(entry.message.content));
        case "custom_message":
            return stripForOneLine(stringifyContent(entry.content));
        case "compaction":
            return stripForOneLine(entry.summary ?? "compaction");
        case "branch_summary":
            return stripForOneLine(entry.summary ?? "branch summary");
        case "label":
            return stripForOneLine(`mark ${entry.label ?? "<cleared>"} → ${entry.targetId}`);
        case "model_change":
            return `${entry.provider}/${entry.modelId}`;
        case "thinking_level_change":
            return `thinking: ${entry.thinkingLevel}`;
        case "session_info":
            return stripForOneLine(`name: ${entry.name}`);
        case "custom":
            return stripForOneLine(JSON.stringify(entry.data ?? {}));
        default:
            return "";
    }
}

function markForEntry(entry: SessionEntry, ctx: ExtensionContext): string | undefined {
    return ctx.sessionManager.getLabel(entry.id);
}

function formatEntryChoice(entry: SessionEntry, ctx: ExtensionContext, reason?: MatchReason): string {
    const mark = markForEntry(entry, ctx);
    const markPart = mark ? ` [${mark}]` : "";
    const reasonPart = reason === "mark" ? " mark" : "";
    const preview = entryPreview(entry);
    return `${entry.id}${reasonPart} · ${entryKind(entry)}${markPart}${preview ? ` · ${preview}` : ""}`;
}

function findEntryMatches(rawQuery: string, ctx: ExtensionContext): EntryMatch[] {
    const query = rawQuery.trim();
    if (!query) return [];

    const entries = ctx.sessionManager.getEntries();
    const exactIds = entries.filter((entry) => entry.id === query);
    if (exactIds.length > 0) return exactIds.map((entry) => ({ entry, reason: "id" }));

    return entries
        .filter((entry) => entry.id.startsWith(query))
        .map((entry) => ({ entry, reason: "id" }));
}

function normalizeMarkQuery(rawQuery: string): string {
    const query = rawQuery.trim();
    if (query.startsWith("mark:")) return query.slice("mark:".length).trim();
    if (query.startsWith("label:")) return query.slice("label:".length).trim();
    if (query.startsWith("#")) return query.slice(1).trim();
    return query;
}

function markedEntries(ctx: ExtensionContext): EntryMatch[] {
    return ctx.sessionManager
        .getEntries()
        .filter((entry) => markForEntry(entry, ctx) !== undefined)
        .map((entry) => ({ entry, reason: "mark" }));
}

function findMarkMatches(rawQuery: string, ctx: ExtensionContext): EntryMatch[] {
    const markQuery = normalizeMarkQuery(rawQuery);
    const marked = markedEntries(ctx);
    if (!markQuery) return marked;

    const exactMarks = marked.filter((match) => markForEntry(match.entry, ctx) === markQuery);
    if (exactMarks.length > 0) return exactMarks;

    return marked.filter((match) => markForEntry(match.entry, ctx)?.startsWith(markQuery));
}

function findAnyMatches(rawQuery: string, ctx: ExtensionContext): EntryMatch[] {
    const query = rawQuery.trim();
    if (!query) return [];

    if (query.startsWith("mark:") || query.startsWith("label:") || query.startsWith("#")) {
        return findMarkMatches(query, ctx);
    }

    const entryMatches = findEntryMatches(query, ctx);
    if (entryMatches.length > 0) return entryMatches;

    return findMarkMatches(query, ctx);
}

function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const theme = ctx.ui.theme;
    const session = theme.fg("dim", sessionId);
    const separator = theme.fg("dim", ":");
    const leaf = leafId ? theme.fg("accent", leafId) : theme.fg("warning", "root");
    ctx.ui.setStatus(STATUS_KEY, `${session}${separator}${leaf}`);
}

function formatLookupProgress(loaded?: number, total?: number): string {
    if (loaded === undefined || total === undefined) return "…";
    if (total <= 0) return "[0/0]";
    const percentage = Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
    return `[${loaded}/${total} · ${percentage}%]`;
}

function setJumpProgressStatus(ctx: ExtensionContext, label: string, loaded?: number, total?: number): void {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
        STATUS_KEY,
        `${theme.fg("warning", "jump")} ${theme.fg("dim", label)} ${theme.fg("accent", formatLookupProgress(loaded, total))}`,
    );
}

function clearStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

function clearLegacyWidget(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setWidget(LEGACY_WIDGET_KEY, undefined);
}

async function chooseMatch(
    matches: EntryMatch[],
    ctx: ExtensionCommandContext,
    title = "Jump to tree entry",
): Promise<EntryMatch | undefined> {
    if (matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0];

    if (matches.length > MAX_SELECT_MATCHES) {
        notify(ctx, `Found ${matches.length} matches. Type a longer ID or mark prefix.`, "error");
        return undefined;
    }

    if (!ctx.hasUI) {
        notify(ctx, `Found ${matches.length} matches; refine the prefix.`, "error");
        return undefined;
    }

    const choices = matches.map((match) => formatEntryChoice(match.entry, ctx, match.reason));
    const selected = await ctx.ui.select(title, choices);
    if (!selected) return undefined;
    const selectedId = selected.split(" ", 1)[0];
    return matches.find((match) => match.entry.id === selectedId);
}

function entryCompletions(prefix: string, ctx?: ExtensionContext): CompletionItem[] | null {
    if (!ctx) return null;
    const trimmed = prefix.trim();
    const items: CompletionItem[] = [];

    for (const entry of ctx.sessionManager.getEntries()) {
        if (!entry.id.startsWith(trimmed)) continue;
        const mark = markForEntry(entry, ctx);
        items.push({
            value: entry.id,
            label: mark ? `${entry.id} [${mark}]` : entry.id,
            description: `${entryKind(entry)}${entryPreview(entry) ? ` · ${entryPreview(entry)}` : ""}`,
        });
        if (items.length >= MAX_COMPLETIONS) break;
    }

    return items.length > 0 ? items : null;
}

function markCompletions(prefix: string, ctx?: ExtensionContext): CompletionItem[] | null {
    if (!ctx) return null;
    const markPrefix = normalizeMarkQuery(prefix);
    const items: CompletionItem[] = [];

    for (const match of markedEntries(ctx)) {
        const mark = markForEntry(match.entry, ctx);
        if (!mark || !mark.startsWith(markPrefix)) continue;
        items.push({
            value: mark,
            label: mark,
            description: `${match.entry.id} · ${entryKind(match.entry)}${entryPreview(match.entry) ? ` · ${entryPreview(match.entry)}` : ""}`,
        });
        if (items.length >= MAX_COMPLETIONS) break;
    }

    return items.length > 0 ? items : null;
}

function anyCompletions(prefix: string, ctx?: ExtensionContext): CompletionItem[] | null {
    if (!ctx) return null;

    const entryItems = entryCompletions(prefix, ctx) ?? [];
    const markItems = markCompletions(prefix, ctx) ?? [];
    const items = [...entryItems, ...markItems.map((item) => ({ ...item, value: `mark:${item.value}` }))];
    return items.length > 0 ? items.slice(0, MAX_COMPLETIONS) : null;
}

function parseQualifiedJumpTarget(rawQuery: string): QualifiedJumpTarget | undefined {
    const query = rawQuery.trim();
    const separatorIndex = query.indexOf(":");
    if (separatorIndex <= 0) return undefined;

    return {
        sessionSelector: query.slice(0, separatorIndex).trim(),
        targetSelector: query.slice(separatorIndex + 1).trim(),
    };
}

function formatSessionChoice(target: SessionTarget): string {
    const suffix = [target.current ? "current" : undefined, target.name, target.cwd, target.path]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" · ");
    return suffix ? `${target.id} · ${suffix}` : target.id;
}

async function listKnownSessions(ctx: ExtensionContext): Promise<SessionInfo[]> {
    const byPath = new Map<string, SessionInfo>();
    const addSessions = (sessions: SessionInfo[]): void => {
        for (const session of sessions) byPath.set(session.path, session);
    };

    const scanSessions = async (
        label: string,
        load: (onProgress: (loaded: number, total: number) => void) => Promise<SessionInfo[]>,
    ): Promise<void> => {
        setJumpProgressStatus(ctx, label);
        try {
            addSessions(
                await load((loaded, total) => {
                    setJumpProgressStatus(ctx, label, loaded, total);
                }),
            );
        } catch {
            // Ignore lookup failures; current-session jumps still work.
        }
    };

    await scanSessions("scanning all sessions", (onProgress) => SessionManager.listAll(onProgress));
    await scanSessions("scanning session dir", (onProgress) => SessionManager.listAll(ctx.sessionManager.getSessionDir(), onProgress));
    updateStatus(ctx);

    return [...byPath.values()];
}

async function findSessionTargets(rawSelector: string, ctx: ExtensionContext): Promise<SessionTarget[]> {
    const selector = rawSelector.trim();
    if (!selector) return [];

    const targets = new Map<string, SessionTarget>();
    const addTarget = (target: SessionTarget): void => {
        targets.set(target.path ?? `current:${target.id}`, target);
    };

    const currentId = ctx.sessionManager.getSessionId();
    if (currentId === selector || currentId.startsWith(selector)) {
        addTarget({
            current: true,
            id: currentId,
            name: ctx.sessionManager.getSessionName(),
            path: ctx.sessionManager.getSessionFile(),
            cwd: ctx.cwd,
        });
    }
    if (currentId === selector) return [...targets.values()];

    for (const session of await listKnownSessions(ctx)) {
        if (session.id === selector || session.id.startsWith(selector)) {
            addTarget({
                current: session.id === currentId || session.path === ctx.sessionManager.getSessionFile(),
                cwd: session.cwd,
                id: session.id,
                name: session.name,
                path: session.path,
            });
        }
    }

    const matches = [...targets.values()];
    const exactMatches = matches.filter((target) => target.id === selector);
    return exactMatches.length > 0 ? exactMatches : matches;
}

async function chooseSessionTarget(
    matches: SessionTarget[],
    ctx: ExtensionCommandContext,
    selector: string,
    title = "Choose session",
): Promise<SessionTarget | undefined> {
    if (matches.length === 0) {
        notify(ctx, `No session ID found matching: ${selector}`, "warning");
        return undefined;
    }
    if (matches.length === 1) return matches[0];

    if (matches.length > MAX_SELECT_MATCHES) {
        notify(ctx, `Found ${matches.length} sessions. Type a longer session ID prefix.`, "error");
        return undefined;
    }

    if (!ctx.hasUI) {
        notify(ctx, `Found ${matches.length} sessions; refine the session ID prefix.`, "error");
        return undefined;
    }

    const selected = await ctx.ui.select(title, matches.map(formatSessionChoice));
    if (!selected) return undefined;
    const selectedId = selected.split(" ", 1)[0];
    return matches.find((match) => match.id === selectedId);
}

function targetMatchesInSession(targetSelector: string, ctx: ExtensionContext): EntryMatch[] {
    return findAnyMatches(targetSelector, ctx);
}

function qualifiedJumpCompletions(prefix: string, ctx?: ExtensionContext): CompletionItem[] | null {
    if (!ctx) return null;
    const parsed = parseQualifiedJumpTarget(prefix);
    if (!parsed) return entryCompletions(prefix, ctx);

    const currentSessionId = ctx.sessionManager.getSessionId();
    if (parsed.sessionSelector !== currentSessionId && !currentSessionId.startsWith(parsed.sessionSelector)) {
        return null;
    }

    const entryItems = entryCompletions(parsed.targetSelector, ctx) ?? [];
    const markItems = markCompletions(parsed.targetSelector, ctx) ?? [];
    const innerItems = [...entryItems, ...markItems];
    const sessionPrefix = `${currentSessionId}:`;
    return innerItems.slice(0, MAX_COMPLETIONS).map((item) => ({
        ...item,
        value: `${sessionPrefix}${item.value}`,
    }));
}

async function jumpToQualifiedTarget(parsed: QualifiedJumpTarget, ctx: ExtensionCommandContext): Promise<void> {
    if (!parsed.targetSelector) {
        notify(ctx, "Usage: /jump <session-id>:<entry-id-or-mark>", "warning");
        return;
    }

    const sessionTarget = await chooseSessionTarget(
        await findSessionTargets(parsed.sessionSelector, ctx),
        ctx,
        parsed.sessionSelector,
    );
    if (!sessionTarget) return;

    const jumpInsideSession = async (targetCtx: ExtensionCommandContext): Promise<void> => {
        const matches = targetMatchesInSession(parsed.targetSelector, targetCtx);
        if (matches.length === 0) {
            updateStatus(targetCtx);
            notify(targetCtx, `No entry ID or mark found matching: ${parsed.targetSelector}`, "warning");
            return;
        }

        const match = await chooseMatch(matches, targetCtx, "Jump to session tree entry or mark");
        if (match) {
            await navigateToMatch(match, targetCtx);
        } else {
            updateStatus(targetCtx);
        }
    };

    const currentSessionId = ctx.sessionManager.getSessionId();
    const currentSessionFile = ctx.sessionManager.getSessionFile();
    const isCurrentSession = sessionTarget.current
        || sessionTarget.id === currentSessionId
        || (sessionTarget.path !== undefined && sessionTarget.path === currentSessionFile);

    if (isCurrentSession) {
        await jumpInsideSession(ctx);
        return;
    }

    if (!sessionTarget.path) {
        notify(ctx, `Session ${sessionTarget.id} has no file path to open`, "error");
        return;
    }

    setJumpProgressStatus(ctx, `switching to ${sessionTarget.id}`);
    const result = await ctx.switchSession(sessionTarget.path, {
        withSession: jumpInsideSession,
    });
    if (result.cancelled) {
        updateStatus(ctx);
        notify(ctx, `Switch to session ${sessionTarget.id} cancelled`, "warning");
    }
}

async function navigateToMatch(match: EntryMatch, ctx: ExtensionCommandContext): Promise<void> {
    const oldLeafId = ctx.sessionManager.getLeafId();
    const mark = markForEntry(match.entry, ctx);
    const target = match.reason === "mark" && mark ? `${mark} (${match.entry.id})` : match.entry.id;

    if (oldLeafId === match.entry.id) {
        updateStatus(ctx);
        notify(ctx, `Already at ${target}`, "info");
        return;
    }

    const result = await ctx.navigateTree(match.entry.id, { summarize: false });
    if (result.cancelled) {
        notify(ctx, "Jump cancelled", "warning");
        return;
    }

    updateStatus(ctx);
    notify(ctx, `Jumped to ${target}`, "info");
}

export default function piJumpTree(pi: ExtensionAPI): void {
    let latestContext: ExtensionContext | undefined;

    function rememberContext(ctx: ExtensionContext): void {
        latestContext = ctx;
        clearLegacyWidget(ctx);
        updateStatus(ctx);
    }

    pi.on("session_start", async (_event, ctx) => rememberContext(ctx));
    pi.on("message_end", async (_event, ctx) => rememberContext(ctx));
    pi.on("session_tree", async (_event, ctx) => rememberContext(ctx));
    pi.on("session_compact", async (_event, ctx) => rememberContext(ctx));
    pi.on("session_shutdown", async (_event, ctx) => {
        latestContext = undefined;
        clearStatus(ctx);
        clearLegacyWidget(ctx);
    });

    pi.registerCommand("jump", {
        description: "Jump to an entry by ID, or <session-id>:<entry-id-or-mark>",
        getArgumentCompletions: (prefix) => qualifiedJumpCompletions(prefix, latestContext),
        handler: async (args, ctx) => {
            const query = args.trim();
            if (!query) {
                notify(ctx, "Usage: /jump <entry-id-prefix> or /jump <session-id>:<entry-id-or-mark>", "warning");
                return;
            }

            const qualifiedTarget = parseQualifiedJumpTarget(query);
            if (qualifiedTarget) {
                await jumpToQualifiedTarget(qualifiedTarget, ctx);
                return;
            }

            const matches = findEntryMatches(query, ctx);
            if (matches.length === 0) {
                notify(ctx, `No entry ID found matching: ${query}`, "warning");
                return;
            }

            const match = await chooseMatch(matches, ctx);
            if (match) await navigateToMatch(match, ctx);
        },
    });

    pi.registerCommand("jump-to-mark", {
        description: "Jump to a marked session tree entry",
        getArgumentCompletions: (prefix) => markCompletions(prefix, latestContext),
        handler: async (args, ctx) => {
            const query = args.trim();
            const matches = findMarkMatches(query, ctx);

            if (matches.length === 0) {
                notify(ctx, query ? `No mark found matching: ${query}` : "No marks found in this session", "warning");
                return;
            }

            const match = await chooseMatch(matches, ctx, "Jump to mark");
            if (match) await navigateToMatch(match, ctx);
        },
    });

    pi.registerCommand("mark-leaf", {
        description: "Mark/bookmark the current leaf (usage: /mark-leaf [mark])",
        handler: async (args, ctx) => {
            const leafId = ctx.sessionManager.getLeafId();
            if (!leafId) {
                notify(ctx, "No leaf to mark yet", "warning");
                return;
            }

            const mark = args.trim() || `leaf-${leafId}`;
            pi.setLabel(leafId, mark);
            updateStatus(ctx);
            notify(ctx, `Marked ${leafId} as ${mark}. Jump with /jump-to-mark ${mark} or /jump ${ctx.sessionManager.getSessionId()}:${mark}`, "info");
        },
    });

    pi.registerCommand("unmark-leaf", {
        description: "Remove mark/bookmark from the current leaf",
        handler: async (_args, ctx) => {
            const leafId = ctx.sessionManager.getLeafId();
            if (!leafId) {
                notify(ctx, "No current leaf", "warning");
                return;
            }

            const mark = ctx.sessionManager.getLabel(leafId);
            if (!mark) {
                notify(ctx, `Current leaf ${leafId} has no mark`, "info");
                return;
            }

            pi.setLabel(leafId, undefined);
            updateStatus(ctx);
            notify(ctx, `Removed mark: ${mark}`, "info");
        },
    });

    pi.registerCommand("unmark", {
        description: "Remove mark/bookmark by entry ID prefix or mark",
        getArgumentCompletions: (prefix) => anyCompletions(prefix, latestContext),
        handler: async (args, ctx) => {
            const query = args.trim();
            if (!query) {
                const leafId = ctx.sessionManager.getLeafId();
                if (!leafId) {
                    notify(ctx, "Usage: /unmark <entry-id-prefix | mark | mark:<mark> | #<mark>>", "warning");
                    return;
                }

                const mark = ctx.sessionManager.getLabel(leafId);
                if (!mark) {
                    notify(ctx, `Current leaf ${leafId} has no mark`, "info");
                    return;
                }

                pi.setLabel(leafId, undefined);
                notify(ctx, `Removed mark: ${mark}`, "info");
                return;
            }

            const matches = findAnyMatches(query, ctx);
            if (matches.length === 0) {
                notify(ctx, `No entry or mark found matching: ${query}`, "warning");
                return;
            }

            const match = await chooseMatch(matches, ctx, "Remove mark");
            if (!match) return;

            const mark = ctx.sessionManager.getLabel(match.entry.id);
            if (!mark) {
                notify(ctx, `Entry ${match.entry.id} has no mark`, "info");
                return;
            }

            pi.setLabel(match.entry.id, undefined);
            notify(ctx, `Removed mark: ${mark}`, "info");
        },
    });
}
