import { describe, expect, it } from "vitest";

import type { ShellHostInfo } from "../src/hosts.js";
import {
    BASH_SECTION_NAME,
    BASH_SECTION_PROMPT,
    HOSTS_SECTION_NAME,
    HOSTS_SECTION_ORDER,
    renderHostsPrompt,
} from "../src/prompt.js";

function host(
    id: string,
    kind: "local" | "sandbox",
    description: string
): ShellHostInfo {
    return {
        id,
        kind,
        title: id,
        description,
        capabilities: {
            background: true,
            sandbox: false,
            workdir: "local",
            terminal: true,
        },
    };
}

describe("hosts prompt", () => {
    it("exposes stable section metadata", () => {
        expect(HOSTS_SECTION_NAME).toBe("nokoribi:hosts");
        expect(HOSTS_SECTION_ORDER).toBe(3000);
        expect(BASH_SECTION_NAME).toBe("tool:bash");
        expect(BASH_SECTION_PROMPT).toContain("[exit code: N]");
    });

    it("renders the default host, sandbox facts, and registered ids", () => {
        const text = renderHostsPrompt("sandbox:default", [
            host("local:workspace", "local", "主机环境"),
            host("sandbox:default", "sandbox", "干净环境"),
        ]);
        expect(text).toContain("默认 host：`sandbox:default`");
        expect(text).toContain("DSH_SANDBOX_DIR");
        expect(text).toContain("DSH_WORKSPACE_DIR");
        expect(text).toContain("sandbox 内不能 sudo");
        expect(text).toContain("`local:workspace`");
        expect(text).toContain("`sandbox:default`");
        expect(text).toContain("cp/rsync");
        expect(text).toContain("terminal_open.type");
        expect(text).toContain("terminal: true");
    });

    it("keeps discovery guidance when no hosts are listed", () => {
        const text = renderHostsPrompt("sandbox:default", []);
        expect(text).toContain("get_available_shell_host");
        expect(text).not.toContain("已注册 host：");
    });

    it("omits terminal guidance when no terminal backend is registered", () => {
        const text = renderHostsPrompt(
            "sandbox:default",
            [host("local:workspace", "local", "主机环境")],
            false
        );
        expect(text).not.toContain("terminal_open.type");
        expect(text).toContain("get_available_shell_host");
    });
});
