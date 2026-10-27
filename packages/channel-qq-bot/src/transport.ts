import type { ChannelHealth } from "@nokoribi/channel-core";
import type {
    ChatScope,
    InboundMessage as SdkInboundMessage,
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
    /** Resolve the WebSocket gateway URL. */
    getGatewayUrl(): Promise<string>;
    /** Return a cached or freshly fetched access token. */
    getAccessToken(): Promise<string>;
    /** Drop the cached token after an authentication failure. */
    clearTokenCache(): void;
    /** Stop background token refresh. */
    stop(): void;
}

/** Gateway lifecycle surface used by the QQ driver. */
export interface QqGatewayClient {
    /** Start the connection; resolves after READY or the bounded wait. */
    start(onInbound: (message: SdkInboundMessage) => void): Promise<void>;
    /** Stop the connection and cancel reconnect timers. */
    stop(): Promise<void>;
    /** Current connection health. */
    health(): ChannelHealth;
}
