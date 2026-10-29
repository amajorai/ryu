import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** Only the declared immutable original tab is replaced for its baseline.
 * Relative imports keep resolving at the original shipping module's directory;
 * every unrelated dependency remains the current authentic installed/source code.
 * This is not a whole-old-main execution.
 */
export function immutableTabBaseline(desktop: string): Plugin[] {
	const artifact = process.env.RYU_PLUGIN_SHORTCUTS_BASELINE_TAB;
	const expectedHash = process.env.RYU_PLUGIN_SHORTCUTS_BASELINE_SHA256;
	if (!(artifact || expectedHash)) {
		return [];
	}
	if (
		!(
			artifact &&
			path.isAbsolute(artifact) &&
			expectedHash &&
			/^[a-f0-9]{64}$/.test(expectedHash)
		)
	) {
		throw new Error("Explicit immutable tab artifact and SHA256 required");
	}
	const source = readFileSync(artifact, "utf8");
	if (createHash("sha256").update(source).digest("hex") !== expectedHash) {
		throw new Error("Immutable original tab artifact changed");
	}
	const shipping = path.join(
		desktop,
		"src/components/settings/KeyboardShortcutsTab.tsx"
	);
	const baseline = `${shipping}?ryu-immutable-original-tab`;
	let loaded = 0;
	return [
		{
			name: "immutable-original-plugin-shortcut-tab",
			enforce: "pre",
			resolveId(id, importer) {
				if (
					id === shipping ||
					(importer &&
						id.startsWith(".") &&
						path.resolve(
							path.dirname(importer.split("?")[0] ?? importer),
							id
						) === shipping)
				) {
					return baseline;
				}
				return null;
			},
			load(id) {
				if (id !== baseline) {
					return null;
				}
				loaded += 1;
				return source;
			},
			buildEnd(error) {
				if (!error && loaded !== 1) {
					throw new Error("Immutable original tab must be loaded exactly once");
				}
			},
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "plugin-shortcuts-baseline-source.json",
					source: JSON.stringify(
						{
							module:
								"apps/desktop/src/components/settings/KeyboardShortcutsTab.tsx",
							sha256: expectedHash,
							loaded,
							boundary:
								"Original tab only; current unrelated source and installed dependencies",
						},
						null,
						2
					),
				});
			},
		},
	];
}
