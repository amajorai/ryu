import type { IncomingMessage } from "node:http";
import path from "node:path";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { z } from "zod";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const MODEL_SELECTION_PATH =
	"/api/conversations/model-selection-proof-room/model-selection";

interface StoredModelChange {
	changedBy: string | null;
	createdAt: number;
	id: string;
	kind: "change" | "initial";
	modelId: string | null;
	modelLabel: string | null;
	providerId: string | null;
	providerLabel: string | null;
	sequence: number;
}

async function readJsonBody(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	try {
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return value;
	} catch {
		return null;
	}
}

function modelSelectionApi(): Plugin {
	const changes: StoredModelChange[] = [];
	return {
		name: "conversation-model-selection-proof-api",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? "/", "http://localhost")
					.pathname;
				if (pathname !== MODEL_SELECTION_PATH) {
					next();
					return;
				}
				response.setHeader("content-type", "application/json");
				if (request.method === "GET") {
					response.statusCode = 200;
					response.end(
						JSON.stringify({
							changes,
							current: changes.at(-1) ?? null,
						})
					);
					return;
				}
				if (request.method !== "PUT") {
					response.statusCode = 405;
					response.end(JSON.stringify({ error: "method not allowed" }));
					return;
				}

				void readJsonBody(request).then((input) => {
					const result = z
						.object({
							changeId: z.string(),
							kind: z.enum(["change", "initial"]),
							providerId: z.string().nullable(),
							providerLabel: z.string().nullable(),
							modelId: z.string().nullable(),
							modelLabel: z.string().nullable(),
						})
						.safeParse(input);
					if (!result.success) {
						response.statusCode = 400;
						response.end(JSON.stringify({ error: "invalid selection" }));
						return;
					}
					const body = result.data;
					const current = changes.at(-1);
					const changed =
						!current ||
						current.providerId !== body.providerId ||
						current.modelId !== body.modelId;
					if (!changed) {
						response.statusCode = 200;
						response.end(JSON.stringify({ change: current, changed: false }));
						return;
					}
					const userJwt = request.headers["x-ryu-user-jwt"];
					const change: StoredModelChange = {
						changedBy: isNativeText(userJwt) ? userJwt : null,
						createdAt: Date.now(),
						id: body.changeId,
						kind: body.kind,
						modelId: body.modelId,
						modelLabel: body.modelLabel,
						providerId: body.providerId,
						providerLabel: body.providerLabel,
						sequence: changes.length + 1,
					};
					changes.push(change);
					response.statusCode = 200;
					response.end(JSON.stringify({ change, changed: true }));
				});
			});
		},
	};
}

export default defineConfig({
	base: "./",
	build: {
		emptyOutDir: true,
		outDir: path.resolve(harnessDir, "dist-model-selection-proof"),
		rollupOptions: {
			input: path.resolve(
				harnessDir,
				"conversation-model-selection-proof.html"
			),
		},
		target: "chrome105",
	},
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: [
			path.resolve(harnessDir, "conversation-model-selection-proof.html"),
		],

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react(), modelSelectionApi()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: { "@": desktopRoot },
		dedupe: ["react", "react-dom"],
	},
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-model-selection-proof"
	),
	server: {
		hmr: false,
		host: "127.0.0.1",
		port: Number(process.env.RYU_MODEL_SELECTION_E2E_PORT ?? "5192"),
		strictPort: true,
		watch: null,
	},
});
