import type { Context } from "@deepseek-ai/cordis";
import type {
    Profile,
    ProfileContext,
} from "@deepseek-ai/dsh-app-boot";
import type { LaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";

/** An application-owned profile and its independent installation fallback. */
export interface ResolvedProfileRuntime {
    profile: Profile;
    installAnchor: string;
}

/** Bounded process-shutdown controller used by the upstream boot path. */
export interface ProcessShutdown {
    shutdown(code: number): Promise<void>;
    interrupt(code: number): void;
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
    environment: LaunchEnvironmentSnapshot;
    profile: string;
    resolvedProfile?: ResolvedProfileRuntime | undefined;
    fromDefaultProfile?: string | undefined;
    patchFiles: readonly string[];
    args: readonly string[];
    packageManager?: ProfileContext["packageManager"];
}

export declare const PROFILE_ROOT_FILENAME = "cordis.yml";
export declare const INSTALL_ANCHOR: string;

export declare function homePatchPath(): string;
export declare function prepareProfile(
    name: string,
    userLayer?: boolean,
    fromDefaultProfile?: string,
): Profile;
export declare function initializeProfileFromDefault(
    name: string,
    fromDefaultProfile: string,
    home?: string,
): void;
export declare function runProfile(options: RunProfileOptions): Promise<{
    ctx: Context;
    shutdown: ProcessShutdown;
}>;
