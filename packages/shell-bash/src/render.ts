import type { CollectedOutput } from "@deepseek-ai/dsh-shell";

/** One canonical stream value carried by the bash tool result. */
export interface BashStreamValue {
    readonly text: string;
    readonly truncated: boolean;
    readonly spillPath?: string;
}

/** Completed foreground bash result shown to the model. */
export interface BashForegroundValue {
    readonly kind: "foreground";
    readonly host: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly aborted: boolean;
    readonly timeoutMs: number;
    readonly stdout: BashStreamValue;
    readonly stderr: BashStreamValue;
}

/** Conversion from the executor's collected output to the canonical value. */
export function toStreamValue(output: CollectedOutput): BashStreamValue {
    return {
        text: output.text,
        truncated: output.truncated,
        ...(output.spillPath === undefined
            ? {}
            : { spillPath: output.spillPath }),
    };
}

function streamText(output: BashStreamValue): string {
    if (!output.truncated) return output.text;
    return `${output.text}\n[output truncated; full output: ${
        output.spillPath ?? "(unavailable)"
    }]`;
}

/**
 * Shape one finished run into the text the model sees: stdout, a marked
 * stderr section, then exit-status markers. Nonzero exits are reported, not
 * errored; only infrastructure failures surface as tool errors.
 * @param value - the canonical foreground result.
 * @returns model-facing text with output and markers.
 */
export function renderForeground(value: BashForegroundValue): string {
    const out = streamText(value.stdout);
    const err = streamText(value.stderr);
    let body = out;
    if (err.length > 0) {
        if (body.length > 0 && !body.endsWith("\n")) body += "\n";
        body += `[stderr]\n${err}`;
    }
    if (body.length === 0) body = "(no output)";

    const markers: string[] = [];
    if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`);
    if (value.signal !== null) {
        markers.push(`[killed by signal: ${value.signal}]`);
    } else if (value.exitCode !== 0) {
        markers.push(`[exit code: ${value.exitCode}]`);
    }
    if (markers.length === 0) return body;
    if (!body.endsWith("\n")) body += "\n";
    return body + markers.join("\n");
}
