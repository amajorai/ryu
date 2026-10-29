import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BOOTSTRAP = new URL("./plugin_host_bootstrap.mjs", import.meta.url);

async function waitForHealthy(port) {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`, {
				headers: { authorization: "Bearer test-token" },
			});
			if (response.ok) {
				return;
			}
		} catch {
			// The child is still binding or activating.
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("extension host did not become healthy");
}

test("node extension host forwards async response chunks incrementally", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ryu-host-test-"));
	const entry = join(dir, "backend.mjs");
	await writeFile(
		entry,
		`export async function activate(ctx) {
			ctx.http.onRequest(() => ({
				status: 200,
				headers: { "content-type": "text/event-stream" },
				stream: (async function* () {
					yield "data: first\\n\\n";
					yield await new Promise((resolve) => setTimeout(() => resolve("data: second\\n\\n"), 250));
				})(),
			}));
		}
		`,
		"utf8"
	);

	const port = 49_000 + Math.floor(Math.random() * 500);
	const child = spawn(process.execPath, [BOOTSTRAP.pathname], {
		env: {
			...process.env,
			RYU_HOST_ENTRY: entry,
			RYU_HOST_PORT: String(port),
			RYU_HOST_HEALTH_PATH: "/health",
			RYU_EXT_PLUGIN_ID: "com.test.stream",
			RYU_EXT_TOKEN: "test-token",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	try {
		try {
			await waitForHealthy(port);
		} catch (error) {
			throw new Error(`${error.message}\nchild stderr: ${stderr}`);
		}
		const response = await fetch(`http://127.0.0.1:${port}/stream`, {
			headers: { authorization: "Bearer test-token" },
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/event-stream");

		const reader = response.body?.getReader();
		assert.ok(reader, "stream response should have a body");
		const first = await Promise.race([
			reader.read(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("first chunk was buffered")), 150)
			),
		]);
		assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");

		const second = await reader.read();
		assert.equal(new TextDecoder().decode(second.value), "data: second\n\n");
		assert.equal((await reader.read()).done, true);
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			once(child, "exit"),
			new Promise((resolve) => setTimeout(resolve, 500)),
		]);
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await once(child, "exit").catch(() => undefined);
		}
		await rm(dir, { recursive: true, force: true });
	}
});

test("node extension host preserves native stream receivers and status accessor reads", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ryu-host-reader-test-"));
	const entry = join(dir, "backend.mjs");
	await writeFile(
		entry,
		`export function activate(ctx) {
		if (this !== undefined) throw new Error("activation receiver changed");
		ctx.http.onRequest(() => {
			let statusReads = 0;
			let readerReads = 0;
			const stream = {
				get getReader() {
					readerReads++;
					return function () {
						if (this !== stream) throw new Error("stream receiver changed");
						let sent = false;
						const reader = {
							async read() {
								if (this !== reader) throw new Error("reader receiver changed");
								if (sent) return {done:true};
								sent = true;
								return {done:false,value: String(statusReads) + ":" + String(readerReads)};
							},
							releaseLock() {
								if (this !== reader) throw new Error("lock receiver changed");
								process.stderr.write("reader lock released\\n");
							}
						};
						return reader;
					};
				}
			};
			return {get status() {statusReads++;return statusReads === 1 ? 201 : 202;}, stream};
		});
	}`,
		"utf8"
	);
	const port = 49_500 + Math.floor(Math.random() * 500);
	const child = spawn(process.execPath, [BOOTSTRAP.pathname], {
		env: {
			...process.env,
			RYU_HOST_ENTRY: entry,
			RYU_HOST_PORT: String(port),
			RYU_EXT_PLUGIN_ID: "com.test.reader",
			RYU_EXT_TOKEN: "test-token",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	try {
		await waitForHealthy(port);
		const denied = await fetch(`http://127.0.0.1:${port}/reader`);
		assert.equal(denied.status, 401);
		const response = await fetch(`http://127.0.0.1:${port}/reader`, {
			headers: { authorization: "Bearer test-token" },
		});
		assert.equal(response.status, 202);
		assert.equal(await response.text(), "2:2");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.match(stderr, /reader lock released/);
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			once(child, "exit"),
			new Promise((resolve) => setTimeout(resolve, 500)),
		]);
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await once(child, "exit").catch(() => undefined);
		}
		await rm(dir, { recursive: true, force: true });
	}
});
