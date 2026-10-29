import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export function quotaSourceGraph(sourceRoot: string, harnessDir: string) {
	const workspaceRoot = path.resolve(harnessDir, "../../../..");
	const loaded = new Map<
		string,
		{ file: string; beforeSha256: string; provenance: string }
	>();
	const forbidden: string[] = [];
	const hash = (file: string) =>
		createHash("sha256").update(readFileSync(file)).digest("hex");
	const record = (id: string) => {
		const raw = id.split("?")[0];
		if (!(path.isAbsolute(raw) && existsSync(raw))) {
			return;
		}
		const file = realpathSync(raw);
		if (file.includes(`${path.sep}node_modules${path.sep}`)) {
			return;
		}
		const selected = file.startsWith(`${sourceRoot}${path.sep}`);
		const harness = file.startsWith(
			`${harnessDir}${path.sep}sdk-account-quota-`
		);
		if (
			file.startsWith(`${workspaceRoot}${path.sep}`) &&
			!(selected || harness)
		) {
			forbidden.push(file);
			throw new Error(`Mixed project source forbidden: ${file}`);
		}
		if ((selected || harness) && !loaded.has(file)) {
			loaded.set(file, {
				file,
				beforeSha256: hash(file),
				provenance: selected ? "selected-tree" : "proof-harness",
			});
		}
	};
	const plugin: Plugin = {
		name: "sdk-quota-selected-source-graph",
		enforce: "pre",
		transform(code, id) {
			record(id);
			if (
				path.resolve(id.split("?")[0]) ===
				path.join(harnessDir, "sdk-account-quota-proof.css")
			) {
				return `${code}\n@source "${path.join(sourceRoot, "apps/desktop/src/components/settings/OAuthAccountPoolControls.tsx").replaceAll("\\", "/")}";\n@source "${path.join(sourceRoot, "packages/ui/src/components").replaceAll("\\", "/")}";`;
			}
			return null;
		},
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				if (request.url !== "/__sdk-quota-source-graph") {
					next();
					return;
				}
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify({
						sourceRoot,
						forbidden,
						files: [...loaded.values()]
							.sort((a, b) => a.file.localeCompare(b.file))
							.map((entry) => ({ ...entry, afterSha256: hash(entry.file) })),
					})
				);
			});
		},
	};
	return { plugin, record };
}
