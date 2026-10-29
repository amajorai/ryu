import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function panelProofDependencyAliases(
	harnessDir: string
): { find: RegExp; replacement: string }[] {
	const repository = path.resolve(harnessDir, "../../../..");
	const resolver = createRequire(
		path.join(repository, "apps/desktop/package.json")
	);
	let runtime: string;
	try {
		runtime = resolver.resolve("react-compiler-runtime");
	} catch {
		const store = path.join(repository, "node_modules/.bun");
		const matches = readdirSync(store).filter((entry) =>
			entry.startsWith("react-compiler-runtime@")
		);
		if (matches.length !== 1) {
			throw new Error(
				"Expected one installed React compiler runtime for the panel fixture."
			);
		}
		runtime = path.join(
			store,
			matches[0],
			"node_modules/react-compiler-runtime/dist/index.js"
		);
	}
	return [{ find: /^react-compiler-runtime$/, replacement: runtime }];
}
