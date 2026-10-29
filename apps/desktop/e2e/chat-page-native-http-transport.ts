import { readFileSync } from "node:fs";
export function createTransportDiagnostics() {
	const requests: Array<{
		request: Request;
		server: Bun.Server<undefined>;
		peer: ReturnType<Bun.Server<undefined>["requestIP"]>;
		bornAtMs: number;
		node: string;
	}> = [];
	return {
		record(request: Request, node: string, server?: Bun.Server<undefined>) {
			if (server) {
				requests.push({
					request,
					server,
					peer: server.requestIP(request),
					bornAtMs: Date.now(),
					node,
				});
			}
		},
		snapshot() {
			let rows: string[][] | null = null;
			let reason: string | null = null;
			try {
				if (process.platform !== "linux") {
					throw new Error("Linux /proc/net/tcp unavailable");
				}
				rows = readFileSync("/proc/net/tcp", "utf8")
					.trim()
					.split("\n")
					.slice(1)
					.map((line) => line.trim().split(/\s+/));
			} catch (error) {
				reason = error instanceof Error ? error.message : String(error);
			}
			return requests.map(
				({ request, server, peer, bornAtMs, node }, index) => {
					const local = `0100007F:${server.port!.toString(16).padStart(4, "0").toUpperCase()}`;
					const remote = peer
						? `0100007F:${peer.port.toString(16).padStart(4, "0").toUpperCase()}`
						: null;
					return {
						id: index + 1,
						node,
						method: request.method,
						url: request.url,
						bornAtMs,
						headers: Object.fromEntries(request.headers.entries()),
						signalAborted: request.signal.aborted,
						localPort: server.port,
						peer,
						observedPeer: server.requestIP(request),
						kernelTcp:
							rows && peer?.address === "127.0.0.1"
								? {
										supported: true,
										states: rows
											.filter((row) => row[1] === local && row[2] === remote)
											.map((row) => row[3]),
									}
								: {
										supported: false,
										reason: reason ?? "Owned IPv4 loopback peer unavailable",
									},
					};
				}
			);
		},
	};
}
