"use client";

import {
	Bookmark01Icon,
	Cancel01Icon,
	GhostIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useState } from "react";
import styles from "./input-bar.module.css";
import type {
	InputBarInfoBar,
	TemporaryChatSaveControls,
} from "./input-bar-types.ts";

/**
 * Open state and dismissal for the composer info-bar strip, with voice / mic
 * failures taking precedence over the host-supplied `infoBar`.
 */
export function useComposerInfoBar(
	infoBar: InputBarInfoBar | undefined,
	voiceError: string | null,
	clearVoiceError: () => void
) {
	const [isInfoBarOpen, setIsInfoBarOpen] = useState(true);

	// Voice / mic failures surface on the top info-bar (destructive) so they
	// don't crowd the workspace / sources footer under the input.
	const effectiveInfoBar: InputBarInfoBar | undefined = voiceError
		? {
				description: voiceError,
				variant: "destructive",
				position: "top",
				onClose: clearVoiceError,
			}
		: infoBar;

	// Re-open the strip whenever its content changes (new error, new banner).
	useEffect(() => {
		if (
			effectiveInfoBar &&
			(effectiveInfoBar.title || effectiveInfoBar.description)
		) {
			setIsInfoBarOpen(true);
		}
	}, [
		effectiveInfoBar?.title,
		effectiveInfoBar?.description,
		effectiveInfoBar?.variant,
	]);

	const handleInfoBarClose = useCallback(() => {
		setIsInfoBarOpen(false);
		if (voiceError) {
			clearVoiceError();
		} else {
			infoBar?.onClose?.();
		}
	}, [voiceError, clearVoiceError, infoBar]);

	return { effectiveInfoBar, handleInfoBarClose, isInfoBarOpen };
}

/** The composer info-bar strip (title, description, actions, dismiss). */
export function InputBarInfoStrip({
	effectiveInfoBar,
	handleInfoBarClose,
	isInfoBarOpen,
}: {
	effectiveInfoBar: InputBarInfoBar | undefined;
	handleInfoBarClose: () => void;
	isInfoBarOpen: boolean;
}) {
	const infoBarPosition = effectiveInfoBar?.position ?? "top";
	const infoBarVariant = effectiveInfoBar?.variant ?? "default";
	const isDestructiveInfoBar = infoBarVariant === "destructive";
	const infoBarData = effectiveInfoBar ?? {};

	return (
		<div
			aria-live={isDestructiveInfoBar ? undefined : "polite"}
			className={cn(
				styles.infoBar,
				isInfoBarOpen ? styles.infoBarOpen : styles.infoBarClosed,
				infoBarPosition === "top" ? "rounded-t-2xl" : "rounded-b-2xl"
			)}
			data-position={infoBarPosition}
			data-slot="composer-info-bar"
			role={isDestructiveInfoBar ? "alert" : undefined}
		>
			<div
				className={cn(
					"min-w-0 flex-1 truncate text-xs",
					isDestructiveInfoBar ? "text-status-destructive" : "text-foreground"
				)}
			>
				{infoBarData.title && (
					<span className="font-medium">{infoBarData.title}</span>
				)}
				{infoBarData.description && (
					<span
						className={
							isDestructiveInfoBar
								? "text-status-destructive/80"
								: "text-muted-foreground"
						}
					>
						{infoBarData.title
							? ` ${infoBarData.description}`
							: infoBarData.description}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{infoBarData.actions?.map((action) => (
					<Button
						appearance="composer-info-action"
						key={action.label}
						onClick={action.onClick}
						size="sm"
						type="button"
						variant={action.variant ?? "secondary"}
					>
						{action.label}
					</Button>
				))}
				{infoBarData.action && (
					<Button
						appearance="composer-info-action"
						onClick={infoBarData.action.onClick}
						size="sm"
						type="button"
					>
						{infoBarData.action.label}
					</Button>
				)}
				{infoBarData.onClose && (
					<Button
						appearance={
							isDestructiveInfoBar
								? "composer-info-dismiss-destructive"
								: "composer-info-dismiss"
						}
						aria-label="Close"
						className="size-6 shrink-0"
						onClick={handleInfoBarClose}
						size="icon"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="h-3.5 w-3.5"
							icon={Cancel01Icon}
							strokeWidth={2}
						/>
					</Button>
				)}
			</div>
		</div>
	);
}

/**
 * Temporary chat: a top info-bar strip signalling the thread isn't being
 * saved. Neutral styling (no bg/border of its own) so it shows the frame color
 * like the other bars — the ghost icon + copy carry the signal.
 */
export function TemporaryChatBar({
	temporaryChatSaveControls,
}: {
	temporaryChatSaveControls?: TemporaryChatSaveControls;
}) {
	return (
		<div className="flex h-[34px] min-w-0 items-center gap-2 rounded-t-2xl px-3 text-muted-foreground text-xs">
			<HugeiconsIcon className="size-3.5 shrink-0" icon={GhostIcon} />
			<span className="shrink-0 font-medium text-foreground">
				Temporary chat
			</span>
			<span className="min-w-0 flex-1 truncate">
				Messages in this chat won't be saved.
			</span>
			{temporaryChatSaveControls ? (
				<Button
					appearance="composer-save-temporary"
					aria-label={
						temporaryChatSaveControls.saving
							? "Saving temporary chat"
							: "Save temporary chat"
					}
					disabled={
						temporaryChatSaveControls.disabled ||
						temporaryChatSaveControls.saving
					}
					onClick={temporaryChatSaveControls.onSave}
					title="Save this temporary chat to your history"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3.5" icon={Bookmark01Icon} />
					{temporaryChatSaveControls.saving ? "Saving…" : "Save chat"}
				</Button>
			) : null}
		</div>
	);
}
