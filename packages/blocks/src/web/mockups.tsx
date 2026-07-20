import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * Shared, design-system-native visual primitives for product pages.
 * Everything here is monochrome, minimal, and borderless-leaning to match
 * the existing landing aesthetic (muted/50 surfaces, hairline borders, mono
 * type for technical chrome). Compose these inside product hero/feature visuals.
 */

/* ------------------------------------------------------------------ */
/* Minimal card (landing sections — no window chrome)                  */
/* ------------------------------------------------------------------ */

export function MinimalCard({
	children,
	className,
	contentClassName,
}: {
	children: ReactNode;
	className?: string;
	contentClassName?: string;
}) {
	return (
		<div className={cn("rounded-xl bg-muted/30", className)}>
			<div className={cn("p-4", contentClassName)}>{children}</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Window chrome (app / browser frames)                                */
/* ------------------------------------------------------------------ */

function TrafficLights() {
	return (
		<div className="flex items-center gap-1.5">
			<span className="size-2.5 rounded-full bg-foreground/15" />
			<span className="size-2.5 rounded-full bg-foreground/15" />
			<span className="size-2.5 rounded-full bg-foreground/15" />
		</div>
	);
}

export function WindowFrame({
	title,
	children,
	className,
	contentClassName,
}: {
	title?: ReactNode;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
}) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-xl border border-border bg-card shadow-md backdrop-blur-sm",
				className
			)}
		>
			<div className="flex items-center gap-3 border-border border-b bg-muted/60 px-3 py-2">
				<TrafficLights />
				{title ? (
					<span className="truncate font-medium text-muted-foreground text-xs">
						{title}
					</span>
				) : null}
			</div>
			<div className={cn("p-4", contentClassName)}>{children}</div>
		</div>
	);
}

export function BrowserFrame({
	url,
	children,
	className,
	contentClassName,
}: {
	url: string;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
}) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-xl border border-border bg-card shadow-md backdrop-blur-sm",
				className
			)}
		>
			<div className="flex items-center gap-3 border-border border-b bg-muted/60 px-3 py-2">
				<TrafficLights />
				<div className="flex flex-1 items-center justify-center">
					<span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md bg-background/60 px-3 py-1 font-mono text-[11px] text-muted-foreground">
						<LockGlyph />
						{url}
					</span>
				</div>
			</div>
			<div className={cn("p-4", contentClassName)}>{children}</div>
		</div>
	);
}

function LockGlyph() {
	return (
		<svg
			aria-hidden="true"
			className="size-3 text-muted-foreground/60"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<rect height="11" rx="2" strokeWidth="2" width="18" x="3" y="11" />
			<path d="M7 11V7a5 5 0 0110 0v4" strokeWidth="2" />
		</svg>
	);
}

/* ------------------------------------------------------------------ */
/* Sidebar app shell mockup                                            */
/* ------------------------------------------------------------------ */

export function AppShell({
	children,
	className,
}: {
	nav?: string[];
	active?: string;
	children: ReactNode;
	className?: string;
}) {
	return <MinimalCard className={className}>{children}</MinimalCard>;
}

/* ------------------------------------------------------------------ */
/* Terminal                                                            */
/* ------------------------------------------------------------------ */

interface TermLine {
	muted?: boolean;
	prompt?: boolean;
	text: string;
}

export function Terminal({
	lines,
	className,
	title = "zsh - ryu",
	children,
}: {
	lines: TermLine[];
	className?: string;
	title?: string;
	children?: ReactNode;
}) {
	return (
		<MinimalCard
			className={className}
			contentClassName="bg-foreground/[0.03] font-mono text-[12.5px] leading-relaxed"
		>
			<div className="space-y-1">
				{lines.map((line, i) => (
					<div
						className={cn(
							"flex gap-2",
							line.muted ? "text-muted-foreground/70" : "text-foreground/80"
						)}
						// biome-ignore lint/suspicious/noArrayIndexKey: static script
						key={i}
					>
						{line.prompt ? (
							<span className="select-none text-foreground/40">$</span>
						) : null}
						<span className="whitespace-pre-wrap">{line.text}</span>
					</div>
				))}
				{children}
				<span className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-foreground/60" />
			</div>
		</MinimalCard>
	);
}

/* ------------------------------------------------------------------ */
/* Code pane                                                           */
/* ------------------------------------------------------------------ */

export function CodePane({
	code,
	filename,
	className,
}: {
	code: string;
	filename?: string;
	className?: string;
}) {
	const lines = code.split("\n");
	return (
		<MinimalCard
			className={className}
			contentClassName="overflow-x-auto bg-foreground/[0.03] font-mono text-[12.5px] leading-relaxed"
		>
			<pre className="text-foreground/80">
				<code>
					{lines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static code
						<div className="flex gap-4" key={i}>
							<span className="w-4 shrink-0 select-none text-right text-foreground/25">
								{i + 1}
							</span>
							<span className="whitespace-pre">{line || " "}</span>
						</div>
					))}
				</code>
			</pre>
		</MinimalCard>
	);
}

/* ------------------------------------------------------------------ */
/* Small primitives                                                    */
/* ------------------------------------------------------------------ */

export function Pill({
	children,
	active,
	className,
}: {
	children: ReactNode;
	active?: boolean;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
				active
					? "border-transparent bg-foreground font-medium text-background"
					: "border-border bg-muted/50 text-foreground/70",
				className
			)}
		>
			{children}
		</span>
	);
}

export function Node({
	children,
	emphasis,
	className,
}: {
	children: ReactNode;
	emphasis?: boolean;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"rounded-md border px-2.5 py-1.5 text-center text-xs",
				emphasis
					? "border-foreground/40 bg-foreground/5 font-medium text-foreground"
					: "border-border bg-muted/50 text-foreground/70",
				className
			)}
		>
			{children}
		</div>
	);
}

export function Connector({
	vertical,
	className,
}: {
	vertical?: boolean;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"bg-border",
				vertical ? "h-6 w-px" : "h-px flex-1",
				className
			)}
		/>
	);
}

/** A horizontal wire with animated packets flowing along it. */
export function Wire({
	delays = [0, 0.4, 0.8],
	className,
}: {
	delays?: number[];
	className?: string;
}) {
	return (
		<div className={cn("relative flex items-center", className)}>
			<div className="h-px w-full bg-border" />
			{delays.map((delay, i) => (
				<div
					className="absolute left-0 size-1.5 animate-flow-right rounded-full bg-foreground/60"
					// biome-ignore lint/suspicious/noArrayIndexKey: static dots
					key={i}
					style={{ animationDelay: `${delay}s` }}
				/>
			))}
		</div>
	);
}
