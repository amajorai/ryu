import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	type DownloadBinaryOptions,
	downloadBinary,
} from "../core/bootstrap.ts";

const ASSET = "ryu-core-linux-x86_64";
const realFetch = globalThis.fetch;
const servers: ReturnType<typeof Bun.serve>[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

type ReleaseHandler = (pathname: string) => Response | Promise<Response>;

/** Serve release URLs from a local fixture so no test reaches GitHub. */
function releaseFetcher(handle: ReleaseHandler): typeof fetch {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => handle(new URL(request.url).pathname),
	});
	servers.push(server);
	return Object.assign(
		(
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const destination = new URL(new Request(input, init).url);
			destination.host = server.url.host;
			destination.protocol = server.url.protocol;
			return realFetch(destination, init);
		},
		{ preconnect: realFetch.preconnect }
	);
}

async function binDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ryu-cli-bootstrap-"));
	directories.push(directory);
	return directory;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Stream `bytes` in delayed chunks so concurrent downloads overlap. */
function slowBody(
	bytes: Uint8Array,
	chunks: number,
	delayMs = 10
): ReadableStream<Uint8Array> {
	const size = Math.ceil(bytes.byteLength / chunks);
	let offset = 0;
	return new ReadableStream({
		async pull(controller) {
			if (offset >= bytes.byteLength) {
				controller.close();
				return;
			}
			await Bun.sleep(delayMs);
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}

function options(
	directory: string,
	fetcher: typeof fetch,
	extra: Partial<DownloadBinaryOptions> = {}
): DownloadBinaryOptions {
	return {
		arch: "x64",
		binDir: directory,
		fetcher,
		platform: "linux",
		...extra,
	};
}

test("rejects a binary that does not match its published checksum", async () => {
	const directory = await binDir();
	const binary = new Uint8Array([1, 2, 3, 4]);
	const fetcher = releaseFetcher((pathname) => {
		if (pathname.endsWith(`/${ASSET}.sha256`)) {
			return new Response(`${sha256(new Uint8Array([9]))}  ${ASSET}\n`);
		}
		if (pathname.endsWith(`/${ASSET}`)) {
			return new Response(binary);
		}
		return new Response("unexpected", { status: 404 });
	});

	await expect(
		downloadBinary("core", options(directory, fetcher))
	).rejects.toThrow(/checksum mismatch/);
	expect(await readdir(directory)).toEqual([]);
});

test("refuses to install when the checksum is missing or names another asset", async () => {
	const directory = await binDir();
	const requested: string[] = [];
	let checksum: Response | null = null;
	const fetcher = releaseFetcher((pathname) => {
		requested.push(pathname);
		if (pathname.endsWith(".sha256") && checksum) {
			return checksum;
		}
		if (pathname.endsWith(`/${ASSET}`)) {
			return new Response(new Uint8Array([1]));
		}
		return new Response("not found", { status: 404 });
	});

	await expect(
		downloadBinary("core", options(directory, fetcher))
	).rejects.toThrow(/refusing to install an unverified binary/);
	expect(requested.some((pathname) => pathname.endsWith(`/${ASSET}`))).toBe(
		false
	);

	checksum = new Response(`${sha256(new Uint8Array([1]))}  other-asset\n`);
	await expect(
		downloadBinary("core", options(directory, fetcher))
	).rejects.toThrow(/malformed checksum/);
	expect(await readdir(directory)).toEqual([]);
});

test("concurrent first-run downloads both resolve to one verified binary", async () => {
	const directory = await binDir();
	const binary = crypto.getRandomValues(new Uint8Array(64 * 1024));
	const expected = sha256(binary);
	const fetcher = releaseFetcher((pathname) => {
		if (pathname.endsWith(`/${ASSET}.sha256`)) {
			return new Response(`${expected}  ${ASSET}\n`);
		}
		if (pathname.endsWith(`/${ASSET}`)) {
			return new Response(slowBody(binary, 8));
		}
		return new Response("unexpected", { status: 404 });
	});

	const [first, second] = await Promise.all([
		downloadBinary("core", options(directory, fetcher)),
		downloadBinary("core", options(directory, fetcher)),
	]);

	expect(first).toBe(second);
	expect(sha256(await readFile(first))).toBe(expected);
	if (process.platform !== "win32") {
		expect((await stat(first)).mode & 0o777).toBe(0o755);
	}
	expect(await readdir(directory)).toEqual([basename(first)]);
});

test("a stalled download times out instead of hanging launch", async () => {
	const directory = await binDir();
	const binary = new Uint8Array([7, 7, 7]);
	const fetcher = releaseFetcher((pathname) => {
		if (pathname.endsWith(`/${ASSET}.sha256`)) {
			return new Response(`${sha256(binary)}  ${ASSET}\n`);
		}
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(binary.slice(0, 1));
				},
			})
		);
	});

	const started = Date.now();
	await expect(
		downloadBinary("core", options(directory, fetcher, { stallTimeoutMs: 50 }))
	).rejects.toThrow(/no data for 50ms/);
	expect(Date.now() - started).toBeLessThan(5000);
	expect(await readdir(directory)).toEqual([]);
});

test("a slow download that keeps making progress outlives the stall timeout", async () => {
	const directory = await binDir();
	const binary = crypto.getRandomValues(new Uint8Array(8 * 1024));
	const expected = sha256(binary);
	const fetcher = releaseFetcher((pathname) => {
		if (pathname.endsWith(`/${ASSET}.sha256`)) {
			return new Response(`${expected}  ${ASSET}\n`);
		}
		return new Response(slowBody(binary, 8, 40));
	});

	const installed = await downloadBinary(
		"core",
		options(directory, fetcher, { stallTimeoutMs: 150 })
	);
	expect(sha256(await readFile(installed))).toBe(expected);
});

test("a progressing download still stops at the overall ceiling", async () => {
	const directory = await binDir();
	const binary = crypto.getRandomValues(new Uint8Array(8 * 1024));
	const fetcher = releaseFetcher((pathname) => {
		if (pathname.endsWith(`/${ASSET}.sha256`)) {
			return new Response(`${sha256(binary)}  ${ASSET}\n`);
		}
		return new Response(slowBody(binary, 64, 20));
	});

	await expect(
		downloadBinary(
			"core",
			options(directory, fetcher, { stallTimeoutMs: 5000, timeoutMs: 200 })
		)
	).rejects.toThrow();
	expect(await readdir(directory)).toEqual([]);
});
