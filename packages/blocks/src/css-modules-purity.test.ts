import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { Glob } from "bun";

// Next.js (Turbopack/lightningcss and webpack's postcss-modules-local-by-default)
// compiles CSS modules in pure mode: every top-level style rule must contain a
// local class or id. A global selector such as `:root` or `body` in a blocks
// module fails the storyboard build even though Vite accepts it.
//
// A `composes: x from "…"` target must itself be a CSS module (or `global`).
// Turbopack, which `next build` uses, and Bun reject a plain stylesheet such as
// `../styles.css`; webpack and Vite silently compile it as a module, so only
// the deployed build fails.

const COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const GLOBAL_WRAPPER_PATTERN = /:global\([^)]*\)/g;
const ATTRIBUTE_PATTERN = /\[[^\]]*\]/g;
const LOCAL_SELECTOR_PATTERN = /[.#][A-Za-z_-]/;
const AT_RULE_NAME_PATTERN = /^@([\w-]+)/;
const KEYFRAMES_AT_RULE_PATTERN = /keyframes$/;
const COMPOSES_FROM_PATTERN =
	/composes\s*:\s*([^;{}]+?)\s+from\s+([^;{}]+?)\s*(?:;|\})/g;
const QUOTED_SPECIFIER_PATTERN = /^(["'])(.+)\1$/;
const CSS_MODULE_SPECIFIER_PATTERN = /\.module\.css$/;
const WHITESPACE_PATTERN = /\s+/;
const REGEXP_SPECIAL_PATTERN = /[.*+?^${}()|[\]\\]/g;

type BlockContext = "keyframes" | "at-rule" | "style";

function isPureSelector(selector: string): boolean {
	const localPart = selector
		.replace(GLOBAL_WRAPPER_PATTERN, "")
		.replace(ATTRIBUTE_PATTERN, "");
	return LOCAL_SELECTOR_PATTERN.test(localPart);
}

function classifyAtRule(prelude: string): BlockContext {
	const name = AT_RULE_NAME_PATTERN.exec(prelude)?.[1] ?? "";
	return KEYFRAMES_AT_RULE_PATTERN.test(name) ? "keyframes" : "at-rule";
}

/** Splits a selector list on top-level commas, keeping `:is(a, b)` intact. */
function splitSelectorList(prelude: string): string[] {
	const selectors: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < prelude.length; index += 1) {
		const character = prelude[index];
		if (character === "(") {
			depth += 1;
		} else if (character === ")") {
			depth -= 1;
		} else if (character === "," && depth === 0) {
			selectors.push(prelude.slice(start, index));
			start = index + 1;
		}
	}
	selectors.push(prelude.slice(start));
	return selectors;
}

/** Returns the selectors of style rules that carry no local class or id. */
function findImpureSelectors(stylesheet: string): string[] {
	const source = stylesheet.replace(COMMENT_PATTERN, "");
	const stack: BlockContext[] = [];
	const impure: string[] = [];
	let preludeStart = 0;

	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === ";") {
			preludeStart = index + 1;
			continue;
		}
		if (character === "}") {
			stack.pop();
			preludeStart = index + 1;
			continue;
		}
		if (character !== "{") {
			continue;
		}

		const prelude = source.slice(preludeStart, index).trim();
		preludeStart = index + 1;
		// Keyframe steps and rules nested in a style rule (even through an
		// at-rule such as `.local { @media (…) { &:hover {} } }`) inherit
		// their ancestor's scope.
		const inheritsScope =
			stack.at(-1) === "keyframes" || stack.includes("style");

		if (prelude.startsWith("@")) {
			stack.push(classifyAtRule(prelude));
			continue;
		}
		stack.push("style");
		if (inheritsScope) {
			continue;
		}
		for (const selector of splitSelectorList(prelude)) {
			if (!isPureSelector(selector)) {
				impure.push(selector.trim());
			}
		}
	}

	return impure;
}

interface ComposesFrom {
	classNames: string[];
	/** The quoted file specifier, or undefined for `from global`. */
	specifier: string | undefined;
	target: string;
}

/** Lists each `composes: … from …` declaration of a stylesheet. */
function findComposesFrom(stylesheet: string): ComposesFrom[] {
	const source = stylesheet.replace(COMMENT_PATTERN, "");
	const compositions: ComposesFrom[] = [];
	for (const [, names = "", target = ""] of source.matchAll(
		COMPOSES_FROM_PATTERN
	)) {
		compositions.push({
			classNames: names.trim().split(WHITESPACE_PATTERN),
			specifier: QUOTED_SPECIFIER_PATTERN.exec(target)?.[2],
			target,
		});
	}
	return compositions;
}

/** Returns composes targets that Turbopack and Bun reject: neither `global` nor a CSS module. */
function findNonModuleComposesTargets(stylesheet: string): string[] {
	return findComposesFrom(stylesheet)
		.filter(
			({ specifier, target }) =>
				target !== "global" &&
				!(specifier && CSS_MODULE_SPECIFIER_PATTERN.test(specifier))
		)
		.map(({ target }) => target);
}

function declaresLocalClass(stylesheet: string, className: string): boolean {
	const escaped = className.replace(REGEXP_SPECIAL_PATTERN, "\\$&");
	return new RegExp(`\\.${escaped}(?![\\w-])`).test(
		stylesheet.replace(COMMENT_PATTERN, "")
	);
}

function listModules(): string[] {
	return [
		...new Glob("**/*.module.css").scanSync({ cwd: import.meta.dir }),
	].sort();
}

describe("blocks CSS modules", () => {
	it("flags global selectors that pure CSS modules reject", () => {
		expect(
			findImpureSelectors(
				":root { --x: red; } .local { color: red; } html, .ok { color: blue; }" +
					":where(html, body) { margin: 0; } :global(.dark) { color: white; }"
			)
		).toEqual([":root", "html", ":where(html, body)", ":global(.dark)"]);
		expect(
			findImpureSelectors(
				"@keyframes drift { from { opacity: 0; } to { opacity: 1; } }" +
					"@media (prefers-reduced-motion: reduce) { .local::before { animation: none; } }" +
					".local { &:hover { color: red; } }" +
					".local { @media (width < 40rem) { &:hover { color: red; } } }" +
					".group:has(a, [data-slot]) { color: red; }" +
					":global(.dark) .local { color: white; }"
			)
		).toEqual([]);
	});

	it("keeps every style rule scoped to a local class or id", async () => {
		const offenders: string[] = [];
		const modules = listModules();
		expect(modules.length).toBeGreaterThan(0);

		for (const relativePath of modules) {
			const stylesheet = await Bun.file(
				join(import.meta.dir, relativePath)
			).text();
			for (const selector of findImpureSelectors(stylesheet)) {
				offenders.push(`${relativePath}: ${selector}`);
			}
		}

		expect(offenders).toEqual([]);
	});

	it("flags composes targets that are not CSS modules", () => {
		expect(
			findNonModuleComposesTargets(
				'.a { composes: animate-x from "../styles.css"; }' +
					".b { composes: shared-a shared-b from global; }" +
					".c { composes: toolFloat from './animations.module.css'; }" +
					".d { composes: local; }" +
					".e { composes: y from './plain.css' }"
			)
		).toEqual(['"../styles.css"', "'./plain.css'"]);
	});

	it("composes only from `global` or a CSS module that declares the class", async () => {
		const offenders: string[] = [];
		for (const relativePath of listModules()) {
			const modulePath = join(import.meta.dir, relativePath);
			const stylesheet = await Bun.file(modulePath).text();
			for (const target of findNonModuleComposesTargets(stylesheet)) {
				offenders.push(`${relativePath}: composes from ${target}`);
			}
			for (const { classNames, specifier } of findComposesFrom(stylesheet)) {
				if (!(specifier && CSS_MODULE_SPECIFIER_PATTERN.test(specifier))) {
					continue;
				}
				const composedFile = Bun.file(join(dirname(modulePath), specifier));
				if (!(await composedFile.exists())) {
					offenders.push(`${relativePath}: ${specifier} does not exist`);
					continue;
				}
				const composedStylesheet = await composedFile.text();
				for (const className of classNames) {
					if (!declaresLocalClass(composedStylesheet, className)) {
						offenders.push(
							`${relativePath}: ${specifier} does not declare .${className}`
						);
					}
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});
