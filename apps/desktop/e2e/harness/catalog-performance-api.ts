import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";
import { z } from "zod";

const catalogWriteSchema = z.object({
	name: z.string().optional(),
	data_base64: z.string().optional(),
});

async function readJson(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk));
	}
	return catalogWriteSchema.parse(
		JSON.parse(Buffer.concat(chunks).toString() || "{}")
	);
}
const documents = [
	{
		id: "slides",
		title: "Review.pptx",
		mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		file: "review.pptx",
	},
	{
		id: "spreadsheet",
		title: "Budget.xlsx",
		mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		file: "budget.xlsx",
	},
	{
		id: "document",
		title: "Proposal.docx",
		mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		file: "proposal.docx",
	},
	{
		id: "pdf",
		title: "Policy.pdf",
		mime: "application/pdf",
		file: "policy.pdf",
	},
];
export function catalogPerformanceApi(): Plugin {
	let catalogReads = 0;
	let polls = 0;
	let saves = 0;
	const names = new Map<string, string>();
	const enabled = new Map<string, boolean>();
	return {
		name: "catalog-performance-api",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				const url = request.url ?? "";
				if (!url.startsWith("/proof-")) {
					next();
					return;
				}
				response.setHeader("Content-Type", "application/json");
				const send = <FixturePayload>(body: FixturePayload) =>
					response.end(JSON.stringify(body));
				if (url === "/proof-reset") {
					catalogReads = 0;
					polls = 0;
					saves = 0;
					names.clear();
					enabled.clear();
					send({ ok: true });
					return;
				}
				if (url === "/proof-metrics") {
					send({ catalogReads, polls, saves });
					return;
				}
				if (url === "/proof-poll") {
					polls++;
					send({ ok: true });
					return;
				}
				const match = url.match(/^\/proof-api\/([^/]+)(\/api\/.*)$/);
				if (!match) {
					response.statusCode = 404;
					send({ error: "Unknown proof route" });
					return;
				}
				const node = match[1];
				const endpoint = match[2];
				try {
					if (endpoint === "/api/agents" && request.method === "GET") {
						catalogReads++;
						send({
							agents: [
								{
									id: "agent-1",
									name: names.get(node) ?? `${node} researcher`,
									built_in: false,
								},
							],
						});
						return;
					}
					if (endpoint === "/api/engines") {
						catalogReads++;
						send({ engines: [] });
						return;
					}
					if (endpoint === "/api/engine/active") {
						catalogReads++;
						send({ active: null, running: false, available: [] });
						return;
					}
					if (endpoint === "/api/plugins") {
						catalogReads++;
						send({
							apps: [
								{
									id: "app-1",
									name: `${node} Notes`,
									enabled: enabled.get(node) ?? false,
									installed: true,
									version: "1.0.0",
									capabilities: [],
									runnables: [],
									permission_grants: [],
								},
							],
						});
						return;
					}
					if (endpoint === "/api/agents/agent-1" && request.method === "PUT") {
						const data = await readJson(request);
						names.set(node, String(data.name));
						send({
							agent: {
								id: "agent-1",
								name: names.get(node),
								tools: [],
								built_in: false,
							},
						});
						return;
					}
					if (
						endpoint === "/api/plugins/app-1/enable" ||
						endpoint === "/api/plugins/app-1/disable"
					) {
						const value = endpoint.endsWith("/enable");
						enabled.set(node, value);
						send({
							app: { id: "app-1", enabled: value, config: {}, installed: true },
						});
						return;
					}
					if (endpoint === "/api/system/status") {
						send({
							engine: { active: null, running: false },
							gateway: { reachable: true },
							sidecars: [{ name: "shadow", running: false }],
							mesh: null,
						});
						return;
					}
					if (endpoint === "/api/spaces/space-1/documents") {
						send({
							documents: documents.map((doc) => ({
								...doc,
								space_id: "space-1",
								kind: "file",
							})),
						});
						return;
					}
					const blob = endpoint.match(
						/^\/api\/spaces\/space-1\/documents\/([^/]+)\/blob$/
					);
					if (blob) {
						const doc = documents.find((item) => item.id === blob[1]);
						if (!doc) {
							throw new Error("Unknown fixture");
						}
						if (request.method === "GET") {
							response.setHeader("Content-Type", doc.mime);
							response.end(
								await readFile(
									path.join(
										import.meta.dirname,
										"performance-fixtures",
										doc.file
									)
								)
							);
							return;
						}
						const body = await readJson(request);
						saves++;
						send({
							id: doc.id,
							title: doc.title,
							mime: doc.mime,
							byte_size: Buffer.from(String(body.data_base64 ?? ""), "base64")
								.length,
						});
						return;
					}
					response.statusCode = 404;
					send({ error: `Unimplemented fixture: ${endpoint}` });
				} catch (error) {
					response.statusCode = 500;
					send({
						error: error instanceof Error ? error.message : "Proof API failed",
					});
				}
			});
		},
	};
}
