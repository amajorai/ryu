import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
export interface UploadCall {
	method: string;
	path: string;
	authorization: string | null;
	userJwt: string | null;
	body: unknown;
	status: number | null;
	clientId: string | null;
	clientLabel: string | null;
	surface: string | null;
}
export function startSpacesUploadHost(
	port = 5711,
	origin = "http://127.0.0.1:5710"
) {
	const directory = mkdtempSync(
		path.join(tmpdir(), "ryu-spaces-upload-bytes-")
	);
	const calls: UploadCall[] = [];
	const unexpected: string[] = [];
	const documents: Array<{
		id: string;
		title: string;
		mime: string;
		byte_size: number;
		index: { state: string; message?: string };
		file: string;
	}> = [];
	let held: Promise<void> | null = null;
	let release: (() => void) | null = null;
	let refusal: string | null = null;
	const headers = {
		"access-control-allow-origin": origin,
		"access-control-allow-headers":
			"authorization,content-type,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface,x-proof-control",
		"access-control-allow-methods": "GET,POST,PUT,OPTIONS",
		"access-control-allow-credentials": "true",
		vary: "Origin",
	};
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status, headers });
	const apiPaths = [
		"/api/spaces",
		"/api/spaces/space-owned/files",
		"/api/spaces/space-owned/documents",
		"/api/auth/get-session",
		"/api/preferences/entitlement-active",
		"/api/preferences/managed-inference-entitled",
	];
	const server: Bun.Server<undefined> = Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port,
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url),
				route = url.pathname,
				method = request.method;
			if (method === "GET" && route === "/__state")
				return json({
					calls,
					unexpected,
					held: held !== null,
					documents: documents.map(({ file, ...document }) => ({
						...document,
						data_base64: readFileSync(file).toString("base64"),
					})),
				});
			if (
				method === "POST" &&
				route === "/__control" &&
				request.headers.get("x-proof-control") === "owned-fixture"
			) {
				const action = (await request.json()) as {
					action?: string;
					title?: string;
				};
				if (action.action === "hold" && !held) {
					held = new Promise<void>((resolve) => {
						release = resolve;
					});
					return json({ ok: true });
				}
				if (action.action === "release" && release) {
					const resolve = release;
					held = null;
					release = null;
					resolve();
					return json({ ok: true });
				}
				if (action.action === "refuse" && typeof action.title === "string") {
					refusal = action.title;
					return json({ ok: true });
				}
				if (action.action === "allow") {
					refusal = null;
					return json({ ok: true });
				}
				return json({ error: "Unsupported owned control" }, 400);
			}
			if (
				method === "OPTIONS" &&
				apiPaths.includes(route) &&
				request.headers.get("origin") === origin
			)
				return new Response(null, { status: 204, headers });
			if (method === "GET" && route === "/api/auth/get-session")
				return json(null);
			const body: unknown = ["POST", "PUT"].includes(method)
				? await request.json()
				: null;
			const call: UploadCall = {
				method,
				path: route,
				authorization: request.headers.get("authorization"),
				userJwt: request.headers.get("x-ryu-user-jwt"),
				body,
				status: null,
				clientId: request.headers.get("x-ryu-client-id"),
				clientLabel: request.headers.get("x-ryu-client-label"),
				surface: request.headers.get("x-ryu-surface"),
			};
			calls.push(call);
			const output = (value: unknown, status = 200) => {
				call.status = status;
				return json(value, status);
			};
			if (
				call.authorization !== "Bearer spaces-upload-owned-token" ||
				call.userJwt !== null ||
				url.search !== ""
			) {
				unexpected.push(`${method} ${url.href} authority`);
				return output({ error: "Unowned authority" }, 403);
			}
			if (
				method === "PUT" &&
				[
					"/api/preferences/entitlement-active",
					"/api/preferences/managed-inference-entitled",
				].includes(route)
			) {
				const value = body as { value?: unknown };
				if (
					value &&
					Object.keys(value).join() === "value" &&
					(value.value === "true" || value.value === "false")
				)
					return output({ ok: true, key: route.split("/").at(-1) });
			}
			if (method === "GET" && route === "/api/spaces")
				return output({
					spaces: [
						{
							id: "space-owned",
							name: "Owned uploads",
							created_at: 1,
							updated_at: 1,
							document_count: documents.length,
							retrieval_mode: "vector",
							system: false,
						},
					],
				});
			if (method === "GET" && route === "/api/spaces/space-owned/documents")
				return output({
					documents: documents.map(({ file, ...document }) => ({
						...document,
						space_id: "space-owned",
						kind: "file",
						created_at: 1,
						updated_at: 1,
						chunk_count: document.index.state === "indexed" ? 1 : 0,
					})),
				});
			if (method === "POST" && route === "/api/spaces/space-owned/files") {
				const value = body as {
					title?: unknown;
					mime?: unknown;
					data_base64?: unknown;
				};
				if (
					value &&
					Object.keys(value).sort().join() === "data_base64,mime,title" &&
					typeof value.title === "string" &&
					typeof value.mime === "string" &&
					typeof value.data_base64 === "string" &&
					Buffer.from(value.data_base64, "base64").toString("base64") ===
						value.data_base64
				) {
					const fail = refusal === value.title;
					const gate = held;
					if (gate) await gate;
					if (fail)
						return output({ error: "Storage temporarily refused" }, 503);
					const id = `document-${documents.length + 1}`,
						file = path.join(directory, id);
					const bytes = Buffer.from(value.data_base64, "base64");
					writeFileSync(file, bytes);
					const index =
						value.mime === "application/octet-stream"
							? { state: "skipped" }
							: { state: "indexed" };
					const document = {
						id,
						title: value.title,
						mime: value.mime,
						byte_size: bytes.length,
						index,
						file,
					};
					documents.push(document);
					return output({
						id,
						mime: document.mime,
						byte_size: bytes.length,
						index,
					});
				}
			}
			unexpected.push(`${method} ${url.href} unsupported/body`);
			return output({ error: "Unexpected upload fixture request" }, 503);
		},
	});
	return {
		server,
		directory,
		release: () => {
			release?.();
			held = null;
			release = null;
		},
	};
}
if (import.meta.main) startSpacesUploadHost();
