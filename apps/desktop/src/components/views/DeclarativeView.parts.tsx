import {
	type SourceItem,
	sourceItemsFromResponse,
	type ViewAction,
	type ViewActionContext,
	type ViewBadge,
	type ViewItem,
	type ViewSource,
	type ViewSourceRow,
	type ViewSpec,
	type ViewTone,
	viewSourceRowSchema,
} from "@ryu/app-host/views";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from "@ryu/ui/components/item.tsx";
import { useEffect, useMemo, useState } from "react";
import type {
	ViewActionHandler,
	ViewSourceFetcher,
} from "./DeclarativeView.tsx";

export type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

export type ButtonVariant = React.ComponentProps<typeof Button>["variant"];

/** Map the vocabulary's abstract tone to a concrete `@ryu/ui` Badge variant. The
 *  design system has no literal "success"/"warning" badge, so tones collapse onto
 *  the nearest primitive — the renderer, not the app, owns this mapping. */
export function badgeVariant(tone: ViewTone | undefined): BadgeVariant {
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

export function buttonVariant(style: ViewAction["style"]): ButtonVariant {
	switch (style) {
		case "primary":
			return "default";
		case "danger":
			return "destructive";
		default:
			return "outline";
	}
}

export function Badges({ badges }: { badges?: ViewBadge[] }) {
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

export function Actions({
	actions,
	onAction,
	ctx,
}: {
	actions?: ViewAction[];
	onAction?: ViewActionHandler;
	ctx?: ViewActionContext;
}) {
	const [pending, setPending] = useState(false);
	if (!actions || actions.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap gap-2">
			{actions.map((a) => (
				<Button
					disabled={pending}
					key={a.id}
					onClick={async () => {
						setPending(true);
						try {
							await onAction?.(a, ctx ?? {});
						} finally {
							setPending(false);
						}
					}}
					size="sm"
					type="button"
					variant={buttonVariant(a.style)}
				>
					{a.label}
				</Button>
			))}
		</div>
	);
}

/** A declared (non-source) item's fields as a `{{item.<key>}}` templating base. */
export function itemRecord(item: ViewItem): ViewSourceRow {
	return viewSourceRowSchema.parse(item);
}

/**
 * Fetch a `list-detail` view's declarative `source` at mount (and whenever
 * `reloadToken` bumps, e.g. after a successful action), mapping response rows to
 * items via the vocabulary's field-map. `null` while unresolved (the caller
 * falls back to the spec's static `items`); failed reads expose a retry state.
 */
export function useSourceItems(
	source: ViewSource | undefined,
	fetchJson: ViewSourceFetcher | undefined,
	reloadToken: number
) {
	const [items, setItems] = useState<SourceItem[] | null>(null);
	const [error, setError] = useState(false);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		setItems(null);
		setError(false);
		if (!(source && fetchJson)) {
			setItems(null);
			return;
		}
		const controller = new AbortController();
		fetchJson(source.http.method ?? "GET", source.http.path, controller.signal)
			.then((payload) => {
				if (!controller.signal.aborted) {
					setItems(sourceItemsFromResponse(source, payload));
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) {
					setItems([]);
					setError(true);
				}
			});
		return () => {
			controller.abort();
		};
	}, [source, fetchJson, reloadToken, attempt]);
	return { items, error, retry: () => setAttempt((value) => value + 1) };
}

export function ListDetail({
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
	const {
		items: sourceItems,
		error,
		retry,
	} = useSourceItems(spec.source, fetchJson, reloadToken);
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

	if (spec.source && fetchJson && sourceItems === null) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>Loading view…</EmptyTitle>
				</EmptyHeader>
			</Empty>
		);
	}
	if (error) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>Couldn't load this view.</EmptyTitle>
					<EmptyDescription>
						Check your connection or app permissions, then try again.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={retry} size="sm" variant="outline">
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (rows.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>{spec.emptyText ?? "Nothing here yet."}</EmptyTitle>
				</EmptyHeader>
				<EmptyContent>
					<Actions actions={spec.actions} ctx={{}} onAction={onAction} />
				</EmptyContent>
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
									<button
										className="text-left"
										onClick={() => setSelectedId(item.id)}
										type="button"
									>
										{item.title}
									</button>
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
