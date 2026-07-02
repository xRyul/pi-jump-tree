import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    getAgentDir,
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
const STARTUP_JUMP_FLAG = "jump";
const SESSION_VALUE_FLAGS = new Set(["--session", "--fork", "--session-id"]);
const SESSION_BOOLEAN_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--no-session"]);
const RUNTIME_REGISTRY_SCHEMA_VERSION = 1;
const RUNTIME_REGISTRY_DIR = join(getAgentDir(), "logs", "pi-jump-tree", "runtime");
const RUNTIME_INSTANCES_DIR = join(RUNTIME_REGISTRY_DIR, "instances");
const RUNTIME_BY_TTY_DIR = join(RUNTIME_REGISTRY_DIR, "by-tty");
const REGISTRY_REFRESH_DEBOUNCE_MS = 25;
const POST_SESSION_WRITE_REFRESH_DELAYS_MS = [0, 50, 250, 1000] as const;

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

interface RuntimeInstanceRegistryEntry {
    schemaVersion: typeof RUNTIME_REGISTRY_SCHEMA_VERSION;
    pid: number;
    tty?: string;
    cwd: string;
    sessionId: string;
    leafId: string | null;
    sessionFile: string | null;
    sessionName?: string;
    jumpTarget?: string;
    jumpCommand?: string;
    updatedAt: string;
}

interface RuntimeRegistryPaths {
    instancePath: string;
    byTtyPath?: string;
}

interface RuntimeRegistryWriteResult {
    paths: RuntimeRegistryPaths;
    signature: string;
}

let detectedTtyName: string | null | undefined;

function normalizeTtyName(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;

    const trimmed = value.trim();
    if (!trimmed || trimmed === "not a tty" || trimmed === "??") return undefined;

    if (trimmed.startsWith("/dev/")) return trimmed;
    if (trimmed.startsWith("tty") || trimmed.startsWith("pts/")) return `/dev/${trimmed}`;
    return trimmed;
}

function detectTtyNameWithFd(fd: number): string | undefined {
    try {
        const result = spawnSync("tty", [], {
            encoding: "utf8",
            stdio: [fd, "pipe", "ignore"],
            timeout: 1000,
        });
        if (result.status !== 0) return undefined;
        return normalizeTtyName(result.stdout);
    } catch {
        return undefined;
    }
}

function detectTtyName(): string | undefined {
    if (detectedTtyName !== undefined) return detectedTtyName ?? undefined;

    detectedTtyName = normalizeTtyName(process.env.TTY)
        ?? detectTtyNameWithFd(0)
        ?? detectTtyNameWithFd(1)
        ?? detectTtyNameWithFd(2)
        ?? null;

    return detectedTtyName ?? undefined;
}

function sanitizeRegistryKey(value: string): string {
    const withoutDevicePrefix = value.trim().replace(/^\/dev\//, "");
    const sanitized = withoutDevicePrefix
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized || "unknown";
}

function runtimeRegistryPathsFor(tty = detectTtyName()): RuntimeRegistryPaths {
    return {
        instancePath: join(RUNTIME_INSTANCES_DIR, `${process.pid}.json`),
        byTtyPath: tty ? join(RUNTIME_BY_TTY_DIR, `${sanitizeRegistryKey(tty)}.json`) : undefined,
    };
}

function buildRuntimeRegistryEntry(
    ctx: ExtensionContext,
    knownSessionName?: string | null,
    updatedAt = new Date().toISOString(),
): RuntimeInstanceRegistryEntry {
    const tty = detectTtyName();
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId() ?? null;
    const jumpTarget = leafId ? `${sessionId}:${leafId}` : undefined;
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const sessionName = knownSessionName === undefined
        ? ctx.sessionManager.getSessionName()
        : knownSessionName ?? undefined;

    return {
        schemaVersion: RUNTIME_REGISTRY_SCHEMA_VERSION,
        pid: process.pid,
        ...(tty ? { tty } : {}),
        cwd: ctx.cwd,
        sessionId,
        leafId,
        sessionFile,
        ...(sessionName ? { sessionName } : {}),
        ...(jumpTarget ? { jumpTarget, jumpCommand: `pi --jump ${jumpTarget}` } : {}),
        updatedAt,
    };
}

function runtimeRegistrySignature(entry: RuntimeInstanceRegistryEntry): string {
    return JSON.stringify({
        schemaVersion: entry.schemaVersion,
        pid: entry.pid,
        tty: entry.tty ?? null,
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        leafId: entry.leafId,
        sessionFile: entry.sessionFile,
        sessionName: entry.sessionName ?? null,
        jumpTarget: entry.jumpTarget ?? null,
        jumpCommand: entry.jumpCommand ?? null,
    });
}

let atomicWriteCounter = 0;

async function writeJsonAtomically(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const nonce = `${process.pid}.${Date.now()}.${++atomicWriteCounter}`;
    const temporaryPath = `${path}.${nonce}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
}

async function writeRuntimeRegistry(
    ctx: ExtensionContext,
    previousSignature?: string,
    knownSessionName?: string | null,
): Promise<RuntimeRegistryWriteResult> {
    const entry = buildRuntimeRegistryEntry(ctx, knownSessionName);
    const signature = runtimeRegistrySignature(entry);
    const paths = runtimeRegistryPathsFor(entry.tty);

    if (signature === previousSignature) return { paths, signature };

    await writeJsonAtomically(paths.instancePath, entry);
    if (paths.byTtyPath) await writeJsonAtomically(paths.byTtyPath, entry);

    return { paths, signature };
}

async function readRuntimeRegistryEntry(path: string): Promise<RuntimeInstanceRegistryEntry | undefined> {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RuntimeInstanceRegistryEntry>;
        return typeof parsed.pid === "number" ? parsed as RuntimeInstanceRegistryEntry : undefined;
    } catch {
        return undefined;
    }
}

async function removeByTtyRegistryIfOwned(path: string): Promise<void> {
    const current = await readRuntimeRegistryEntry(path);
    if (!current || current.pid === process.pid) await rm(path, { force: true });
}

async function removeRuntimeRegistry(paths: RuntimeRegistryPaths): Promise<void> {
    await rm(paths.instancePath, { force: true });
    if (paths.byTtyPath) await removeByTtyRegistryIfOwned(paths.byTtyPath);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === code;
}

async function readRegistryDirectory(path: string): Promise<string[]> {
    try {
        return await readdir(path);
    } catch (error) {
        if (hasNodeErrorCode(error, "ENOENT")) return [];
        throw error;
    }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return hasNodeErrorCode(error, "EPERM");
    }
}

async function cleanupStaleInstanceRegistries(): Promise<void> {
    const files = await readRegistryDirectory(RUNTIME_INSTANCES_DIR);

    await Promise.all(files.map(async (file) => {
        const match = /^(\d+)\.json$/.exec(file);
        if (!match) return;

        const pid = Number(match[1]);
        if (pid === process.pid || isProcessAlive(pid)) return;

        await rm(join(RUNTIME_INSTANCES_DIR, file), { force: true });
    }));
}

async function cleanupStaleByTtyRegistries(): Promise<void> {
    const files = await readRegistryDirectory(RUNTIME_BY_TTY_DIR);

    await Promise.all(files.map(async (file) => {
        if (!file.endsWith(".json")) return;

        const path = join(RUNTIME_BY_TTY_DIR, file);
        const entry = await readRuntimeRegistryEntry(path);
        if (!entry || entry.pid === process.pid || isProcessAlive(entry.pid)) return;

        await rm(path, { force: true });
    }));
}

async function cleanupStaleRuntimeRegistry(): Promise<void> {
    await Promise.all([
        cleanupStaleInstanceRegistries(),
        cleanupStaleByTtyRegistries(),
    ]);
}

function logRuntimeRegistryError(action: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-jump-tree] Failed to ${action} runtime registry: ${message}`);
}

function notify(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
}

function stripTerminalArtifacts(value: string): string {
    return value
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\x00-\x1f\x7f]+/g, "")
        .trim();
}

function sessionIdMatchKey(value: string): string {
    return stripTerminalArtifacts(value).replace(/-/g, "").toLowerCase();
}

function sessionIdMatches(id: string, selector: string): boolean {
    const cleanedSelector = stripTerminalArtifacts(selector);
    if (!cleanedSelector) return false;
    if (id === cleanedSelector || id.startsWith(cleanedSelector)) return true;

    const idKey = sessionIdMatchKey(id);
    const selectorKey = sessionIdMatchKey(cleanedSelector);
    return selectorKey.length > 0 && idKey.startsWith(selectorKey);
}

function sessionIdEquals(id: string, selector: string): boolean {
    const cleanedSelector = stripTerminalArtifacts(selector);
    return id === cleanedSelector || sessionIdMatchKey(id) === sessionIdMatchKey(cleanedSelector);
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
            return stripForOneLine("content" in entry.message ? stringifyContent(entry.message.content) : "");
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
    const query = stripTerminalArtifacts(rawQuery);
    if (!query) return [];

    const entries = ctx.sessionManager.getEntries();
    const exactIds = entries.filter((entry) => entry.id === query);
    if (exactIds.length > 0) return exactIds.map((entry) => ({ entry, reason: "id" }));

    return entries
        .filter((entry) => entry.id.startsWith(query))
        .map((entry) => ({ entry, reason: "id" }));
}

function normalizeMarkQuery(rawQuery: string): string {
    const query = stripTerminalArtifacts(rawQuery);
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
    const query = stripTerminalArtifacts(rawQuery);
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
    const query = stripTerminalArtifacts(rawQuery);
    const separatorIndex = query.indexOf(":");
    if (separatorIndex <= 0) return undefined;

    return {
        sessionSelector: stripTerminalArtifacts(query.slice(0, separatorIndex)),
        targetSelector: stripTerminalArtifacts(query.slice(separatorIndex + 1)),
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
    const selector = stripTerminalArtifacts(rawSelector);
    if (!selector) return [];

    const targets = new Map<string, SessionTarget>();
    const addTarget = (target: SessionTarget): void => {
        targets.set(target.path ?? `current:${target.id}`, target);
    };

    const currentId = ctx.sessionManager.getSessionId();
    if (sessionIdMatches(currentId, selector)) {
        addTarget({
            current: true,
            id: currentId,
            name: ctx.sessionManager.getSessionName(),
            path: ctx.sessionManager.getSessionFile(),
            cwd: ctx.cwd,
        });
    }
    if (sessionIdEquals(currentId, selector)) return [...targets.values()];

    for (const session of await listKnownSessions(ctx)) {
        if (sessionIdMatches(session.id, selector)) {
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
    const exactMatches = matches.filter((target) => sessionIdEquals(target.id, selector));
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

    const jumpInsideSession = async (
        targetCtx: ExtensionCommandContext,
        options: { reloadFromFileOnMiss?: boolean } = {},
    ): Promise<void> => {
        const matches = targetMatchesInSession(parsed.targetSelector, targetCtx);
        if (matches.length === 0) {
            const reloadPath = sessionTarget.path ?? targetCtx.sessionManager.getSessionFile();
            if (options.reloadFromFileOnMiss && reloadPath) {
                setJumpProgressStatus(targetCtx, `reloading ${sessionTarget.id}`);
                const result = await targetCtx.switchSession(reloadPath, {
                    withSession: async (reloadedCtx) => {
                        await jumpInsideSession(reloadedCtx, { reloadFromFileOnMiss: false });
                    },
                });

                if (result.cancelled) {
                    updateStatus(targetCtx);
                    notify(targetCtx, `Reload of session ${sessionTarget.id} cancelled`, "warning");
                }
                return;
            }

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
        await jumpInsideSession(ctx, { reloadFromFileOnMiss: true });
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

function failStartupJump(message: string): never {
    console.error(`[pi-jump-tree] ${message}`);
    process.exit(1);
}

function getStartupJumpValue(pi: ExtensionAPI): string | undefined {
    const value = pi.getFlag(STARTUP_JUMP_FLAG);
    if (value === undefined || value === false) return undefined;

    if (typeof value !== "string" || value.trim().length === 0) {
        failStartupJump("Usage: pi --jump <session-id>:<entry-id-or-mark>");
    }

    return value.trim();
}

function stripStartupJumpRelaunchArgs(args: string[]): string[] {
    const result: string[] = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (!arg) continue;

        if (arg === `--${STARTUP_JUMP_FLAG}`) {
            index++;
            continue;
        }

        if (arg.startsWith(`--${STARTUP_JUMP_FLAG}=`)) continue;

        if (SESSION_VALUE_FLAGS.has(arg)) {
            index++;
            continue;
        }

        if ([...SESSION_VALUE_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) continue;
        if (SESSION_BOOLEAN_FLAGS.has(arg)) continue;

        result.push(arg);
    }

    return result;
}

function chooseStartupSessionTarget(matches: SessionTarget[], selector: string): SessionTarget | undefined {
    const exactMatches = matches.filter((target) => target.id === selector);
    const candidates = exactMatches.length > 0 ? exactMatches : matches;
    return candidates.length === 1 ? candidates[0] : undefined;
}

function formatStartupSessionMatches(matches: SessionTarget[]): string {
    return matches
        .slice(0, 10)
        .map((match) => `  ${formatSessionChoice(match)}`)
        .join("\n");
}

function relaunchPiForStartupJump(sessionTarget: SessionTarget, parsed: QualifiedJumpTarget): never {
    if (!sessionTarget.path) {
        failStartupJump(`Session ${sessionTarget.id} has no file path to open`);
    }

    const jumpTarget = `${sessionTarget.id}:${parsed.targetSelector}`;
    const passthroughArgs = stripStartupJumpRelaunchArgs(process.argv.slice(2));
    const childCliArgs = ["--session", sessionTarget.path, `/jump ${jumpTarget}`, ...passthroughArgs];
    const executable = process.argv[0];
    const script = process.argv[1];
    const childArgs = script ? [script, ...childCliArgs] : childCliArgs;

    const result = spawnSync(executable, childArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
    });

    if (result.error) {
        failStartupJump(`Failed to launch target session: ${result.error.message}`);
    }

    if (result.signal) {
        failStartupJump(`Target session exited from signal ${result.signal}`);
    }

    process.exit(result.status ?? 0);
}

async function handleStartupJumpFlag(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const rawTarget = getStartupJumpValue(pi);
    if (!rawTarget) return;

    const parsed = parseQualifiedJumpTarget(rawTarget);
    if (!parsed || !parsed.targetSelector) {
        failStartupJump("Usage: pi --jump <session-id>:<entry-id-or-mark>");
    }

    setJumpProgressStatus(ctx, `opening ${parsed.sessionSelector}`);
    const matches = await findSessionTargets(parsed.sessionSelector, ctx);
    const sessionTarget = chooseStartupSessionTarget(matches, parsed.sessionSelector);

    if (!sessionTarget) {
        const suffix = matches.length > 0 ? `\nMatches:\n${formatStartupSessionMatches(matches)}` : "";
        failStartupJump(`No unique session ID found matching: ${parsed.sessionSelector}${suffix}`);
    }

    relaunchPiForStartupJump(sessionTarget, parsed);
}

export default function piJumpTree(pi: ExtensionAPI): void {
    let latestContext: ExtensionContext | undefined;
    let latestRegistryPaths: RuntimeRegistryPaths | undefined;
    let latestRegistrySignature: string | undefined;
    let latestSessionName: string | undefined;
    let pendingRegistryContext: ExtensionContext | undefined;
    let pendingRegistryTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingPostSessionWriteContext: ExtensionContext | undefined;
    const postSessionWriteTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let registryWriteQueue: Promise<void> = Promise.resolve();
    let sessionGeneration = 0;
    let staleCleanupStarted = false;

    function applyContext(ctx: ExtensionContext): void {
        latestContext = ctx;
        clearLegacyWidget(ctx);
        updateStatus(ctx);
    }

    function enqueueRegistryWrite(ctx: ExtensionContext, generation = sessionGeneration): Promise<void> {
        registryWriteQueue = registryWriteQueue
            .catch(() => undefined)
            .then(async () => {
                if (generation !== sessionGeneration) return;

                try {
                    const result = await writeRuntimeRegistry(
                        ctx,
                        latestRegistrySignature,
                        latestSessionName ?? null,
                    );
                    if (generation !== sessionGeneration) return;

                    latestRegistryPaths = result.paths;
                    latestRegistrySignature = result.signature;
                } catch (error) {
                    logRuntimeRegistryError("write", error);
                }
            });

        return registryWriteQueue;
    }

    function cancelPendingRegistryWrite(): void {
        if (pendingRegistryTimer) {
            clearTimeout(pendingRegistryTimer);
            pendingRegistryTimer = undefined;
        }
        pendingRegistryContext = undefined;
    }

    function cancelPostSessionWriteRefreshes(): void {
        for (const timer of postSessionWriteTimers.values()) clearTimeout(timer);
        postSessionWriteTimers.clear();
        pendingPostSessionWriteContext = undefined;
    }

    function scheduleRegistryWrite(ctx: ExtensionContext): void {
        pendingRegistryContext = ctx;
        if (pendingRegistryTimer) return;

        const generation = sessionGeneration;
        pendingRegistryTimer = setTimeout(() => {
            pendingRegistryTimer = undefined;
            const nextContext = pendingRegistryContext;
            pendingRegistryContext = undefined;

            if (!nextContext || generation !== sessionGeneration) return;
            void enqueueRegistryWrite(nextContext, generation);
        }, REGISTRY_REFRESH_DEBOUNCE_MS);
    }

    async function rememberContext(
        ctx: ExtensionContext,
        options: { immediate?: boolean } = {},
    ): Promise<void> {
        applyContext(ctx);

        if (options.immediate) {
            cancelPendingRegistryWrite();
            await enqueueRegistryWrite(ctx);
            return;
        }

        scheduleRegistryWrite(ctx);
    }

    function rememberContextAfterSessionWrite(ctx: ExtensionContext): void {
        pendingPostSessionWriteContext = ctx;
        const generation = sessionGeneration;

        // SessionManager appends messages after extension message_end handlers run.
        // Keep one timer per delay and reset it on newer activity, so busy turns
        // converge to one delayed refresh sequence instead of one sequence per event.
        for (const delayMs of POST_SESSION_WRITE_REFRESH_DELAYS_MS) {
            const existingTimer = postSessionWriteTimers.get(delayMs);
            if (existingTimer) clearTimeout(existingTimer);

            const timer = setTimeout(() => {
                if (postSessionWriteTimers.get(delayMs) === timer) {
                    postSessionWriteTimers.delete(delayMs);
                }

                const nextContext = pendingPostSessionWriteContext;
                if (postSessionWriteTimers.size === 0) pendingPostSessionWriteContext = undefined;

                if (!nextContext || generation !== sessionGeneration) return;
                void rememberContext(nextContext);
            }, delayMs);

            postSessionWriteTimers.set(delayMs, timer);
        }
    }

    function startStaleRegistryCleanup(): void {
        if (staleCleanupStarted) return;
        staleCleanupStarted = true;

        void cleanupStaleRuntimeRegistry().catch((error) => {
            logRuntimeRegistryError("clean stale", error);
        });
    }

    pi.registerFlag(STARTUP_JUMP_FLAG, {
        description: "Open <session-id>:<entry-id-or-mark> at startup",
        type: "string",
    });

    pi.on("session_start", async (event, ctx) => {
        sessionGeneration++;
        latestSessionName = ctx.sessionManager.getSessionName();
        if (event.reason === "startup") await handleStartupJumpFlag(pi, ctx);
        await rememberContext(ctx, { immediate: true });
        startStaleRegistryCleanup();
    });
    pi.on("message_end", async (_event, ctx) => {
        rememberContextAfterSessionWrite(ctx);
    });
    pi.on("turn_end", async (_event, ctx) => {
        await rememberContext(ctx);
        rememberContextAfterSessionWrite(ctx);
    });
    pi.on("agent_end", async (_event, ctx) => {
        await rememberContext(ctx);
        rememberContextAfterSessionWrite(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => rememberContext(ctx, { immediate: true }));
    pi.on("session_compact", async (_event, ctx) => rememberContext(ctx, { immediate: true }));
    pi.on("session_info_changed", async (event, ctx) => {
        latestSessionName = event.name;
        await rememberContext(ctx, { immediate: true });
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        sessionGeneration++;
        latestContext = undefined;
        latestSessionName = undefined;
        cancelPendingRegistryWrite();
        cancelPostSessionWriteRefreshes();
        clearStatus(ctx);
        clearLegacyWidget(ctx);

        try {
            await registryWriteQueue.catch(() => undefined);
            await removeRuntimeRegistry(latestRegistryPaths ?? runtimeRegistryPathsFor());
        } catch (error) {
            logRuntimeRegistryError("remove", error);
        } finally {
            latestRegistryPaths = undefined;
            latestRegistrySignature = undefined;
        }
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
