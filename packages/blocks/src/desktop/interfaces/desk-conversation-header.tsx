import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, PanelRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { DeskAvatarStack } from "./desk-avatar.tsx";
import type { DeskRow } from "./desk-model.ts";
import { DeskStatusPill } from "./desk-status.tsx";

export function ConversationHeader({
	detailsInline,
	detailsOpen,
	newTargetLabel,
	onClose,
	onToggleDetails,
	row,
	stacked,
}: {
	/** Details sit beside the chat, so the pill would repeat their status. */
	detailsInline: boolean;
	detailsOpen: boolean;
	newTargetLabel: string | null;
	onClose: () => void;
	onToggleDetails: (() => void) | null;
	row: DeskRow | null;
	stacked: boolean;
}) {
	const tl = useLiteralMessages();
	const title = row ? row.title : "New conversation";
	let context: ReactNode = newTargetLabel
		? tl("With {newTargetLabel} · write the first message below", {
				newTargetLabel,
			})
		: "Pick an agent and write the first message below";
	if (row) {
		const names =
			row.agents.length > 0
				? row.agents.map((agent) => agent.name).join(", ")
				: "No agent";
		context = row.group ? `${names} · ${row.group.name}` : names;
	}
	return (
		<header
			className={cn(
				"flex h-14 shrink-0 items-center gap-3 border-border border-b bg-background pr-2",
				stacked ? "pl-2" : "pl-4"
			)}
		>
			{stacked ? (
				<Button
					aria-label="Back to conversations"
					onClick={onClose}
					size="icon-sm"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" />
				</Button>
			) : null}
			{row && row.agents.length > 0 ? (
				<DeskAvatarStack agents={row.agents} />
			) : null}
			<div className="flex min-w-0 flex-1 flex-col">
				<h2 className="truncate text-foreground text-sm">
					<span className="font-semibold">{title}</span>
				</h2>
				<p className="truncate text-muted-foreground text-xs">{context}</p>
			</div>
			{row && !detailsInline ? (
				<DeskStatusPill
					className="@max-[520px]/conv:hidden"
					status={row.status}
				/>
			) : null}
			<div className="flex shrink-0 items-center gap-1">
				{onToggleDetails ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-controls="desk-details"
									aria-expanded={detailsOpen}
									aria-label={detailsOpen ? "Hide details" : "Show details"}
									className={cn(detailsOpen && "bg-muted text-foreground")}
									data-testid="desk-details-toggle"
									onClick={onToggleDetails}
									size="icon-sm"
									variant="ghost-muted"
								/>
							}
						>
							<PanelRight aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{detailsOpen ? "Hide details" : "Show details"} <Kbd>I</Kbd>
						</TooltipContent>
					</Tooltip>
				) : null}
				{stacked ? null : (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-label="Close conversation"
									onClick={onClose}
									size="icon-sm"
									variant="ghost-muted"
								/>
							}
						>
							<X aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent side="bottom">
							Close <Kbd>Esc</Kbd>
						</TooltipContent>
					</Tooltip>
				)}
			</div>
		</header>
	);
}
