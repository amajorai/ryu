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
	ViewAction,
	ViewActionContext,
	ViewActionHttpMethod,
	ViewSpec,
} from "@ryu/app-host/views";
import {
	helloListDetail,
	type sourceItemsFromResponse,
	validateView,
} from "@ryu/app-host/views";
import { Badge } from "@ryu/ui/components/badge.tsx";

import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";

import { Label } from "@ryu/ui/components/label.tsx";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { FormRenderer } from "./DeclarativeView.form.tsx";
import { Actions, ListDetail } from "./DeclarativeView.parts.tsx";

/** Fires when a user activates any action in the rendered view. The renderer
 *  supplies the context (form `values`, the owning/selected `item`); the page
 *  wrapper decides what the action means (declarative `http` tier or a
 *  `view.action` intent relayed to the owning app). */
export type ViewActionHandler = (
	action: ViewAction,
	ctx: ViewActionContext
) => void | Promise<void>;

/** The host's authenticated Core fetch seam a source-carrying view uses at mount.
 *  Resolves parsed JSON; rejects on a non-2xx. The spec never sees a token. */
export type ViewSourceFetcher = (
	method: ViewActionHttpMethod,
	path: string,
	signal?: AbortSignal
) => Promise<Parameters<typeof sourceItemsFromResponse>[1]>;

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
								<CardTitle variant="metric-label">{stat.label}</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="font-medium text-2xl">{stat.value}</div>
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
			<h2 className="mb-4 font-medium text-lg">
				Declarative view — hello list-detail
			</h2>
			<DeclarativeView spec={helloListDetail} />
		</div>
	);
}
