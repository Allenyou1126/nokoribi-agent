import type { ChannelCapabilities } from "./contract.js";

const MARKDOWN_HTML = /<[^>]+>/g;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
const MARKDOWN_BOLD = /\*\*([^*]+)\*\*/g;
const MARKDOWN_ITALIC = /(^|\s)\*([^*]+)\*(?=\s|$)/g;
const MARKDOWN_HEADING = /^#{1,6}\s+/gm;
const CODE_FENCE = /```[^\n]*\n?/g;

/** Downgrade markdown for the driver's declared capability. */
export function renderForCapability(
    text: string,
    capabilities: ChannelCapabilities
): string {
    if (capabilities.markdown === "full") return text;
    if (capabilities.markdown === "basic") {
        return text
            .replace(MARKDOWN_HTML, "")
            .replace(/\n?\|[^\n]*\|[^\n]*\n?/g, "\n");
    }
    return text
        .replace(MARKDOWN_HTML, "")
        .replace(MARKDOWN_LINK, "$1 ($2)")
        .replace(MARKDOWN_BOLD, "$1")
        .replace(MARKDOWN_ITALIC, "$1$2")
        .replace(MARKDOWN_HEADING, "")
        .replace(CODE_FENCE, "");
}

/** Split text into chunks that fit one driver's limit, preferring paragraphs. */
export function splitText(
    text: string,
    maxTextLength: number
): readonly string[] {
    if (maxTextLength <= 0 || text.length <= maxTextLength) return [text];

    const chunks: string[] = [];
    let rest = text;
    while (rest.length > maxTextLength) {
        const window = rest.slice(0, maxTextLength);
        let cut = window.lastIndexOf("\n\n");
        if (cut < Math.floor(maxTextLength / 2)) {
            cut = window.lastIndexOf("\n");
        }
        if (cut < Math.floor(maxTextLength / 2)) {
            cut = window.lastIndexOf(" ");
        }
        if (cut <= 0) cut = maxTextLength;
        chunks.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).replace(/^\s+/, "");
    }
    if (rest.length > 0) chunks.push(rest);
    return chunks;
}

/** Options for one outbound formatting pass. */
export interface FormatOptions {
    /** Keep at most this many chunks; the last one is truncated with `…`. */
    readonly maxChunks?: number;
}

/** Render, split, and annotate one outbound text. */
export function formatOutbound(
    text: string,
    capabilities: ChannelCapabilities,
    options: FormatOptions = {}
): readonly string[] {
    const rendered = renderForCapability(text, capabilities);
    const chunks = withChunkPrefixes(rendered, capabilities.maxTextLength);
    const maxChunks = options.maxChunks;
    if (maxChunks === undefined || maxChunks < 0) return chunks;
    if (maxChunks === 0) return [];
    if (chunks.length <= maxChunks) return chunks;
    const kept = chunks.slice(0, maxChunks);
    const lastIndex = kept.length - 1;
    const last = kept[lastIndex];
    if (last !== undefined) {
        kept[lastIndex] = truncateWithEllipsis(
            last,
            capabilities.maxTextLength,
            true
        );
    }
    return kept;
}

function chunkPrefix(index: number, total: number): string {
    return `(${index}/${total}) `;
}

/**
 * Split with enough budget left for the `(i/n) ` prefix.
 *
 * The prefix width depends on the chunk count, so re-split until the count is
 * stable. A single chunk never gets a prefix.
 */
function withChunkPrefixes(
    text: string,
    maxTextLength: number
): readonly string[] {
    if (maxTextLength <= 0 || text.length <= maxTextLength) return [text];
    let chunks = splitText(text, maxTextLength);
    for (let pass = 0; pass < 6; pass += 1) {
        if (chunks.length <= 1) return chunks;
        const prefixWidth = chunkPrefix(chunks.length, chunks.length).length;
        const budget = maxTextLength - prefixWidth;
        if (budget <= 0) {
            return chunks.map((chunk) => chunk.slice(0, maxTextLength));
        }
        const next = splitText(text, budget);
        if (next.length === chunks.length) {
            return next.map(
                (chunk, index) =>
                    `${chunkPrefix(index + 1, next.length)}${chunk}`
            );
        }
        chunks = next;
    }
    return chunks.map((chunk, index) =>
        truncateWithoutEllipsis(
            `${chunkPrefix(index + 1, chunks.length)}${chunk}`,
            maxTextLength
        )
    );
}

function truncateWithoutEllipsis(text: string, maxTextLength: number): string {
    if (maxTextLength <= 0 || text.length <= maxTextLength) return text;
    return text.slice(0, maxTextLength);
}

function truncateWithEllipsis(
    text: string,
    maxTextLength: number,
    force: boolean
): string {
    if (maxTextLength <= 0) return force ? `${text}…` : text;
    if (!force && text.length <= maxTextLength) return text;
    if (maxTextLength === 1) return "…";
    const slice = text.slice(0, maxTextLength - 1).trimEnd();
    return `${slice}…`;
}
