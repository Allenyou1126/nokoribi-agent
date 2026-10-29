import type { ChannelHealth } from "@nokoribi/channel-core";
import type {
    ChatScope,
    InboundMessage as SdkInboundMessage,
    InteractionEvent,
    MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";

/** REST operations used by the QQ driver. */
export interface QqRestClient {
    /** Send one raw message body to a C2C user or group. */
    send(
        scope: ChatScope,
        targetId: string,
        body: Record<string, unknown>
    ): Promise<MessageResponse>;
    /** Acknowledge one interaction callback; code 0 succeeds, 1 fails. */
    ackInteraction(interactionId: string, code: 0 | 1): Promise<void>;
    /** Resolve the WebSocket gateway URL. */
    getGatewayUrl(): Promise<string>;
    /** Return a cached or freshly fetched access token. */
    getAccessToken(): Promise<string>;
    /** Drop the cached token after an authentication failure. */
    clearTokenCache(): void;
    /** Stop background token refresh. */
    stop(): void;
}

/** Event callbacks consumed by the QQ driver. */
export interface QqGatewayHandlers {
    /** One normalized inbound message or group @ event. */
    onInbound(message: SdkInboundMessage): void;
    /** One INTERACTION_CREATE event; may acknowledge asynchronously. */
    onInteraction(event: InteractionEvent): void | Promise<void>;
}

/** Gateway lifecycle surface used by the QQ driver. */
export interface QqGatewayClient {
    /** Start the connection; resolves after READY or the bounded wait. */
    start(handlers: QqGatewayHandlers): Promise<void>;
    /** Stop the connection and cancel reconnect timers. */
    stop(): Promise<void>;
    /** Current connection health. */
    health(): ChannelHealth;
    /** Whether button callbacks are subscribed and usable right now. */
    interactionAvailable(): boolean;
}
