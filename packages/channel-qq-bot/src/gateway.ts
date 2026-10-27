import type { ChannelHealth } from "@nokoribi/channel-core";
import type { Logger } from "@nokoribi/shared";
import {
    GatewayConnection,
    type GatewayConnectionOptions,
    type InboundMessage as SdkInboundMessage,
} from "@tencent-connect/qqbot-nodejs/protocol";

import type { QqBotConfig, QqCredentials } from "./config.js";
import { createSdkLogger } from "./logger.js";
import type { QqGatewayClient, QqRestClient } from "./transport.js";

/** Intents required for C2C and group @ messages only. */
export const QQ_GROUP_AND_C2C_INTENTS: number = 1 << 25;

/** Options for the SDK-backed gateway wrapper. */
export interface QqGatewayOptions {
    readonly config: QqBotConfig;
    readonly credentials: QqCredentials;
    readonly rest: QqRestClient;
    readonly logger: Logger;
}

/** Build a geometric reconnect delay list bounded by `maxMs`. */
export function buildReconnectDelays(
    baseMs: number,
    maxMs: number
): readonly number[] {
    const base = Math.max(1, baseMs);
    const max = Math.max(base, maxMs);
    const delays: number[] = [];
    let value = base;
    while (value < max) {
        delays.push(value);
        value *= 2;
    }
    delays.push(max);
    return delays;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function gatewayFields(error: unknown): {
    readonly errorName?: string;
    readonly code?: number;
} {
    if (typeof error !== "object" || error === null) return {};
    const value = error as Record<string, unknown>;
    return {
        ...(typeof value.name === "string" ? { errorName: value.name } : {}),
        ...(typeof value.code === "number" ? { code: value.code } : {}),
    };
}

/**
 * Gateway lifecycle wrapper around the SDK's `GatewayConnection`.
 *
 * The connection runs in the background. `start()` waits for the first
 * READY/RESUMED up to `connectTimeoutMs`, then returns even if the gateway is
 * still reconnecting; daemon readiness must not depend on QQ.
 */
export class QqGateway implements QqGatewayClient {
    private readonly config: QqBotConfig;
    private readonly credentials: QqCredentials;
    private readonly rest: QqRestClient;
    private readonly logger: Logger;
    private controller: AbortController | undefined;
    private run: Promise<void> | undefined;
    private ready: Promise<void> | undefined;
    private resolveReady: (() => void) | undefined;
    private state: ChannelHealth["state"] = "offline";
    private detail: string | undefined;
    private stopped = false;

    constructor(options: QqGatewayOptions) {
        this.config = options.config;
        this.credentials = options.credentials;
        this.rest = options.rest;
        this.logger = options.logger;
    }

    async start(
        onInbound: (message: SdkInboundMessage) => void
    ): Promise<void> {
        if (this.ready !== undefined) return await this.ready;
        this.stopped = false;
        this.state = "connecting";
        this.ready = new Promise((resolve) => {
            this.resolveReady = resolve;
        });
        const controller = new AbortController();
        this.controller = controller;
        const options: GatewayConnectionOptions = {
            account: {
                accountId: this.credentials.appId,
                appId: this.credentials.appId,
                clientSecret: this.credentials.clientSecret,
                markdownSupport: this.config.markdown !== "none",
            },
            abortSignal: controller.signal,
            log: createSdkLogger(this.logger),
            getAccessToken: () => this.rest.getAccessToken(),
            clearTokenCache: () => {
                this.rest.clearTokenCache();
            },
            getGatewayUrl: () => this.rest.getGatewayUrl(),
            intents: QQ_GROUP_AND_C2C_INTENTS,
            reconnect: {
                delays: buildReconnectDelays(
                    this.config.reconnectBaseMs,
                    this.config.reconnectMaxMs
                ),
            },
            handshakeTimeoutMs: this.config.connectTimeoutMs,
            onReady: () => {
                this.setOnline();
            },
            onResumed: () => {
                this.setOnline();
            },
            onError: (error: Error) => {
                if (this.stopped) return;
                this.state = "connecting";
                this.detail = "gateway error";
                this.logger.warn("qq bot gateway error", gatewayFields(error));
            },
            onDisconnected: (event) => {
                if (this.stopped) return;
                this.state = event.willReconnect ? "connecting" : "offline";
                this.detail = `close ${event.code}`;
                this.logger.warn("qq bot gateway disconnected", {
                    code: event.code,
                    reconnect: event.willReconnect,
                });
                if (!event.willReconnect) this.resolveReady?.();
            },
            onMessage: (message) => {
                onInbound(message);
            },
            onInteraction: () => {
                this.logger.debug("qq bot interaction ignored");
            },
            onRawEvent: (type) => {
                this.logger.debug("qq bot event ignored", { event: type });
            },
        };
        const connection = new GatewayConnection(options);
        this.run = connection
            .start()
            .then(() => {
                this.state = "offline";
            })
            .catch((error: unknown) => {
                if (this.stopped) return;
                this.state = "offline";
                this.detail = "gateway stopped";
                this.logger.error(
                    "qq bot gateway stopped",
                    gatewayFields(error)
                );
            })
            .finally(() => {
                this.resolveReady?.();
            });

        await Promise.race([this.ready, delay(this.config.connectTimeoutMs)]);
        if (!this.isOnline()) {
            this.logger.warn(
                "qq bot gateway not ready; continuing in background",
                {
                    timeoutMs: this.config.connectTimeoutMs,
                }
            );
        }
        this.ready = Promise.resolve();
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.state = "offline";
        this.detail = "stopped";
        this.controller?.abort();
        const running = this.run;
        if (running !== undefined) {
            await Promise.race([running, delay(5000)]);
        }
    }

    health(): ChannelHealth {
        return {
            state: this.state,
            ...(this.detail === undefined ? {} : { detail: this.detail }),
        };
    }

    private isOnline(): boolean {
        return this.state === "online";
    }

    private setOnline(): void {
        if (this.stopped) return;
        this.state = "online";
        this.detail = undefined;
        this.resolveReady?.();
    }
}
