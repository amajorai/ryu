import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

declare const window: Window;

import type { Node } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";

export interface ProjectEnvironmentProofApiCall {
	body?: unknown;
	headers: Record<string, string>;
	method: string;
	path: string;
	query?: string;
}

export interface ProjectEnvironmentProofState {
	apiCalls: ProjectEnvironmentProofApiCall[];
	fileReads: string[];
	fileWriteFailuresRemaining: number;
	fileWrites: Array<{ content: string; path: string }>;
	mappingWriteFailuresRemaining: number;
}

declare global {
	interface Window {
		__PROJECT_ENVIRONMENT_PROOF__?: ProjectEnvironmentProofState;
	}
}

const MAPPINGS_KEY = "ryu_project_environment_proof_mappings";
const FILES_KEY = "ryu_project_environment_proof_files";

const query = new URLSearchParams(window.location.search);

if (!window.__PROJECT_ENVIRONMENT_PROOF__) {
	window.__PROJECT_ENVIRONMENT_PROOF__ = {
		apiCalls: [],
		fileReads: [],
		fileWrites: [],
		fileWriteFailuresRemaining: query.get("denyFileWriteOnce") === "1" ? 1 : 0,
		mappingWriteFailuresRemaining: query.get("denyMappingOnce") === "1" ? 1 : 0,
	};
}

function getState(): ProjectEnvironmentProofState {
	const current = window.__PROJECT_ENVIRONMENT_PROOF__;
	if (!current) {
		throw new Error("Project environment proof fixture was not initialized");
	}
	return current;
}

function proofNode(): Node {
	return {
		name: "Project environment proof node",
		token: "project-environment-proof-token",
		url: "http://127.0.0.1:18982",
	};
}

export function useActiveNode(): Node {
	return proofNode();
}

// Stable like the real `useCallback` getter.
export function useActiveNodeGetter(): () => Node {
	return proofNode;
}

const projectFilesSchema = z.record(z.string(), z.string());
const projectMappingSchema = z.object({
	root: z.string(),
	organizationId: z.string(),
	projectId: z.string(),
});

export async function invoke(
	command: string,
	args?: { path?: string; content?: string }
): Promise<string | undefined> {
	const current = getState();
	if (command === "read_project_file") {
		const filePath = isNativeText(args?.path) ? args.path : "";
		current.fileReads.push(filePath);
		if (filePath.endsWith("/AGENTS.md")) {
			const files = projectFilesSchema.parse(
				JSON.parse(localStorage.getItem(FILES_KEY) ?? "{}")
			);
			return (
				files[filePath] ??
				"Keep local environment settings with this project.\n"
			);
		}
		throw new Error("project file not found");
	}
	if (command === "write_project_file") {
		const filePath = isNativeText(args?.path) ? args.path : "";
		const content = isNativeText(args?.content) ? args.content : "";
		current.fileWrites.push({ content, path: filePath });
		if (current.fileWriteFailuresRemaining > 0) {
			current.fileWriteFailuresRemaining -= 1;
			throw new Error("project file write denied");
		}
		const files = projectFilesSchema.parse(
			JSON.parse(localStorage.getItem(FILES_KEY) ?? "{}")
		);
		files[filePath] = content;
		localStorage.setItem(FILES_KEY, JSON.stringify(files));
	}
	return undefined;
}

export async function listen(): Promise<() => void> {
	return () => undefined;
}

export class Resource {
	readonly rid: number;

	constructor(rid: number) {
		this.rid = rid;
	}
}

export function basename(path: string): string {
	return path.split(/[/\\]/).at(-1) ?? path;
}

export function joinPath(folder: string, name: string): string {
	const separator = folder.includes("\\") ? "\\" : "/";
	return `${folder.replace(/[/\\]+$/, "")}${separator}${name}`;
}

function response<FixturePayload>(
	value: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function readMappings() {
	try {
		return z
			.array(projectMappingSchema)
			.parse(JSON.parse(localStorage.getItem(MAPPINGS_KEY) ?? "[]"));
	} catch {
		return [];
	}
}

export function installProjectEnvironmentFetch(): () => void {
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const parsedUrl = new URL(url, window.location.href);
		const method =
			init?.method ?? (input instanceof Request ? input.method : "GET");
		const path = parsedUrl.pathname;
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		);
		const body = isNativeText(init?.body)
			? parseProofJson(init.body)
			: undefined;
		const current = getState();
		current.apiCalls.push({
			body,
			headers: Object.fromEntries(headers.entries()),
			method,
			path,
			...(path === "/api/workspace/list"
				? { query: parsedUrl.search }
				: undefined),
		});

		if (path === "/api/gateway/governance" && method === "GET") {
			return response({
				layers: [{ scope: "node", revision: 1, values: {}, writable: true }],
				schemaVersion: 1,
			});
		}
		if (path === "/api/workspace/list" && method === "GET") {
			const folder = parsedUrl.searchParams.get("path");
			if (folder === "::this-pc") {
				return response({ error: "virtual root unavailable" }, 404);
			}
			if (folder === "/denied") {
				return response({ error: "folder access denied" }, 403);
			}
			return response({
				path: folder ?? "/Users/proof/projects",
				home: "/Users/proof",
				parent: "/Users/proof",
				entries:
					folder === "/Users/proof/projects/new-project"
						? []
						: [
								{
									name: "new-project",
									path: "/Users/proof/projects/new-project",
								},
							],
			});
		}
		if (path === "/api/org-project-mappings" && method === "GET") {
			return response({ mappings: readMappings() });
		}
		if (path === "/api/org-project-mappings" && method === "PUT") {
			if (current.mappingWriteFailuresRemaining > 0) {
				current.mappingWriteFailuresRemaining -= 1;
				return response({ error: "project_mapping_forbidden" }, 403);
			}
			const mapping = projectMappingSchema.parse(body);
			const mappings = readMappings().filter(
				(item) => item.root !== mapping.root
			);
			mappings.push(mapping);
			localStorage.setItem(MAPPINGS_KEY, JSON.stringify(mappings));
			return response({ ok: true });
		}
		if (path === "/api/org-project-mappings" && method === "DELETE") {
			const query = new URLSearchParams(parsedUrl.search);
			const mappings = readMappings().filter(
				(item) =>
					item.root !== query.get("root") ||
					item.organizationId !== query.get("organizationId") ||
					item.projectId !== query.get("projectId")
			);
			localStorage.setItem(MAPPINGS_KEY, JSON.stringify(mappings));
			return response({ ok: true });
		}
		return originalFetch(input, init);
	};
	return () => {
		window.fetch = originalFetch;
	};
}
