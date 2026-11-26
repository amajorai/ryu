import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// Toasts render outside the panel that raised them, so each title and
// description must go through the component's `tl`; a bare literal (or a lookup
// table read without `tl`) shows English when the DOM localizer is off or
// late. This guard parses every non-test source file in the vault
// folder and the Vault page, finds each `sileo.<kind>({ ... })` (or
// `toast(...)`) call and checks its `title` and `description`, including the
// fallback a `vaultErrorMessage` call returns when the error has no message.
// Other `title` props (section headings, list rows) are JSX text the localizer
// owns.

const VAULT_DIR = import.meta.dir;
const PAGES_DIR = join(VAULT_DIR, "..", "..", "pages");
const TOAST_FIELDS = new Set(["title", "description"]);

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (
			/\.tsx?$/.test(entry.name) &&
			!/\.test\.tsx?$/.test(entry.name) &&
			!entry.name.endsWith(".d.ts")
		) {
			files.push(path);
		}
	}
	return files;
}

function isToastCall(node: ts.CallExpression): boolean {
	const callee = node.expression;
	if (ts.isIdentifier(callee)) {
		return callee.text === "toast";
	}
	if (ts.isPropertyAccessExpression(callee)) {
		const owner = callee.expression;
		return (
			ts.isIdentifier(owner) &&
			(owner.text === "sileo" || owner.text === "toast")
		);
	}
	return false;
}

function unwrap(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

type Lookup = Map<string, ts.Expression[]>;

// Variable initializers by name, so `{ title }` and `title: heading` can be
// traced to what they hold. Parameters (a mutation's result) are not traced:
// that value is built where it is returned, under the producer's own `tl`.
function declarations(file: ts.SourceFile): Lookup {
	const found: Lookup = new Map();
	const visit = (node: ts.Node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer
		) {
			const list = found.get(node.name.text) ?? [];
			list.push(node.initializer);
			found.set(node.name.text, list);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

const SPLIT_OPERATORS = new Set([
	ts.SyntaxKind.QuestionQuestionToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.PlusToken,
]);

// Why an expression is an untranslated title, or null when it is translated
// (a call such as `tl(...)`, or a binding the guard cannot see into).
function untranslated(
	node: ts.Expression,
	lookup: Lookup,
	seen: Set<string> = new Set()
): string | null {
	const expr = unwrap(node);
	if (
		ts.isStringLiteral(expr) ||
		ts.isNoSubstitutionTemplateLiteral(expr) ||
		ts.isTemplateExpression(expr)
	) {
		return "literal";
	}
	if (ts.isConditionalExpression(expr)) {
		return (
			untranslated(expr.whenTrue, lookup, seen) ??
			untranslated(expr.whenFalse, lookup, seen)
		);
	}
	if (
		ts.isBinaryExpression(expr) &&
		SPLIT_OPERATORS.has(expr.operatorToken.kind)
	) {
		return (
			untranslated(expr.left, lookup, seen) ??
			untranslated(expr.right, lookup, seen)
		);
	}
	if (ts.isElementAccessExpression(expr)) {
		return "table lookup";
	}
	// `vaultErrorMessage(error, fallback, tl)` returns its fallback verbatim.
	if (
		ts.isCallExpression(expr) &&
		ts.isIdentifier(expr.expression) &&
		expr.expression.text === "vaultErrorMessage"
	) {
		const fallback = expr.arguments[1];
		const reason = fallback ? untranslated(fallback, lookup, seen) : null;
		return reason ? `vaultErrorMessage fallback is a ${reason}` : null;
	}
	// `TOASTS.saved`: a property of a literal object table.
	if (
		ts.isPropertyAccessExpression(expr) &&
		ts.isIdentifier(expr.expression) &&
		(lookup.get(expr.expression.text) ?? []).some((init) =>
			ts.isObjectLiteralExpression(unwrap(init))
		)
	) {
		return "table lookup";
	}
	if (ts.isIdentifier(expr) && !seen.has(expr.text)) {
		seen.add(expr.text);
		for (const init of lookup.get(expr.text) ?? []) {
			const reason = untranslated(init, lookup, seen);
			if (reason) {
				return `${expr.text} is a ${reason}`;
			}
		}
	}
	return null;
}

function titleReason(
	prop: ts.ObjectLiteralElementLike,
	lookup: Lookup
): string | null {
	if (
		ts.isShorthandPropertyAssignment(prop) &&
		TOAST_FIELDS.has(prop.name.text)
	) {
		return untranslated(prop.name, lookup);
	}
	if (ts.isPropertyAssignment(prop) && TOAST_FIELDS.has(prop.name.getText())) {
		return untranslated(prop.initializer, lookup);
	}
	return null;
}

function untranslatedToastTitles(
	source: string,
	name = "fixture.tsx"
): string[] {
	const file = ts.createSourceFile(
		name,
		source,
		ts.ScriptTarget.Latest,
		true,
		name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
	const lookup = declarations(file);
	const offenders: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && isToastCall(node)) {
			for (const arg of node.arguments) {
				const options = unwrap(arg);
				if (!ts.isObjectLiteralExpression(options)) {
					continue;
				}
				for (const prop of options.properties) {
					const reason = titleReason(prop, lookup);
					if (reason) {
						const { line } = file.getLineAndCharacterOfPosition(
							prop.getStart()
						);
						offenders.push(`${name}:${line + 1} ${reason}: ${prop.getText()}`);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return offenders;
}

test("every vault toast title and description goes through tl", () => {
	const pages = sourceFiles(PAGES_DIR).filter((path) =>
		/[\\/]VaultPage[^\\/]*$/.test(path)
	);
	expect(pages.length).toBeGreaterThan(3);
	const files = [...sourceFiles(VAULT_DIR), ...pages];
	expect(files.length).toBeGreaterThan(40);
	const offenders = files.flatMap((path) =>
		untranslatedToastTitles(
			readFileSync(path, "utf8"),
			relative(VAULT_DIR, path)
		)
	);
	expect(offenders).toEqual([]);
});

test("the guard flags literal descriptions and vaultErrorMessage fallbacks", () => {
	expect(
		untranslatedToastTitles(
			'sileo.error({ title: tl("Could not seal"), description: "Try again." });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'sileo.error({ title: tl("No"), description: vaultErrorMessage(error, "Try again.", tl) });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'const description = vaultErrorMessage(error, "Try again.", tl);\nsileo.error({ title: tl("No"), description });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'sileo.error({ title: vaultErrorMessage(error, "Could not seal.", tl) });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'sileo.error({ title: tl("No"), description: vaultErrorMessage(error, tl("Try again."), tl) });\nsileo.success({ title: tl("Deleted"), description: name });'
		)
	).toEqual([]);
	// Outside a toast the fallback renders as page text the localizer owns.
	expect(
		untranslatedToastTitles(
			'setProblem(vaultErrorMessage(caught, "Could not issue.", tl));'
		)
	).toEqual([]);
});

test("the guard flags a literal title", () => {
	expect(
		untranslatedToastTitles('sileo.success({ title: "Copied" });')
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			["sileo.error({ title: `Lost $", "{name}` });"].join("")
		)
	).toHaveLength(1);
	expect(untranslatedToastTitles('toast({ title: "Copied" });')).toHaveLength(
		1
	);
	expect(
		untranslatedToastTitles('sileo.success({ title: tl("Copied") });')
	).toEqual([]);
});

test("the guard flags a ternary with a literal branch", () => {
	expect(
		untranslatedToastTitles(
			'sileo.success({ title: editing ? "Service saved" : "Service added" });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'sileo.success({ title: editing ? tl("Service saved") : "Service added" });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'sileo.success({ title: editing ? tl("Service saved") : tl("Service added") });'
		)
	).toEqual([]);
	expect(
		untranslatedToastTitles(
			'sileo.success({ title: tl(editing ? "Service saved" : "Service added") });'
		)
	).toEqual([]);
});

test("the guard flags shorthand title bound to a literal or a table", () => {
	expect(
		untranslatedToastTitles('const title = "Saved";\nsileo.success({ title });')
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			"const title = DECISION_TOAST[decision];\nsileo.success({ title });"
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'const heading = "Saved";\nsileo.success({ title: heading });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'const title = tl("Saved");\nsileo.success({ title });'
		)
	).toEqual([]);
	// A mutation result is built (and translated) where it is returned.
	expect(
		untranslatedToastTitles(
			"useMutation({ onSuccess: (title) => sileo.success({ title }) });"
		)
	).toEqual([]);
});

test("the guard flags upper and lower-case table lookups without tl", () => {
	expect(
		untranslatedToastTitles(
			"sileo.success({ title: DECISION_TOAST[decision] });"
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			"sileo.success({ title: decisionToast[decision] });"
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			"sileo.success({ title: tl(DECISION_TOAST[decision]) });"
		)
	).toEqual([]);
	expect(
		untranslatedToastTitles(
			"sileo.success({ title: tl(decisionToast[decision]) });"
		)
	).toEqual([]);
});

test("the guard flags ?? and + titles and property tables without tl", () => {
	expect(
		untranslatedToastTitles(
			'sileo.error({ title: error.message ?? "That did not work" });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles('sileo.success({ title: "Saved " + name });')
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'const TOASTS = { saved: "Saved" };\nsileo.success({ title: TOASTS.saved });'
		)
	).toHaveLength(1);
	expect(
		untranslatedToastTitles(
			'const TOASTS = { saved: "Saved" };\nsileo.success({ title: tl(TOASTS.saved) });\nsileo.error({ title: error.message ?? tl("That did not work") });'
		)
	).toEqual([]);
	expect(
		untranslatedToastTitles("sileo.error({ title: result.title });")
	).toEqual([]);
});

test("the guard ignores title props outside toast calls", () => {
	expect(
		untranslatedToastTitles(
			'const node = <Section title="Leases" />;\nopenDialog({ title: "Edit" });'
		)
	).toEqual([]);
});
