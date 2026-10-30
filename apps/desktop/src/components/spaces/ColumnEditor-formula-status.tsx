import { useLiteralMessages } from "@ryu/i18n/react";
import { compileFormula } from "@ryu/ui/lib/data-grid-formula.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMemo } from "react";

/** Live feedback for a formula draft: an error, or the columns it uses. */
export function FormulaStatus({
	expression,
	columns,
}: {
	expression: string;
	columns: Array<{ id: string; label: string }>;
}) {
	const tl = useLiteralMessages();
	const status = useMemo(() => {
		if (!expression.trim()) {
			return null;
		}
		const result = compileFormula(expression);
		if (!result.ok) {
			return { error: result.message };
		}
		const known = new Set(
			columns.flatMap((column) => [
				column.label.trim().toLowerCase(),
				column.id.toLowerCase(),
			])
		);
		const missing = result.formula.references.filter(
			(name) => !known.has(name.trim().toLowerCase())
		);
		return missing.length > 0
			? { error: tl("No column named {names}", { names: missing.join(", ") }) }
			: { ok: true };
	}, [expression, columns, tl]);

	if (!status) {
		return null;
	}
	return (
		<p
			className={cn(
				"text-xs",
				"error" in status ? "text-destructive" : "text-muted-foreground"
			)}
		>
			{"error" in status ? status.error : "Formula is valid"}
		</p>
	);
}
