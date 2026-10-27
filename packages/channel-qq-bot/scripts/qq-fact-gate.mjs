#!/usr/bin/env node
/**
 * QQ Open Platform fact-gate probe (development only, not shipped).
 *
 * This script never prints the client secret or access token. It exists to run
 * the 14 platform-fact gates in .spec/17 / .spec/notes before real acceptance.
 *
 * Usage:
 *   node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --token
 *   node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --gateway
 *   node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --watch
 *   node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --passive \
 *     --chat c2c:<openid> --message-id <event-id> --seq 1 --text "probe"
 *   node packages/channel-qq-bot/scripts/qq-fact-gate.mjs --active \
 *     --chat group:<group-openid> --text "probe"
 */

import {
    ApiClient,
    GatewayConnection,
    MessageApi,
    TokenManager,
} from "@tencent-connect/qqbot-nodejs/protocol";

const API_BASE =
    process.env.NOKORIBI_QQ_BOT_API_BASE ?? "https://api.bot.qq.com";
const TOKEN_BASE =
    process.env.NOKORIBI_QQ_BOT_TOKEN_BASE ?? "https://api.bot.qq.com";
const APP_ID = process.env.NOKORIBI_QQ_BOT_APP_ID ?? "";
const CLIENT_SECRET = process.env.NOKORIBI_QQ_BOT_CLIENT_SECRET ?? "";
const INTENTS = 1 << 25;

function parseArgs(argv) {
    const options = {
        token: false,
        gateway: false,
        watch: false,
        passive: false,
        active: false,
        chat: "",
        messageId: "",
        seq: 1,
        text: "fact-gate probe",
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--token") options.token = true;
        else if (arg === "--gateway") options.gateway = true;
        else if (arg === "--watch") options.watch = true;
        else if (arg === "--passive") options.passive = true;
        else if (arg === "--active") options.active = true;
        else if (arg === "--chat") options.chat = argv[++index] ?? "";
        else if (arg === "--message-id") {
            options.messageId = argv[++index] ?? "";
        } else if (arg === "--seq") options.seq = Number(argv[++index] ?? 1);
        else if (arg === "--text") options.text = argv[++index] ?? "";
        else if (arg === "--help" || arg === "-h") options.help = true;
        else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
    return options;
}

function usage() {
    process.stdout.write(
        [
            "QQ fact-gate probe; credentials come from:",
            "  NOKORIBI_QQ_BOT_APP_ID",
            "  NOKORIBI_QQ_BOT_CLIENT_SECRET",
            "Optional: NOKORIBI_QQ_BOT_API_BASE, NOKORIBI_QQ_BOT_TOKEN_BASE",
            "",
            "Modes: --token | --gateway | --watch | --passive | --active",
            "Passive fields: --chat c2c:<openid>|group:<openid> --message-id <id> --seq <n>",
        ].join("\n") + "\n"
    );
}

function requireCredentials() {
    if (APP_ID.trim() === "" || CLIENT_SECRET.trim() === "") {
        throw new Error(
            "set NOKORIBI_QQ_BOT_APP_ID and NOKORIBI_QQ_BOT_CLIENT_SECRET"
        );
    }
}

function parseChat(chat) {
    if (chat.startsWith("c2c:")) {
        return { scope: "c2c", targetId: chat.slice(4) };
    }
    if (chat.startsWith("group:")) {
        return { scope: "group", targetId: chat.slice(6) };
    }
    throw new Error("--chat must be c2c:<openid> or group:<openid>");
}

function client() {
    const tokens = new TokenManager({ baseUrl: TOKEN_BASE });
    const api = new ApiClient({
        baseUrl: API_BASE,
        defaultTimeoutMs: 10000,
    });
    const messages = new MessageApi(api, tokens, {
        markdownSupport: true,
    });
    return { tokens, messages };
}

async function probeToken(base) {
    const response = await fetch(`${base}/app/getAppAccessToken`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            appId: APP_ID,
            clientSecret: CLIENT_SECRET,
        }),
    });
    const text = await response.text();
    let parsed = {};
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = { raw: text.slice(0, 120) };
    }
    const safe = {
        base,
        httpStatus: response.status,
        ok: response.ok,
        hasAccessToken: typeof parsed.access_token === "string",
        expiresIn: parsed.expires_in ?? null,
        code: parsed.code ?? null,
        message: parsed.message ?? null,
    };
    process.stdout.write(`${JSON.stringify(safe)}\n`);
}

async function withGateway(handler) {
    const controller = new AbortController();
    const { tokens, messages } = client();
    const connection = new GatewayConnection({
        account: {
            accountId: APP_ID,
            appId: APP_ID,
            clientSecret: CLIENT_SECRET,
            markdownSupport: true,
        },
        abortSignal: controller.signal,
        getAccessToken: () => tokens.getAccessToken(APP_ID, CLIENT_SECRET),
        getGatewayUrl: () =>
            messages.getGatewayUrl({
                appId: APP_ID,
                clientSecret: CLIENT_SECRET,
            }),
        intents: INTENTS,
        onReady: (data) => {
            handler.ready?.(data);
        },
        onResumed: (data) => {
            handler.ready?.(data);
        },
        onError: (error) => {
            handler.error?.(error);
        },
        onDisconnected: (event) => {
            handler.disconnected?.(event);
        },
        onMessage: (message) => {
            handler.message?.(message);
        },
        onInteraction: () => {},
        onRawEvent: () => {},
    });
    const run = connection.start().catch((error) => {
        handler.error?.(error);
    });
    await handler.run?.(controller, run);
}

async function gatewayMode(watch) {
    let ready = false;
    const seen = [];
    await withGateway({
        ready(data) {
            ready = true;
            const sessionId =
                typeof data === "object" && data !== null
                    ? (data.session_id ?? data.sessionId ?? null)
                    : null;
            process.stdout.write(
                `${JSON.stringify({
                    event: "ready-or-resumed",
                    hasSessionId: typeof sessionId === "string",
                })}\n`
            );
        },
        error(error) {
            process.stdout.write(
                `${JSON.stringify({
                    event: "error",
                    name: error?.name ?? "Error",
                    message: String(error?.message ?? error).slice(0, 160),
                })}\n`
            );
        },
        disconnected(event) {
            process.stdout.write(
                `${JSON.stringify({
                    event: "disconnected",
                    code: event.code,
                    willReconnect: event.willReconnect,
                })}\n`
            );
        },
        message(message) {
            seen.push(message.rawEventType);
            process.stdout.write(
                `${JSON.stringify({
                    event: "message",
                    type: message.rawEventType,
                    kind: message.kind,
                    messageId: message.messageId,
                    contentLength: message.content.length,
                })}\n`
            );
        },
        async run(controller) {
            if (!watch) {
                const deadline = Date.now() + 30000;
                while (!ready && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            } else {
                process.stdout.write(
                    `${JSON.stringify({
                        event: "watching",
                        hint: "send a QQ message to the bot; press Ctrl+C to stop",
                    })}\n`
                );
                await new Promise((resolve) => {
                    process.once("SIGINT", resolve);
                });
            }
            controller.abort();
        },
    });
    process.stdout.write(
        `${JSON.stringify({ event: "done", messagesSeen: seen.length })}\n`
    );
}

async function sendMode(options) {
    const chat = parseChat(options.chat);
    const { messages } = client();
    const body = {
        msg_type: 0,
        content: options.text,
    };
    if (options.passive) {
        if (options.messageId.trim() === "") {
            throw new Error("--passive requires --message-id");
        }
        body.msg_id = options.messageId;
        body.msg_seq = Number.isFinite(options.seq) ? options.seq : 1;
    }
    try {
        const result = await messages.sendRaw(
            chat.scope,
            chat.targetId,
            { appId: APP_ID, clientSecret: CLIENT_SECRET },
            body
        );
        process.stdout.write(
            `${JSON.stringify({
                event: "sent",
                passive: options.passive,
                scope: chat.scope,
                messageId: result.id,
            })}\n`
        );
    } catch (error) {
        process.stdout.write(
            `${JSON.stringify({
                event: "send-failed",
                passive: options.passive,
                scope: chat.scope,
                name: error?.name ?? "Error",
                httpStatus: error?.httpStatus ?? null,
                bizCode: error?.bizCode ?? null,
                message: String(error?.message ?? error).slice(0, 200),
            })}\n`
        );
        process.exitCode = 1;
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        usage();
        return;
    }
    requireCredentials();
    if (options.token) {
        await probeToken("https://api.bot.qq.com");
        await probeToken("https://bots.qq.com");
        return;
    }
    if (options.watch) {
        await gatewayMode(true);
        return;
    }
    if (options.gateway) {
        await gatewayMode(false);
        return;
    }
    if (options.passive || options.active) {
        await sendMode(options);
        return;
    }
    usage();
}

main().catch((error) => {
    process.stderr.write(`qq-fact-gate: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
});
