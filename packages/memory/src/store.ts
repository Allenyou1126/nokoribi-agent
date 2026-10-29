import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Service, type Context } from "@deepseek-ai/cordis";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { isNodeError, STATE_DIR_MODE, STATE_FILE_MODE } from "@nokoribi/shared";

import type { MemoryConfidence, MemoryEntry } from "./frontmatter.js";
import {
    DEFAULT_CONFIDENCE,
    DEFAULT_PINNED,
    normalizeBody,
    serializeMemoryFile,
    tryParseMemoryFile,
} from "./frontmatter.js";
import { assertNoSecrets } from "./secret.js";

/** Directory under `root` that holds active entries. */
export const ENTRIES_DIR_NAME: string = "entries";

/** Directory under `root` that holds archived entries. */
export const ARCHIVE_DIR_NAME: string = "archive";

/** Suffix of one memory entry file. */
export const MEMORY_FILE_SUFFIX: string = ".md";

/** Default number of search hits when the caller does not set a limit. */
export const DEFAULT_SEARCH_LIMIT: number = 10;

/** Upper bound for one search result page. */
export const MAX_SEARCH_LIMIT: number = 50;

/** Maximum accepted body size in UTF-8 bytes. */
export const MAX_MEMORY_BODY_BYTES: number = 64 * 1024;

/** Maximum accepted title size in UTF-8 bytes. */
export const MAX_MEMORY_TITLE_BYTES: number = 200;

/** Minimum tags per entry. */
export const MIN_MEMORY_TAGS: number = 1;

/** Maximum tags per entry. */
export const MAX_MEMORY_TAGS: number = 20;

/** Ids must be safe single-segment file names. */
export const MEMORY_ID_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Retrieval tags follow the `namespace:value` convention. */
export const MEMORY_TAG_PATTERN: RegExp =
    /^[A-Za-z0-9][A-Za-z0-9._-]*:[^\s:]+$/;

/** Configuration accepted by the memory plugin and service. */
export interface MemoryServiceConfig {
    /** Directory holding `entries/` and `archive/`. */
    readonly root: string;
    /** Default search page size, clamped to 1..50 (default 10). */
    readonly defaultLimit?: number | undefined;
}

/** Filters accepted by {@link MemoryService.search}. */
export interface MemorySearchOptions {
    /** Case-insensitive keywords matched against title, tags, and body. */
    readonly query?: string | undefined;
    /** Tags that must all be present on a candidate entry. */
    readonly tags?: readonly string[] | undefined;
    /** Page size; defaults to the configured limit and is capped at 50. */
    readonly limit?: number | undefined;
}

/** Fields accepted by {@link MemoryService.write}. */
export interface MemoryWriteInput {
    /** Existing active id to update; omit to create a new entry. */
    readonly id?: string | undefined;
    /** Short retrieval title, at most 200 UTF-8 bytes. */
    readonly title: string;
    /** One to twenty `namespace:value` tags. */
    readonly tags: readonly string[];
    /** Markdown body, at most 64 KiB. */
    readonly body: string;
    /** Optional provenance such as `session:<sessionId>#turn-12`. */
    readonly source?: string | undefined;
    /** Trust level; defaults to `medium` for new entries. */
    readonly confidence?: MemoryConfidence | undefined;
    /** Whether the entry is pinned for automatic snapshot injection. */
    readonly pinned?: boolean | undefined;
    /** Active ids this entry replaces; they are archived on write. */
    readonly supersedes?: string | readonly string[] | undefined;
}

/** Store counters reported by {@link MemoryService.stats}. */
export interface MemoryStats {
    /** Searchable entries under `entries/`. */
    readonly active: number;
    /** Entries moved to `archive/` by `forget` or `supersedes`. */
    readonly archived: number;
    /** Files under either directory that failed to parse as entries. */
    readonly invalid: number;
    /** Total bytes of every `.md` file under either directory. */
    readonly bytes: number;
    /** Active entries pinned for automatic snapshot injection (M16). */
    readonly pinned: number;
}

/** Observation of the M16 automatic snapshot reported by `/status full`. */
export interface MemoryRuntimeStatus {
    /** Whether automatic snapshot injection is configured on. */
    readonly enabled: boolean;
    /** Characters of the snapshot frozen for the latest turn. */
    readonly snapshotChars: number;
}

/** One write after validation but before it reaches the commit chain. */
interface NormalizedWrite {
    readonly id: string | undefined;
    readonly title: string;
    readonly tags: readonly string[];
    readonly body: string;
    readonly source: string | undefined;
    readonly confidence: MemoryConfidence | undefined;
    readonly pinned: boolean | undefined;
    readonly supersedes: readonly string[] | undefined;
}

/** One search candidate during ranking. */
interface ScoredEntry {
    readonly entry: MemoryEntry;
    readonly score: number;
}

/** Result of scanning one entry directory. */
interface DirectoryScan {
    readonly entries: readonly MemoryEntry[];
    readonly invalid: number;
    readonly bytes: number;
}

declare module "@deepseek-ai/cordis" {
    interface Context {
        /** Global Markdown memory store registered by the memory plugin. */
        memory: MemoryService;
    }
}

/** Pad one date component to two digits. */
function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/**
 * Generate one candidate memory id of the form
 * `mem-YYYYMMDD-HHMMSS-<hex>` (UTC timestamp, six random hex digits).
 * @param now - clock value, injectable for tests.
 * @returns a candidate id that still needs an existence check.
 */
export function generateMemoryId(now: Date = new Date()): string {
    const date =
        `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}` +
        `${pad(now.getUTCDate())}`;
    const time =
        `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}` +
        `${pad(now.getUTCSeconds())}`;
    return `mem-${date}-${time}-${randomBytes(3).toString("hex")}`;
}

/** Validate and trim one entry id. */
function normalizeEntryId(id: string): string {
    const value = id.trim();
    if (!MEMORY_ID_PATTERN.test(value)) {
        throw new Error(
            `invalid memory id "${id}": expected 1-128 letters, digits, ` +
                `dots, underscores or dashes starting with a letter or digit`
        );
    }
    return value;
}

/** Validate and deduplicate write tags. */
function normalizeTags(tags: readonly string[]): readonly string[] {
    const unique: string[] = [];
    for (const raw of tags) {
        const tag = raw.trim();
        if (!MEMORY_TAG_PATTERN.test(tag)) {
            throw new Error(
                `invalid memory tag "${raw}": expected namespace:value`
            );
        }
        if (!unique.includes(tag)) unique.push(tag);
    }
    if (unique.length < MIN_MEMORY_TAGS || unique.length > MAX_MEMORY_TAGS) {
        throw new Error(
            `memory write requires between ${String(MIN_MEMORY_TAGS)} and ` +
                `${String(MAX_MEMORY_TAGS)} tags (got ${String(unique.length)})`
        );
    }
    return unique;
}

/** Validate and normalize an optional source reference. */
function normalizeSource(source: string | undefined): string | undefined {
    if (source === undefined) return undefined;
    const value = source.trim();
    return value === "" ? undefined : value;
}

/** Validate an optional confidence level. */
function normalizeConfidence(
    confidence: MemoryConfidence | undefined
): MemoryConfidence | undefined {
    if (confidence === undefined) return undefined;
    if (
        confidence !== "high" &&
        confidence !== "medium" &&
        confidence !== "low"
    ) {
        throw new Error(
            `invalid memory confidence "${String(confidence)}": ` +
                "expected high, medium or low"
        );
    }
    return confidence;
}

/** Validate an optional pinned flag. */
function normalizePinned(pinned: boolean | undefined): boolean | undefined {
    if (pinned === undefined) return undefined;
    if (typeof pinned !== "boolean") {
        throw new Error(
            `invalid memory pinned value "${String(pinned)}": ` +
                "expected a boolean"
        );
    }
    return pinned;
}

/** Validate and deduplicate the ids a write supersedes. */
function normalizeSupersedes(
    supersedes: string | readonly string[] | undefined,
    ownId: string | undefined
): readonly string[] | undefined {
    if (supersedes === undefined) return undefined;
    const raw = typeof supersedes === "string" ? [supersedes] : supersedes;
    const ids: string[] = [];
    for (const candidate of raw) {
        const id = normalizeEntryId(candidate);
        if (id === ownId) {
            throw new Error("a memory entry cannot supersede itself");
        }
        if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

/**
 * Validate one write and check the title, tags, source, and body for secrets.
 * @param input - caller write input.
 * @returns the validated write ready for the commit chain.
 * @throws when a size, tag, id, confidence, or secret rule is violated.
 */
function normalizeWrite(input: MemoryWriteInput): NormalizedWrite {
    const id = input.id === undefined ? undefined : normalizeEntryId(input.id);
    const title = input.title.trim();
    if (title === "") throw new Error("memory title must not be empty");
    if (Buffer.byteLength(title, "utf8") > MAX_MEMORY_TITLE_BYTES) {
        throw new Error(
            `memory title exceeds ${String(MAX_MEMORY_TITLE_BYTES)} bytes`
        );
    }
    const tags = normalizeTags(input.tags);
    if (Buffer.byteLength(input.body, "utf8") > MAX_MEMORY_BODY_BYTES) {
        throw new Error(
            `memory body exceeds ${String(MAX_MEMORY_BODY_BYTES)} bytes`
        );
    }
    const body = normalizeBody(input.body);
    const source = normalizeSource(input.source);
    const confidence = normalizeConfidence(input.confidence);
    const pinned = normalizePinned(input.pinned);
    const supersedes = normalizeSupersedes(input.supersedes, id);
    assertNoSecrets(
        [title, tags.join(" "), source ?? "", body].join("\n"),
        "memory entry"
    );
    return { id, title, tags, body, source, confidence, pinned, supersedes };
}

/** Tokenize a search query into lowercase keyword fragments. */
function tokenizeQuery(query: string | undefined): readonly string[] {
    if (query === undefined) return [];
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token !== "");
}

/** Normalize and deduplicate the tags a search must match. */
function normalizeSearchTags(
    tags: readonly string[] | undefined
): readonly string[] {
    if (tags === undefined) return [];
    const normalized: string[] = [];
    for (const raw of tags) {
        const tag = raw.trim().toLowerCase();
        if (tag === "" || normalized.includes(tag)) continue;
        normalized.push(tag);
    }
    return normalized;
}

/** Score one entry against query tokens: title > tags > body. */
function scoreEntry(entry: MemoryEntry, tokens: readonly string[]): number {
    if (tokens.length === 0) return 0;
    const title = entry.title.toLowerCase();
    const tags = entry.tags.join(" ").toLowerCase();
    const body = entry.body.toLowerCase();
    let score = 0;
    for (const token of tokens) {
        if (title.includes(token)) score += 5;
        if (tags.includes(token)) score += 3;
        if (body.includes(token)) score += 1;
    }
    return score;
}

/** Best score first, most recently updated next, id as the stable tiebreak. */
function compareScoredEntries(left: ScoredEntry, right: ScoredEntry): number {
    if (left.score !== right.score) return right.score - left.score;
    const updated =
        Date.parse(right.entry.updated) - Date.parse(left.entry.updated);
    if (updated !== 0) return updated;
    return left.entry.id.localeCompare(right.entry.id);
}

/** Whether a path exists. */
async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
    }
}

/**
 * File-backed memory store exposed as the `memory` Cordis service.
 *
 * One Markdown file per entry: active entries in `entries/<id>.md`, archived
 * entries in `archive/<id>.md`. Mutations are serialized on one internal
 * promise chain and committed with atomic writes; reads scan the directory and
 * skip malformed files instead of failing the daemon.
 */
export class MemoryService extends Service {
    private readonly rootPath: string;
    private readonly entriesDir: string;
    private readonly archiveDir: string;
    private readonly defaultLimit: number;
    private initialization: Promise<void> | undefined;
    private writeChain: Promise<unknown> = Promise.resolve();
    private readonly changeListeners = new Set<() => void>();
    private runtimeStatusValue: MemoryRuntimeStatus | undefined;

    /**
     * Create and install the `memory` service.
     * @param ctx - Cordis context that owns the service.
     * @param config - store root and optional default search limit.
     */
    constructor(ctx: Context, config: MemoryServiceConfig) {
        super(ctx, "memory");
        const configuredRoot = config.root?.trim() ?? "";
        if (configuredRoot === "") {
            throw new Error("memory root is required");
        }
        this.rootPath = resolve(configuredRoot);
        this.entriesDir = join(this.rootPath, ENTRIES_DIR_NAME);
        this.archiveDir = join(this.rootPath, ARCHIVE_DIR_NAME);
        const configuredLimit = config.defaultLimit ?? DEFAULT_SEARCH_LIMIT;
        if (!Number.isInteger(configuredLimit) || configuredLimit < 1) {
            throw new Error(
                "memory defaultLimit must be a positive integer " +
                    `(got ${String(configuredLimit)})`
            );
        }
        this.defaultLimit = Math.min(configuredLimit, MAX_SEARCH_LIMIT);
    }

    /** Absolute directory that holds the store. */
    get root(): string {
        return this.rootPath;
    }

    /** Latest automatic-injection observation, set by the snapshot injector. */
    get runtimeStatus(): MemoryRuntimeStatus | undefined {
        return this.runtimeStatusValue;
    }

    /**
     * Record the current automatic-injection observation for `/status full`.
     * @param status - latest injector state, or `undefined` to clear it.
     */
    setRuntimeStatus(status: MemoryRuntimeStatus | undefined): void {
        this.runtimeStatusValue = status;
    }

    /**
     * Subscribe to successful entry mutations (write/pin/unpin/forget and
     * supersede archiving). The snapshot injector uses this to invalidate its
     * rendered cache without polling.
     * @param listener - called after each committed mutation.
     * @returns the disposer that stops notifications.
     */
    onChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => {
            this.changeListeners.delete(listener);
        };
    }

    /**
     * Create `entries/` and `archive/` with private permissions. Idempotent;
     * a failed initialization is retried by the next caller.
     * @returns a promise that settles when both directories exist.
     */
    initialize(): Promise<void> {
        this.initialization ??= this.createDirectories().catch(
            (error: unknown) => {
                this.initialization = undefined;
                throw error;
            }
        );
        return this.initialization;
    }

    /**
     * Search active entries by keyword and tags.
     *
     * Keyword matching is case-insensitive and scores title matches above tag
     * matches above body matches; ties break on `updated` (descending) and then
     * id. An empty query returns the most recently updated entries.
     * @param options - query, required tags, and page size.
     * @returns matching active entries, best match first.
     */
    async search(options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
        await this.initialize();
        const scan = await this.scanDirectory(this.entriesDir);
        const tokens = tokenizeQuery(options.query);
        const requiredTags = normalizeSearchTags(options.tags);
        const limit = this.resolveLimit(options.limit);
        const scored: ScoredEntry[] = [];
        for (const entry of scan.entries) {
            if (entry.status !== "active") continue;
            if (
                !requiredTags.every((required) =>
                    entry.tags.some((tag) => tag.toLowerCase() === required)
                )
            ) {
                continue;
            }
            const score = scoreEntry(entry, tokens);
            if (tokens.length > 0 && score === 0) continue;
            scored.push({ entry, score });
        }
        scored.sort(compareScoredEntries);
        return scored.slice(0, limit).map((candidate) => candidate.entry);
    }

    /**
     * Read one active entry by id.
     * @param id - entry id.
     * @returns the entry, or `undefined` when it is absent, archived, or
     * invalid.
     */
    async read(id: string): Promise<MemoryEntry | undefined> {
        const entryId = normalizeEntryId(id);
        await this.initialize();
        const entry = await this.readEntryFile(
            this.entryPath(entryId),
            entryId
        );
        if (entry === undefined || entry.status !== "active") return undefined;
        return entry;
    }

    /**
     * List every active entry, for the automatic snapshot renderer.
     * @returns active entries in directory order.
     */
    async listActive(): Promise<MemoryEntry[]> {
        await this.initialize();
        const scan = await this.scanDirectory(this.entriesDir);
        return scan.entries.filter((entry) => entry.status === "active");
    }

    /**
     * Pin one active entry so the automatic snapshot always includes it.
     * @param id - entry id.
     * @returns the updated entry.
     * @throws when the entry is missing, malformed, or archived.
     */
    async pin(id: string): Promise<MemoryEntry> {
        return this.setPinned(id, true);
    }

    /**
     * Unpin one active entry; automatic inclusion by tag still applies.
     * @param id - entry id.
     * @returns the updated entry.
     * @throws when the entry is missing, malformed, or archived.
     */
    async unpin(id: string): Promise<MemoryEntry> {
        return this.setPinned(id, false);
    }

    /**
     * Create or update one entry.
     *
     * A write without an id creates a generated id; a write with an existing
     * active id keeps `created` and replaces the content; a write naming an
     * archived id is refused. Ids listed in `supersedes` are archived after the
     * new entry is committed.
     * @param input - entry fields.
     * @returns the stored entry.
     * @throws when validation fails, a secret is detected, or the id is
     * archived.
     */
    async write(input: MemoryWriteInput): Promise<MemoryEntry> {
        const normalized = normalizeWrite(input);
        return this.enqueue(async () => {
            await this.initialize();
            return this.commitWrite(normalized);
        });
    }

    /**
     * Soft-delete one active entry: set `status: archived` and move it to
     * `archive/`.
     * @param id - entry id.
     * @returns the archived entry.
     * @throws when the entry is missing or its file is malformed.
     */
    async forget(id: string): Promise<MemoryEntry> {
        const entryId = normalizeEntryId(id);
        return this.enqueue(async () => {
            await this.initialize();
            const text = await this.readText(this.entryPath(entryId));
            if (text === undefined) {
                throw new Error(`memory entry "${entryId}" was not found`);
            }
            const parsed = tryParseMemoryFile(text);
            if (!parsed.ok) {
                throw new Error(
                    `memory entry "${entryId}" is invalid: ` +
                        parsed.error.message
                );
            }
            const archived: MemoryEntry = {
                ...parsed.entry,
                status: "archived",
            };
            await this.writeEntryFile(this.archivePath(entryId), archived);
            await rm(this.entryPath(entryId), { force: true });
            this.notifyChange();
            return archived;
        });
    }

    /**
     * Count active, archived, and invalid entries plus their on-disk bytes.
     * @returns store counters.
     */
    async stats(): Promise<MemoryStats> {
        await this.initialize();
        const active = await this.scanDirectory(this.entriesDir);
        const archived = await this.scanDirectory(this.archiveDir);
        let activeCount = 0;
        let pinnedCount = 0;
        let archivedCount = archived.entries.length;
        for (const entry of active.entries) {
            if (entry.status === "active") {
                activeCount += 1;
                if (entry.pinned) pinnedCount += 1;
            } else {
                archivedCount += 1;
            }
        }
        return {
            active: activeCount,
            archived: archivedCount,
            invalid: active.invalid + archived.invalid,
            bytes: active.bytes + archived.bytes,
            pinned: pinnedCount,
        };
    }

    /** Create the two entry directories with private permissions. */
    private async createDirectories(): Promise<void> {
        await mkdir(this.entriesDir, { recursive: true, mode: STATE_DIR_MODE });
        await mkdir(this.archiveDir, { recursive: true, mode: STATE_DIR_MODE });
    }

    /** Run one mutation after every previously enqueued mutation settled. */
    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.writeChain.then(operation, operation);
        this.writeChain = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    /** Resolve an explicit page size against the configured default. */
    private resolveLimit(limit: number | undefined): number {
        if (limit === undefined) return this.defaultLimit;
        if (!Number.isInteger(limit)) {
            throw new Error("memory search limit must be an integer");
        }
        return Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT);
    }

    /** Commit one validated write after the read-modify-write state is settled. */
    private async commitWrite(input: NormalizedWrite): Promise<MemoryEntry> {
        const now = new Date().toISOString();
        let id: string;
        let existing: MemoryEntry | undefined;
        if (input.id === undefined) {
            id = await this.allocateId();
        } else {
            id = input.id;
            if (await pathExists(this.archivePath(id))) {
                throw new Error(
                    `memory entry "${id}" is archived; write a new entry ` +
                        "instead of reviving it"
                );
            }
            existing = await this.readEntryFile(this.entryPath(id), id);
        }
        const source = input.source ?? existing?.source;
        const supersedes = input.supersedes ?? existing?.supersedes ?? [];
        const entry: MemoryEntry = {
            id,
            title: input.title,
            tags: input.tags,
            ...(source === undefined ? {} : { source }),
            created: existing?.created ?? now,
            updated: now,
            confidence:
                input.confidence ?? existing?.confidence ?? DEFAULT_CONFIDENCE,
            status: "active",
            pinned: input.pinned ?? existing?.pinned ?? DEFAULT_PINNED,
            supersedes,
            body: input.body,
        };
        await this.writeEntryFile(this.entryPath(id), entry);
        for (const supersededId of supersedes) {
            if (supersededId === id) continue;
            await this.archiveEntry(supersededId);
        }
        this.notifyChange();
        return entry;
    }

    /** Flip the pinned flag of one active entry; no-op when already set. */
    private async setPinned(id: string, pinned: boolean): Promise<MemoryEntry> {
        const entryId = normalizeEntryId(id);
        return this.enqueue(async () => {
            await this.initialize();
            const text = await this.readText(this.entryPath(entryId));
            if (text === undefined) {
                throw new Error(`memory entry "${entryId}" was not found`);
            }
            const parsed = tryParseMemoryFile(text);
            if (!parsed.ok) {
                throw new Error(
                    `memory entry "${entryId}" is invalid: ` +
                        parsed.error.message
                );
            }
            if (parsed.entry.status !== "active") {
                throw new Error(`memory entry "${entryId}" is archived`);
            }
            if (parsed.entry.pinned === pinned) return parsed.entry;
            const entry: MemoryEntry = { ...parsed.entry, pinned };
            await this.writeEntryFile(this.entryPath(entryId), entry);
            this.notifyChange();
            return entry;
        });
    }

    /** Notify snapshot caches after one committed mutation. */
    private notifyChange(): void {
        for (const listener of this.changeListeners) {
            try {
                listener();
            } catch {
                // A cache listener must never fail a memory mutation.
            }
        }
    }

    /** Allocate an unused generated id. */
    private async allocateId(): Promise<string> {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const candidate = generateMemoryId();
            if (await pathExists(this.entryPath(candidate))) continue;
            if (await pathExists(this.archivePath(candidate))) continue;
            return candidate;
        }
        throw new Error("could not allocate a unique memory id");
    }

    /** Soft-delete one existing entry; missing or invalid entries are skipped. */
    private async archiveEntry(id: string): Promise<void> {
        const text = await this.readText(this.entryPath(id));
        if (text === undefined) return;
        const parsed = tryParseMemoryFile(text);
        if (!parsed.ok || parsed.entry.id !== id) return;
        if (parsed.entry.status === "archived") return;
        const archived: MemoryEntry = { ...parsed.entry, status: "archived" };
        await this.writeEntryFile(this.archivePath(id), archived);
        await rm(this.entryPath(id), { force: true });
    }

    /** Scan one directory, counting malformed files instead of failing. */
    private async scanDirectory(dir: string): Promise<DirectoryScan> {
        let names: string[];
        try {
            names = (await readdir(dir))
                .filter((name) => name.endsWith(MEMORY_FILE_SUFFIX))
                .sort();
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                return { entries: [], invalid: 0, bytes: 0 };
            }
            throw error;
        }
        const entries: MemoryEntry[] = [];
        let invalid = 0;
        let bytes = 0;
        for (const name of names) {
            const filePath = join(dir, name);
            let text: string;
            let size: number;
            try {
                const info = await stat(filePath);
                if (!info.isFile()) continue;
                size = info.size;
                text = await readFile(filePath, "utf8");
            } catch (error) {
                if (isNodeError(error) && error.code === "ENOENT") continue;
                invalid += 1;
                continue;
            }
            bytes += size;
            const expectedId = name.slice(0, -MEMORY_FILE_SUFFIX.length);
            const parsed = tryParseMemoryFile(text);
            if (!parsed.ok || parsed.entry.id !== expectedId) {
                invalid += 1;
                continue;
            }
            entries.push(parsed.entry);
        }
        return { entries, invalid, bytes };
    }

    /** Read one file as UTF-8, or `undefined` when it does not exist. */
    private async readText(path: string): Promise<string | undefined> {
        try {
            return await readFile(path, "utf8");
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
    }

    /** Read and validate one entry file, or `undefined` when absent/invalid. */
    private async readEntryFile(
        path: string,
        expectedId: string
    ): Promise<MemoryEntry | undefined> {
        const text = await this.readText(path);
        if (text === undefined) return undefined;
        const parsed = tryParseMemoryFile(text);
        if (!parsed.ok || parsed.entry.id !== expectedId) return undefined;
        return parsed.entry;
    }

    /** Atomically write one entry file with private permissions. */
    private async writeEntryFile(
        path: string,
        entry: MemoryEntry
    ): Promise<void> {
        await writeFileAtomic(path, serializeMemoryFile(entry), {
            mode: STATE_FILE_MODE,
            dirMode: STATE_DIR_MODE,
        });
    }

    /** Path of one active entry file. */
    private entryPath(id: string): string {
        return join(this.entriesDir, `${id}${MEMORY_FILE_SUFFIX}`);
    }

    /** Path of one archived entry file. */
    private archivePath(id: string): string {
        return join(this.archiveDir, `${id}${MEMORY_FILE_SUFFIX}`);
    }
}
