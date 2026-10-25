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

/** Render, split, and annotate one outbound text. */
export function formatOutbound(
    text: string,
    capabilities: ChannelCapabilities
): readonly string[] {
    const rendered = renderForCapability(text, capabilities);
    const chunks = splitText(rendered, capabilities.maxTextLength);
    if (chunks.length <= 1) return chunks;
    return chunks.map(
        (chunk, index) => `(${index + 1}/${chunks.length}) ${chunk}`
    );
}
