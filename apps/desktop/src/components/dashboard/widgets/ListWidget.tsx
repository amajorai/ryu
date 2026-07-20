// List widget: a simple vertical list of items from an array value.

import { asRecord, cell, resolveArray } from "./data.ts";
import { listConfigSchema, parseConfig } from "./schema.ts";

function itemLabel(item: unknown, labelKey?: string): string {
	const record = asRecord(item);
	if (record) {
		if (labelKey && record[labelKey] !== undefined) {
			return cell(record[labelKey]);
		}
		// Prefer common label-ish fields before falling back to JSON.
		for (const k of ["title", "name", "label", "id"]) {
			if (record[k] !== undefined) {
				return cell(record[k]);
			}
		}
	}
	return cell(item);
}

export function ListBody({
	value,
	config,
}: {
	value: unknown;
	config: unknown;
}) {
	const cfg = parseConfig(listConfigSchema, config);
	const items = resolveArray(value, cfg.items_key);
	if (items.length === 0) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				Empty
			</div>
		);
	}
	return (
		<ul className="h-full space-y-0.5 overflow-auto text-sm">
			{items.map((item, i) => (
				// List order is the data's natural order; index is a stable key here.
				<li
					className="flex items-center gap-2 truncate rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
					key={i}
				>
					<span className="size-1.5 shrink-0 rounded-full bg-primary/40" />
					<span className="truncate">{itemLabel(item, cfg.label_key)}</span>
				</li>
			))}
		</ul>
	);
}
