import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import {
	type LanguagePack,
	languagePackArchive,
	MAX_LANGUAGE_PACK_ARCHIVE_BYTES,
	parseLanguagePackArchive,
} from "../../../../packages/i18n/src/core.ts";
import { installedIndividualIcons } from "./installed-individual-icons.ts";

const desktop = path.resolve(import.meta.dirname, "../..");
const cacheDir = process.env.RYU_LANGUAGE_VITE_CACHE;
if (!(cacheDir && path.isAbsolute(cacheDir))) {
	throw new Error("An absolute owned language Vite cache is required");
}
const initialPacks: LanguagePack[] = [
	{
		schemaVersion: 1,
		id: "coverage/window",
		name: "Window proof Spanish",
		version: "1.0.0",
		locale: "es",
		baseLocale: "en",
		direction: "ltr",
		enabled: true,
		messages: { "common.install": "Instalar entre ventanas" },
	},
	{
		schemaVersion: 1,
		id: "coverage/disabled",
		name: "Disabled French",
		version: "1.0.0",
		locale: "fr",
		baseLocale: "en",
		direction: "ltr",
		enabled: false,
		messages: { "common.install": "Installer après confirmation" },
	},
];
function installedPackage(pack: LanguagePack, digest: string) {
	return {
		id: pack.id,
		kind: "language_pack",
		version: pack.version,
		enabled: true,
		installed_at_unix_ms: 1_791_504_000_000,
		package_digest: digest,
		runtime_ids: [],
	};
}
function languageFixture(): Plugin {
	let packs = structuredClone(initialPacks);
	let enabledRefused = false;
	let importRefused = false;
	let enableWrites = 0;
	let importWrites = 0;
	let catalogReads = 0;
	let importedArchiveSha256: string | null = null;
	const unexpected: string[] = [];
	const middleware = (
		request: IncomingMessage,
		response: ServerResponse,
		next: () => void
	) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const send = (status: number, value: unknown) => {
			response.statusCode = status;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(value));
		};
		const rawBody = async () => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of request) {
				const buffer = Buffer.from(chunk);
				bytes += buffer.byteLength;
				if (bytes > MAX_LANGUAGE_PACK_ARCHIVE_BYTES * 2) {
					throw new Error("fixture body too large");
				}
				chunks.push(buffer);
			}
			return Buffer.concat(chunks).toString("utf8");
		};
		if (
			url.pathname === "/__language-proof/control" &&
			request.method === "POST" &&
			url.search === ""
		) {
			void rawBody()
				.then((raw) => {
					const input: unknown = JSON.parse(raw);
					if (!input || typeof input !== "object" || Array.isArray(input)) {
						throw new Error("invalid fixture control object");
					}
					for (const key of Object.keys(input)) {
						if (
							!["enabledRefused", "importRefused", "reset"].includes(key) ||
							typeof Reflect.get(input, key) !== "boolean"
						) {
							throw new Error("invalid fixture control field");
						}
					}
					enabledRefused = Reflect.get(input, "enabledRefused") === true;
					importRefused = Reflect.get(input, "importRefused") === true;
					if (Reflect.get(input, "reset") === true) {
						packs = structuredClone(initialPacks);
						enableWrites = 0;
						importWrites = 0;
						catalogReads = 0;
						importedArchiveSha256 = null;
						unexpected.length = 0;
					}
					send(200, { enabledRefused, importRefused });
				})
				.catch(() => send(400, { error: "invalid fixture control" }));
			return;
		}
		if (
			url.pathname === "/__language-proof/receipts" &&
			request.method === "GET" &&
			url.search === ""
		) {
			send(200, {
				enableWrites,
				importWrites,
				catalogReads,
				importedArchiveSha256,
				packs,
				unexpected,
			});
			return;
		}
		if (!url.pathname.startsWith("/api/")) {
			next();
			return;
		}
		if (
			request.headers.authorization !== "Bearer language-proof-node" ||
			request.headers["x-ryu-user-jwt"] !== undefined ||
			request.headers["x-ryu-buyer-token"] !== undefined
		) {
			unexpected.push(`admission:${request.method}:${url.pathname}`);
			send(401, { error: "wrong fixture admission bearer" });
			return;
		}
		if (url.search !== "") {
			unexpected.push(`query:${request.method}:${url.pathname}${url.search}`);
			send(422, { error: "undeclared fixture query" });
			return;
		}
		if (
			url.pathname === "/api/language-packs/installed" &&
			request.method === "GET"
		) {
			void rawBody()
				.then((raw) => {
					if (raw !== "") {
						unexpected.push(`body:${request.method}:${url.pathname}`);
						send(422, { error: "undeclared catalog body" });
						return;
					}
					catalogReads += 1;
					send(200, { packs });
				})
				.catch(() => send(400, { error: "invalid catalog body" }));
			return;
		}
		if (
			url.pathname === "/api/language-packs/import" &&
			request.method === "POST"
		) {
			void rawBody()
				.then((raw) => {
					try {
						const input: unknown = JSON.parse(raw);
						if (
							!input ||
							typeof input !== "object" ||
							Array.isArray(input) ||
							Object.keys(input).length !== 1 ||
							typeof Reflect.get(input, "archive_base64") !== "string"
						) {
							unexpected.push(`import-body:${raw}`);
							throw new Error("undeclared import body");
						}
						const encoded: unknown = Reflect.get(input, "archive_base64");
						if (typeof encoded !== "string") {
							throw new Error("missing archive");
						}
						const archive = Buffer.from(encoded, "base64");
						if (archive.toString("base64") !== encoded) {
							throw new Error("invalid base64");
						}
						importWrites += 1;
						if (importRefused) {
							send(503, { error: "fixture import write refused" });
							return;
						}
						const pack = parseLanguagePackArchive(archive);
						importedArchiveSha256 = createHash("sha256")
							.update(archive)
							.digest("hex");
						packs = [
							...packs.filter((candidate) => candidate.id !== pack.id),
							{ ...pack, enabled: true },
						];
						send(200, {
							success: true,
							package: installedPackage(pack, importedArchiveSha256),
							pack,
						});
					} catch {
						send(400, { error: "archive rejected" });
					}
				})
				.catch(() => send(400, { error: "invalid import body" }));
			return;
		}
		if (
			url.pathname ===
				"/api/marketplace/packages/language_pack/coverage%2Fdisabled/enable" &&
			request.method === "POST"
		) {
			void rawBody()
				.then((raw) => {
					if (raw !== "") {
						unexpected.push(`body:${request.method}:${url.pathname}`);
						send(422, { error: "undeclared enable body" });
						return;
					}
					enableWrites += 1;
					if (enabledRefused) {
						send(503, { error: "fixture write refused" });
						return;
					}
					const pack = packs.find(
						(candidate) => candidate.id === "coverage/disabled"
					);
					if (!pack) {
						throw new Error("missing fixture package");
					}
					pack.enabled = true;
					send(200, {
						success: true,
						package: installedPackage(
							pack,
							createHash("sha256")
								.update(languagePackArchive(pack))
								.digest("hex")
						),
					});
				})
				.catch(() => send(400, { error: "invalid enable body" }));
			return;
		}
		unexpected.push(`${request.method}:${url.pathname}`);
		send(404, { error: "unhandled fixture route" });
	};
	return {
		name: "language-native-http-boundary-fixture",
		configureServer(server) {
			server.middlewares.use(middleware);
		},
		configurePreviewServer(server) {
			server.middlewares.use(middleware);
		},
	};
}
export default defineConfig({
	root: import.meta.dirname,
	cacheDir,
	publicDir: path.join(desktop, "public"),
	plugins: [languageFixture(), installedIndividualIcons(), react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["language-settings-proof.html"],
		exclude: [
			"@hugeicons/core-free-icons",
			"@tabler/icons-react",
			"lucide-react",
		],
		esbuildOptions: { target: "esnext" },
	},
	resolve: { dedupe: ["react", "react-dom"], alias: { "@": desktop } },
	build: {
		outDir: path.join(cacheDir, "build"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.join(import.meta.dirname, "language-settings-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_E2E_PORT ?? "5190"),
		strictPort: true,
	},
	preview: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_E2E_PORT ?? "5190"),
		strictPort: true,
	},
});
