// Shared building blocks of the island declarative-view renderer: tone badges and
// the Raycast-style foot ActionPanel every view kind fires its actions through.

import type {
	ViewAction,
	ViewActionContext,
	ViewBadge,
	ViewTone,
} from "@ryu/app-host/views";

/** Fires when a user activates an action row. The renderer supplies the ctx
 *  (selected `item`, collected form `values`); the island shell forwards the
 *  action to the declarative http tier or the owning app. */
export type IslandViewActionHandler = (
	action: ViewAction,
	ctx: ViewActionContext
) => void;

export const TONE_DOT = {
	neutral: "bg-muted-foreground",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-destructive",
	info: "bg-info",
} satisfies Record<ViewTone, string>;

export function ToneBadges({ badges }: { badges?: ViewBadge[] }) {
	if (!badges || badges.length === 0) {
		return null;
	}
	return (
		<span className="flex items-center gap-1">
			{badges.map((b, i) => (
				<span
					className="flex items-center gap-1 text-muted-foreground text-xs"
					key={`${b.label}-${i}`}
				>
					<span
						className={`size-1.5 rounded-full ${TONE_DOT[b.tone ?? "neutral"]}`}
					/>
					{b.label}
				</span>
			))}
		</span>
	);
}

/** One entry of the foot ActionPanel: the action plus the ctx it fires with. */
export interface PanelEntry {
	action: ViewAction;
	ctx: ViewActionContext;
}

/** The Raycast-style ActionPanel: a compact row of pill buttons at the foot of the
 *  overlay. Primary reads brighter; danger reads red. Each entry carries its own
 *  ctx (the selected item / form values) so `{{…}}` templating resolves upstream. */
export function ActionPanel({
	entries,
	onAction,
}: {
	entries: PanelEntry[];
	onAction?: IslandViewActionHandler;
}) {
	if (entries.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1 border-border border-t px-2 pt-2">
			{entries.map(({ action, ctx }) => (
				<button
					className={`flex h-7 items-center rounded-lg px-2 text-xs transition-colors duration-(--duration-fast) ${
						action.style === "primary"
							? "bg-foreground text-background hover:bg-foreground/90"
							: action.style === "danger"
								? "text-status-destructive hover:bg-destructive/15"
								: "text-muted-foreground hover:bg-foreground/5"
					}`}
					key={action.id}
					onClick={() => onAction?.(action, ctx)}
					type="button"
				>
					{action.label}
				</button>
			))}
		</div>
	);
}

/** Actions with a shared ctx → panel entries. */
export function withCtx(
	actions: ViewAction[] | undefined,
	ctx: ViewActionContext
): PanelEntry[] {
	return (actions ?? []).map((action) => ({ action, ctx }));
}
