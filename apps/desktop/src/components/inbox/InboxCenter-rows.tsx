// apps/desktop/src/components/inbox/InboxCenter-rows.tsx
//
// The Inbox tray's row components (approval, task suggestion, notification) and
// the decision actions its notification stack uses. Split out of InboxCenter.tsx.
//
// Each notification row
// shows the SENDING APP'S icon (resolved from the app catalog by
// `source_app_id`, so a monitor alert reads as the Monitors app, a reply as
// Outpost), and carries an archive action. Clicking the row marks it read and
// opens the full Inbox, where the read/unread/archived views live.
//
// Rows are actionable: approve/reject an approval, accept/dismiss a task
// suggestion, or archive a notification, without leaving the tray — the same
// mutations the full Inbox drives (useApprovals / useQuests / useNotifications),
// so the two surfaces never disagree. The affirmative action is a labelled pill,
// not a bare tick: this is the one surface in the app where mistaking "reject"
// for "approve" actually costs something. Clicking the row body opens the full
// Inbox; the popover is controlled so those clicks dismiss it.

import {
	Archive01Icon,
	ArchiveRestoreIcon,
	Calendar04Icon,
	Cancel01Icon,
	CheckListIcon,
	Notification01Icon,
	Pulse01Icon,
	SparklesIcon,
	WorkflowCircle06Icon,
	Wrench01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { riskTagLabel } from "@ryuhq/protocol/interfaces";
import { useState } from "react";
import {
	TrayAction,
	TrayIconAction,
	TrayRow,
	trayMeta,
} from "@/src/components/shell/TrayPopover.tsx";
import type { useApprovals } from "@/src/hooks/useApprovals.ts";
import type { useNotifications } from "@/src/hooks/useNotifications.ts";
import type { useQuests } from "@/src/hooks/useQuests.ts";
import type { ApprovalKind, ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { AppNotification } from "@/src/lib/api/notifications.ts";
import type { AppInfo } from "@/src/lib/api/plugins.ts";
import type { Quest } from "@/src/lib/api/quests.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A glyph per approval kind so the list scans by shape, not just by text. */
export const KIND_ICON = {
	tool_call: Wrench01Icon,
	workflow_gate: WorkflowCircle06Icon,
	scheduled_run: Calendar04Icon,
	trigger_run: ZapIcon,
	skill_synthesis: SparklesIcon,
	heal_fix: Pulse01Icon,
} satisfies Record<ApprovalKind, IconSvgElement>;

/** Short "2m"/"3h"/"5d" stamp — the tray has no room for a full timestamp. */
export function shortAgo(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const at = new Date(value).getTime();
	if (Number.isNaN(at)) {
		return null;
	}
	const delta = Date.now() - at;
	if (delta < MINUTE_MS) {
		return "now";
	}
	if (delta < HOUR_MS) {
		return `${Math.floor(delta / MINUTE_MS)}m`;
	}
	if (delta < DAY_MS) {
		return `${Math.floor(delta / HOUR_MS)}h`;
	}
	return `${Math.floor(delta / DAY_MS)}d`;
}

export function ApprovalRow({
	approval,
	busy,
	onApprove,
	onOpen,
	onReject,
}: {
	approval: ApprovalRequest;
	busy: boolean;
	onApprove: () => void;
	onOpen: () => void;
	onReject: () => void;
}) {
	const tl = useLiteralMessages();
	const risky = approval.risk_tags.length > 0;
	return (
		<TrayRow
			actions={
				<>
					<TrayIconAction
						icon={Cancel01Icon}
						label="Reject"
						onClick={onReject}
						tone="danger"
					/>
					<TrayAction label="Approve" onClick={onApprove} tone="success" />
				</>
			}
			busy={busy}
			icon={KIND_ICON[approval.kind] ?? Wrench01Icon}
			// Risk is carried by the red glyph plus the leading meta segments; the
			// old red chips stacked a third line onto every risky row and turned the
			// list into a wall of pink.
			meta={trayMeta(
				...approval.risk_tags.slice(0, 2).map(riskTagLabel),
				approval.summary
			)}
			onOpen={onOpen}
			openLabel={tl("Open {title} in the inbox", { title: approval.title })}
			title={approval.title}
			tone={risky ? "danger" : "default"}
			trailing={shortAgo(approval.created_at)}
		/>
	);
}

export function SuggestionRow({
	busy,
	onAccept,
	onDismiss,
	onOpen,
	quest,
}: {
	busy: boolean;
	onAccept: () => void;
	onDismiss: () => void;
	onOpen: () => void;
	quest: Quest;
}) {
	const tl = useLiteralMessages();
	return (
		<TrayRow
			actions={
				<>
					<TrayIconAction
						icon={Cancel01Icon}
						label="Not yet"
						onClick={onDismiss}
					/>
					<TrayAction label="Done" onClick={onAccept} tone="success" />
				</>
			}
			busy={busy}
			icon={CheckListIcon}
			meta={quest.suggestion?.reason}
			onOpen={onOpen}
			openLabel={tl("Open {title} in the inbox", { title: quest.title })}
			title={tl("Finished “{title}”?", { title: quest.title })}
		/>
	);
}

/**
 * One unread inbox notification. The lead tile is the SENDING app's icon when the
 * row carries a `source_app_id` we can resolve (so a monitor alert reads as the
 * Monitors app, a reply as Outpost); rows from legacy Core producers fall back to
 * a generic glyph. Clicking the row marks it read and opens the full Inbox; the
 * archive action moves it out of the tray without opening anything.
 */
export function NotificationTrayRow({
	appsById,
	archived,
	notification,
	notifications,
	onOpen,
}: {
	archived: boolean;
	appsById: Map<string, AppInfo>;
	notification: AppNotification;
	notifications: ReturnType<typeof useNotifications>;
	onOpen: () => void;
}) {
	const tl = useLiteralMessages();
	const app = notification.source_app_id
		? (appsById.get(notification.source_app_id) ?? null)
		: null;
	return (
		<TrayRow
			actions={
				<TrayIconAction
					icon={archived ? ArchiveRestoreIcon : Archive01Icon}
					label={archived ? "Restore to inbox" : "Archive"}
					onClick={() => {
						const action = archived
							? notifications.unarchive(notification.id)
							: notifications.archive(notification.id);
						// useNotifications' mutation onError already toasts the failure.
						action.catch(() => undefined);
					}}
				/>
			}
			icon={Notification01Icon}
			iconNode={
				app ? (
					<span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-(--radius-inbox-app-icon)">
						<AppIcon
							className="size-7"
							dither={app.iconDither}
							iconBackground={app.iconBackground ?? undefined}
							iconId={app.icon}
							iconPadding={app.iconPadding}
							iconUrl={app.iconUrl}
							name={app.name}
							presentation="inbox"
							seedId={app.id}
							size={14}
						/>
					</span>
				) : undefined
			}
			meta={trayMeta(
				app?.name ?? "Ryu",
				notification.body ?? undefined,
				shortAgo(notification.created_at)
			)}
			onOpen={onOpen}
			openLabel={tl("Open {title} in the inbox", {
				title: notification.title,
			})}
			title={notification.title}
		/>
	);
}

export type InboxDecisionResult = Promise<
	| Awaited<ReturnType<ReturnType<typeof useApprovals>["approve"]>>
	| Awaited<ReturnType<ReturnType<typeof useQuests>["acceptSuggestion"]>>
	| undefined
>;

export function DecisionStackActions({
	busy,
	confirmLabel,
	declineLabel,
	declineTone = "default",
	onConfirm,
	onDecline,
	pendingLabel,
}: {
	busy: boolean;
	confirmLabel: string;
	declineLabel: string;
	declineTone?: "default" | "danger";
	onConfirm: () => InboxDecisionResult;
	onDecline: () => InboxDecisionResult;
	pendingLabel: string;
}) {
	const [pending, setPending] = useState(false);
	const isPending = busy || pending;
	const decide = (action: () => InboxDecisionResult) => {
		setPending(true);
		// The approval/quest hooks' mutation onError already toasts failures.
		action()
			.catch(() => undefined)
			.finally(() => setPending(false));
	};

	if (isPending) {
		return (
			<span
				aria-busy="true"
				aria-label={pendingLabel}
				className="relative z-20 flex h-6 items-center px-2 text-muted-foreground text-xs"
				role="status"
			>
				Working…
			</span>
		);
	}

	return (
		<span className="relative z-20 flex items-center gap-0.5">
			<TrayIconAction
				icon={Cancel01Icon}
				label={declineLabel}
				onClick={() => decide(onDecline)}
				tone={declineTone}
			/>
			<TrayAction
				label={confirmLabel}
				onClick={() => decide(onConfirm)}
				tone="success"
			/>
		</span>
	);
}
