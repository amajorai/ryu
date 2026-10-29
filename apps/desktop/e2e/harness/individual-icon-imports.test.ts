import { expect, test } from "bun:test";
import { rewriteIndividualIconImports } from "./individual-icon-imports.ts";

const paths = new Map([
	[
		"lucide-react",
		new Map([
			["ArrowUp", "/icons/arrow-up.js"],
			["ArrowDown", "/icons/arrow-down.js"],
		]),
	],
]);
function rewrite(source: string) {
	return rewriteIndividualIconImports(source, "example.tsx", paths);
}

test("comments and strings cannot become imports while actual aliased multiline declarations retain components", () => {
	const prefix = `// import { ArrowUp, ArrowDown } from "lucide-react";\nconst text = 'import { ArrowUp } from "lucide-react";';\n/* import { ArrowDown } from "lucide-react"; */\n`;
	const result = rewrite(
		`${prefix}import {\n /* alias, with comma */ ArrowUp as Up,\n ArrowDown, // trailing comment\n type LucideProps as Props\n} from "lucide-react";`
	);
	expect(result.code).toBe(
		`${prefix}import Up from "/icons/arrow-up.js";\nimport ArrowDown from "/icons/arrow-down.js";\nimport type { LucideProps as Props } from "lucide-react";`
	);
	expect(result.rawImports).toBe(1);
	expect(result.rewrittenNames).toBe(2);
	expect(result.unmatched).toEqual([]);
});

test("named re-exports preserve aliases and type-only exports", () => {
	const result = rewrite(
		'export { ArrowUp as Ascend, type LucideProps } from "lucide-react";'
	);
	expect(result.code).toBe(
		'export { default as Ascend } from "/icons/arrow-up.js";\nexport type { LucideProps } from "lucide-react";'
	);
	expect(result.rewrittenImports).toBe(1);
});

test("side-effect, empty, default, namespace and unmapped declarations remain intact", () => {
	for (const source of [
		'import "lucide-react";',
		'import {} from "lucide-react";',
		'import Default, { ArrowUp } from "lucide-react";',
		'import * as Icons from "lucide-react";',
		'export * from "lucide-react";',
		'export * as Icons from "lucide-react";',
		'import { ArrowUp, Unknown } from "lucide-react";',
		'import { "ArrowUp" as Up } from "lucide-react";',
		'import type { LucideProps } from "lucide-react";',
		'export type { LucideProps } from "lucide-react";',
		'import { type LucideProps } from "lucide-react";',
		'const Icons = await import("lucide-react");',
	]) {
		const result = rewrite(source);
		expect(result.code).toBe(source);
		expect(result.rewrittenImports).toBe(0);
	}
});

test("rewritten absolute paths and comments are absent from bare-declaration diagnostics", () => {
	const result = rewrite(
		'// import * as Icons from "lucide-react";\nimport ArrowUp from "/packages/lucide-react/icons/arrow-up.js";'
	);
	expect(result.rawImports).toBe(0);
	expect(result.unmatched).toEqual([]);
});
