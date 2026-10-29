import ts from "typescript";

export interface IconImportRewrite {
	code: string;
	rawImports: number;
	rewrittenImports: number;
	rewrittenNames: number;
	unmatched: string[][];
}

/** Rewrite only parsed module declarations, retaining the installed components. */
export function rewriteIndividualIconImports(
	source: string,
	id: string,
	iconPaths: ReadonlyMap<string, ReadonlyMap<string, string>>
): IconImportRewrite {
	const result: IconImportRewrite = {
		code: source,
		rawImports: 0,
		rewrittenImports: 0,
		rewrittenNames: 0,
		unmatched: [],
	};
	// Most graph modules do not reference these packages. Avoid parsing them.
	if (![...iconPaths.keys()].some((name) => source.includes(name))) {
		return result;
	}
	const file = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true);
	const edits: { start: number; end: number; text: string }[] = [];
	for (const statement of file.statements) {
		if (
			!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
		) {
			continue;
		}
		const specifier = statement.moduleSpecifier;
		if (!(specifier && ts.isStringLiteral(specifier))) {
			continue;
		}
		const paths = iconPaths.get(specifier.text);
		if (!paths) {
			continue;
		}
		const isImport = ts.isImportDeclaration(statement);
		if (
			(isImport && statement.importClause?.isTypeOnly) ||
			(!isImport && statement.isTypeOnly)
		) {
			continue;
		}
		result.rawImports += 1;
		const bindings = isImport
			? statement.importClause?.namedBindings
			: statement.exportClause;
		// Preserve side effects and default/namespace semantics without assumptions.
		if (
			!(
				bindings &&
				(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
			) ||
			(isImport && statement.importClause?.name) ||
			bindings.elements.length === 0 ||
			statement.attributes
		) {
			result.unmatched.push(["unrewritten package declaration"]);
			continue;
		}
		const replacements: string[] = [];
		const types: string[] = [];
		let supported = true;
		for (const binding of bindings.elements) {
			const imported = binding.propertyName ?? binding.name;
			if (!(ts.isIdentifier(imported) && ts.isIdentifier(binding.name))) {
				supported = false;
				break;
			}
			if (binding.isTypeOnly) {
				types.push(
					binding.propertyName
						? `${imported.text} as ${binding.name.text}`
						: binding.name.text
				);
				continue;
			}
			const iconPath = paths.get(imported.text);
			if (!iconPath) {
				supported = false;
				break;
			}
			replacements.push(
				isImport
					? `import ${binding.name.text} from ${JSON.stringify(iconPath)};`
					: `export { default as ${binding.name.text} } from ${JSON.stringify(iconPath)};`
			);
		}
		if (!supported) {
			result.unmatched.push(
				bindings.elements.map((binding) => binding.getText(file))
			);
			continue;
		}
		// An all-type declaration has no runtime graph to optimize.
		if (replacements.length === 0) {
			continue;
		}
		result.rewrittenImports += 1;
		result.rewrittenNames += replacements.length;
		if (types.length > 0) {
			replacements.push(
				`${isImport ? "import" : "export"} type { ${types.join(", ")} } from ${JSON.stringify(specifier.text)};`
			);
		}
		edits.push({
			start: statement.getStart(file),
			end: statement.end,
			text: replacements.join("\n"),
		});
	}
	function recordDynamicImports(node: ts.Node) {
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			const specifier = node.arguments[0];
			if (
				specifier &&
				ts.isStringLiteral(specifier) &&
				iconPaths.has(specifier.text)
			) {
				result.unmatched.push(["unrewritten dynamic package import"]);
			}
		}
		ts.forEachChild(node, recordDynamicImports);
	}
	recordDynamicImports(file);

	for (const edit of edits.reverse()) {
		result.code =
			result.code.slice(0, edit.start) +
			edit.text +
			result.code.slice(edit.end);
	}
	return result;
}
