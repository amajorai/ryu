// An item's history: its timeline events oldest first, paged by Core's
// cursor. Callers with `read` see earlier items at the same key too; with
// only `list`, the current item. Events name fields, never values.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listVaultItemEvents,
	type VaultItemSummary,
} from "@/src/lib/api/vault-items.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { describeItemEvent, itemEventActor } from "./vault-item-history.ts";
import { timestampMillis } from "./vault-ttl.ts";

export const ITEM_EVENTS_PAGE = 100;

function Timeline({
	item,
	target,
}: {
	item: VaultItemSummary;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const location = { environment: item.environment, path: item.path };
	const eventsQuery = useInfiniteQuery({
		queryKey: [
			"vault",
			"items",
			"events",
			target.url,
			item.environment,
			item.path,
			item.key,
		],
		initialPageParam: 0,
		queryFn: ({ pageParam }) =>
			listVaultItemEvents(target, item.key, {
				...location,
				after: pageParam,
				limit: ITEM_EVENTS_PAGE,
			}),
		getNextPageParam: (page) =>
			page.events.length === ITEM_EVENTS_PAGE ? page.next : undefined,
	});
	const events = eventsQuery.data?.pages.flatMap((page) => page.events) ?? [];

	if (eventsQuery.isLoading) {
		return <SkeletonRows inset="panel" rows={3} />;
	}
	if (eventsQuery.error) {
		return (
			<p className="text-sm text-status-destructive" role="alert">
				{vaultErrorMessage(eventsQuery.error, "Could not load history.", tl)}
			</p>
		);
	}
	if (events.length === 0) {
		return <p className="text-muted-foreground text-sm">No history yet.</p>;
	}
	return (
		<div className="space-y-2">
			<ol className="max-h-96 divide-y overflow-y-auto rounded-lg border">
				{events.map((event) => {
					const at = timestampMillis(event.createdAt);
					return (
						<li className="px-3 py-2" key={event.seq}>
							<p className="text-sm">{describeItemEvent(event, tl)}</p>
							<p className="text-muted-foreground text-xs">
								{tl("Version {version} · {actor} · {when}", {
									version: event.version,
									actor: itemEventActor(event),
									when: at === null ? "" : formatDateTime(at),
								})}
							</p>
						</li>
					);
				})}
			</ol>
			{eventsQuery.hasNextPage ? (
				<Button
					disabled={eventsQuery.isFetchingNextPage}
					onClick={() => eventsQuery.fetchNextPage()}
					size="sm"
					variant="ghost"
				>
					Load more
				</Button>
			) : null}
		</div>
	);
}

export function VaultItemHistoryDialog({
	item,
	onOpenChange,
	target,
}: {
	/** The item to show; `null` closes the dialog. */
	item: VaultItemSummary | null;
	onOpenChange: (open: boolean) => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	return (
		<Dialog onOpenChange={onOpenChange} open={item !== null}>
			<DialogContent className="sm:max-w-lg">
				{item ? (
					<>
						<DialogHeader>
							<DialogTitle>
								{tl("History of {item}", { item: item.key })}
							</DialogTitle>
							<DialogDescription>
								Changes, reveals and status changes, oldest first. Values are
								never shown here.
							</DialogDescription>
						</DialogHeader>
						<Timeline item={item} key={item.id} target={target} />
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
