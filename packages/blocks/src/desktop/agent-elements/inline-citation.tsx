import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { cn } from "@ryu/ui/lib/utils";
import type React from "react";

/**
 * A source cited by an assistant turn, mirroring the AI SDK "InlineCitation"
 * data model. Produced from the turn's web tool parts (WebFetch `input.url`,
 * WebSearch results) — see `utils/citations.ts`.
 */
export interface Citation {
	description?: string;
	number: number;
	quote?: string;
	title: string;
	url: string;
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

export function InlineCitation({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span className={cn("inline items-center gap-0.5", className)} {...props} />
	);
}

export function InlineCitationCard(
	props: React.ComponentProps<typeof HoverCard>
) {
	return <HoverCard closeDelay={100} openDelay={120} {...props} />;
}

export interface InlineCitationCardTriggerProps {
	className?: string;
	label?: string;
	sources: string[];
}

export function InlineCitationCardTrigger({
	sources,
	label,
	className,
}: InlineCitationCardTriggerProps) {
	const primary = sources[0] ? hostnameOf(sources[0]) : "source";
	const extra = sources.length > 1 ? ` +${sources.length - 1}` : "";
	return (
		<HoverCardTrigger
			className={cn(
				"inline-flex cursor-default items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 align-middle font-medium text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground",
				className
			)}
		>
			{label ? <span className="text-primary">{label}</span> : null}
			<span className="max-w-[140px] truncate">{primary}</span>
			{extra ? <span className="text-muted-foreground/70">{extra}</span> : null}
		</HoverCardTrigger>
	);
}

export function InlineCitationCardBody({
	className,
	...props
}: React.ComponentProps<typeof HoverCardContent>) {
	return (
		<HoverCardContent
			className={cn("w-80 max-w-[min(90vw,20rem)] p-0 text-sm", className)}
			{...props}
		/>
	);
}

export function InlineCitationSource({
	title,
	url,
	description,
	className,
}: {
	className?: string;
	description?: string;
	title: string;
	url: string;
}) {
	return (
		<div className={cn("flex flex-col gap-1 p-3", className)}>
			<a
				className="line-clamp-2 font-medium text-foreground text-sm underline-offset-2 hover:underline"
				href={url}
				rel="noopener noreferrer"
				target="_blank"
			>
				{title}
			</a>
			<span className="truncate text-muted-foreground text-xs">
				{hostnameOf(url)}
			</span>
			{description ? (
				<p className="line-clamp-3 text-muted-foreground text-xs leading-relaxed">
					{description}
				</p>
			) : null}
		</div>
	);
}

export function InlineCitationQuote({
	children,
	className,
	...props
}: React.ComponentProps<"blockquote">) {
	return (
		<blockquote
			className={cn(
				"border-border border-t px-3 py-2 text-muted-foreground text-xs italic",
				className
			)}
			{...props}
		>
			{children}
		</blockquote>
	);
}

/**
 * A single citation rendered as a hover pill. `label` (e.g. "1") shows the
 * citation number; hovering reveals the source title, host, and any snippet.
 */
export function CitationPill({ citation }: { citation: Citation }) {
	return (
		<InlineCitation>
			<InlineCitationCard>
				<InlineCitationCardTrigger
					label={String(citation.number)}
					sources={[citation.url]}
				/>
				<InlineCitationCardBody>
					<InlineCitationSource
						description={citation.description}
						title={citation.title}
						url={citation.url}
					/>
					{citation.quote ? (
						<InlineCitationQuote>{citation.quote}</InlineCitationQuote>
					) : null}
				</InlineCitationCardBody>
			</InlineCitationCard>
		</InlineCitation>
	);
}

/**
 * The compact "Sources" strip shown under an assistant turn that consulted the
 * web. Each source is a hover pill. This is the guaranteed-to-work anchor for
 * citations (every source has a real URL); mapping `[n]` markers inline in the
 * reply text is a follow-up once agents emit them reliably.
 */
export function CitationSources({ citations }: { citations: Citation[] }) {
	if (citations.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5 pt-1">
			<span className="text-muted-foreground/70 text-xs">Sources</span>
			{citations.map((citation) => (
				<CitationPill
					citation={citation}
					key={`${citation.number}-${citation.url}`}
				/>
			))}
		</div>
	);
}
