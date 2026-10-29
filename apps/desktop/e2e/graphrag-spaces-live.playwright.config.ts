import { rmSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const CORE_PORT = 17_980;
const EMBEDDING_PORT = 18_081;
const VITE_PORT = 15_177;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const STORY_URL = `http://127.0.0.1:${VITE_PORT}`;
const NODE_TOKEN = "graphrag-e2e-node-token-2026-08-23";
const dataDir = path.resolve("test-results/graphrag-spaces-live/ryu-dir");
const coreCommand =
	process.env.GRAPHRAG_CORE_COMMAND ?? "cargo run -p ryu-core";

if (process.env.TEST_WORKER_INDEX === undefined) {
	rmSync(dataDir, { force: true, recursive: true });
}

export default defineConfig({
	fullyParallel: false,
	outputDir: "test-results/graphrag-spaces-live/playwright",
	reporter: "list",
	testDir: ".",
	testMatch: /graphrag-spaces\.live\.spec\.ts/,
	use: {
		baseURL: STORY_URL,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { height: 1600, width: 1440 },
			},
		},
	],
	webServer: [
		{
			command: "bun ./fixtures/graphrag-embeddings-server.ts",
			env: { GRAPHRAG_EMBED_PORT: String(EMBEDDING_PORT) },
			reuseExistingServer: false,
			timeout: 30_000,
			url: `http://127.0.0.1:${EMBEDDING_PORT}/health`,
		},
		{
			command: coreCommand,
			cwd: path.resolve(import.meta.dirname, "../../.."),
			env: {
				RYU_BIND: `127.0.0.1:${CORE_PORT}`,
				RYU_CORS_ORIGINS: STORY_URL,
				RYU_DIR: dataDir,
				RYU_EMBED_BASE_URL: `http://127.0.0.1:${EMBEDDING_PORT}`,
				RYU_EMBED_DIMS: "8",
				RYU_EMBED_MODEL: "graphrag-e2e",
				RYU_GRAPH_EXTRACTION_MODEL: "local-cooccurrence",
				RYU_KEYCHAIN: "off",
				RYU_PROFILE: "dev",
				RYU_RERANKER_BASE_URL: `http://127.0.0.1:${EMBEDDING_PORT}`,
				RYU_TOKEN: NODE_TOKEN,
			},
			reuseExistingServer: false,
			timeout: 900_000,
			url: `${CORE_URL}/api/health`,
		},
		{
			command: `bunx vite --config harness/vite.harness.config.ts --host 127.0.0.1 --port ${VITE_PORT} --strictPort`,
			env: {
				VITE_GRAPHRAG_CORE_TOKEN: NODE_TOKEN,
				VITE_GRAPHRAG_CORE_URL: CORE_URL,
			},
			reuseExistingServer: false,
			timeout: 120_000,
			url: `${STORY_URL}/graphrag-spaces-live.html`,
		},
	],
});
