import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { rewriteIndividualIconImports } from "./individual-icon-imports.ts";
function requiredOwnedPath(name: string): string {
	const value = process.env[name];
	if (!value || !path.isAbsolute(value))
		throw new Error("Explicit owned proof path required: " + name);
	return value;
}
const manifest = JSON.parse(
	readFileSync(requiredOwnedPath("RYU_APPEARANCE_ICON_MAP"), "utf8"),
);
const digest = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
export function installedIndividualIcons(): Plugin {
	const mappings = new Map<string, Map<string, string>>();
	for (const [name, raw] of Object.entries(manifest) as Array<[string, any]>) {
		if (
			realpathSync(raw.entry) !== raw.entry ||
			digest(readFileSync(raw.entry)) !== raw.entrySha256
		)
			throw new Error("Installed icon export authority changed: " + name);
		mappings.set(
			name,
			new Map(
				Object.entries(raw.exports).map(([name, v]: [string, any]) => [
					name,
					v.path,
				]),
			),
		);
	}
	const receipt = {
		rawImports: 0,
		rewrittenImports: 0,
		rewrittenNames: 0,
		unmatched: [] as any[],
		modules: {} as Record<string, string>,
		entries: Object.fromEntries(
			Object.entries(manifest).map(([name, v]: [string, any]) => [
				name,
				{ path: v.entry, sha256: v.entrySha256 },
			]),
		),
	};
	const diagnostic = requiredOwnedPath("RYU_APPEARANCE_ICON_DIAGNOSTIC");
	function save() {
		writeFileSync(diagnostic, JSON.stringify(receipt, null, 2) + "\n");
	}
	save();
	return {
		name: "consumer-proof-installed-individual-icons",
		enforce: "pre",
		transform(source, id) {
			if (!/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) return null;
			const rewrite = rewriteIndividualIconImports(source, id, mappings);
			receipt.rawImports += rewrite.rawImports;
			receipt.rewrittenImports += rewrite.rewrittenImports;
			receipt.rewrittenNames += rewrite.rewrittenNames;
			if (rewrite.unmatched.length) {
				receipt.unmatched.push({ id, names: rewrite.unmatched });
				save();
				throw new Error("Unsupported authentic icon declaration: " + id);
			}
			if (rewrite.rewrittenImports) {
				// Pin the real installed modules used by this transformed declaration.
				for (const exports of mappings.values())
					for (const module of exports.values())
						if (rewrite.code.includes(JSON.stringify(module))) {
							if (realpathSync(module) !== module)
								throw new Error(
									"Installed icon module physical identity changed",
								);
							const current = digest(readFileSync(module));
							if (
								receipt.modules[module] &&
								receipt.modules[module] !== current
							)
								throw new Error("Installed icon module changed during launch");
							receipt.modules[module] = current;
						}
				save();
			}
			return rewrite.code === source ? null : { code: rewrite.code, map: null };
		},
		buildEnd: save,
	};
}
