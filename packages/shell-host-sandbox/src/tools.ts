import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";

import type { SandboxHost, SandboxStatus } from "./host.js";

/** Model-facing sandbox control tool name. */
export const SANDBOX_TOOL_NAME: string = "sandbox";

/** Model-facing temporary package tool name. */
export const SANDBOX_PACKAGES_TOOL_NAME: string = "sandbox_packages";

function sessionIdOf(exec: ToolRunContext): string {
    const sessionId = exec.agent?.session.header.id;
    if (sessionId === undefined) {
        throw new Error("sandbox tools require an agent session");
    }
    return sessionId;
}

function yesNo(value: boolean): string {
    return value ? "yes" : "no";
}

function formatStatus(status: SandboxStatus): string {
    return [
        `host: ${status.host}`,
        `session: ${status.sessionId}`,
        `dir: ${status.dir}`,
        `exists: ${yesNo(status.exists)}`,
        `generation: ${status.generation}`,
        `created: ${status.createdAt ?? "-"}`,
        `lastUsed: ${status.lastUsedAt ?? "-"}`,
        `idleTtlMs: ${status.idleTtlMs}`,
        `activeCommands: ${status.activeCommands}`,
        `backgroundCommands: ${status.backgroundCommands}`,
        `runtimePackages: ${yesNo(status.allowRuntimePackages)}`,
        `packages: ${
            status.packages.length === 0 ? "(none)" : status.packages.join(", ")
        }`,
    ].join("\n");
}

function formatPackages(packages: readonly string[]): string {
    if (packages.length === 0) return "packages: (none)";
    return `packages:\n${packages.map((item) => `- ${item}`).join("\n")}`;
}

/**
 * Build the sandbox control and package tools for one host.
 * @param host - sandbox provider instance.
 * @returns the two tool definitions registered by `apply`.
 */
export function createSandboxTools(host: SandboxHost): {
    readonly sandbox: ToolDefinition;
    readonly packages: ToolDefinition;
} {
    const sandbox = defineTool({
        name: SANDBOX_TOOL_NAME,
        description: `Inspect or reset the current session's sandbox. The sandbox is a clean, disposable Nix environment with its own temporary directory; it is not the workspace and may be reclaimed after idle TTL. Reset deletes the directory, clears temporary packages and increments the generation; it is refused while commands are active. Write important artifacts back to the workspace with cp/rsync.`,
        parameters: {
            action: {
                type: "string",
                required: true,
                enum: ["status", "reset"],
                description: "Read status or reset the sandbox.",
            },
        },
        output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            if (args.action === "status") {
                return formatStatus(await host.status(sessionId));
            }
            await host.reset(sessionId);
            return formatStatus(await host.status(sessionId));
        },
    });

    const packages = defineTool({
        name: SANDBOX_PACKAGES_TOOL_NAME,
        description: `Add, remove or list temporary packages in the current session's sandbox. Packages are realized with nix shell and remain until reset or idle reclaim; they are not part of the profile's base environment. Adding packages may need network access and can be slow. The sandbox still cannot sudo.`,
        parameters: {
            action: {
                type: "string",
                required: true,
                enum: ["add", "remove", "list"],
                description: "Package operation.",
            },
            packages: {
                type: "array",
                items: { type: "string" },
                description:
                    "Installables such as nixpkgs#hello; required for add/remove.",
            },
        },
        output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            const requested = args.packages ?? [];
            if (args.action === "list") {
                return formatPackages(await host.listPackages(sessionId));
            }
            if (requested.length === 0) {
                throw new Error(
                    `sandbox_packages ${args.action} requires packages`
                );
            }
            if (args.action === "add") {
                return formatPackages(
                    await host.addPackages(sessionId, requested)
                );
            }
            return formatPackages(
                await host.removePackages(sessionId, requested)
            );
        },
    });

    return { sandbox, packages };
}
