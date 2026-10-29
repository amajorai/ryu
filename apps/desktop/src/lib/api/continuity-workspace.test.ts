import { describe, expect, it } from "bun:test";
import type { RnpWorkspaceManifestV0 } from "@ryuhq/protocol/continuity";
import { ApiError, type ApiTarget } from "./client.ts";
import {
	createWorkspaceContinuityClient,
	type WorkspaceTransport,
} from "./continuity-workspace.ts";

const source: ApiTarget = {
	url: "https://source.example",
	token: "source-secret",
	userJwt: null,
};
const destination: ApiTarget = {
	url: "https://destination.example",
	token: "destination-secret",
	userJwt: null,
};

const bundleBytes = new Uint8Array([1, 2, 3, 4]).buffer;
const diffBytes = new Uint8Array([5, 6]).buffer;
const manifest: RnpWorkspaceManifestV0 = {
	version: 0,
	workspaceId: "workspace-1",
	conversationId: "conversation-1",
	createdAt: 10,
	repo: {
		name: "repo",
		remoteUrl: "https://github.com/example/repo.git",
		baseCommit: "2".repeat(40),
	},
	commits: {
		blob: {
			sha256: "a".repeat(64),
			bytes: bundleBytes.byteLength,
			mediaType: "application/x-git-bundle",
		},
		tip: "2".repeat(40),
		prerequisites: ["1".repeat(40)],
		count: 1,
	},
	diff: {
		blob: {
			sha256: "b".repeat(64),
			bytes: diffBytes.byteLength,
			mediaType: "text/x-diff",
		},
		files: [
			{
				path: "README.md",
				status: "modified",
				binary: false,
				sensitive: false,
			},
		],
	},
	untracked: [],
	omitted: [{ path: ".env", reason: "not-selected" }],
};

const resumeResult = {
	version: 0,
	workspaceId: "workspace-1",
	conversationId: "conversation-1",
	status: "created",
	folderPath: "/home/me/Documents/Ryu/handoffs/repo-conversa",
	worktreePath:
		"/home/me/Documents/Ryu/handoffs/repo-conversa/.ryu-worktrees/handoff-workspace-1",
	branch: "handoff/conversa",
	warnings: ["workspace-untrusted"],
};

interface Call {
	method: string;
	path: string;
	token: string | null;
}

/** A recording transport; `present` lists blobs the destination already has. */
function recordingTransport(options: {
	present?: string[];
	capabilities?: "ok" | "missing";
	failResume?: boolean;
}) {
	const calls: Call[] = [];
	const record = (target: ApiTarget, method: string, path: string) =>
		calls.push({ token: target.token, method, path });
	const transport: WorkspaceTransport = {
		json: ({ target, method, path }) => {
			record(target, method, path);
			if (path.endsWith("/capabilities")) {
				if (options.capabilities === "missing") {
					return Promise.reject(new ApiError(path, 404));
				}
				return Promise.resolve({ version: 0, features: ["workspace"] });
			}
			if (path.endsWith("/workspace/resume")) {
				return options.failResume
					? Promise.reject(new ApiError(path, 409, "blob is missing"))
					: Promise.resolve(resumeResult);
			}
			if (path.endsWith("/continued")) {
				return Promise.resolve({ continuedOn: null });
			}
			if (path.endsWith("/workspace/export")) {
				return Promise.resolve(manifest);
			}
			return Promise.reject(new Error(`unexpected ${path}`));
		},
		blob: ({ target, method, path }) => {
			record(target, method, path);
			const sha = path.split("/").pop() ?? "";
			if (method === "HEAD") {
				return Promise.resolve({
					status: options.present?.includes(sha) ? 200 : 404,
				});
			}
			if (method === "GET") {
				return Promise.resolve({
					status: 200,
					body: sha.startsWith("a") ? bundleBytes : diffBytes,
				});
			}
			return Promise.resolve({ status: 201 });
		},
	};
	return { calls, transport };
}

describe("RNP working-tree handoff client", () => {
	it("keeps each node's credential on its own requests", async () => {
		const { calls, transport } = recordingTransport({});
		const client = createWorkspaceContinuityClient(transport);
		expect(await client.probeCapabilities(destination)).toBe(true);
		await client.exportWorkspace(source, "conversation-1", {
			version: 0,
			ifHead: "2".repeat(40),
			includeUntracked: [],
		});
		await client.continueWorkspace({
			conversationId: "conversation-1",
			source,
			destination,
			manifest,
			destinationChoice: { mode: "new-clone" },
			nodeLabel: "Mac",
			bundleId: "bundle-1",
		});
		const bySource = calls
			.filter((call) => call.token === "source-secret")
			.map((call) => `${call.method} ${call.path}`);
		const byDestination = calls
			.filter((call) => call.token === "destination-secret")
			.map((call) => `${call.method} ${call.path}`);
		expect(bySource).toEqual([
			"POST /api/rnp/v0/conversations/conversation-1/workspace/export",
			`GET /api/rnp/v0/workspace-blobs/${"a".repeat(64)}`,
			`GET /api/rnp/v0/workspace-blobs/${"b".repeat(64)}`,
			"POST /api/rnp/v0/conversations/conversation-1/continued",
		]);
		expect(byDestination).toEqual([
			"GET /api/rnp/v0/capabilities",
			`HEAD /api/rnp/v0/workspace-blobs/${"a".repeat(64)}`,
			`PUT /api/rnp/v0/workspace-blobs/${"a".repeat(64)}`,
			`HEAD /api/rnp/v0/workspace-blobs/${"b".repeat(64)}`,
			`PUT /api/rnp/v0/workspace-blobs/${"b".repeat(64)}`,
			"POST /api/rnp/v0/conversations/conversation-1/workspace/resume",
		]);
		expect(calls).toHaveLength(bySource.length + byDestination.length);
	});

	it("skips blobs the destination already has", async () => {
		const { calls, transport } = recordingTransport({
			present: ["a".repeat(64)],
		});
		const client = createWorkspaceContinuityClient(transport);
		const progress = await client.relayWorkspaceBlobs(
			source,
			destination,
			manifest
		);
		expect(progress).toEqual({ done: 2, skipped: 1, total: 2 });
		expect(calls.filter((call) => call.path.endsWith("a".repeat(64)))).toEqual([
			{
				token: "destination-secret",
				method: "HEAD",
				path: `/api/rnp/v0/workspace-blobs/${"a".repeat(64)}`,
			},
		]);
	});

	it("treats a 404 capability probe as an older node", async () => {
		const { transport } = recordingTransport({ capabilities: "missing" });
		const client = createWorkspaceContinuityClient(transport);
		expect(await client.probeCapabilities(destination)).toBe(false);
	});

	it("marks the source only after the working tree resumed", async () => {
		const { calls, transport } = recordingTransport({ failResume: true });
		const client = createWorkspaceContinuityClient(transport);
		await expect(
			client.continueWorkspace({
				conversationId: "conversation-1",
				source,
				destination,
				manifest,
				destinationChoice: { mode: "new-clone" },
				nodeLabel: "Mac",
			})
		).rejects.toThrow();
		expect(calls.some((call) => call.path.endsWith("/continued"))).toBe(false);
	});

	it("rejects a manifest for another conversation or a malformed one", async () => {
		const client = createWorkspaceContinuityClient({
			json: () =>
				Promise.resolve({ ...manifest, conversationId: "conversation-2" }),
			blob: () => Promise.resolve({ status: 404 }),
		});
		await expect(
			client.exportWorkspace(source, "conversation-1", {
				version: 0,
				ifHead: "2".repeat(40),
				includeUntracked: [],
			})
		).rejects.toThrow("different conversation");
		const unsafe = createWorkspaceContinuityClient({
			json: () =>
				Promise.resolve({
					...manifest,
					diff: {
						...manifest.diff,
						files: [
							{
								path: "../escape",
								status: "added",
								binary: false,
								sensitive: false,
							},
						],
					},
				}),
			blob: () => Promise.resolve({ status: 404 }),
		});
		await expect(
			unsafe.exportWorkspace(source, "conversation-1", {
				version: 0,
				ifHead: "2".repeat(40),
				includeUntracked: [],
			})
		).rejects.toThrow("invalid response");
	});

	it("refuses a blob whose size does not match the manifest", async () => {
		const client = createWorkspaceContinuityClient({
			json: () => Promise.resolve({}),
			blob: ({ method }) =>
				Promise.resolve(
					method === "GET"
						? { status: 200, body: new Uint8Array([1]).buffer }
						: { status: 404 }
				),
		});
		await expect(
			client.relayWorkspaceBlobs(source, destination, manifest)
		).rejects.toThrow("wrong size");
	});
});
