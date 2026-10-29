import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const artifact = JSON.parse(
	readFileSync(
		path.resolve(
			import.meta.dirname,
			"../../../.tmp/new-parity-final-gates/gateway-runtime-artifact.json"
		),
		"utf8"
	)
);
const selectedSourceRoot =
	process.env.PROVIDER_POOL_SOURCE_ROOT ??
	path.resolve(
		import.meta.dirname,
		"../../../.tmp/new-parity-source",
		artifact.tree
	);
const proofPort = process.env.PROVIDER_POOL_PROOF_PORT ?? "5190";

export default defineConfig({
	testDir: ".",
	testMatch: "provider-pools-proof.spec.ts",
	use: {
		baseURL: `http://127.0.0.1:${proofPort}`,
		viewport: { width: 1280, height: 900 },
	},
	webServer: {
		env: {
			PROVIDER_POOL_SOURCE_ROOT: selectedSourceRoot,
			PROVIDER_POOL_PROOF_PORT: proofPort,
		},
		command:
			"bunx vite --config e2e/harness/vite.provider-pools-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `http://127.0.0.1:${proofPort}/provider-pools-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
