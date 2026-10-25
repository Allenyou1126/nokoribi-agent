import type { Context } from "@deepseek-ai/cordis";
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type {
    SubprocessHandle,
    SubprocessOutcome,
    SubprocessSpawnSpec,
    SubprocessTerminalEnvironment as TerminalEnvironment,
    SubprocessTerminalHandle,
} from "@deepseek-ai/dsh-subprocess";

/** Fixed options for the deterministic subprocess test double. */
export interface FakeSubprocessOptions {
    readonly stdout?: string;
    readonly exitCode?: number;
}

/**
 * Test double for the subprocess seam: it records spawn specs and reports one
 * fixed, already-finished process so the bash executor's mechanics can run
 * without spawning real commands.
 */
export class FakeSubprocess extends SubprocessRuntime {
    readonly spawns: SubprocessSpawnSpec[] = [];
    private readonly stdoutText: string;
    private readonly exitCode: number;

    constructor(ctx: Context, options: FakeSubprocessOptions = {}) {
        super(ctx);
        this.stdoutText = options.stdout ?? "";
        this.exitCode = options.exitCode ?? 0;
    }

    override async resolveExecutable(command: string): Promise<string> {
        return `/fake/bin/${command}`;
    }

    override async terminalEnvironment(): Promise<TerminalEnvironment> {
        return { platform: "posix", defaultShell: "bash" };
    }

    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        this.spawns.push(spec);
        const stdout = this.stdoutText;
        const outcome: SubprocessOutcome = {
            exitCode: this.exitCode,
            signal: null,
        };
        return {
            stdin: undefined,
            stdout: undefined,
            stderr: undefined,
            control: undefined,
            collected: {
                stdout: {
                    readFrom: (fromByte: number) => ({
                        text: stdout.slice(fromByte),
                        nextOffset: stdout.length,
                        lossy: false,
                    }),
                },
                stderr: {
                    readFrom: () => ({
                        text: "",
                        nextOffset: 0,
                        lossy: false,
                    }),
                },
            },
            done: Promise.resolve(outcome),
            terminate: () => {},
            waitForExit: async () => true,
        };
    }

    override async spawnTerminal(): Promise<SubprocessTerminalHandle> {
        throw new Error("terminal processes are not supported by the double");
    }
}
