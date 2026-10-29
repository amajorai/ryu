import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./a2a-proof.vite.config.ts";

export default mergeConfig(
	base,
	defineConfig({
		cacheDir: path.resolve(tmpdir(), "ryu-vault-page-proof-vite"),
		build: {
			outDir:
				process.env.RYU_VAULT_PROOF_OUTPUT ??
				path.resolve(import.meta.dirname, "dist-vault-page-proof"),
			rollupOptions: {
				input: path.resolve(import.meta.dirname, "vault-page-proof.html"),
			},
		},
	})
);
