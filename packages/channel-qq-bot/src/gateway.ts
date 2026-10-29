import type { ChannelHealth } from "@nokoribi/channel-core";
import type { Logger } from "@nokoribi/shared";
import {
    GatewayConnection,
    type GatewayConnectionOptions,
    type InteractionEvent,
} from "@tencent-connect/qqbot-nodejs/protocol";

import {
    resolveInteractionButtons,
    type QqBotConfig,
    type QqCredentials,
} from "./config.js";
import { createSdkLogger } from "./logger.js";
import type {
    QqGatewayClient,
    QqGatewayHandlers,
    QqRestClient,
} from "./transport.js";

/** Intents required for C2C and group @ messages only. */
export const QQ_GROUP_AND_C2C_INTENTS: number = 1 << 25;

/** Intent required for button interaction callbacks. */
export const QQ_INTERACTION_INTENT: number = 1 << 26;

/** Full intent mask used when approval buttons are enabled. */
export const QQ_GROUP_AND_C2C_AND_INTERACTION_INTENTS: number =
    QQ_GROUP_AND_C2C_INTENTS | QQ_INTERACTION_INTENT;

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

function isInteractionClose(code: number | undefined): boolean {
    return code === 4014 || code === 4914 || code === 4915;
}

/**
 * Gateway lifecycle wrapper around the SDK's `GatewayConnection`.
 *
 * The connection runs in the background. `start()` waits for the first
 * READY/RESUMED up to `connectTimeoutMs`, then returns even if the gateway is
 * still reconnecting; daemon readiness must not depend on QQ.
 *
 * When approval buttons are enabled the connection subscribes to the
 * interaction intent. If the platform rejects that intent before the first
 * READY (4014/4914/4915), the wrapper retires the connection and reconnects
 * once with the message intents only; capabilities then turn off and text
 * approvals keep working.
 */
export class QqGateway implements QqGatewayClient {
    private readonly config: QqBotConfig;
    private readonly credentials: QqCredentials;
    private readonly rest: QqRestClient;
    private readonly logger: Logger;
    private handlers: QqGatewayHandlers | undefined;
    private controller: AbortController | undefined;
    private run: Promise<void> | undefined;
    private ready: Promise<void> | undefined;
    private resolveReady: (() => void) | undefined;
    private state: ChannelHealth["state"] = "offline";
    private detail: string | undefined;
    private stopped = false;
    private everReady = false;
    private interactionDegraded = false;
    private degrading = false;
    private generation = 0;

    constructor(options: QqGatewayOptions) {
        this.config = options.config;
        this.credentials = options.credentials;
        this.rest = options.rest;
        this.logger = options.logger;
    }

    async start(handlers: QqGatewayHandlers): Promise<void> {
        if (this.ready !== undefined) return await this.ready;
        this.handlers = handlers;
        this.stopped = false;
        this.state = "connecting";
        this.ready = new Promise((resolve) => {
            this.resolveReady = resolve;
        });
        this.launch(
            resolveInteractionButtons(this.config)
                ? QQ_GROUP_AND_C2C_AND_INTERACTION_INTENTS
                : QQ_GROUP_AND_C2C_INTENTS
        );

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
        this.generation += 1;
        this.state = "offline";
        this.detail = "stopped";
        this.controller?.abort();
        const running = this.run;
        if (running !== undefined) {
            await Promise.race([running, delay(5000)]);
        }
    }

    health(): ChannelHealth {
        const details: string[] = [];
        if (this.detail !== undefined) details.push(this.detail);
        if (this.interactionDegraded) {
            details.push("interaction-intent-unavailable");
        }
        return {
            state: this.state,
            ...(details.length === 0 ? {} : { detail: details.join("; ") }),
        };
    }

    interactionAvailable(): boolean {
        return (
            resolveInteractionButtons(this.config) &&
            !this.interactionDegraded &&
            !this.stopped
        );
    }

    private launch(intents: number): void {
        this.generation += 1;
        const generation = this.generation;
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
            intents,
            reconnect: {
                delays: buildReconnectDelays(
                    this.config.reconnectBaseMs,
                    this.config.reconnectMaxMs
                ),
            },
            handshakeTimeoutMs: this.config.connectTimeoutMs,
            onReady: () => {
                if (generation !== this.generation) return;
                this.setOnline();
            },
            onResumed: () => {
                if (generation !== this.generation) return;
                this.setOnline();
            },
            onError: (error: Error) => {
                if (generation !== this.generation || this.stopped) return;
                this.state = "connecting";
                this.detail = "gateway error";
                this.logger.warn("qq bot gateway error", gatewayFields(error));
            },
            onDisconnected: (event) => {
                if (generation !== this.generation || this.stopped) return;
                this.state = event.willReconnect ? "connecting" : "offline";
                this.detail = `close ${event.code}`;
                this.logger.warn("qq bot gateway disconnected", {
                    code: event.code,
                    reconnect: event.willReconnect,
                });
                if (!event.willReconnect) this.resolveReady?.();
                this.maybeDegrade(event.code);
            },
            onMessage: (message) => {
                if (generation !== this.generation || this.stopped) return;
                this.handlers?.onInbound(message);
            },
            onInteraction: (event: InteractionEvent) =>
                this.forwardInteraction(event, generation),
            onRawEvent: (type) => {
                this.logger.debug("qq bot event ignored", { event: type });
            },
        };
        const connection = new GatewayConnection(options);
        this.run = connection
            .start()
            .then(() => {
                if (generation !== this.generation) return;
                this.state = "offline";
            })
            .catch((error: unknown) => {
                if (this.stopped || generation !== this.generation) return;
                this.state = "offline";
                this.detail = "gateway stopped";
                this.logger.error(
                    "qq bot gateway stopped",
                    gatewayFields(error)
                );
                this.maybeDegrade(gatewayFields(error).code);
            })
            .finally(() => {
                if (generation === this.generation) this.resolveReady?.();
            });
    }

    private forwardInteraction(
        event: InteractionEvent,
        generation: number
    ): void | Promise<void> {
        if (generation !== this.generation || this.stopped) return;
        return this.handlers?.onInteraction(event);
    }

    private maybeDegrade(code: number | undefined): void {
        if (
            this.stopped ||
            this.everReady ||
            this.interactionDegraded ||
            !resolveInteractionButtons(this.config) ||
            !isInteractionClose(code)
        ) {
            return;
        }
        void this.degrade();
    }

    private async degrade(): Promise<void> {
        if (this.degrading || this.stopped) return;
        this.degrading = true;
        this.interactionDegraded = true;
        this.logger.warn(
            "qq bot interaction intent unavailable; retrying without buttons",
            { intents: QQ_GROUP_AND_C2C_INTENTS }
        );
        this.generation += 1;
        this.controller?.abort();
        const running = this.run;
        if (running !== undefined) {
            await running.catch(() => undefined);
        }
        if (this.stopped) return;
        this.state = "connecting";
        this.detail = "interaction intent unavailable";
        this.launch(QQ_GROUP_AND_C2C_INTENTS);
    }

    private isOnline(): boolean {
        return this.state === "online";
    }

    private setOnline(): void {
        if (this.stopped) return;
        this.everReady = true;
        this.state = "online";
        this.detail = undefined;
        this.resolveReady?.();
    }
}
