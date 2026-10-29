import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Real HTTP through Bun's fetch: happy-dom's would apply browser CORS rules.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { ContinueOnNodeDialog } = await import("./ContinueOnNodeDialog.tsx");

const CONVERSATION = "conversation-1";
const BASE = "2".repeat(40);
const bundleBlob = new Uint8Array([1, 2, 3]);
const diffBlob = new Uint8Array([4, 5]);
const BUNDLE_SHA = "a".repeat(64);
const DIFF_SHA = "b".repeat(64);

interface Recorded {
	auth: string | null;
	body: string;
	method: string;
	path: string;
}

let server: ReturnType<typeof Bun.serve>;
let root: Root;
let container: HTMLDivElement;
let calls: Recorded[];
let resumeFailures: number;
let destinationBlobs: Set<string>;

const inspection = {
	version: 0,
	conversationId: CONVERSATION,
	repo: {
		name: "repo",
		remoteUrl: "https://github.com/example/repo.git",
		baseCommit: BASE,
		branch: "main",
	},
	unpushedCommits: 1,
	changed: [
		{ path: "README.md", status: "modified", binary: false, sensitive: false },
	],
	untrackedCandidates: [
		{ path: ".env", bytes: 12, sensitive: true, selectable: true },
		{ path: "notes.txt", bytes: 8, sensitive: false, selectable: true },
	],
	diffStat: { files: 1, insertions: 1, deletions: 0 },
};

const manifest = {
	version: 0,
	workspaceId: "workspace-1",
	conversationId: CONVERSATION,
	createdAt: 10,
	repo: inspection.repo,
	commits: {
		blob: {
			sha256: BUNDLE_SHA,
			bytes: bundleBlob.byteLength,
			mediaType: "application/x-git-bundle",
		},
		tip: BASE,
		prerequisites: ["1".repeat(40)],
		count: 1,
	},
	diff: {
		blob: {
			sha256: DIFF_SHA,
			bytes: diffBlob.byteLength,
			mediaType: "text/x-diff",
		},
		files: [
			{
				path: "README.md",
				status: "modified",
				binary: false,
				sensitive: false,
			},
			{
				path: "notes.txt",
				status: "added",
				bytes: 8,
				binary: false,
				sensitive: false,
			},
		],
	},
	untracked: [
		{
			path: "notes.txt",
			status: "added",
			bytes: 8,
			binary: false,
			sensitive: false,
		},
	],
	omitted: [{ path: ".env", reason: "not-selected" }],
};

const transcript = {
	protocol: "ryu-node-continuity",
	version: 0,
	bundleId: "bundle-1",
	createdAt: 20,
	source: { conversationId: CONVERSATION, updatedAt: 10, title: "Thread" },
	selection: {
		transcript: { mode: "recent", maxMessages: 50 },
		omittedEarlierMessages: false,
	},
	messages: [{ sourceId: "m1", role: "user", text: "Carry on", createdAt: 1 }],
	context: { version: 0, items: [] },
};

function route(method: string, path: string): Response {
	const json = (value: unknown, status = 200) =>
		NativeResponse.json(value, { status });
	const conversation = `/api/rnp/v0/conversations/${CONVERSATION}`;
	if (path === `/source${conversation}/export`) {
		return json(transcript);
	}
	if (path === `/source${conversation}/workspace/inspect`) {
		return json(inspection);
	}
	if (path === `/source${conversation}/workspace/export`) {
		return json(manifest);
	}
	if (path === `/source${conversation}/continued`) {
		return json({ continuedOn: {} });
	}
	if (path === "/destination/api/rnp/v0/capabilities") {
		return json({ version: 0, features: ["workspace"] });
	}
	if (path === `/destination${conversation}/resume`) {
		return json({
			version: 0,
			conversationId: CONVERSATION,
			status: "unchanged",
			imported: { messages: 0, contextItems: 0 },
			warnings: [],
		});
	}
	if (path === `/destination${conversation}/workspace/resume`) {
		if (resumeFailures > 0) {
			resumeFailures -= 1;
			return json({ error: "the destination lost the response" }, 502);
		}
		return json({
			version: 0,
			workspaceId: "workspace-1",
			conversationId: CONVERSATION,
			status: "created",
			folderPath: "/home/me/Documents/Ryu/handoffs/repo-conversa",
			worktreePath:
				"/home/me/Documents/Ryu/handoffs/repo-conversa/.ryu-worktrees/handoff-w",
			branch: "handoff/conversa",
			warnings: ["workspace-untrusted"],
		});
	}
	const blob =
		/^\/(source|destination)\/api\/rnp\/v0\/workspace-blobs\/(\w+)$/.exec(path);
	if (blob) {
		const [, side, sha = ""] = blob;
		if (side === "destination" && method === "HEAD") {
			return new NativeResponse(null, {
				status: destinationBlobs.has(sha) ? 200 : 404,
			});
		}
		if (side === "destination" && method === "PUT") {
			destinationBlobs.add(sha);
			return json({ sha256: sha, status: "created" }, 201);
		}
		if (side === "source" && method === "GET") {
			return new NativeResponse(sha === BUNDLE_SHA ? bundleBlob : diffBlob);
		}
	}
	return json({ error: "not found" }, 404);
}

let domFetch: typeof globalThis.fetch;

beforeEach(() => {
	domFetch = globalThis.fetch;
	globalThis.fetch = nativeFetch;
	calls = [];
	resumeFailures = 0;
	destinationBlobs = new Set();
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			calls.push({
				auth: request.headers.get("authorization"),
				body:
					request.method === "GET" || request.method === "HEAD"
						? ""
						: await request.text(),
				method: request.method,
				path,
			});
			return route(request.method, path);
		},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	server.stop(true);
	globalThis.fetch = domFetch;
});

function nodes() {
	const origin = `http://127.0.0.1:${server.port}`;
	return [
		{ name: "Laptop", url: `${origin}/source`, token: "source-token" },
		{
			name: "Studio",
			url: `${origin}/destination`,
			token: "destination-token",
		},
	];
}

async function settle(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw new Error("condition was never met");
}

function checkbox(label: string): HTMLInputElement {
	const row = [...document.querySelectorAll("label")].find(
		(candidate) => candidate.textContent?.includes(label) ?? false
	);
	const input = row?.querySelector<HTMLInputElement>("input[type=checkbox]");
	if (!input) {
		throw new Error(`no checkbox for ${label}`);
	}
	return input;
}

function button(name: string): HTMLButtonElement {
	const match = [...document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === name
	);
	if (!match) {
		throw new Error(`no button ${name}`);
	}
	return match;
}

async function renderDialog(onCompleted: (...args: unknown[]) => void) {
	const list = nodes();
	const source = list[0];
	if (!source) {
		throw new Error("missing source node");
	}
	await act(async () =>
		root.render(
			<ContinueOnNodeDialog
				conversationId={CONVERSATION}
				conversationTitle="Thread"
				nodes={list}
				onCompleted={onCompleted}
				onOpenChange={() => undefined}
				open
				sourceNode={source}
				sourceUpdatedAt={10}
			/>
		)
	);
	await settle(
		() => document.querySelector("[data-testid=rnp-workspace-review]") !== null
	);
}

test("review leaves secret-like files unticked and warns the folder is untrusted", async () => {
	await renderDialog(() => undefined);
	expect(checkbox(".env").checked).toBe(false);
	expect(checkbox("notes.txt").checked).toBe(true);
	expect(
		document.querySelector("[data-testid=rnp-workspace-remote]")?.textContent
	).toBe("https://github.com/example/repo.git");
	expect(
		document.querySelector("[data-testid=rnp-workspace-untrusted]")?.textContent
	).toContain("not trusted automatically");
	// v1 offers a new clone only: an existing checkout would pass its trust on.
	expect(
		document.querySelector("input[name=rnp-workspace-destination]")
	).toBeNull();
	expect(
		document.querySelector("[data-testid=rnp-workspace-review]")?.textContent
	).not.toContain("existing checkout");
	const inspect = calls.find((call) =>
		call.path.endsWith("/workspace/inspect")
	);
	expect(inspect?.auth).toBe("Bearer source-token");
	const probe = calls.find((call) => call.path.endsWith("/capabilities"));
	expect(probe?.auth).toBe("Bearer destination-token");
});

test("a failed resume retries with the frozen manifest and marks the source last", async () => {
	resumeFailures = 1;
	const completed: unknown[][] = [];
	await renderDialog((...args) => {
		completed.push(args);
	});
	await act(async () => button("Continue on selected node").click());
	await settle(() => document.querySelector("[role=alert]") !== null);
	expect(document.querySelector("[role=alert]")?.textContent).toContain(
		"lost the response"
	);
	expect(calls.some((call) => call.path.endsWith("/continued"))).toBe(false);

	await act(async () => button("Retry same handoff").click());
	await settle(() => completed.length === 1);

	const exports = calls.filter((call) =>
		call.path.endsWith("/workspace/export")
	);
	expect(exports).toHaveLength(1);
	expect(JSON.parse(exports[0]?.body ?? "{}")).toEqual({
		version: 0,
		ifHead: BASE,
		includeUntracked: ["notes.txt"],
		ifUpdatedAt: 10,
	});
	const resumes = calls.filter((call) =>
		call.path.endsWith("/workspace/resume")
	);
	expect(resumes).toHaveLength(2);
	expect(resumes[1]?.body).toBe(resumes[0]?.body ?? "");
	expect(JSON.parse(resumes[0]?.body ?? "{}").manifest).toEqual(manifest);
	expect(JSON.parse(resumes[0]?.body ?? "{}").destination).toEqual({
		mode: "new-clone",
	});
	// The second attempt skips blobs the destination already stored.
	const puts = calls.filter((call) => call.method === "PUT");
	expect(puts).toHaveLength(2);
	const continued = calls.filter((call) => call.path.endsWith("/continued"));
	expect(continued).toHaveLength(1);
	expect(continued[0]?.auth).toBe("Bearer source-token");
	expect(calls.indexOf(continued[0] as Recorded)).toBeGreaterThan(
		calls.indexOf(resumes[1] as Recorded)
	);
	for (const call of calls) {
		const expected = call.path.startsWith("/source")
			? "Bearer source-token"
			: "Bearer destination-token";
		expect(call.auth).toBe(expected);
	}
	const workspace = completed[0]?.[2] as { warnings: string[] } | undefined;
	expect(workspace?.warnings).toEqual(["workspace-untrusted"]);
});
