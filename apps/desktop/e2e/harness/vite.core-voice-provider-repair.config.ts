import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import {
	proofClientCapability,
	proofProxyAuthorization,
} from "./proof-proxy-authorization.ts";
import { voiceProofRoutes } from "./proof-proxy-routes.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const tree = process.env.RYU_VOICE_UI_TREE;
const commit = process.env.RYU_VOICE_UI_COMMIT;
const candidate = process.env.RYU_VOICE_UI_ROOT;
if (!(candidate && tree && commit)) {
	throw new Error("Pass exact voice frontend export metadata");
}
const desktop = path.join(candidate, "apps/desktop");
const core = process.env.CORE_VOICE_PROOF_CORE_URL;
const token = process.env.CORE_VOICE_PROOF_TOKEN;
if (core !== "http://127.0.0.1:54531" || !token) {
	throw new Error("Pass isolated Core endpoint and token");
}
const seams = path.join(
	import.meta.dirname,
	"core-voice-provider-repair-seams.ts"
);
const hashes = new Map<string, string>();
const proof = path.join(root, "docs/proof/core-voice-provider-repair");
mkdirSync(proof, { recursive: true });
const record = () =>
	writeFileSync(
		path.join(proof, "selected-source-hashes.json"),
		JSON.stringify(
			{
				commit,
				tree,
				sourceRoot: candidate,
				files: [...hashes].map(([file, sha256]) => ({ file, sha256 })),
			},
			null,
			2
		)
	);
function runtimeTarget<ExportValue>(value: ExportValue): string | null {
	if (isNativeText(value)) {
		return value;
	}
	if (isNativeObjectLike(value)) {
		// SAFETY: The native object-kind observation establishes only an object.
		// These optional cells remain opaque: no presence, JSON value, or package schema is asserted.
		const conditions = value as {
			browser?: unknown;
			import?: unknown;
			default?: unknown;
		};
		for (const key of ["browser", "import", "default"] as const) {
			const selected = runtimeTarget(conditions[key]);
			if (selected) {
				return selected;
			}
		}
	}
	return null;
}
const workspaceAliases: { find: string | RegExp; replacement: string }[] = [];
for (const folder of ["packages", "apps", "apps-store"]) {
	for (const child of readdirSync(path.join(candidate, folder), {
		withFileTypes: true,
	})) {
		if (!child.isDirectory()) {
			continue;
		}
		for (const suffix of ["", "ui"]) {
			const directory = path.join(candidate, folder, child.name, suffix);
			const file = path.join(directory, "package.json");
			if (!existsSync(file)) {
				continue;
			}
			const metadata = JSON.parse(readFileSync(file, "utf8"));
			if (!(metadata.name && metadata.exports)) {
				continue;
			}
			for (const [key, value] of Object.entries(metadata.exports)) {
				const target = runtimeTarget(value);
				if (!target) {
					continue;
				}
				const find = `${metadata.name}${key === "." ? "" : key.slice(1)}`;
				const replacement = path
					.resolve(directory, target)
					.replaceAll("\\", "/");
				if (key.includes("*")) {
					const pattern = find
						.split("*")
						.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
						.join("(.*)");
					workspaceAliases.push({
						find: new RegExp(`^${pattern}$`),
						replacement: replacement.replace("*", "$1"),
					});
				} else {
					workspaceAliases.push({ find, replacement });
					if (/\.(tsx?|jsx?)$/.test(target)) {
						workspaceAliases.push({
							find: find + path.extname(target),
							replacement,
						});
					}
				}
			}
		}
	}
}
workspaceAliases.sort(
	(left, right) => String(right.find).length - String(left.find).length
);
const graph = {
	name: "exact-committed-voice-ui-graph",
	enforce: "pre" as const,
	async resolveId(source: string, importer: string | undefined) {
		if (source.startsWith("@ryu/") || source.startsWith("@ryuhq/")) {
			throw new Error(`Unmapped candidate workspace import: ${source}`);
		}
		const resolved = await this.resolve(source, importer, { skipSelf: true });
		if (!resolved || resolved.external) {
			return null;
		}
		const relative = path
			.relative(root, resolved.id.split("?")[0])
			.replaceAll("\\", "/");
		if (
			/^(apps|apps-store|packages)\//.test(relative) &&
			!relative.includes("/node_modules/") &&
			!relative.startsWith("apps/desktop/e2e/")
		) {
			const file = path.join(candidate, relative);
			if (!existsSync(file)) {
				throw new Error(`Candidate graph file missing: ${relative}`);
			}
			return file;
		}
		return null;
	},
	transform(source: string, id: string) {
		const file = id.split("?")[0];
		const relative = path.relative(candidate, file).replaceAll("\\", "/");
		if (
			path.isAbsolute(relative) ||
			relative.startsWith("../") ||
			relative.includes("/node_modules/")
		) {
			return null;
		}
		hashes.set(
			relative,
			createHash("sha256").update(readFileSync(file)).digest("hex")
		);
		record();
		if (relative !== "apps/desktop/src/index.css") {
			return null;
		}
		const shared = path.join(candidate, "packages/ui/src/styles/globals.css");
		const output = path.join(
			root,
			".tmp/core-voice-provider-repair/scoped-globals.css"
		);
		const css = readFileSync(shared, "utf8")
			.replace(/^@source\s+[^;]+;\s*$/gm, "")
			.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);')
			.replace(
				/@import\s+"(\.\/[^"\n]+)"/g,
				(_match, value: string) =>
					`@import "${path.resolve(path.dirname(shared), value).replaceAll("\\", "/")}"`
			);
		mkdirSync(path.dirname(output), { recursive: true });
		if (!existsSync(output) || readFileSync(output, "utf8") !== css) {
			writeFileSync(output, css);
		}
		const discovery = [
			"apps/desktop/src/components/settings",
			"packages/ui/src",
		]
			.map(
				(value) =>
					`@source "${path.join(candidate, value).replaceAll("\\", "/")}";`
			)
			.join("\n");
		return {
			code:
				source
					.replace(/^@source\s+[^;]+;\s*$/gm, "")
					.replace(
						'@import "@ryu/ui/globals.css";',
						`@import "${output.replaceAll("\\", "/")}";`
					) +
				`\n${discovery}\n@source "${path.join(import.meta.dirname, "core-voice-provider-repair.tsx").replaceAll("\\", "/")}";`,
			map: null,
		};
	},
};
export default defineConfig({
	root: import.meta.dirname,
	plugins: [
		proofProxyAuthorization(proofClientCapability(), 5331, voiceProofRoutes),
		graph,
		react(),
	],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	publicDir: path.join(desktop, "public"),
	cacheDir: path.join(
		root,
		".tmp/core-voice-provider-repair-exact/node_modules/.vite"
	),
	optimizeDeps: {
		entries: ["core-voice-provider-repair.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: seams },
			{ find: "./useActiveNode.ts", replacement: seams },
			...workspaceAliases,
			{ find: "@", replacement: desktop },
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5331,
		strictPort: true,
		hmr: false,
		fs: { allow: [root, candidate] },
		proxy: {
			"/api": {
				target: core,
				changeOrigin: true,
				headers: { authorization: `Bearer ${token}` },
			},
		},
	},
});
