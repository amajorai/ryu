// Host-side TCP relay for `ryu secrets run --broker … --isolation=container`.
//
// The broker listens only on the node's loopback interface, which a container
// cannot reach. The relay binds the per-invocation Docker network's gateway
// address (Linux) or host loopback (Docker Desktop, whose `host-gateway`
// reaches host loopback) on an ephemeral port and pipes each accepted
// connection to `127.0.0.1:<broker port>`. Because the relay dials loopback,
// the broker keeps seeing a loopback peer and needs no change; every request
// must still carry the `rvb_` session token.

import { connect, createServer, type Server, type Socket } from "node:net";

export interface Forwarder {
	/** Stops accepting, destroys open connections. Safe to call twice. */
	close: () => Promise<void>;
	/** Address the relay is bound to. */
	host: string;
	/** Ephemeral port the relay listens on. */
	port: number;
}

export interface ForwarderOptions {
	/** Returns false to drop a connection from `address` before relaying. */
	allowPeer?: (address: string) => boolean;
	bindHost: string;
	/** Upstream host; loopback unless a test overrides it. */
	upstreamHost?: string;
	upstreamPort: number;
}

/** Strips the IPv4-mapped IPv6 prefix (`::ffff:172.18.0.2`). */
export function normalizePeer(address: string): string {
	return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function relay(client: Socket, upstreamHost: string, upstreamPort: number) {
	const upstream = connect({ host: upstreamHost, port: upstreamPort });
	const closeBoth = () => {
		client.destroy();
		upstream.destroy();
	};
	client.on("error", closeBoth);
	upstream.on("error", closeBoth);
	client.on("close", closeBoth);
	upstream.on("close", closeBoth);
	client.pipe(upstream);
	upstream.pipe(client);
}

export function startForwarder(options: ForwarderOptions): Promise<Forwarder> {
	const upstreamHost = options.upstreamHost ?? "127.0.0.1";
	const sockets = new Set<Socket>();
	const server: Server = createServer((client) => {
		const peer = normalizePeer(client.remoteAddress ?? "");
		if (options.allowPeer && !options.allowPeer(peer)) {
			client.destroy();
			return;
		}
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		relay(client, upstreamHost, options.upstreamPort);
	});
	let closed: Promise<void> | null = null;
	const close = (): Promise<void> => {
		closed ??= new Promise<void>((resolve) => {
			for (const socket of sockets) {
				socket.destroy();
			}
			server.close(() => resolve());
		});
		return closed;
	};
	return new Promise<Forwarder>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: options.bindHost, port: 0 }, () => {
			server.off("error", reject);
			// A later accept error must not crash the CLI mid-run; the
			// affected connection simply fails.
			server.on("error", () => undefined);
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("the relay did not bind a TCP port"));
				return;
			}
			resolve({ host: options.bindHost, port: address.port, close });
		});
	});
}
