/* @jsxImportSource @opentui/react */
// Presentational pieces of the terminal declarative-view renderer
// (DeclarativeView.tsx): rows, table header, form rows, command row, static bodies.

import { Badge, type BadgeVariant } from "@/components/ui/badge.tsx";
import { TextInput } from "@/components/ui/text-input.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type {
	RawViewSpec,
	ViewBadge,
	ViewField,
	ViewSpec,
	ViewTone,
} from "../core/views.ts";
import { tf } from "../i18n/translate.ts";
import {
	type ActionEntry,
	boolLabel,
	type ColumnLayout,
	columnAt,
	MAX_ACTION_KEYS,
	pad,
	type RowModel,
} from "./DeclarativeView-model.ts";
import { ListPosition, SelectableRow } from "./SelectableRow.tsx";
import { useListWindow } from "./useListWindow.ts";

const TONE_VARIANT = {
	neutral: "secondary",
	success: "success",
	warning: "warning",
	danger: "error",
	info: "info",
} satisfies Record<ViewTone, BadgeVariant>;

export function ToneBadges({
	badges,
	color,
}: {
	badges?: ViewBadge[];
	/** Overrides the tone colors, e.g. on the selection background where the
	 *  tone colors fall below text contrast. */
	color?: string;
}) {
	if (!badges || badges.length === 0) {
		return null;
	}
	return (
		<box flexDirection="row" gap={1}>
			{badges.map((badge, i) => (
				<Badge
					bordered={false}
					color={color}
					key={`${badge.label}-${i}`}
					variant={TONE_VARIANT[badge.tone ?? "neutral"]}
				>
					{badge.label}
				</Badge>
			))}
		</box>
	);
}

export function ListRow({
	row,
	selected,
	layout,
	linesPerRow,
}: {
	/** Column geometry for a data-table row; absent for a list-detail row. */
	layout?: ColumnLayout[];
	linesPerRow: number;
	row: RowModel;
	selected: boolean;
}) {
	const theme = useTheme();
	if (row.cells && layout) {
		return (
			<SelectableRow
				linesPerRow={linesPerRow}
				selected={selected}
				titleSuffix={
					row.badges?.length ? (
						<ToneBadges
							badges={row.badges}
							color={selected ? theme.colors.selectionForeground : undefined}
						/>
					) : undefined
				}
			>
				{row.cells.map((cell, i) => {
					const { align, width } = columnAt(layout, i);
					return (
						<text
							fg={
								selected
									? theme.colors.selectionForeground
									: theme.colors.foreground
							}
							flexShrink={0}
							key={`${row.id}-${i}`}
						>
							{i === 0 && selected ? (
								<b>{pad(cell, width, align)}</b>
							) : (
								pad(cell, width, align)
							)}
						</text>
					);
				})}
			</SelectableRow>
		);
	}
	return (
		<SelectableRow
			accessory={row.accessory}
			linesPerRow={linesPerRow}
			selected={selected}
			subtitle={row.subtitle}
			title={row.title}
			titleSuffix={
				row.badges?.length ? (
					<ToneBadges
						badges={row.badges}
						color={selected ? theme.colors.selectionForeground : undefined}
					/>
				) : undefined
			}
		/>
	);
}

/** The windowed row list shared by list-detail and data-table. */
export function RowList({
	rows,
	selected,
	emptyText,
	layout,
}: {
	emptyText: string;
	/** Column geometry, for a data-table's aligned grid. */
	layout?: ColumnLayout[];
	rows: RowModel[];
	selected: number;
}) {
	const theme = useTheme();
	// Window the rows to the measured space so the selection stays visible
	// without a focus-capturing scrollbox (which would fight the shell for arrow
	// keys) — the same windowing the built-in list surfaces use.
	const linesPerRow = rows.some((row) => row.subtitle && !row.cells) ? 2 : 1;
	const { start, end, onSizeChange } = useListWindow({
		count: rows.length,
		index: selected,
		linesPerRow,
	});
	if (rows.length === 0) {
		return <text fg={theme.colors.mutedForeground}>{emptyText}</text>;
	}
	const visible = rows.slice(start, end);
	return (
		<>
			<box
				flexBasis={0}
				flexDirection="column"
				flexGrow={1}
				minHeight={0}
				onSizeChange={onSizeChange}
				overflow="hidden"
			>
				{visible.map((row, i) => (
					<ListRow
						key={row.id}
						layout={layout}
						linesPerRow={linesPerRow}
						row={row}
						selected={start + i === selected}
					/>
				))}
			</box>
			<ListPosition
				count={rows.length}
				index={selected}
				visible={visible.length}
			/>
		</>
	);
}

export function TableHeader({
	spec,
	layout,
}: {
	layout: ColumnLayout[];
	spec: Extract<ViewSpec, { view: "data-table" }>;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="row" flexShrink={0} gap={1} paddingLeft={2}>
			{spec.columns.map((column, i) => {
				const { align, width } = columnAt(layout, i);
				return (
					<text fg={theme.colors.mutedForeground} key={column.id}>
						{pad(column.header, width, align)}
					</text>
				);
			})}
		</box>
	);
}

/** One compact form field row. Text/number fields swap to an inline TextInput
 *  while being edited (the vendored input owns character keys for that window). */
export function FormRow({
	editing,
	field,
	onChange,
	onCommit,
	selected,
	value,
}: {
	editing: boolean;
	field: ViewField;
	onChange: (next: string) => void;
	onCommit: (next: string) => void;
	selected: boolean;
	value: ViewField["value"];
}) {
	const theme = useTheme();
	const display =
		field.type === "switch" ? boolLabel(value) : String(value ?? "");
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.mutedForeground}>
				{selected ? "›" : " "}
			</text>
			<text fg={theme.colors.mutedForeground}>{pad(field.label, 18)}</text>
			{editing ? (
				<TextInput
					bordered={false}
					onChange={onChange}
					onSubmit={onCommit}
					placeholder={field.placeholder}
					value={display}
					width={32}
				/>
			) : (
				<text fg={theme.colors.foreground}>
					{display.length > 0 ? display : "—"}
				</text>
			)}
		</box>
	);
}

/** The foot command row: `1 Complete · 2 Delete`, plus the navigation hints. A
 *  pending `confirm` replaces it with an inline y/n prompt. */
export function CommandRow({
	confirmText,
	entries,
	hints,
}: {
	confirmText: string | null;
	entries: ActionEntry[];
	hints: string;
}) {
	const theme = useTheme();
	if (confirmText) {
		return (
			<box flexDirection="row" flexShrink={0} gap={1} paddingTop={1}>
				<text fg={theme.colors.warning}>{confirmText}</text>
				<text fg={theme.colors.mutedForeground}>y confirm · n cancel</text>
			</box>
		);
	}
	return (
		<box flexDirection="row" flexShrink={0} gap={1} paddingTop={1}>
			{entries.slice(0, MAX_ACTION_KEYS).map((entry, i) => (
				<text
					fg={
						entry.action.style === "danger"
							? theme.colors.error
							: theme.colors.foreground
					}
					key={entry.action.id}
				>
					{`${i + 1} ${entry.action.label}`}
				</text>
			))}
			<text fg={theme.colors.mutedForeground}>{hints}</text>
		</box>
	);
}

/** Body of a kind that has no rows and no fields — rendered inline so the outer
 *  component stays a single switch over the discriminant. */
export function StaticBody({ spec }: { spec: ViewSpec }) {
	const theme = useTheme();
	if (spec.view === "empty-state") {
		return (
			<box flexDirection="column">
				<text fg={theme.colors.foreground}>{spec.title}</text>
				{spec.description ? (
					<text fg={theme.colors.mutedForeground}>{spec.description}</text>
				) : null}
			</box>
		);
	}
	if (spec.view === "filter-bar") {
		return (
			<box flexDirection="column">
				{spec.filters.map((filter) => (
					<box flexDirection="row" gap={1} key={filter.id}>
						<text fg={theme.colors.mutedForeground}>
							{pad(filter.label, 18)}
						</text>
						<text fg={theme.colors.foreground}>
							{filter.options
								.map((option) =>
									option.value === filter.value
										? `[${option.label}]`
										: option.label
								)
								.join(" ")}
						</text>
					</box>
				))}
			</box>
		);
	}
	if (spec.view === "stat-card-row") {
		return (
			<box flexDirection="row" gap={2}>
				{spec.stats.map((stat) => (
					<box flexDirection="column" key={stat.id}>
						<text fg={theme.colors.mutedForeground}>{stat.label}</text>
						<text fg={theme.colors.foreground}>
							<b>{String(stat.value)}</b>
						</text>
						{stat.delta ? (
							<text fg={theme.colors.mutedForeground}>{stat.delta}</text>
						) : null}
					</box>
				))}
			</box>
		);
	}
	if (spec.view === "action-panel") {
		return spec.title ? (
			<text fg={theme.colors.foreground}>{spec.title}</text>
		) : null;
	}
	return <UnsupportedBody spec={spec} />;
}

/**
 * The readable degrade for a spec this shell cannot draw. Two ways in, one line out:
 *  - an UNKNOWN `view` kind — Core forwards new kinds verbatim so a newer app can
 *    target an older shell, and saying so plainly beats rendering nothing;
 *  - a KNOWN kind missing the collection it is made of (`list-detail` with no
 *    `items`, `data-table` with no `columns`, …). The `spec` is opaque to Core, so
 *    that shape reaches the renderer from any manifest; trusting the discriminant
 *    alone would dereference `undefined` and take the whole terminal down through the
 *    root error boundary. `errors` is `validateView`'s explanation, shown so a
 *    plugin author can see WHY their view did not draw.
 */
export function UnsupportedBody({
	spec,
	errors,
}: {
	spec: Pick<RawViewSpec, "view"> | undefined;
	errors?: string[];
}) {
	const theme = useTheme();
	const kind = String(spec?.view ?? "unknown");
	return (
		<box flexDirection="column">
			<text fg={theme.colors.mutedForeground}>
				{tf('Unsupported view kind "{kind}" — open it in the desktop app.', {
					kind,
				})}
			</text>
			{errors && errors.length > 0 ? (
				<text fg={theme.colors.mutedForeground}>{errors.join("; ")}</text>
			) : null}
		</box>
	);
}
