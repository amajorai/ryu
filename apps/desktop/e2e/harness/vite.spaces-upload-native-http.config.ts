import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const proofDirectory = process.env.RYU_SPACES_UPLOAD_PROOF_DIR;
if (
	!(
		proofDirectory &&
		path.isAbsolute(proofDirectory) &&
		path
			.resolve(proofDirectory)
			.startsWith(
				path.resolve(tmpdir()) + path.sep + "ryu-spaces-upload-native-http-"
			)
	)
) {
	throw new Error(
		"Use the owned spaces-upload-native-http.preview.ts launcher"
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
				"spaces-upload-native-http.html"
			),
		},
	},
	preview: { host: "127.0.0.1", port: 5710, strictPort: true },
	root: import.meta.dirname,
	publicDir: path.join(desktopRoot, "public"),
	plugins: [react()],
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:5711"
		),
	},
	resolve: { alias: { "@": desktopRoot } },
	css: { postcss: { plugins: [tailwindcss()] } },
	server: {
		host: "127.0.0.1",
		port: 5710,
		strictPort: true,
		fs: {
			allow: [path.resolve(desktopRoot, "../.."), import.meta.dirname],
		},
	},
	optimizeDeps: {
		entries: ["spaces-upload-native-http.html"],
		esbuildOptions: { target: "esnext" },
	},
});
