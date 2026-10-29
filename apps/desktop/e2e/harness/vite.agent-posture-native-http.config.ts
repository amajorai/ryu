import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const proofDirectory = process.env.RYU_AGENT_POSTURE_PROOF_DIR;
if (
	!(
		proofDirectory &&
		path.isAbsolute(proofDirectory) &&
		path
			.resolve(proofDirectory)
			.startsWith(
				`${path.resolve(tmpdir())}${path.sep}ryu-agent-posture-native-http-`
			)
	)
) {
	throw new Error(
		"Use the owned agent-posture-native-http.preview.ts launcher"
	);
}
export default defineConfig({
	cacheDir: path.join(proofDirectory, "vite-cache"),
	build: {
		target: "esnext",
		outDir: path.join(proofDirectory, "out"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(
				import.meta.dirname,
				"agent-posture-native-http.html"
			),
		},
	},
	preview: { host: "127.0.0.1", port: 5730, strictPort: true },
	root: import.meta.dirname,
	publicDir: path.join(desktopRoot, "public"),
	plugins: [react()],
	assetsInclude: ["**/*.glb"],
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:5731"
		),
	},
	resolve: { alias: { "@": desktopRoot } },
	css: { postcss: { plugins: [tailwindcss()] } },
	server: {
		host: "127.0.0.1",
		port: 5730,
		strictPort: true,
		fs: {
			allow: [path.resolve(desktopRoot, "../.."), import.meta.dirname],
		},
	},
	optimizeDeps: {
		entries: ["agent-posture-native-http.html"],
		esbuildOptions: { target: "esnext" },
	},
});
