// The **desktop renderer** for the declarative view tier (the Raycast model on
// Ryu's contribution registry). A companion app returns a `ViewSpec` — pure DATA
// tagged by a `view` kind — and this component maps it to real `@ryu/ui` components.
// The app writes the spec ONCE; the desktop renders it full-size here, the island
// renders the SAME spec compact (`@ryu/blocks/island/declarative-view`). No bundle,
// no theme bridge, no way to make it ugly — the host owns the components.
//
// Actions are LIVE: every action surface threads `onAction(action, ctx)` where the
// ctx carries collected form `values` and the selected/owning `item` (the raw source
// row when the view is source-fetched), so `{{field}}` / `{{item.<key>}}` templating
// in declarative `http` handlers resolves host-side. A `list-detail` spec with a
// `source` is fetched at mount through the host's `fetchJson` seam (the spec never
// sees a token), replacing the static `items`.
//
// The vocabulary + types are the single source of truth in `@ryu/app-host/views`.

import type {
	SourceItem,
	ViewAction,
	ViewActionContext,
	ViewBadge,
	ViewField,
	ViewItem,
	ViewSource,
	ViewSpec,
	ViewTone,
} from "@ryu/app-host/views";
import {
	helloListDetail,
	sourceItemsFromResponse,
	validateView,
} from "@ryu/app-host/views";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from "@ryu/ui/components/item";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Switch } from "@ryu/ui/components/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table";
import { Textarea } from "@ryu/ui/components/textarea";
import { useEffect, useMemo, useState } from "react";

/** Fires when a user activates any action in the rendered view. The renderer
 *  supplies the context (form `values`, the owning/selected `item`); the page
 *  wrapper decides what the action means (declarative `http` tier or a
 *  `view.action` intent relayed to the owning app). */
export type ViewActionHandler = (
	action: ViewAction,
	ctx: ViewActionContext
) => void;

/** The host's authenticated Core fetch seam a source-carrying view uses at mount.
 *  Resolves parsed JSON; rejects on a non-2xx. The spec never sees a token. */
export type ViewSourceFetcher = (
	method: string,
	path: string
) => Promise<unknown>;

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];
type ButtonVariant = React.ComponentProps<typeof Button>["variant"];

/** Map the vocabulary's abstract tone to a concrete `@ryu/ui` Badge variant. The
 *  design system has no literal "success"/"warning" badge, so tones collapse onto
 *  the nearest primitive — the renderer, not the app, owns this mapping. */
function badgeVariant(tone: ViewTone | undefined): BadgeVariant {
	switch (tone) {
		case "danger":
			return "destructive";
		case "warning":
		case "info":
			return "outline";
		case "success":
			return "default";
		default:
			return "secondary";
	}
}

function buttonVariant(style: ViewAction["style"]): ButtonVariant {
	switch (style) {
		case "primary":
			return "default";
		case "danger":
			return "destructive";
		default:
			return "outline";
	}
}

function Badges({ badges }: { badges?: ViewBadge[] }) {
	if (!badges || badges.length === 0) {
		return null;
	}
	return (
		<span className="flex flex-wrap gap-1">
			{badges.map((b, i) => (
				<Badge key={`${b.label}-${i}`} variant={badgeVariant(b.tone)}>
					{b.label}
				</Badge>
			))}
		</span>
	);
}

function Actions({
	actions,
	onAction,
	ctx,
}: {
	actions?: ViewAction[];
	onAction?: ViewActionHandler;
	ctx?: ViewActionContext;
}) {
	if (!actions || actions.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap gap-2">
			{actions.map((a) => (
				<Button
					key={a.id}
					onClick={() => onAction?.(a, ctx ?? {})}
					size="sm"
					variant={buttonVariant(a.style)}
				>
					{a.label}
				</Button>
			))}
		</div>
	);
}

/** A declared (non-source) item's fields as a `{{item.<key>}}` templating base. */
function itemRecord(item: ViewItem): Record<string, unknown> {
	return { ...item };
}

/**
 * Fetch a `list-detail` view's declarative `source` at mount (and whenever
 * `reloadToken` bumps, e.g. after a successful action), mapping response rows to
 * items via the vocabulary's field-map. `null` while unresolved (the caller
 * falls back to the spec's static `items`); a failed fetch degrades to `[]`.
 */
function useSourceItems(
	source: ViewSource | undefined,
	fetchJson: ViewSourceFetcher | undefined,
	reloadToken: number
): SourceItem[] | null {
	const [items, setItems] = useState<SourceItem[] | null>(null);
	useEffect(() => {
		if (!(source && fetchJson)) {
			setItems(null);
			return;
		}
		let cancelled = false;
		fetchJson(source.http.method ?? "GET", source.http.path)
			.then((payload) => {
				if (!cancelled) {
					setItems(sourceItemsFromResponse(source, payload));
				}
			})
			.catch(() => {
				if (!cancelled) {
					setItems([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [source, fetchJson, reloadToken]);
	return items;
}

function ListDetail({
	spec,
	onAction,
	fetchJson,
	reloadToken,
}: {
	spec: Extract<ViewSpec, { view: "list-detail" }>;
	onAction?: ViewActionHandler;
	fetchJson?: ViewSourceFetcher;
	reloadToken: number;
}) {
	const sourceItems = useSourceItems(spec.source, fetchJson, reloadToken);
	const rows: SourceItem[] = useMemo(
		() =>
			sourceItems ??
			spec.items.map((item) => ({ item, raw: itemRecord(item) })),
		[sourceItems, spec.items]
	);
	// The selection is the `{{item.<key>}}` base for the GLOBAL actions; per-row
	// actions always fire with their own row. First row selected by default.
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected =
		rows.find((r) => r.item.id === selectedId) ?? rows[0] ?? null;

	if (rows.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>{spec.emptyText ?? "Nothing here yet."}</EmptyTitle>
				</EmptyHeader>
			</Empty>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<Actions
				actions={spec.actions}
				ctx={{ item: selected?.raw }}
				onAction={onAction}
			/>
			<ItemGroup>
				{rows.map(({ item, raw }) => {
					const rowActions = [
						...(item.actions ?? []),
						...(spec.itemActions ?? []),
					];
					return (
						<Item
							data-selected={selected?.item.id === item.id || undefined}
							key={item.id}
							onClick={() => setSelectedId(item.id)}
							variant="outline"
						>
							<ItemContent>
								<ItemTitle>
									{item.title}
									<Badges badges={item.badges} />
								</ItemTitle>
								{item.subtitle ? (
									<ItemDescription>{item.subtitle}</ItemDescription>
								) : null}
								{item.detail ? (
									<ItemDescription>{item.detail}</ItemDescription>
								) : null}
							</ItemContent>
							{item.accessory ? (
								<span className="text-muted-foreground text-xs">
									{item.accessory}
								</span>
							) : null}
							{rowActions.length > 0 ? (
								<ItemActions>
									<Actions
										actions={rowActions}
										ctx={{ item: raw }}
										onAction={onAction}
									/>
								</ItemActions>
							) : null}
						</Item>
					);
				})}
			</ItemGroup>
		</div>
	);
}

/** One controlled form field, rendered by its declared `type`. */
function FormField({
	field,
	value,
	onChange,
}: {
	field: ViewField;
	value: unknown;
	onChange: (next: unknown) => void;
}) {
	switch (field.type) {
		case "switch":
			return (
				<Switch
					checked={value === true}
					id={field.id}
					onCheckedChange={(checked) => onChange(checked)}
				/>
			);
		case "select":
			return (
				<NativeSelect
					id={field.id}
					onChange={(e) => onChange(e.target.value)}
					required={field.required}
					value={String(value ?? "")}
				>
					{(field.options ?? []).map((opt) => (
						<NativeSelectOption key={opt.value} value={opt.value}>
							{opt.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			);
		case "textarea":
			return (
				<Textarea
					id={field.id}
					onChange={(e) => onChange(e.target.value)}
					placeholder={field.placeholder}
					required={field.required}
					value={String(value ?? "")}
				/>
			);
		case "number":
			return (
				<Input
					id={field.id}
					onChange={(e) =>
						onChange(e.target.value === "" ? "" : Number(e.target.value))
					}
					placeholder={field.placeholder}
					required={field.required}
					type="number"
					value={String(value ?? "")}
				/>
			);
		default:
			return (
				<Input
					id={field.id}
					onChange={(e) => onChange(e.target.value)}
					placeholder={field.placeholder}
					required={field.required}
					type="text"
					value={String(value ?? "")}
				/>
			);
	}
}

function initialFormValues(fields: ViewField[]): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of fields) {
		values[field.id] = field.value ?? (field.type === "switch" ? false : "");
	}
	return values;
}

function FormRenderer({
	spec,
	onAction,
}: {
	spec: Extract<ViewSpec, { view: "form" }>;
	onAction?: ViewActionHandler;
}) {
	// Controlled inputs: the collected values ARE the form-submit contract — the
	// `Record<string,unknown>` handed to every action fired from this form.
	const [values, setValues] = useState<Record<string, unknown>>(() =>
		initialFormValues(spec.fields)
	);
	const setField = (id: string, next: unknown) =>
		setValues((prev) => ({ ...prev, [id]: next }));
	return (
		<form
			className="flex max-w-md flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (spec.submit) {
					onAction?.(spec.submit, { values });
				}
			}}
		>
			{spec.fields.map((field) => (
				<div className="flex flex-col gap-1.5" key={field.id}>
					<Label htmlFor={field.id}>{field.label}</Label>
					<FormField
						field={field}
						onChange={(next) => setField(field.id, next)}
						value={values[field.id]}
					/>
				</div>
			))}
			<Actions actions={spec.actions} ctx={{ values }} onAction={onAction} />
			{spec.submit ? (
				<Button type="submit" variant={buttonVariant(spec.submit.style)}>
					{spec.submit.label}
				</Button>
			) : null}
		</form>
	);
}

/**
 * Render a {@link ViewSpec} with the desktop's own `@ryu/ui` components. Unknown or
 * malformed specs degrade to an empty-state rather than crashing (a newer app on an
 * older shell must not blank the surface).
 *
 * `fetchJson` is the host's authenticated Core seam a `source`-carrying view is
 * fetched through; `reloadToken` re-runs that fetch when bumped (after an action).
 */
export function DeclarativeView({
	spec,
	onAction,
	fetchJson,
	reloadToken = 0,
}: {
	spec: ViewSpec;
	onAction?: ViewActionHandler;
	fetchJson?: ViewSourceFetcher;
	reloadToken?: number;
}) {
	const check = validateView(spec);
	if (!check.ok) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>Unsupported view</EmptyTitle>
					<EmptyDescription>{check.errors.join("; ")}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	switch (spec.view) {
		case "list-detail": {
			return (
				<ListDetail
					fetchJson={fetchJson}
					onAction={onAction}
					reloadToken={reloadToken}
					spec={spec}
				/>
			);
		}

		case "data-table": {
			const hasRowActions = spec.rows.some(
				(row) => (row.actions ?? []).length > 0
			);
			return (
				<div className="flex flex-col gap-3">
					<Actions actions={spec.actions} ctx={{}} onAction={onAction} />
					<Table>
						<TableHeader>
							<TableRow>
								{spec.columns.map((col) => (
									<TableHead
										className={
											col.align === "right"
												? "text-right"
												: col.align === "center"
													? "text-center"
													: undefined
										}
										key={col.id}
									>
										{col.header}
									</TableHead>
								))}
								{hasRowActions ? <TableHead /> : null}
							</TableRow>
						</TableHeader>
						<TableBody>
							{spec.rows.map((row) => (
								<TableRow key={row.id}>
									{spec.columns.map((col) => (
										<TableCell key={col.id}>
											{String(row.cells[col.id] ?? "")}
										</TableCell>
									))}
									{hasRowActions ? (
										<TableCell>
											<Actions
												actions={row.actions}
												ctx={{ item: { id: row.id, ...row.cells } }}
												onAction={onAction}
											/>
										</TableCell>
									) : null}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			);
		}

		case "form": {
			return <FormRenderer onAction={onAction} spec={spec} />;
		}

		case "action-panel": {
			return (
				<div className="flex flex-col gap-3">
					{spec.title ? (
						<h3 className="font-medium text-sm">{spec.title}</h3>
					) : null}
					<Actions actions={spec.actions} ctx={{}} onAction={onAction} />
				</div>
			);
		}

		case "filter-bar": {
			return (
				<div className="flex flex-wrap gap-3">
					{spec.filters.map((filter) => (
						<div className="flex flex-col gap-1" key={filter.id}>
							<Label>{filter.label}</Label>
							<div className="flex flex-wrap gap-1">
								{filter.options.map((opt) => (
									<Badge
										key={opt.value}
										variant={filter.value === opt.value ? "default" : "outline"}
									>
										{opt.label}
									</Badge>
								))}
							</div>
						</div>
					))}
				</div>
			);
		}

		case "empty-state": {
			return (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>{spec.title}</EmptyTitle>
						{spec.description ? (
							<EmptyDescription>{spec.description}</EmptyDescription>
						) : null}
					</EmptyHeader>
					{spec.action ? (
						<Actions actions={[spec.action]} ctx={{}} onAction={onAction} />
					) : null}
				</Empty>
			);
		}

		case "stat-card-row": {
			return (
				<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
					{spec.stats.map((stat) => (
						<Card key={stat.id}>
							<CardHeader>
								<CardTitle className="text-muted-foreground text-xs">
									{stat.label}
								</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="font-semibold text-2xl">{stat.value}</div>
								{stat.delta ? (
									<div className="text-muted-foreground text-xs">
										{stat.delta}
									</div>
								) : null}
							</CardContent>
						</Card>
					))}
				</div>
			);
		}

		default:
			return (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Unsupported view</EmptyTitle>
					</EmptyHeader>
				</Empty>
			);
	}
}

/** A storybook-style harness rendering the shared `hello list-detail` example — the
 *  desktop half of the "one spec, two renderers" proof. Reachable at the
 *  `/dev/declarative-view` route (registered in `usePluginContributionRoutes`). */
export function HelloDeclarativeViewHarness() {
	return (
		<div className="mx-auto max-w-2xl p-6">
			<h2 className="mb-4 font-semibold text-lg">
				Declarative view — hello list-detail
			</h2>
			<DeclarativeView spec={helloListDetail} />
		</div>
	);
}
