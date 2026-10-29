import type { RowData } from "@tanstack/react-table";

/**
 * Column metadata for the Dice UI data table (`components/data-table`), a port
 * of the tablecn registry onto TanStack Table v8 so it shares the version the
 * data grid already runs on. `label` matches the data-grid augmentation.
 */
export type DataTableFilterVariant = "text" | "select" | "multiSelect";

export interface DataTableFilterOption {
	count?: number;
	icon?: React.ComponentType<React.ComponentProps<"svg">>;
	label: string;
	value: string;
}

declare module "@tanstack/react-table" {
	interface ColumnMeta<TData extends RowData, TValue> {
		/** Column name in toolbar filters and the view menu. */
		label?: string;
		/** Toolbar filter options for `select` / `multiSelect` columns. */
		options?: DataTableFilterOption[];
		/** Toolbar filter input placeholder (defaults to the label). */
		placeholder?: string;
		/** Which toolbar filter the column renders; none when unset. */
		variant?: DataTableFilterVariant;
	}
}
