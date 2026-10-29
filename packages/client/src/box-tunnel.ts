#!/usr/bin/env node
// packages/client/src/box-tunnel.ts
//
// `box-tunnel <box-id> <port>` pipes stdin/stdout to a TCP port inside a Ryu
// Box. It is the SSH ProxyCommand the Box service hands out:
//
//   Host my-box
//     ProxyCommand npx -y -p @ryuhq/client box-tunnel box_123 2222
//
// It reads RYU_BOX_URL and RYU_BOX_API_KEY from the environment.

import { z } from "zod";
import { createBoxClient } from "./box.ts";

// The package does not depend on @types/node; this is the slice of Node's
// `process` the tunnel uses.
interface Readable {
	on(event: "data", listener: (chunk: Uint8Array) => void): void;
	on(event: "end", listener: () => void): void;
}
declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	exit(code: number): never;
	stderr: { write(text: string): void };
	stdin: Readable;
	stdout: { write(data: string | Uint8Array): void };
};

const USAGE =
	"Usage: box-tunnel <box-id> <port>\nEnvironment: RYU_BOX_URL, RYU_BOX_API_KEY";

async function main(): Promise<number> {
	const [boxId, portText] = process.argv.slice(2);
	const port = Number(portText);
	const baseUrl = process.env.RYU_BOX_URL;
	const apiKey = process.env.RYU_BOX_API_KEY;
	if (!(boxId && Number.isInteger(port) && port > 0 && baseUrl && apiKey)) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	// Node gained an unflagged global WebSocket in v22; fail clearly before it.
	if (!globalThis.WebSocket) {
		process.stderr.write(
			"box-tunnel: this runtime has no WebSocket; use Node 22 or newer, or Bun.\n"
		);
		return 1;
	}
	const client = createBoxClient({ apiKey, baseUrl });
	const socket = await client.openTunnel(boxId, port);
	return await new Promise<number>((resolve) => {
		socket.addEventListener("open", () => {
			process.stdin.on("data", (chunk: Uint8Array) =>
				socket.send(new Uint8Array(chunk))
			);
			process.stdin.on("end", () => socket.close());
		});
		socket.addEventListener("message", (event) => {
			const data = z
				.union([z.string(), z.instanceof(ArrayBuffer)])
				.parse(event.data);
			const text = z.string().safeParse(data);
			process.stdout.write(
				text.success
					? text.data
					: new Uint8Array(z.instanceof(ArrayBuffer).parse(data))
			);
		});
		socket.addEventListener("error", () => {
			process.stderr.write(`box-tunnel: could not reach ${boxId}:${port}\n`);
			resolve(1);
		});
		socket.addEventListener("close", () => resolve(0));
	});
}

main().then(
	(code) => process.exit(code),
	(error) => {
		process.stderr.write(
			`box-tunnel: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exit(1);
	}
);
