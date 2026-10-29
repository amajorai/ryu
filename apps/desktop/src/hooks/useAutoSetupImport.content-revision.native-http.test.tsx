import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
GlobalRegistrator.register();
// The hook ignores a focus while its previous scan is still running, and the
// fixture counts a scan when the request arrives rather than when the client
// finishes with it. Count the client's outstanding requests so `scan()` can
// wait for the previous pass to end before it asks for the next one.
let clientInflight = 0;
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		clientInflight += 1;
		try {
			return await nativeFetch(...args);
		} finally {
			clientInflight -= 1;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("@/src/store/useWorkspaceStore.ts", () => ({
	useWorkspaceStore: () => () => undefined,
}));
const { createRoot } = await import("react-dom/client");
const { useAutoSetupImport } = await import(
	"@/src/hooks/useAutoSetupImport.ts"
);
const { scanImportFolder } = await import("@/src/lib/api/import.ts");
let file: string;
let rootPath: string;
let saved: string | null;
let omitRevision: boolean;
let refuse: boolean;
let scans: number;
let writes: number;
const unexpected: string[] = [];
const bodies: unknown[] = [];
let holdWrite = false;
let releaseWrite: (() => void) | undefined;
let clock = 100_000;
const now = spyOn(Date, "now").mockImplementation(() => clock);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (
			request.headers.get("authorization") !== "Bearer node-a" ||
			request.headers.get("x-ryu-user-jwt") !== "user-a"
		) {
			unexpected.push("authority");
			return NativeResponse.json({}, { status: 401 });
		}
		if (
			request.method === "GET" &&
			url.pathname === "/api/agent-sync/profiles"
		) {
			return NativeResponse.json({ profiles: [] });
		}
		if (request.method === "GET" && url.pathname === "/api/workspace/list") {
			return NativeResponse.json({
				home: rootPath,
				path: rootPath,
				parent: null,
				entries: [],
			});
		}
		if (
			request.method === "GET" &&
			url.pathname === "/api/preferences/owned-instructions"
		) {
			return NativeResponse.json({ value: saved });
		}
		const body = request.method === "POST" ? await request.json() : null;
		if (request.method === "POST" && url.pathname === "/api/import/scan") {
			scans++;
			if (
				typeof body?.path !== "string" ||
				![".claude", ".cursor", ".codex"].some(
					(s) => body.path === `${rootPath}/${s}`
				)
			) {
				unexpected.push("scan body");
				return NativeResponse.json({}, { status: 400 });
			}
			const content = await readFile(file, "utf8");
			return NativeResponse.json({
				root: body.path,
				items: body.path.endsWith(".claude")
					? [
							{
								id: "instructions/CLAUDE.md",
								kind: "instructions",
								title: "Instructions",
								...(omitRevision
									? {}
									: {
											content_revision: createHash("sha256")
												.update(content)
												.digest("hex"),
										}),
							},
						]
					: [],
				warnings: [],
			});
		}
		if (request.method === "POST" && url.pathname === "/api/import/run") {
			if (
				JSON.stringify(body) !==
				JSON.stringify({
					path: `${rootPath}/.claude`,
					items: [{ kind: "instructions", id: "instructions/CLAUDE.md" }],
				})
			) {
				unexpected.push("write body");
				return NativeResponse.json({}, { status: 400 });
			}
			writes++;
			bodies.push(body);
			if (holdWrite) {
				holdWrite = false;
				await new Promise<void>((resolve) => {
					releaseWrite = resolve;
				});
			}
			if (refuse) {
				return NativeResponse.json({ error: "refused" }, { status: 503 });
			}
			saved = await readFile(file, "utf8");
			return NativeResponse.json({
				root: body.path,
				results: [
					{
						id: "instructions/CLAUDE.md",
						kind: "instructions",
						title: "Instructions",
						status: "imported",
						folder_path: body.path,
						...(omitRevision
							? {}
							: {
									content_revision: createHash("sha256")
										.update(saved)
										.digest("hex"),
								}),
					},
				],
			});
		}
		unexpected.push(`${request.method} ${url.pathname}`);
		return NativeResponse.json({}, { status: 503 });
	},
});
const target = {
	url: server.url.toString().replace(/\/$/, ""),
	token: "node-a",
	userJwt: "user-a",
};
function Harness() {
	useAutoSetupImport({ target });
	return null;
}
let root = createRoot(document.createElement("div"));
async function until(check: () => boolean) {
	const end = Date.now() + 3000;
	for (let i = 0; !check(); i++) {
		if (i > 300 || Date.now() > end) {
			throw new Error(
				"HTTP contract did not settle " +
					JSON.stringify({ scans, writes, saved, unexpected })
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
async function untilIdle() {
	let quietPolls = 0;
	await until(() => {
		quietPolls = clientInflight === 0 ? quietPolls + 1 : 0;
		return quietPolls >= 3;
	});
}
async function scan() {
	await untilIdle();
	const before = scans;
	clock += 31_000;
	await act(async () => window.dispatchEvent(new Event("focus")));
	await until(() => scans >= before + 3);
	await act(async () => {
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	});
}
async function readback() {
	const r = await nativeFetch(
		`${target.url}/api/preferences/owned-instructions`,
		{ headers: { authorization: "Bearer node-a", "x-ryu-user-jwt": "user-a" } }
	);
	if (r.status !== 200) {
		throw new Error(`Stored instructions readback failed: ${r.status}`);
	}
	return (await r.json()).value;
}
beforeEach(async () => {
	rootPath = await mkdtemp(join(tmpdir(), "ryu-setup-revision-"));
	await mkdir(join(rootPath, ".claude"));
	file = join(rootPath, ".claude", "CLAUDE.md");
	await writeFile(file, "alpha");
	saved = null;
	scans = 0;
	writes = 0;
	omitRevision = false;
	holdWrite = false;
	releaseWrite = undefined;
	refuse = false;
	unexpected.length = 0;
	bodies.length = 0;
	localStorage.clear();
	localStorage.setItem("ryu:auto-import-agent-setup", "true");
	await act(async () => root.render(<Harness />));
});
afterEach(async () => {
	releaseWrite?.();
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	await rm(rootPath, { recursive: true, force: true });
	// Teardown refuses any request outside the fixture contract for every test.
	if (unexpected.length > 0) {
		throw new Error(
			`Unexpected fixture requests: ${JSON.stringify(unexpected)}`
		);
	}
});
afterAll(() => {
	server.stop(true);
	now.mockRestore();
	globalThis.fetch = nativeFetch;
});
test("same locator edited and reverted bytes refresh snapshot; unchanged rescan and remount produce zero repeated writes", async () => {
	await scan();
	await until(() => saved === "alpha");
	expect(await readback()).toBe("alpha");
	expect(writes).toBe(1);
	await scan();
	expect(writes).toBe(1);
	await writeFile(file, "bravo");
	await scan();
	await until(() => saved === "bravo");
	expect(await readback()).toBe("bravo");
	expect(writes).toBe(2);
	await writeFile(file, "alpha");
	await scan();
	await until(() => saved === "alpha");
	expect(await readback()).toBe("alpha");
	expect(writes).toBe(3);
	// Let the acknowledging pass record its revision before this hook instance
	// is retired; an unmounted pass deliberately persists nothing.
	await untilIdle();
	await act(async () => root.render(null));
	await act(async () => root.render(<Harness />));
	await scan();
	expect(writes).toBe(3);
	expect(bodies).toEqual(
		new Array(3).fill({
			path: `${rootPath}/.claude`,
			items: [{ kind: "instructions", id: "instructions/CLAUDE.md" }],
		})
	);
});
test("refused changed bytes preserve stored snapshot and retry exact selection before revision is acknowledged", async () => {
	await scan();
	await until(() => saved === "alpha");
	await writeFile(file, "bravo");
	refuse = true;
	await scan();
	expect(writes).toBe(2);
	expect(await readback()).toBe("alpha");
	refuse = false;
	await scan();
	await until(() => saved === "bravo");
	expect(writes).toBe(3);
	expect(await readback()).toBe("bravo");
	expect(bodies[1]).toEqual(bodies[2]);
	await scan();
	expect(writes).toBe(3);
});
test("older Core without revision remains readable and rechecks changed same-ID bytes instead of falsely claiming they are unchanged", async () => {
	omitRevision = true;
	await scan();
	await until(() => saved === "alpha");
	const result = await scanImportFolder(target, `${rootPath}/.claude`);
	expect(result.items[0]?.contentRevision).toBeUndefined();
	await writeFile(file, "bravo");
	await scan();
	await until(() => saved === "bravo");
	expect(await readback()).toBe("bravo");
	expect(writes).toBe(2);
});

test("held import acknowledges actual stored bytes rather than scan bytes, so a subsequent revert cannot be skipped", async () => {
	holdWrite = true;
	const before = scans;
	clock += 31_000;
	await act(async () => window.dispatchEvent(new Event("focus")));
	await until(() => writes === 1 && !!releaseWrite);
	await writeFile(file, "bravo");
	releaseWrite?.();
	await until(() => saved === "bravo" && scans >= before + 3);
	expect(await readback()).toBe("bravo");
	await writeFile(file, "alpha");
	await scan();
	await until(() => saved === "alpha");
	expect(await readback()).toBe("alpha");
	expect(writes).toBe(2);
	expect(bodies[0]).toEqual(bodies[1]);
	await scan();
	expect(writes).toBe(2);
});
