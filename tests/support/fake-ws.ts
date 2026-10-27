import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One server-side WebSocket connection. */
export class FakeWsConnection {
    private readonly socket: Duplex;
    private buffer: Buffer = Buffer.alloc(0);
    private closed = false;
    onText: ((text: string) => void) | undefined;
    onClose: ((code: number) => void) | undefined;

    constructor(socket: Duplex) {
        this.socket = socket;
        this.socket.on("data", (chunk: Buffer) => {
            this.feed(chunk);
        });
        this.socket.on("error", () => {
            this.closed = true;
        });
        this.socket.on("close", () => {
            this.closed = true;
        });
    }

    feed(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
    }

    sendText(text: string): void {
        this.writeFrame(0x1, Buffer.from(text, "utf8"));
    }

    sendJson(value: unknown): void {
        this.sendText(JSON.stringify(value));
    }

    sendClose(code = 1000, reason = ""): void {
        const reasonBytes = Buffer.from(reason, "utf8");
        const payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
        this.writeFrame(0x8, payload);
        this.socket.end();
    }

    destroy(): void {
        this.closed = true;
        this.socket.destroy();
    }

    private writeFrame(opcode: number, payload: Buffer): void {
        if (this.closed) return;
        const length = payload.length;
        let header: Buffer;
        if (length < 126) {
            header = Buffer.from([0x80 | opcode, length]);
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        this.socket.write(Buffer.concat([header, payload]));
    }

    private drain(): void {
        for (;;) {
            if (this.buffer.length < 2) return;
            const first = this.buffer[0] ?? 0;
            const second = this.buffer[1] ?? 0;
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffer.length < 4) return;
                length = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (this.buffer.length < 10) return;
                const value = this.buffer.readBigUInt64BE(2);
                if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
                    this.destroy();
                    return;
                }
                length = Number(value);
                offset = 10;
            }
            if (masked) {
                if (this.buffer.length < offset + 4 + length) return;
            } else if (this.buffer.length < offset + length) {
                return;
            }
            const mask = masked
                ? this.buffer.subarray(offset, offset + 4)
                : undefined;
            if (masked) offset += 4;
            const payload = Buffer.from(
                this.buffer.subarray(offset, offset + length)
            );
            this.buffer = this.buffer.subarray(offset + length);
            if (mask !== undefined) {
                for (let index = 0; index < payload.length; index += 1) {
                    payload[index] =
                        (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
                }
            }
            if (!fin) {
                this.destroy();
                return;
            }
            if (opcode === 0x1) {
                this.onText?.(payload.toString("utf8"));
            } else if (opcode === 0x8) {
                const code =
                    payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
                this.onClose?.(code);
                this.sendClose(code);
                return;
            } else if (opcode === 0x9) {
                this.writeFrame(0xa, payload);
            }
        }
    }
}

/** Minimal dependency-free WebSocket server for driver/gateway tests. */
export class FakeWsServer {
    readonly server: Server;
    readonly connections: FakeWsConnection[] = [];
    onConnection: ((connection: FakeWsConnection) => void) | undefined;
    onText: ((text: string, connection: FakeWsConnection) => void) | undefined;
    private readonly sockets = new Set<Duplex>();

    private constructor(server: Server) {
        this.server = server;
        server.on("upgrade", (request, socket) => {
            this.handleUpgrade(request, socket);
        });
    }

    static async start(): Promise<FakeWsServer> {
        const server = createServer();
        const fake = new FakeWsServer(server);
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });
        return fake;
    }

    get url(): string {
        const address = this.server.address();
        if (address === null || typeof address === "string") {
            throw new Error("fake websocket server is not listening");
        }
        return `ws://127.0.0.1:${String(address.port)}/websocket`;
    }

    get connection(): FakeWsConnection | undefined {
        return this.connections[0];
    }

    async close(): Promise<void> {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve());
        });
    }

    private handleUpgrade(request: IncomingMessage, socket: Duplex): void {
        const key = request.headers["sec-websocket-key"];
        if (typeof key !== "string") {
            socket.destroy();
            return;
        }
        const accept = createHash("sha1")
            .update(`${key}${WEBSOCKET_GUID}`)
            .digest("base64");
        socket.write(
            [
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${accept}`,
                "",
                "",
            ].join("\r\n")
        );
        this.sockets.add(socket);
        socket.on("close", () => {
            this.sockets.delete(socket);
        });
        const connection = new FakeWsConnection(socket);
        connection.onText = (text) => {
            this.onText?.(text, connection);
        };
        this.connections.push(connection);
        this.onConnection?.(connection);
    }
}
