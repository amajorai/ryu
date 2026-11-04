import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// src/lib/api → src/lib → src → apps/desktop → apps → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../../..");

const MOD_DECLARATION = /^mod (\w+);$/gm;

/** Options for {@link rustModuleSource}. */
export interface RustModuleSourceOptions {
	/**
	 * Also read submodules that keep their own path, such as the `tests`
	 * module, for an anchor that pins a test as well as the code it covers.
	 */
	includeAllSubmodules?: boolean;
}

/**
 * The source of a Rust module that is split across files, for mirror tests that
 * anchor on Core code: `<relativeDir>/mod.rs` plus, recursively, every submodule
 * it splices back in with a glob re-export (`mod part;` and `use part::*;` at
 * any visibility). Submodules that keep their own path (`pub mod x;`, the
 * `tests` module) are left out unless `includeAllSubmodules` is set, exactly
 * as their code was not part of the module's own items when it was one file.
 * `relativeDir` is relative to the repository root.
 */
export function rustModuleSource(
	relativeDir: string,
	options: RustModuleSourceOptions = {}
): string {
	const dir = join(REPO_ROOT, relativeDir);
	const root = readFileSync(join(dir, "mod.rs"), "utf8");
	const sources = [root];
	for (const [, name] of root.matchAll(MOD_DECLARATION)) {
		const spliced = new RegExp(
			`^(?:pub(?:\\([^)]*\\))? )?use ${name}::\\*;$`,
			"m"
		);
		if (!(name && (options.includeAllSubmodules || spliced.test(root)))) {
			continue;
		}
		const file = join(dir, `${name}.rs`);
		sources.push(
			existsSync(file)
				? readFileSync(file, "utf8")
				: rustModuleSource(join(relativeDir, name), options)
		);
	}
	return sources.join("\n");
}
