"use client";

import {
	ArrowDown01Icon,
	BookOpen01Icon,
	Globe02Icon,
	LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure.tsx";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import { getFaviconUrl } from "@ryu/ui/lib/favicon.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useId, useState } from "react";

export interface CitationItem {
	domain?: ReactNode;
	id: string;
	title: ReactNode;
	url?: string;
}

export interface CitationsProps {
	citations: CitationItem[];
	className?: string;
	defaultOpen?: boolean;
	idPrefix?: string;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	title?: ReactNode;
}

export interface CitationProps {
	citationId: string;
	className?: string;
	/** Must match the related Citations idPrefix. */
	idPrefix: string;
	index: number;
}

export interface CitationListProps {
	citations: CitationItem[];
	className?: string;
	idPrefix?: string;
	surface?: "default" | "transcript";
}

export interface CitationStackProps {
	citations: CitationItem[];
	className?: string;
	limit?: number;
}

function citationTargetId(prefix: string, citationId: string) {
	return `${prefix}-${citationId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function safeCitationUrl(value: string | undefined): string | null {
	if (!value?.trim()) {
		return null;
	}
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

export function Citation({
	citationId,
	index,
	idPrefix,
	className,
}: CitationProps) {
	const tl = useLiteralMessages();
	return (
		<a
			aria-label={tl("View citation {index}", { index })}
			className={cn(
				"mx-0.5 inline-flex min-w-4 -translate-y-0.5 items-center justify-center rounded-lg bg-muted px-1 py-0.5 font-medium text-muted-foreground text-xs leading-none no-underline outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				className
			)}
			href={`#${citationTargetId(idPrefix, citationId)}`}
		>
			{index}
		</a>
	);
}

export function CitationFavicon({
	url,
	className,
}: {
	url?: string;
	className?: string;
}) {
	const safeUrl = safeCitationUrl(url);
	const favicon = safeUrl ? getFaviconUrl(safeUrl) : null;
	const [failedUrl, setFailedUrl] = useState<string | null>(null);

	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid size-5 shrink-0 place-items-center text-muted-foreground",
				className
			)}
		>
			{favicon && failedUrl !== favicon ? (
				<img
					alt=""
					className="size-4 rounded-sm object-contain"
					height={16}
					onError={() => setFailedUrl(favicon)}
					referrerPolicy="no-referrer"
					src={favicon}
					width={16}
				/>
			) : (
				<HugeiconsIcon className="size-3.5" icon={Globe02Icon} />
			)}
		</span>
	);
}

export function CitationStack({
	citations,
	limit = 3,
	className,
}: CitationStackProps) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex -space-x-1.5 [--avatar-overlap:--spacing(1.5)] [--avatar-size:--spacing(6)]",
				className
			)}
			data-avatar-stack=""
		>
			{citations.slice(0, limit).map((citation) => (
				<CitationFavicon
					className="size-6 rounded-full bg-background"
					key={citation.id}
					url={citation.url}
				/>
			))}
		</span>
	);
}

function CitationRow({
	citation,
	index,
	idPrefix,
	surface,
}: {
	citation: CitationItem;
	index: number;
	idPrefix: string;
	surface: CitationListProps["surface"];
}) {
	const safeUrl = safeCitationUrl(citation.url);
	const content = (
		<>
			<CitationFavicon url={safeUrl ?? undefined} />
			<span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
				<span className="truncate font-medium text-foreground text-sm">
					{citation.title}
				</span>
				{citation.domain ? (
					<span className="min-w-0 truncate text-muted-foreground text-xs">
						{citation.domain}
					</span>
				) : null}
			</span>
			<span className="flex shrink-0 items-center gap-1.5">
				<span
					className={cn(
						"grid size-5 place-items-center rounded-lg font-medium text-muted-foreground text-xs tabular-nums",
						surface === "transcript" ? "bg-background" : "bg-muted"
					)}
				>
					{index}
				</span>
				{safeUrl ? (
					<HugeiconsIcon
						className="size-3.5 text-muted-foreground/70 transition-colors group-hover/citation:text-muted-foreground"
						icon={LinkSquare02Icon}
					/>
				) : null}
			</span>
		</>
	);
	const className =
		"group/citation flex items-center gap-2 rounded-lg px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring";
	const id = citationTargetId(idPrefix, citation.id);

	return safeUrl ? (
		<a
			className={className}
			href={safeUrl}
			id={id}
			rel="noreferrer noopener"
			target="_blank"
		>
			{content}
		</a>
	) : (
		<div className={className} id={id}>
			{content}
		</div>
	);
}

export function CitationList({
	surface = "default",
	citations,
	idPrefix,
	className,
}: CitationListProps) {
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const resolvedPrefix =
		idPrefix ?? `citation-list-${baseId.replace(/:/g, "")}`;

	return (
		<div
			className={cn(
				"grid gap-0.5",
				surface === "transcript" && "rounded-xl bg-muted p-2",
				className
			)}
		>
			<AnimatePresence mode="popLayout">
				{citations.map((citation, index) => (
					<motion.div
						animate={{ opacity: 1, y: 0 }}
						exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
						initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
						key={citation.id}
						layout="position"
						transition={
							reduce
								? { duration: 0 }
								: {
										opacity: { duration: 0.18, ease: EASE_OUT },
										y: SPRING_LAYOUT,
										layout: SPRING_LAYOUT,
									}
						}
					>
						<CitationRow
							citation={citation}
							idPrefix={resolvedPrefix}
							index={index + 1}
							surface={surface}
						/>
					</motion.div>
				))}
			</AnimatePresence>
		</div>
	);
}

export function Citations({
	citations,
	title = "Sources",
	open,
	defaultOpen = false,
	onOpenChange,
	idPrefix,
	className,
}: CitationsProps) {
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const contentId = `${baseId}-content`;
	const resolvedPrefix = idPrefix ?? `citation-${baseId.replace(/:/g, "")}`;
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const currentOpen = open ?? internalOpen;
	const setOpen = useCallback(
		(next: boolean) => {
			if (open === undefined) {
				setInternalOpen(next);
			}
			onOpenChange?.(next);
		},
		[onOpenChange, open]
	);

	return (
		<div className={cn("w-full text-sm", className)}>
			<button
				aria-controls={contentId}
				aria-expanded={currentOpen}
				className="group -ml-1 flex min-h-8 items-center gap-2 rounded-lg px-1 text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => setOpen(!currentOpen)}
				type="button"
			>
				<HugeiconsIcon className="size-4" icon={BookOpen01Icon} />
				<span className="font-medium">{title}</span>
				<span className="text-muted-foreground/70 text-xs tabular-nums">
					{citations.length}
				</span>
				<motion.span
					animate={{ rotate: currentOpen ? 180 : 0 }}
					aria-hidden="true"
					className="text-muted-foreground"
					transition={reduce ? { duration: 0 } : SPRING_SWAP}
				>
					<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
				</motion.span>
			</button>

			<AgentDisclosure id={contentId} open={currentOpen}>
				<CitationList
					citations={citations}
					className="mt-1"
					idPrefix={resolvedPrefix}
				/>
			</AgentDisclosure>
		</div>
	);
}
