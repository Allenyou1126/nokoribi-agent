/** Markdown frontmatter delimiter. */
const DELIMITER: string = "---";

/** Field pattern of one `key: value` frontmatter line. */
const FIELD_PATTERN: RegExp = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;

/** How strongly a memory entry is trusted. */
export type MemoryConfidence = "high" | "medium" | "low";

/** Lifecycle state of a memory entry; `archived` is the soft-delete state. */
export type MemoryStatus = "active" | "archived";

/** Confidence assigned to a new entry when the caller does not choose one. */
export const DEFAULT_CONFIDENCE: MemoryConfidence = "medium";

/** Lifecycle state assigned to every stored entry. */
export const DEFAULT_STATUS: MemoryStatus = "active";

/** Frontmatter fields of one memory entry. */
export interface MemoryFrontmatter {
    /** Stable entry id; also the file name without the `.md` suffix. */
    readonly id: string;
    /** Short human-readable title used for retrieval. */
    readonly title: string;
    /** Namespaced retrieval tags such as `type:preference`. */
    readonly tags: readonly string[];
    /** Optional provenance such as `session:<sessionId>#turn-12`. */
    readonly source?: string | undefined;
    /** ISO timestamp of creation. */
    readonly created: string;
    /** ISO timestamp of the last content update. */
    readonly updated: string;
    /** Trust level for this entry. */
    readonly confidence: MemoryConfidence;
    /** Lifecycle state; only `active` entries are searchable. */
    readonly status: MemoryStatus;
    /** Ids of the entries this entry replaces. */
    readonly supersedes: readonly string[];
}

/** One complete memory entry: frontmatter plus Markdown body. */
export interface MemoryEntry extends MemoryFrontmatter {
    /** Markdown body between the closing delimiter and the end of file. */
    readonly body: string;
}

/** A parsed memory document before frontmatter and body are merged. */
export interface ParsedMemoryFile {
    /** Validated frontmatter fields. */
    readonly frontmatter: MemoryFrontmatter;
    /** Normalized body after the closing delimiter. */
    readonly body: string;
}

/** Raised when a memory Markdown document is not a valid entry. */
export class MemoryFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemoryFormatError";
    }
}

/** Result of a non-throwing memory document parse. */
export type MemoryFileParseResult =
    | { readonly ok: true; readonly entry: MemoryEntry }
    | { readonly ok: false; readonly error: MemoryFormatError };

/**
 * Normalize a body: LF line endings, no leading blank lines, and no trailing
 * whitespace. The stored form is canonical, so a write followed by a read
 * returns the same body.
 * @param body - raw Markdown body.
 * @returns the canonical body text.
 */
export function normalizeBody(body: string): string {
    return body
        .replaceAll("\r\n", "\n")
        .replace(/^(?:[ \t]*\n)+/, "")
        .replace(/\s+$/, "");
}

/** Quote one string as a JSON scalar usable as a YAML double-quoted scalar. */
function quote(value: string): string {
    return JSON.stringify(value) as string;
}

/**
 * Serialize frontmatter fields and a body into one memory Markdown document.
 *
 * Every string is written as a JSON double-quoted scalar and every list as a
 * JSON flow sequence, so the document is valid YAML and parses back without
 * ambiguity.
 * @param frontmatter - validated frontmatter fields.
 * @param body - entry body; normalized before writing.
 * @returns complete Markdown document, newline terminated.
 */
export function serializeFrontmatter(
    frontmatter: MemoryFrontmatter,
    body: string
): string {
    const lines: string[] = [
        DELIMITER,
        `id: ${quote(frontmatter.id)}`,
        `title: ${quote(frontmatter.title)}`,
        `tags: ${JSON.stringify(frontmatter.tags)}`,
    ];
    if (frontmatter.source !== undefined) {
        lines.push(`source: ${quote(frontmatter.source)}`);
    }
    lines.push(
        `created: ${quote(frontmatter.created)}`,
        `updated: ${quote(frontmatter.updated)}`,
        `confidence: ${quote(frontmatter.confidence)}`,
        `status: ${quote(frontmatter.status)}`
    );
    lines.push(
        frontmatter.supersedes.length === 0
            ? "supersedes: null"
            : `supersedes: ${JSON.stringify(frontmatter.supersedes)}`
    );
    lines.push(DELIMITER);
    const normalized = normalizeBody(body);
    if (normalized === "") return `${lines.join("\n")}\n`;
    return `${lines.join("\n")}\n\n${normalized}\n`;
}

/**
 * Serialize one complete memory entry.
 * @param entry - entry to serialize.
 * @returns complete Markdown document.
 */
export function serializeMemoryFile(entry: MemoryEntry): string {
    const { body, ...frontmatter } = entry;
    return serializeFrontmatter(frontmatter, body);
}

/** Parse one scalar frontmatter value written by this module or by hand. */
function parseValue(raw: string, key: string): unknown {
    if (raw === "" || raw === "null" || raw === "~") return null;
    if (raw.startsWith('"') || raw.startsWith("[")) {
        try {
            return JSON.parse(raw) as unknown;
        } catch {
            throw new MemoryFormatError(
                `frontmatter field "${key}" is not valid JSON: ${raw}`
            );
        }
    }
    if (raw.startsWith("'")) {
        if (raw.length < 2 || !raw.endsWith("'")) {
            throw new MemoryFormatError(
                `frontmatter field "${key}" has an unterminated quote`
            );
        }
        return raw.slice(1, -1).replaceAll("''", "'");
    }
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
}

/** Parse every `key: value` line of one frontmatter block. */
function parseFields(lines: readonly string[]): ReadonlyMap<string, unknown> {
    const fields = new Map<string, unknown>();
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const match = FIELD_PATTERN.exec(line);
        if (match === null) {
            throw new MemoryFormatError(
                `unsupported frontmatter line: ${trimmed}`
            );
        }
        fields.set(match[1], parseValue(match[2], match[1]));
    }
    return fields;
}

/** Split a document into parsed frontmatter fields and the raw body. */
function splitDocument(text: string): {
    readonly fields: ReadonlyMap<string, unknown>;
    readonly body: string;
} {
    const normalized = text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
    const lines = normalized.split("\n");
    if (lines[0]?.trim() !== DELIMITER) {
        throw new MemoryFormatError(
            "missing opening `---` frontmatter delimiter"
        );
    }
    let closing = -1;
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index]?.trim() === DELIMITER) {
            closing = index;
            break;
        }
    }
    if (closing === -1) {
        throw new MemoryFormatError(
            "missing closing `---` frontmatter delimiter"
        );
    }
    return {
        fields: parseFields(lines.slice(1, closing)),
        body: lines.slice(closing + 1).join("\n"),
    };
}

/** Read one required non-empty string field. */
function readRequiredString(
    fields: ReadonlyMap<string, unknown>,
    key: string
): string {
    const value = fields.get(key);
    if (value === undefined || value === null) {
        throw new MemoryFormatError(`missing required field "${key}"`);
    }
    if (typeof value !== "string") {
        throw new MemoryFormatError(`field "${key}" must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed === "") {
        throw new MemoryFormatError(`field "${key}" must not be empty`);
    }
    return trimmed;
}

/** Read one optional non-empty string field. */
function readOptionalString(
    fields: ReadonlyMap<string, unknown>,
    key: string
): string | undefined {
    const value = fields.get(key);
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
        throw new MemoryFormatError(`field "${key}" must be a string`);
    }
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
}

/** Read one required timestamp field. */
function readTimestamp(
    fields: ReadonlyMap<string, unknown>,
    key: string
): string {
    const value = readRequiredString(fields, key);
    if (Number.isNaN(Date.parse(value))) {
        throw new MemoryFormatError(`field "${key}" is not an ISO timestamp`);
    }
    return value;
}

/** Read the tags field, accepting a flow sequence or a bare scalar. */
function readTags(fields: ReadonlyMap<string, unknown>): readonly string[] {
    const value = fields.get("tags");
    if (value === undefined || value === null) {
        throw new MemoryFormatError('missing required field "tags"');
    }
    if (typeof value === "string") return [value.trim()];
    if (!Array.isArray(value)) {
        throw new MemoryFormatError('field "tags" must be a list of strings');
    }
    return value.map((item) => {
        if (typeof item !== "string") {
            throw new MemoryFormatError(
                'field "tags" must be a list of strings'
            );
        }
        return item.trim();
    });
}

/** Read the confidence field, defaulting it when absent. */
function readConfidence(
    fields: ReadonlyMap<string, unknown>
): MemoryConfidence {
    const value = readOptionalString(fields, "confidence");
    if (value === undefined) return DEFAULT_CONFIDENCE;
    if (value !== "high" && value !== "medium" && value !== "low") {
        throw new MemoryFormatError(
            `field "confidence" must be high, medium or low`
        );
    }
    return value;
}

/** Read the status field, defaulting it when absent. */
function readStatus(fields: ReadonlyMap<string, unknown>): MemoryStatus {
    const value = readOptionalString(fields, "status");
    if (value === undefined) return DEFAULT_STATUS;
    if (value !== "active" && value !== "archived") {
        throw new MemoryFormatError(
            `field "status" must be active or archived`
        );
    }
    return value;
}

/** Read the supersedes field, accepting null, a scalar, or a list. */
function readSupersedes(
    fields: ReadonlyMap<string, unknown>
): readonly string[] {
    const value = fields.get("supersedes");
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return [value.trim()];
    if (!Array.isArray(value)) {
        throw new MemoryFormatError(
            'field "supersedes" must be null, an id, or a list of ids'
        );
    }
    return value.map((item) => {
        if (typeof item !== "string") {
            throw new MemoryFormatError(
                'field "supersedes" must be null, an id, or a list of ids'
            );
        }
        return item.trim();
    });
}

/**
 * Parse one memory Markdown document into frontmatter and body.
 *
 * Required fields are `id`, `title`, `tags`, `created` and `updated`; `source`
 * and `supersedes` are optional, and `confidence`/`status` default to
 * `medium`/`active` when a hand-written file omits them.
 * @param text - complete Markdown document.
 * @returns validated frontmatter and the normalized body.
 * @throws {MemoryFormatError} when the document is not a valid entry.
 */
export function parseFrontmatter(text: string): ParsedMemoryFile {
    const document = splitDocument(text);
    const fields = document.fields;
    const source = readOptionalString(fields, "source");
    return {
        frontmatter: {
            id: readRequiredString(fields, "id"),
            title: readRequiredString(fields, "title"),
            tags: readTags(fields),
            ...(source === undefined ? {} : { source }),
            created: readTimestamp(fields, "created"),
            updated: readTimestamp(fields, "updated"),
            confidence: readConfidence(fields),
            status: readStatus(fields),
            supersedes: readSupersedes(fields),
        },
        body: normalizeBody(document.body),
    };
}

/**
 * Parse one memory Markdown document into a complete entry.
 * @param text - complete Markdown document.
 * @returns the parsed entry.
 * @throws {MemoryFormatError} when the document is not a valid entry.
 */
export function parseMemoryFile(text: string): MemoryEntry {
    const parsed = parseFrontmatter(text);
    return { ...parsed.frontmatter, body: parsed.body };
}

/**
 * Parse one memory document without throwing on malformed content.
 * @param text - complete Markdown document.
 * @returns the entry, or the format error that rejected it.
 */
export function tryParseMemoryFile(text: string): MemoryFileParseResult {
    try {
        return { ok: true, entry: parseMemoryFile(text) };
    } catch (error) {
        if (error instanceof MemoryFormatError) return { ok: false, error };
        throw error;
    }
}
