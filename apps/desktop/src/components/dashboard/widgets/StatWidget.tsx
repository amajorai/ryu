// Stat / KPI widget: one big number with an optional label, unit, and delta.
// Pure shadcn primitives — no custom styling beyond layout utilities.

import { dottedGet, resolveNumber, toNumber } from "./data.ts";
import { parseConfig, statConfigSchema } from "./schema.ts";

export function StatBody({
	value,
	config,
}: {
	value: unknown;
	config: unknown;
}) {
	const cfg = parseConfig(statConfigSchema, config);
	const n = resolveNumber(value, cfg.value_key);
	const delta = cfg.delta_key
		? toNumber(dottedGet(value, cfg.delta_key))
		: null;
	const display = n === null ? "—" : n.toLocaleString();

	return (
		<div className="flex h-full flex-col justify-center gap-2">
			<div className="flex items-baseline gap-1.5">
				<span className="font-semibold text-4xl tabular-nums tracking-tight">
					{display}
				</span>
				{cfg.unit && (
					<span className="text-muted-foreground text-sm">{cfg.unit}</span>
				)}
			</div>
			{cfg.label && (
				<span className="text-muted-foreground text-sm">{cfg.label}</span>
			)}
			{delta !== null && (
				<span
					className={
						delta >= 0
							? "inline-flex w-fit items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success text-xs dark:text-success"
							: "inline-flex w-fit items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive text-xs"
					}
				>
					{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toLocaleString()}
				</span>
			)}
		</div>
	);
}
