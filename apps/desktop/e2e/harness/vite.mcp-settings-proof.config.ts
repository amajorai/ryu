import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type ViteDevServer } from "vite";
import { z } from "zod";
import { parseProofJsonRecord } from "../fixture-json.ts";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const proofDirectory = path.resolve(
	desktopRoot,
	"../../target/mcp-settings-proof"
);
const settingsFile = path.join(proofDirectory, "settings.json");
const eventsFile = path.join(proofDirectory, "events.json");

const schema = {
	type: "object",
	properties: {
		units: { type: "string", title: "Measurement units", enum: ["mm", "in"] },
		showGrid: {
			type: "boolean",
			title: "Show grid",
			description: "Display a grid while editing parts.",
		},
		lineWidth: {
			type: "integer",
			title: "Line width",
			minimum: 1,
			maximum: 10,
		},
	},
};

function fixture(server: Pick<ViteDevServer, "middlewares">) {
	server.middlewares.use(async (request, response, next) => {
		if (!request.url?.startsWith("/api/")) {
			next();
			return;
		}
		response.setHeader("Content-Type", "application/json");
		if (request.headers.authorization !== "Bearer settings-proof") {
			response.statusCode = 401;
			response.end(
				JSON.stringify({ error: "Fixture authentication required" })
			);
			return;
		}
		await mkdir(proofDirectory, { recursive: true });
		let values;
		try {
			values = z
				.object({
					units: z.string(),
					showGrid: z.boolean(),
					lineWidth: z.number(),
				})
				.parse(JSON.parse(await readFile(settingsFile, "utf8")));
		} catch {
			values = { units: "mm", showGrid: false, lineWidth: 2 };
			await writeFile(settingsFile, JSON.stringify(values));
		}
		if (request.url.startsWith("/api/agents")) {
			response.end(
				JSON.stringify({
					agents: [
						{ id: "proof-agent", name: "Local fixture agent", enabled: true },
					],
				})
			);
			return;
		}
		if (request.url.startsWith("/api/mcp/tools") && request.method === "GET") {
			response.end(
				JSON.stringify({
					tools: [
						{
							id: "parts.settings.verify",
							name: "settings.verify",
							server: "parts",
						},
					],
				})
			);
			return;
		}
		if (request.url === "/api/mcp/tools/call" && request.method === "POST") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}
			const input = parseProofJsonRecord(
				Buffer.concat(chunks).toString("utf8")
			);
			if (input.agent_id !== "proof-agent") {
				response.statusCode = 403;
				response.end(
					JSON.stringify({
						ok: false,
						error: "Select the authorized fixture agent",
					})
				);
				return;
			}
			if (input.tool === "parts.settings.read") {
				response.end(
					JSON.stringify({
						ok: true,
						output: {
							content: [],
							structuredContent: {
								schema,
								values,
								layout: [
									{
										kind: "group",
										title: "Display",
										items: [
											{ kind: "property", property: "units" },
											{ kind: "property", property: "showGrid" },
											{
												kind: "tool",
												tool: "settings.verify",
												title: "Verify settings",
											},
										],
									},
								],
							},
						},
					})
				);
				return;
			}
			if (input.tool === "parts.settings.update") {
				const update = z
					.object({
						set: z
							.object({
								units: z.string().optional(),
								showGrid: z.boolean().optional(),
								lineWidth: z.number().optional(),
							})
							.strict(),
					})
					.safeParse(input.arguments);
				const changed = update.success ? update.data.set : undefined;
				if (
					!changed ||
					Object.keys(changed).some((key) => !Object.hasOwn(values, key)) ||
					Object.values(changed).some(
						(value) =>
							!(
								isNativeText(value) ||
								isNativeNumber(value) ||
								isNativeBoolean(value)
							)
					)
				) {
					response.statusCode = 400;
					response.end(
						JSON.stringify({ ok: false, error: "Invalid settings update" })
					);
					return;
				}
				for (const [key, value] of Object.entries(changed)) {
					if (
						isNativeText(value) ||
						isNativeNumber(value) ||
						isNativeBoolean(value)
					) {
						if (key === "units" && isNativeText(value)) {
							values.units = value;
						}
						if (key === "showGrid" && isNativeBoolean(value)) {
							values.showGrid = value;
						}
						if (key === "lineWidth" && isNativeNumber(value)) {
							values.lineWidth = value;
						}
					}
				}
				await writeFile(settingsFile, JSON.stringify(values));
				await writeFile(eventsFile, JSON.stringify(input));
				response.end(
					JSON.stringify({
						ok: true,
						output: { content: [], structuredContent: { values } },
					})
				);
				return;
			}
			if (input.tool === "parts.settings.verify") {
				response.end(
					JSON.stringify({
						ok: true,
						output: {
							content: [
								{
									type: "text",
									text: "Settings verified against the local fixture.",
								},
							],
						},
					})
				);
				return;
			}
		}
		response.statusCode = 404;
		response.end(
			JSON.stringify({ ok: false, error: "Unknown fixture endpoint" })
		);
	});
}

export default defineConfig({
	optimizeDeps: {
		entries: ["mcp-settings-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	plugins: [
		react(),
		{
			name: "settings-fixture",
			configureServer: fixture,
			configurePreviewServer: fixture,
		},
	],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: import.meta.dirname,
	cacheDir: path.resolve(desktopRoot, "node_modules/.vite-mcp-settings-proof"),
	resolve: { alias: { "@": desktopRoot } },
	server: { host: "127.0.0.1", port: 5236, strictPort: true },
	preview: { host: "127.0.0.1", port: 5237, strictPort: true },
	build: {
		target: "chrome105",
		outDir: path.resolve(desktopRoot, "../../target/mcp-settings-proof-build"),
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "mcp-settings-proof.html"),
		},
	},
});
