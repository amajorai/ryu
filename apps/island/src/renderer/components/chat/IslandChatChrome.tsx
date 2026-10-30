// The expanded chat's quiet chrome: an `h-10` header (thread title once there
// is one; language in "More"; command palette and minimize as `icon-sm`
// buttons), and the one-line `h-8` strips for plugin notes, an unreachable
// Core, and a failed reply. Kept apart from `IslandChat` so the chat file
// holds state and wiring only.

import {
	Cancel01Icon,
	CommandIcon,
	MinusSignIcon,
	MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { UIMessage } from "ai";

/** The thread's title: its first question, once the thread exists. */
export function threadTitle(messages: readonly UIMessage[]): string {
	for (const message of messages) {
		if (message.role !== "user") {
			continue;
		}
		for (const part of message.parts) {
			if (part.type === "text" && part.text.trim()) {
				return part.text.trim();
			}
		}
	}
	return "";
}

export function IslandChatHeader({
	onMinimize,
	onOpenCommand,
	title,
}: {
	onMinimize: () => void;
	onOpenCommand: () => void;
	title: string;
}) {
	const { availablePacks, selectPack, selectedPackId, t } = useI18n();
	const commandPaletteLabel = t(
		"island.open-command-palette",
		undefined,
		"Open command palette"
	);
	const minimizeLabel = t("island.minimize", undefined, "Minimize");
	const languageLabel = t("language.current");
	return (
		<header className="relative z-20 flex h-10 shrink-0 items-center gap-2 ps-1">
			<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
				{title}
			</span>
			<div className="flex items-center gap-1">
				{/* "More" holds the language choice. The native select sits over the
				    button so its list opens as an OS popup, which the small Island
				    window cannot clip. */}
				<span className="relative inline-flex rounded-full has-focus-visible:ring-2 has-focus-visible:ring-ring">
					<Button
						aria-hidden
						className="pointer-events-none"
						size="icon-sm"
						tabIndex={-1}
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</Button>
					<select
						aria-label={languageLabel}
						className="absolute inset-0 cursor-pointer rounded-full opacity-0"
						onChange={(event) => selectPack(event.target.value || null)}
						title={languageLabel}
						value={selectedPackId ?? ""}
					>
						<option value="">{t("common.english")}</option>
						{availablePacks
							.filter((pack) => pack.enabled !== false)
							.map((pack) => (
								<option key={pack.id} value={pack.id}>
									{pack.name}
								</option>
							))}
					</select>
				</span>
				<Button
					aria-label={commandPaletteLabel}
					onClick={onOpenCommand}
					size="icon-sm"
					title={commandPaletteLabel}
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={CommandIcon} />
				</Button>
				<Button
					aria-label={t("island.minimize-ryu", undefined, "Minimize Ryu")}
					onClick={onMinimize}
					size="icon-sm"
					title={minimizeLabel}
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={MinusSignIcon} />
				</Button>
			</div>
		</header>
	);
}

/** One `h-8` line: a sentence, then at most a couple of quiet actions. */
function Strip({
	children,
	tone = "muted",
}: {
	children: React.ReactNode;
	tone?: "muted" | "warning" | "destructive";
}) {
	return (
		<div
			className={cn(
				"relative z-20 flex h-8 shrink-0 items-center gap-2 rounded-lg ps-2 pe-1 text-sm",
				// The Island surface is the popover token (equal to `muted`), so a
				// muted strip tints the foreground instead.
				tone === "muted" && "bg-foreground/5 text-muted-foreground",
				tone === "warning" && "bg-warning/10 text-status-warning",
				tone === "destructive" && "bg-destructive/10 text-status-destructive"
			)}
			role="status"
		>
			{children}
		</div>
	);
}

export function IslandNotesStrip({
	notes,
	onDismiss,
}: {
	notes: readonly string[];
	onDismiss: () => void;
}) {
	const { t } = useI18n();
	if (notes.length === 0) {
		return null;
	}
	const text = notes.join(" · ");
	return (
		<Strip tone="warning">
			<span className="min-w-0 flex-1 truncate" title={text}>
				{text}
			</span>
			<Button
				aria-label={t("island.dismiss-notes", undefined, "Dismiss notes")}
				onClick={onDismiss}
				size="icon-xs"
				variant="ghost-muted"
			>
				<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
			</Button>
		</Strip>
	);
}

function copyDetails(details: string): void {
	navigator.clipboard?.writeText(details).catch(() => {
		// Clipboard access can be refused; the details stay in the tooltip.
	});
}

/** An unreachable Core or a failed reply: one sentence, Retry, Copy details. */
export function IslandChatProblem({
	details,
	onRetry,
	sentence,
}: {
	details?: string;
	onRetry?: () => void;
	sentence: string;
}) {
	const { t } = useI18n();
	return (
		<Strip tone={details ? "destructive" : "muted"}>
			<span className="min-w-0 flex-1 truncate" title={sentence}>
				{sentence}
			</span>
			{details ? (
				<Button
					onClick={() => copyDetails(details)}
					size="xs"
					title={details}
					variant="ghost-muted"
				>
					{t("island.copy-details", undefined, "Copy details")}
				</Button>
			) : null}
			{onRetry ? (
				<Button onClick={onRetry} size="xs" variant="ghost-muted">
					{t("common.retry")}
				</Button>
			) : null}
		</Strip>
	);
}
