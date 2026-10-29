import type { InvokeArgs } from "@tauri-apps/api/core";
import type { listen as nativeListen } from "@tauri-apps/api/event";
import { z } from "zod";
import {
	type PluginValue,
	pluginDocumentSchema,
} from "../../src/lib/api/plugin-wire-values.ts";
import type { Node } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";

const storedStringRecordFieldsSchema = z.record(z.string(), z.string());
const storedStringRecordSchema = z.custom<
	z.output<typeof storedStringRecordFieldsSchema>
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		storedStringRecordFieldsSchema.safeParse(value).success
);
const storedMappingsSchema = z.custom<
	z.output<typeof storedStringRecordFieldsSchema>[]
>((value) => z.array(storedStringRecordSchema).safeParse(value).success);
const fileArgumentsSchema = z
	.object({ path: z.string().catch(""), content: z.string().catch("") })
	.catch({ path: "", content: "" });
const cloneArgumentsSchema = z
	.object({
		name: z.string().nullish().catch(null),
		url: z.string().nullish().catch(null),
	})
	.catch({ name: null, url: null });

const FILES_KEY = "project-settings-proof-files";
const MAPPINGS_KEY = "project-settings-proof-mappings";
let fileWriteFailuresRemaining = 0;

export interface ProjectSettingsApiCall {
	body: PluginValue;
	headers: Record<string, string>;
	method: string;
	path: string;
	status: number | null;
}

export interface ProjectSettingsFileWrite {
	content: string;
	path: string;
	status: "failed" | "saved";
}

export interface ProjectSettingsProofSnapshot {
	apiCalls: ProjectSettingsApiCall[];
	fileReads: string[];
	files: Record<string, string>;
	fileWrites: ProjectSettingsFileWrite[];
	mappings: Record<string, string>[];
}

interface ProjectSettingsProofState extends ProjectSettingsProofSnapshot {
	armCloneFailure: () => void;
	armFileWriteFailure: () => void;
	snapshot: () => ProjectSettingsProofSnapshot;
}

declare global {
	interface Window {
		__PROJECT_SETTINGS_PROOF__?: ProjectSettingsProofState;
	}
}

const NODE = {
	managed: false,
	name: "project-settings-proof-node",
	orgId: null,
	token: "project-settings-proof-token",
	url: "http://127.0.0.1:19892",
	userJwt: null,
};

function parseStored<S extends z.ZodType>(
	key: string,
	fallback: z.output<S>,
	schema: S
): z.output<S> {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : schema.parse(JSON.parse(raw));
	} catch {
		return fallback;
	}
}

function saveStored<FixturePayload>(key: string, value: FixturePayload): void {
	localStorage.setItem(key, JSON.stringify(value));
}

function response<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function state(): ProjectSettingsProofState {
	const current = window.__PROJECT_SETTINGS_PROOF__;
	if (!current) {
		throw new Error("Project settings fixture was not initialized");
	}
	return current;
}

export function initializeProjectSettingsFixture(reset = false): void {
	if (reset) {
		localStorage.removeItem(FILES_KEY);
		localStorage.removeItem(MAPPINGS_KEY);
	}
	if (!localStorage.getItem(FILES_KEY)) {
		saveStored(FILES_KEY, {});
	}
	if (!localStorage.getItem(MAPPINGS_KEY)) {
		saveStored(MAPPINGS_KEY, []);
	}

	let cloneFailuresRemaining = 0;
	fileWriteFailuresRemaining = 0;
	const current: ProjectSettingsProofState = {
		apiCalls: [],
		files: parseStored(FILES_KEY, {}, storedStringRecordSchema),
		fileReads: [],
		fileWrites: [],
		mappings: parseStored(MAPPINGS_KEY, [], storedMappingsSchema),
		armCloneFailure: () => {
			cloneFailuresRemaining += 1;
		},
		armFileWriteFailure: () => {
			fileWriteFailuresRemaining += 1;
		},
		snapshot: () => ({
			apiCalls: structuredClone(current.apiCalls),
			files: structuredClone(
				parseStored(FILES_KEY, {}, storedStringRecordSchema)
			),
			fileReads: structuredClone(current.fileReads),
			fileWrites: structuredClone(current.fileWrites),
			mappings: structuredClone(
				parseStored(MAPPINGS_KEY, [], storedMappingsSchema)
			),
		}),
	};
	window.__PROJECT_SETTINGS_PROOF__ = current;

	const nativeFetch = window.fetch;
	const originalFetch = nativeFetch.bind(window);
	window.fetch = Object.assign(
		async (
			input: Parameters<typeof nativeFetch>[0],
			init?: Parameters<typeof nativeFetch>[1]
		) => {
			const request = input instanceof Request ? input : null;
			const url = new URL(request?.url ?? String(input), window.location.href);
			if (!url.pathname.startsWith("/api/")) {
				return originalFetch(input, init);
			}
			const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
			const bodyText = z.string().safeParse(init?.body);
			const body = bodyText.success ? parseProofJson(bodyText.data) : null;
			const headers = new Headers(
				init?.headers ??
					(request instanceof Request ? request.headers : undefined)
			);
			const record: ProjectSettingsApiCall = {
				body,
				headers: Object.fromEntries(headers.entries()),
				method,
				path: url.pathname + url.search,
				status: null,
			};
			current.apiCalls.push(record);

			if (url.pathname === "/api/auth/get-session" && method === "GET") {
				record.status = 200;
				return response({ session: null, user: null });
			}
			if (url.pathname === "/api/gateway/governance" && method === "GET") {
				record.status = 200;
				return response({ layers: [], schemaVersion: 1 });
			}
			if (url.pathname === "/api/org-project-mappings" && method === "GET") {
				const mappings = parseStored(MAPPINGS_KEY, [], storedMappingsSchema);
				record.status = 200;
				return response({ mappings });
			}
			if (url.pathname === "/api/org-project-mappings" && method === "PUT") {
				const mappingResult = storedStringRecordSchema.safeParse(body);
				if (mappingResult.success) {
					const mapping = mappingResult.data;
					const mappings = parseStored(MAPPINGS_KEY, [], storedMappingsSchema)
						.filter((existing) => existing.root !== mapping.root)
						.concat(mapping);
					saveStored(MAPPINGS_KEY, mappings);
				}
				record.status = 200;
				return response({ ok: true });
			}
			if (url.pathname === "/api/org-project-mappings" && method === "DELETE") {
				const query = url.searchParams;
				const mappings = parseStored(
					MAPPINGS_KEY,
					[],
					storedMappingsSchema
				).filter(
					(existing) =>
						existing.root !== query.get("root") ||
						existing.organizationId !== query.get("organizationId") ||
						existing.projectId !== query.get("projectId")
				);
				saveStored(MAPPINGS_KEY, mappings);
				record.status = 200;
				return response({ ok: true });
			}
			if (url.pathname === "/api/workspace/list" && method === "GET") {
				const requested = url.searchParams.get("path");
				if (requested === "::this-pc") {
					record.status = 404;
					return response({ error: "Unsupported fixture root" }, 404);
				}
				const listing = requested
					? {
							entries:
								requested === "/fixture/home"
									? [{ name: "projects", path: "/fixture/home/projects" }]
									: [],
							home: "/fixture/home",
							parent: requested === "/fixture/home" ? "/fixture" : null,
							path: requested,
						}
					: {
							entries: [{ name: "projects", path: "/fixture/home/projects" }],
							home: "/fixture/home",
							parent: "/fixture",
							path: "/fixture/home",
						};
				record.status = 200;
				return response(listing);
			}
			if (url.pathname === "/api/workspace/clone" && method === "POST") {
				if (cloneFailuresRemaining > 0) {
					cloneFailuresRemaining -= 1;
					record.status = 403;
					return response({ error: "Fixture clone denied" }, 403);
				}
				const cloneInput = cloneArgumentsSchema.parse(body);
				const folderName = cloneInput?.name || "fixture-repository";
				const path = `/fixture/cloned/${folderName}`;
				record.status = 200;
				return response({ name: folderName, path });
			}
			record.status = 404;
			return response(
				{ error: `Unhandled fixture API: ${method} ${url.pathname}` },
				404
			);
		},
		{ preconnect: nativeFetch.preconnect }
	);
}

export function useActiveNode(): Node {
	return NODE;
}

function getNode(): Node {
	return NODE;
}

export function useActiveNodeGetter(): () => Node {
	return getNode;
}

export async function invoke(
	command: string,
	args?: InvokeArgs
): Promise<string | undefined> {
	const current = state();
	const fileArgs = fileArgumentsSchema.parse(args);
	const filePath = fileArgs.path;
	if (command === "read_project_file") {
		current.fileReads.push(filePath);
		const files = parseStored(FILES_KEY, {}, storedStringRecordSchema);
		if (Object.hasOwn(files, filePath)) {
			return files[filePath];
		}
		throw new Error("fixture_file_not_found");
	}
	if (command === "write_project_file") {
		const content = fileArgs.content;
		if (fileWriteFailuresRemaining > 0) {
			fileWriteFailuresRemaining -= 1;
			current.fileWrites.push({ content, path: filePath, status: "failed" });
			throw new Error("fixture_file_write_denied");
		}
		const files = parseStored(FILES_KEY, {}, storedStringRecordSchema);
		files[filePath] = content;
		saveStored(FILES_KEY, files);
		current.fileWrites.push({ content, path: filePath, status: "saved" });
		return undefined;
	}
	return undefined;
}

export async function listen<T>(
	..._parameters: Parameters<typeof nativeListen<T>>
): Promise<() => void> {
	return () => undefined;
}

export class Resource {
	readonly rid: number;

	constructor(rid: number) {
		this.rid = rid;
	}
}

export function transformCallback(): number {
	return 1;
}
