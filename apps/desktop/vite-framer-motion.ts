import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// Bun installs one framer-motion per requested range, so sileo's own
// motion@12.38 brings a second 12.x runtime (and motion-dom) next to the
// framer-motion@12.43 the shell already ships, both in the startup bundle.
// Resolve every same-major copy to this app's own, semver-compatible one.
// Other majors (motion@13 pulls framer-motion@13) are left alone: they behave
// differently (Reorder axis detection, AnimatePresence exit ordering).

const PACKAGE_DIR = /^(.*\/node_modules\/framer-motion)\//;

function majorVersion(file: string): string | null {
	const packageDir = PACKAGE_DIR.exec(file)?.[1];
	if (!packageDir) {
		return null;
	}
	try {
		const manifest: unknown = JSON.parse(
			readFileSync(`${packageDir}/package.json`, "utf8")
		);
		const version =
			typeof manifest === "object" && manifest !== null && "version" in manifest
				? manifest.version
				: null;
		return typeof version === "string" ? (version.split(".")[0] ?? null) : null;
	} catch {
		return null;
	}
}

export function unifyFramerMotion(): Plugin {
	const canonical = fileURLToPath(import.meta.resolve("framer-motion"));
	const canonicalMajor = majorVersion(canonical);
	return {
		name: "ryu-unify-framer-motion",
		apply: "build",
		enforce: "pre",
		async resolveId(source, importer, options) {
			if (source !== "framer-motion" || !importer || !canonicalMajor) {
				return null;
			}
			const resolved = await this.resolve(source, importer, {
				...options,
				skipSelf: true,
			});
			if (
				resolved &&
				resolved.id !== canonical &&
				majorVersion(resolved.id) === canonicalMajor
			) {
				// Keep the resolution's metadata (`sideEffects: false` in every
				// copy), so the redirect does not opt the module out of tree-shaking.
				return { ...resolved, id: canonical };
			}
			return resolved;
		},
	};
}
