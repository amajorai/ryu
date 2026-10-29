import { tmpdir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type Plugin } from "vite";
import desktopConfig from "../../vite.config.ts";
import { rewriteIndividualIconImports } from "./individual-icon-imports.ts";
import base from "./vite.rules-agent-edit-panel-proof.config.ts";

// Match Desktop's production entry resolution instead of parsing the flattened
// icon package barrel as one module in this real AgentEditPage graph.
const modularIcons = path.join(
	path.dirname(
		fileURLToPath(
			import.meta.resolve("@hugeicons/core-free-icons/package.json")
		)
	),
	"dist/esm/index.js"
);

// Import the same package exports directly so this proof does not ask Rollup
// to load the whole icon catalog before it can tree-shake unused exports.
// Read aliases from the package's own entry, rather than assuming every export
// name matches a filename (some icon exports have several public names).
function individualIconImports(): Plugin {
	const diagnosticPath = process.env.RYU_OPTIMIZER_GRAPH_DIAGNOSTIC_PATH;
	const lastModules: { id: string; bytes: number }[] = [];
	const packages = new Map<string, { modules: number; bytes: number }>();
	const unmatchedIconImports: { id: string; names: string[] }[] = [];
	let transformedModules = 0;
	let rawIconImports = 0;
	let rewrittenIconImports = 0;
	let rewrittenIconNames = 0;
	const iconEntries = new Map([
		["@hugeicons/core-free-icons", modularIcons],
		[
			"@tabler/icons-react",
			fileURLToPath(
				import.meta.resolve(
					"@tabler/icons-react/dist/esm/tabler-icons-react.mjs"
				)
			),
		],
		[
			"lucide-react",
			fileURLToPath(
				import.meta.resolve("lucide-react/dist/esm/lucide-react.js")
			),
		],
	]);
	const iconPaths = new Map<string, Map<string, string>>();
	for (const [packageName, entry] of iconEntries) {
		const exports = new Map<string, string>();
		for (const row of readFileSync(entry, "utf8").matchAll(
			/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g
		)) {
			for (const exported of row[1].matchAll(/default\s+as\s+(\w+)/g)) {
				exports.set(exported[1], path.resolve(path.dirname(entry), row[2]));
			}
		}
		iconPaths.set(packageName, exports);
	}
	function writeDiagnostic() {
		if (!diagnosticPath) {
			return;
		}
		writeFileSync(
			diagnosticPath,
			JSON.stringify({
				transformedModules,
				iconExportNames: [...iconPaths.values()].reduce(
					(count, exports) => count + exports.size,
					0
				),
				iconPackageExports: [...iconPaths].map(([name, exports]) => ({
					name,
					names: exports.size,
				})),
				rawIconImports,
				rewrittenIconImports,
				rewrittenIconNames,
				lastModules,
				packages: [...packages.entries()]
					.sort((left, right) => right[1].bytes - left[1].bytes)
					.slice(0, 64)
					.map(([name, counts]) => ({ name, ...counts })),
				unmatchedIconImports,
			})
		);
	}
	return {
		name: "optimizer-proof-individual-icon-imports",
		enforce: "pre",
		transform(source, id) {
			if (diagnosticPath) {
				transformedModules += 1;
				lastModules.push({ id, bytes: source.length });
				if (lastModules.length > 128) {
					lastModules.shift();
				}
				const packageMatches = [
					...id.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/g),
				];
				const packageMatch = packageMatches.at(-1);
				const packageName = packageMatch?.[1] ?? "workspace";
				const counts = packages.get(packageName) ?? { modules: 0, bytes: 0 };
				counts.modules += 1;
				counts.bytes += source.length;
				packages.set(packageName, counts);
				if (transformedModules % 16 === 0) {
					writeDiagnostic();
				}
			}
			if (!/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) {
				return null;
			}
			const result = rewriteIndividualIconImports(source, id, iconPaths);
			rawIconImports += result.rawImports;
			rewrittenIconImports += result.rewrittenImports;
			rewrittenIconNames += result.rewrittenNames;
			for (const names of result.unmatched) {
				if (unmatchedIconImports.length < 128) {
					unmatchedIconImports.push({ id, names });
				}
			}
			if (result.unmatched.length > 0) {
				writeDiagnostic();
			}
			const rewritten = result.code;
			return rewritten === source ? null : { code: rewritten, map: null };
		},
		buildEnd: writeDiagnostic,
	};
}
export default mergeConfig(
	base,
	defineConfig({
		plugins: [individualIconImports()],
		cacheDir: `${tmpdir()}/ryu-optimizer-agent-route-vite-cache`,
		optimizeDeps: { entries: ["optimizer-agent-route-proof.html"] },
		server: { port: 5496, strictPort: true },
		resolve: {
			alias: [
				{ find: "@", replacement: path.resolve(import.meta.dirname, "../..") },
				{ find: /^@hugeicons\/core-free-icons$/, replacement: modularIcons },
			],
		},
		build: {
			// Use the product's supported runtime target for its real module graph.
			target: desktopConfig.build?.target,
			// Product proof needs the genuine module graph, not minified output.
			// Avoid an additional full-graph minification pass in bounded local runs.
			minify: false,
			outDir:
				process.env.RYU_OPTIMIZER_AGENT_BUILD_DIR ??
				path.join(tmpdir(), "ryu-optimizer-agent-route-built"),
			emptyOutDir: true,
			rollupOptions: {
				input: path.resolve(
					import.meta.dirname,
					"optimizer-agent-route-proof.html"
				),
			},
		},
	})
);
