import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { isNewerCliVersion, runCliAutoUpdate } from "../core/self-update.ts";

const target: ApiTarget = { url: "http://node:7980", token: "node-secret" };
const realFetch = globalThis.fetch;
const servers: ReturnType<typeof Bun.serve>[] = [];
type ResponseProvider = (
	...args: Parameters<typeof realFetch>
) => Response | Promise<Response>;

function installResponse(provide: ResponseProvider): void {
	const pending = new Map<string, () => Response | Promise<Response>>();
	let nextRequestId = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const id = request.headers.get("x-ryu-fixture-request") ?? "";
			const respond = pending.get(id);
			pending.delete(id);
			if (!respond) {
				throw new Error("Unexpected conversation fixture request");
			}
			return respond();
		},
	});
	servers.push(server);
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const request = new Request(input, init);
			const id = String(nextRequestId++);
			pending.set(id, () => provide(input, init));
			const destination = new URL(request.url);
			destination.host = server.url.host;
			destination.protocol = server.url.protocol;
			const forwarded = new Request(destination, request);
			forwarded.headers.set("x-ryu-fixture-request", id);
			return realFetch(forwarded).finally(() => pending.delete(id));
		},
		{ preconnect: realFetch.preconnect }
	);
}

let directory: string | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
	if (directory) {
		await rm(directory, { force: true, recursive: true });
		directory = null;
	}
});

async function executablePath(): Promise<string> {
	directory = await mkdtemp(join(tmpdir(), "ryu-cli-self-update-"));
	const path = join(
		directory,
		process.platform === "win32" ? "ryu-cli.exe" : "ryu-cli"
	);
	await writeFile(path, "old CLI", { mode: 0o755 });
	await chmod(path, 0o755);
	return path;
}

function preferenceResponse(enabled: boolean): Response {
	return new Response(JSON.stringify({ value: JSON.stringify({ enabled }) }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

// The complete native UpdateCheck verdict: core-client validates every field
// Core's publisher always serializes, including the nullable notes and asset.
function updateResponse(latest: string, tag: string): Response {
	return new Response(
		JSON.stringify({
			current: "0.4.0",
			latest,
			channel: "stable",
			update_available: true,
			notes: null,
			asset: null,
			tag,
			html_url: `https://github.com/amajorai/ryu/releases/tag/${tag}`,
		}),
		{ status: 200, headers: { "content-type": "application/json" } }
	);
}

test("compares stable and prerelease versions using semver precedence", () => {
	expect(isNewerCliVersion("0.5.0", "0.4.9")).toBe(true);
	expect(isNewerCliVersion("0.5.0", "0.5.0-rc.1")).toBe(true);
	expect(isNewerCliVersion("0.5.0-beta.2", "0.5.0-beta.1")).toBe(true);
	expect(isNewerCliVersion("0.5.0-beta.1", "0.5.0")).toBe(false);
	expect(isNewerCliVersion("not-a-version", "0.4.0")).toBe(false);
});

test("downloads, verifies, and stages the matching official CLI release", async () => {
	const path = await executablePath();
	const binary = new Uint8Array([0, 1, 2, 3, 255]);
	const hash = createHash("sha256").update(binary).digest("hex");
	const calls: string[] = [];
	installResponse(async (input) => {
		const url = new URL(String(input));
		calls.push(url.toString());
		if (url.pathname === "/api/preferences/auto-updates") {
			return preferenceResponse(true);
		}
		if (url.pathname === "/api/update/check") {
			expect(url.searchParams.get("channel")).toBe("stable");
			return updateResponse("0.5.0", "v0.5.0");
		}
		if (url.pathname.endsWith(".sha256")) {
			return new Response(`${hash}  ryu-cli-macos-aarch64\n`);
		}
		if (url.pathname.endsWith("/ryu-cli-macos-aarch64")) {
			return new Response(binary);
		}
		return new Response("unexpected request", { status: 404 });
	});

	const result = await runCliAutoUpdate(target, {
		arch: "arm64",
		executablePath: path,
		platform: "darwin",
		version: "0.4.0",
	});

	expect(result).toEqual({ status: "installed", version: "0.5.0" });
	expect(await readFile(path)).toEqual(Buffer.from(binary));
	expect(calls.some((url) => url.includes("/releases/download/v0.5.0/"))).toBe(
		true
	);
	await expect(readFile(`${path}.update`)).rejects.toThrow();
});

test("does not download when the shared preference is disabled", async () => {
	const path = await executablePath();
	const calls: string[] = [];
	installResponse(async (input) => {
		const url = String(input);
		calls.push(url);
		return preferenceResponse(false);
	});

	const result = await runCliAutoUpdate(target, {
		arch: "arm64",
		executablePath: path,
		platform: "darwin",
		version: "0.4.0",
	});

	expect(result).toEqual({ status: "disabled" });
	expect(calls).toHaveLength(1);
	expect(await readFile(path, "utf8")).toBe("old CLI");
});

test("refuses an asset whose release checksum does not match", async () => {
	const path = await executablePath();
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/preferences/auto-updates") {
			return preferenceResponse(true);
		}
		if (url.pathname === "/api/update/check") {
			return updateResponse("0.5.0", "v0.5.0");
		}
		if (url.pathname.endsWith(".sha256")) {
			return new Response(`${"0".repeat(64)}  ryu-cli-macos-aarch64\n`);
		}
		return new Response(new Uint8Array([1, 2, 3]));
	});

	const result = await runCliAutoUpdate(target, {
		arch: "arm64",
		executablePath: path,
		platform: "darwin",
		version: "0.4.0",
	});

	expect(result).toEqual({ status: "unavailable" });
	expect(await readFile(path, "utf8")).toBe("old CLI");
	await expect(readFile(`${path}.update`)).rejects.toThrow();
});

test("leaves source and unsupported platform runs untouched", async () => {
	const calls: string[] = [];
	installResponse(async (input) => {
		calls.push(String(input));
		return preferenceResponse(true);
	});

	const sourceRun = await runCliAutoUpdate(target, {
		executablePath: "/usr/local/bin/bun",
		platform: "darwin",
		arch: "arm64",
		version: "0.4.0",
	});
	const unsupported = await runCliAutoUpdate(target, {
		executablePath: "/opt/bin/ryu-cli",
		platform: "linux",
		arch: "arm64",
		version: "0.4.0",
	});

	expect(sourceRun).toEqual({ status: "not-applicable" });
	expect(unsupported).toEqual({ status: "not-applicable" });
	expect(calls).toHaveLength(0);
});

test("defers installation when the shared preference cannot be read", async () => {
	const path = await executablePath();
	installResponse(
		Object.assign(async () => new Response("unavailable", { status: 503 }), {
			preconnect: realFetch.preconnect,
		})
	);
	expect(
		await runCliAutoUpdate(target, {
			arch: "arm64",
			executablePath: path,
			platform: "darwin",
			version: "0.4.0",
		})
	).toEqual({ status: "disabled" });
	expect(await readFile(path, "utf8")).toBe("old CLI");
});

test("concurrent CLI invocations share one executable update lock", async () => {
	const path = await executablePath();
	let release!: () => void;
	let observed!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		observed = resolve;
	});
	let reads = 0;
	installResponse(async () => {
		reads += 1;
		observed();
		await gate;
		return preferenceResponse(false);
	});
	const options = {
		arch: "arm64",
		executablePath: path,
		platform: "darwin" as const,
		version: "0.4.0",
	};
	const first = runCliAutoUpdate(target, options);
	await started;
	expect(await runCliAutoUpdate(target, options)).toEqual({
		status: "unavailable",
	});
	release();
	expect(await first).toEqual({ status: "disabled" });
	expect(reads).toBe(1);
	await expect(readFile(`${path}.update.lock`)).rejects.toThrow();
});
