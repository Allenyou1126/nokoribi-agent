import type { ChannelHealth } from "@nokoribi/channel-core";
import type {
    ChatScope,
    InboundMessage as SdkInboundMessage,
    InteractionEvent,
    MessageResponse,
} from "@tencent-connect/qqbot-nodejs/protocol";

/** One downloaded inbound image. */
export interface DownloadedImage {
    readonly data: Uint8Array;
    /** Content type reported by the download response, when present. */
    readonly mime?: string;
}

/** Options bounding one inbound image download. */
export interface DownloadImageOptions {
    readonly maxBytes: number;
    readonly timeoutMs: number;
}

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
    /**
     * Download one platform-provided image URL with timeout and byte caps.
     * Optional so lightweight test doubles for non-media scenarios compile.
     */
    downloadImage?(
        url: string,
        options: DownloadImageOptions
    ): Promise<DownloadedImage>;
    /**
     * Upload one media file through the rich-media API.
     * @returns the platform `file_info` used by a `msg_type=7` message.
     */
    uploadMedia?(
        scope: ChatScope,
        targetId: string,
        body: Record<string, unknown>
    ): Promise<{ readonly file_info: string }>;
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
