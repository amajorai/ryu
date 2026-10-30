import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const repositoryRoot = path.resolve(harnessDir, "../../../..");
const stylesDirectory = path.resolve(repositoryRoot, "packages/ui/src/styles");
const generatedStylesDirectory = path.resolve(
	repositoryRoot,
	"target/cloud-environments-proof-vite"
);
const generatedStylesPath = path.resolve(
	generatedStylesDirectory,
	"product-styles.css"
);
const productStyles = readFileSync(
	path.resolve(stylesDirectory, "globals.css"),
	"utf8"
)
	.replace(/^@source .*;\r?\n/gm, "")
	.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);')
	.replace(
		/@import "(\.\/[^"]+)";/g,
		(_, file: string) =>
			`@import "${path.resolve(stylesDirectory, file).replaceAll("\\", "/")}";`
	);
const desktopStylesDirectory = path.resolve(repositoryRoot, "apps/desktop/src");
const desktopStyles = readFileSync(
	path.resolve(desktopStylesDirectory, "index.css"),
	"utf8"
)
	.replace(/^@source .*;\r?\n/gm, "")
	.replace('@import "@ryu/ui/globals.css";', "")
	.replace(
		/@import "(\.\.?\/[^"]+)";/g,
		(_, file: string) =>
			`@import "${path.resolve(desktopStylesDirectory, file).replaceAll("\\", "/")}";`
	);
const sources = [
	path.resolve(harnessDir, "cloud-environments-proof.tsx"),
	path.resolve(
		repositoryRoot,
		"apps/desktop/src/components/gateway/CloudEnvironmentsSettings.tsx"
	),
	path.resolve(
		repositoryRoot,
		"apps/desktop/src/components/gateway/cloud-environments"
	),
	path.resolve(
		repositoryRoot,
		"apps/desktop/src/components/chat/CloudEnvironmentPicker.tsx"
	),
	path.resolve(
		repositoryRoot,
		"apps/desktop/src/components/chat/CloudGithubConnectionDialog.tsx"
	),
	path.resolve(
		repositoryRoot,
		"apps/desktop/src/components/settings/shared/settings-items.tsx"
	),
	path.resolve(
		repositoryRoot,
		"packages/blocks/src/desktop/settings-items.tsx"
	),
	path.resolve(repositoryRoot, "packages/ui/src/components"),
]
	.map((source) => `@source "${source.replaceAll("\\", "/")}";`)
	.join("\n");
mkdirSync(generatedStylesDirectory, { recursive: true });
const imports =
	`${productStyles}\n${desktopStyles}`.match(/^@import [^;]+;/gm) ?? [];
const rules = `${productStyles}\n${desktopStyles}`.replace(
	/^@import [^;]+;\r?\n/gm,
	""
);
writeFileSync(
	generatedStylesPath,
	`${imports.join("\n")}\n${rules}\n${sources}\n`,
	"utf8"
);
const proofFiles = [
	"apps/desktop/src/components/gateway/CloudEnvironmentsSettings.tsx",
	"apps/desktop/src/lib/api/cloud-environments.ts",
	"apps/desktop/src/lib/api/cloud-environment-input.ts",
	"packages/protocol/src/cloud-environments.ts",
	"packages/blocks/src/desktop/settings-items.tsx",
	"packages/ui/src/styles/globals.css",
	"apps/desktop/src/index.css",
	"apps/desktop/e2e/harness/cloud-environments-proof.tsx",
	"apps/desktop/src/components/chat/CloudEnvironmentPicker.tsx",
	"apps/desktop/src/components/chat/CloudGithubConnectionDialog.tsx",
	"apps/desktop/src/components/chat/WorkspaceBar.tsx",
	"apps/desktop/src/hooks/useCloudTaskSelection.ts",
	"apps/desktop/src/lib/cloud-task-selection.ts",
	"apps/desktop/src/lib/api/cloud-github.ts",
	"apps/desktop/src/pages/ChatPage.tsx",
	"packages/core-client/src/chat.ts",
];
const proofInputHashes = Object.fromEntries(
	proofFiles.map((file) => [
		file,
		createHash("sha256")
			.update(readFileSync(path.resolve(repositoryRoot, file)))
			.digest("hex"),
	])
);

export default defineConfig({
	plugins: [
		react(),
		{
			name: "cloud-settings-proof-inputs",
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "source-hashes.json",
					source: JSON.stringify(proofInputHashes, null, 2),
				});
			},
		},
	],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	cacheDir: path.resolve(
		harnessDir,
		"../../../../target/cloud-environments-proof-vite"
	),
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "cloud-environments-proof.html")],
	},
	resolve: {
		alias: [
			{
				find: "cloud-environments-product.css",
				replacement: generatedStylesPath,
			},
			{
				find: "@/src/hooks/useActiveNode.ts",
				replacement: path.resolve(
					harnessDir,
					"cloud-environments-proof-node.ts"
				),
			},
			{
				find: "@/lib/auth-client.ts",
				replacement: path.resolve(
					harnessDir,
					"cloud-environments-proof-auth.ts"
				),
			},
			{ find: "@", replacement: path.resolve(harnessDir, "../..") },
		],
	},
	server: { host: "127.0.0.1", port: 5249, strictPort: true },
	preview: { host: "127.0.0.1", port: 5249, strictPort: true },
	build: {
		outDir: path.resolve(
			repositoryRoot,
			"target/cloud-environments-proof-build"
		),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "cloud-environments-proof.html"),
		},
	},
});
