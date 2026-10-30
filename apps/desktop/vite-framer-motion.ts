import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// Bun installs one framer-motion per requested range, so sileo's own
// motion@12.38 brings a second 12.x runtime (and motion-dom) next to the
// framer-motion@12.43 the shell already ships, both in the startup bundle.
// Resolve every same-major copy to the one this app's own `motion` uses (the
// app imports `motion/react` and has no direct framer-motion dependency).
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

interface Canonical {
	id: string;
	major: string;
}

export function unifyFramerMotion(): Plugin {
	const motionEntry = fileURLToPath(import.meta.resolve("motion"));
	let canonical: Promise<Canonical | null> | undefined;
	return {
		name: "ryu-unify-framer-motion",
		apply: "build",
		enforce: "pre",
		async resolveId(source, importer, options) {
			if (source !== "framer-motion" || !importer) {
				return null;
			}
			canonical ??= this.resolve(source, motionEntry, {
				...options,
				skipSelf: true,
			}).then((resolved) => {
				const major = resolved ? majorVersion(resolved.id) : null;
				return resolved && major ? { id: resolved.id, major } : null;
			});
			const target = await canonical;
			if (!target) {
				return null;
			}
			const resolved = await this.resolve(source, importer, {
				...options,
				skipSelf: true,
			});
			if (
				resolved &&
				resolved.id !== target.id &&
				majorVersion(resolved.id) === target.major
			) {
				// Keep the resolution's metadata (`sideEffects: false` in every
				// copy), so the redirect does not opt the module out of tree-shaking.
				return { ...resolved, id: target.id };
			}
			return resolved;
		},
	};
}
