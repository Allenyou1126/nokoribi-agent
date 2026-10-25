import type {
    JobHooks,
    JobOutcome,
    JobOutputSource,
} from "@deepseek-ai/dsh-jobs";
import type { ShellProcess } from "@deepseek-ai/dsh-shell";

/**
 * Map a settled bash process onto the generic job-outcome vocabulary.
 * `killed` stays `killed`; everything else is `completed` with the exit code
 * as detail. A nonzero command exit is reported, not failed.
 * @param proc - the settled process handle.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc: ShellProcess): JobOutcome {
    if (proc.status === "killed") {
        return {
            status: "killed",
            detail:
                proc.signal === null
                    ? "killed before exit"
                    : `signal: ${proc.signal}`,
        };
    }
    return {
        status: "completed",
        detail: `exit code: ${proc.exitCode ?? 0}`,
    };
}

/**
 * Expose the process's non-consuming stream readers as registry pull sources.
 * The readers bind lazily because the process is spawned inside the job
 * starter, after admission.
 * @param proc - accessor for the started process, once available.
 * @returns one source per stream, stdout first.
 */
export function processSources(
    proc: () => ShellProcess | undefined
): JobOutputSource[] {
    const source = (channel: "stdout" | "stderr"): JobOutputSource => ({
        channel,
        read: (fromByte: number) => {
            const live = proc();
            if (live === undefined) {
                return {
                    text: "",
                    nextOffset: fromByte,
                    lossy: false,
                };
            }
            return live.observed[channel].readFrom(fromByte);
        },
    });
    return [source("stdout"), source("stderr")];
}

/**
 * Adapt asynchronous shell preparation after job admission without exposing a
 * partial process.
 * @param start - starts the process with job-owned cancellation.
 * @param outcome - projects the settled process into the job outcome.
 * @returns synchronous job hooks whose completion includes preparation and
 *   process settlement.
 */
export function processJob(
    start: (signal: AbortSignal) => Promise<ShellProcess>,
    outcome: (process: ShellProcess) => JobOutcome
): JobHooks {
    const controller = new AbortController();
    let process: ShellProcess | undefined;
    return {
        cancel: (reason): void => {
            if (controller.signal.aborted) return;
            controller.abort(reason);
            process?.kill();
        },
        done: (async (): Promise<JobOutcome> => {
            try {
                process = await start(controller.signal);
                try {
                    if (controller.signal.aborted) process.kill();
                } finally {
                    await process.done;
                }
                return outcome(process);
            } catch (error) {
                return {
                    status:
                        controller.signal.aborted && process === undefined
                            ? "killed"
                            : "failed",
                    detail:
                        error instanceof Error ? error.message : String(error),
                };
            }
        })(),
    };
}
