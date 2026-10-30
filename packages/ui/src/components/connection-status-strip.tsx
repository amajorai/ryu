"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** The status colour of a strip's icon. The strip itself is never tinted. */
export type StatusStripTone =
	| "neutral"
	| "info"
	| "success"
	| "warning"
	| "destructive";

const TONE_ICON_CLASS: Record<StatusStripTone, string> = {
	neutral: "text-muted-foreground",
	info: "text-status-info",
	success: "text-status-success",
	warning: "text-status-warning",
	destructive: "text-status-destructive",
};

export interface StatusStripProps extends Omit<ComponentProps<"div">, "title"> {
	/** At most one action, conventionally a ghost `sm` Button. */
	action?: ReactNode;
	/** The rest of the sentence, in muted text after the title. */
	detail?: ReactNode;
	/** A 16px icon; the tone colours the icon only. */
	icon?: ReactNode;
	/** The lead of the sentence, in foreground text. */
	title?: ReactNode;
	tone?: StatusStripTone;
}

/**
 * The one system-banner pattern: an inline `h-8` strip under the header with a
 * muted (or status-coloured) icon, one sentence and at most one action. No pill,
 * shadow, blur or tinted fill: the strip takes the page tone and a hairline.
 */
export function StatusStrip({
	action,
	className,
	detail,
	icon,
	title,
	tone = "neutral",
	...props
}: StatusStripProps) {
	// The sentence truncates to one line; keep the whole of it on hover when it
	// is plain text.
	const fullText =
		typeof title === "string" &&
		(detail === undefined || typeof detail === "string")
			? [title, detail].filter(Boolean).join(" ")
			: undefined;
	return (
		<div
			aria-live="polite"
			className={cn(
				"flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden border-border border-b bg-background px-4 text-sm",
				className
			)}
			data-slot="status-strip"
			data-tone={tone}
			role="status"
			{...props}
		>
			{icon ? (
				<span
					aria-hidden="true"
					className={cn(
						"flex size-4 shrink-0 items-center justify-center [&_svg]:size-4",
						TONE_ICON_CLASS[tone]
					)}
					data-slot="status-strip-icon"
				>
					{icon}
				</span>
			) : null}
			<p
				className="min-w-0 flex-1 truncate"
				data-slot="status-strip-text"
				title={fullText}
			>
				{title ? (
					<span className="text-foreground" data-slot="status-strip-title">
						{title}
					</span>
				) : null}
				{title && detail ? " " : null}
				{detail ? (
					<span
						className="text-muted-foreground"
						data-slot="status-strip-detail"
					>
						{detail}
					</span>
				) : null}
			</p>
			{action ? (
				<div
					className="flex shrink-0 items-center"
					data-slot="status-strip-action"
				>
					{action}
				</div>
			) : null}
		</div>
	);
}
