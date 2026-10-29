import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type ViteDevServer } from "vite";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const proofFile = path.resolve(
	desktopRoot,
	"../../target/extension-parity-proof/selected-file.txt"
);
function installFixture(server: Pick<ViteDevServer, "middlewares">) {
	server.middlewares.use("/__proof/file", async (request, response) => {
		await mkdir(path.dirname(proofFile), { recursive: true });
		if (request.method === "PUT") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}
			await writeFile(proofFile, Buffer.concat(chunks));
			response.end("saved");
		} else {
			let text: string;
			try {
				text = await readFile(proofFile, "utf8");
			} catch {
				text = "Selected file: hex bolt\n";
				await writeFile(proofFile, text);
			}
			response.setHeader("Content-Type", "text/plain");
			response.end(text);
		}
	});
}
export default defineConfig({
	plugins: [
		react(),
		{
			name: "selected-file-proof",
			configureServer: installFixture,
			configurePreviewServer: installFixture,
		},
	],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: import.meta.dirname,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-extension-parity-proof"
	),
	optimizeDeps: { entries: ["extension-parity-proof.html"] },
	resolve: { alias: { "@": desktopRoot } },
	server: { host: "127.0.0.1", port: 5231, strictPort: true },
	preview: { host: "127.0.0.1", port: 5232, strictPort: true },
	build: {
		outDir: path.resolve(
			desktopRoot,
			"../../target/extension-parity-proof-build"
		),
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "extension-parity-proof.html"),
		},
	},
});
