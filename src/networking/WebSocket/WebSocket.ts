import type { IncomingMessage, Server } from "http";
import WS from "ws";
import { WSCloseCodes, WSCloseMessage, WSEvents, WSOpCodes } from "../../Utils/Constants";
import { Util } from "../../Utils/Util";
import { MessagePayload } from "../../types/types";
import { Client } from "../../audio/Client";
import { GatewayDispatchEvents } from "discord-api-types/v8";
import clients from "./clients";
import { randomBytes } from "crypto";

class WebSocket {
    public ws: WS.Server;
    public ondebug: (message: string) => any = Util.noop; // eslint-disable-line @typescript-eslint/no-explicit-any

    constructor(public readonly password: string, public readonly blockedIP: string[] = [], public readonly httpServer: Server, public readonly updateStatusInterval: number) {
        this.debug("Initializing WebSocket server...");

        this.ws = new WS.Server({
            server: this.httpServer,
            perMessageDeflate: false
        });

        this.ws.on("connection", this.handleConnection.bind(this));
    }

    private handleConnection(ws: WS, request: IncomingMessage) {
        if (this.blockedIP?.includes((request.headers["x-forwarded-for"] || request.socket.remoteAddress) as string)) {
            this.debug("Got connection request from blocked ip");
            return ws.close(WSCloseCodes.NOT_ALLOWED, WSCloseMessage.NOT_ALLOWED);
        }
        const clientID = request.headers["client-id"] as string;
        if (!clientID) return ws.close(WSCloseCodes.NO_CLIENT_ID, WSCloseMessage.NO_CLIENT_ID);
        if (this.password && request.headers.authorization !== this.password) {
            this.debug("Got unauthorized connection request");
            return ws.close(WSCloseCodes.NO_AUTH, WSCloseMessage.NO_AUTH);
        }
        if (clients.has(clientID)) {
            const previousSocket = clients.get(clientID)?.socket;
            if (previousSocket && previousSocket.readyState !== previousSocket.CLOSED) {
                this.debug(`Session expired for socket ${clientID}`);
                previousSocket.close(WSCloseCodes.SESSION_EXPIRED, WSCloseMessage.SESSION_EXPIRED);
            }
        }

        // just in case
        Object.defineProperty(ws, "__client_id__", {
            value: clientID
        });

        this.send(ws, {
            op: WSOpCodes.HELLO,
            d: {
                ready: Date.now()
            }
        });

        this.debug(`HELLO dispatched to ${clientID}`);

        ws.on("message", this.handleWSMessage.bind(this, ws));
        ws.on("close", (code, reason) => {
            this.debug(`Connection was closed for "${clientID}" with the code "${code}" and reason "${reason || "No reason"}"`);
            try {
                const subclient = clients.get(clientID);
                subclient?.subscriptions.forEach((s) => subclient.kill(s.guildID));
            } catch {} // eslint-disable-line no-empty
            clients.delete(clientID);
        });
    }

    private handleWSMessage(ws: WS, msg: WS.Data) {
        const message = Util.parse<MessagePayload>(msg);

        if (!message) {
            this.debug(`client ${this.getID(ws)} sent an invalid payload!`);
            return ws.close(WSCloseCodes.DECODE_ERROR, WSCloseMessage.DECODE_ERROR);
        }

        if (message.op === 10) {
            this.debug(`${this.getID(ws)} sent identification payload`);
            if (clients.has(this.getID(ws))) {
                this.debug(`Closed connection for ${this.getID(ws)} for sending identification twice`);
                return ws.close(WSCloseCodes.ALREADY_CONNECTED, WSCloseMessage.ALREADY_CONNECTED);
            }
            const secret_key = `${Buffer.from(this.getID(ws)).toString("base64")}.${Date.now()}.${randomBytes(32).toString("hex")}`;
            const wsClient = new Client(ws, secret_key, this.updateStatusInterval);
            clients.set(this.getID(ws), wsClient);

            this.send(ws, {
                t: WSEvents.READY,
                d: {
                    client_id: wsClient.id,
                    access_token: secret_key
                }
            });
            return this.debug(`READY dispatched to ${wsClient.id}`);
        }

        const client = clients.get(this.getID(ws));
        if (!client) {
            this.debug(`Got payload from unidentified client ${this.getID(ws)}`);
            return ws.close(WSCloseCodes.NOT_IDENTIFIED, WSCloseMessage.NOT_IDENTIFIED);
        }

        switch (message.t) {
            case GatewayDispatchEvents.VoiceStateUpdate:
                {
                    if (message.d.guild_id && message.d.session_id && message.d.user_id === this.getID(client.socket)) {
                        const adapter = client.adapters.get(message.d.guild_id);
                        adapter?.onVoiceStateUpdate(message.d);
                    }
                }
                break;
            case GatewayDispatchEvents.VoiceServerUpdate:
                {
                    const adapter = client.adapters.get(message.d.guild_id);
                    adapter?.onVoiceServerUpdate(message.d);
                }
                break;
            default:
                break;
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(ws: WS, data: any) {
        return ws.send(JSON.stringify(data), Util.noop);
    }

    close() {
        this.debug("Closing the server...");

        this.ws.clients.forEach((client) => {
            if (client.readyState !== client.OPEN) return;
            client.close(WSCloseCodes.SERVER_CLOSED, WSCloseMessage.SERVER_CLOSED);
        });

        this.ws.close(Util.noop);
        clients.clear();
    }

    private getID(ws: WS) {
        return (ws as any)["__client_id__"]; // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    debug(msg: string) {
        try {
            this.ondebug.call(this, `[${this.time}] | ${msg}\n`);
        } catch {} // eslint-disable-line no-empty
    }

    get time() {
        return new Date().toLocaleString();
    }
}

export { WebSocket };
