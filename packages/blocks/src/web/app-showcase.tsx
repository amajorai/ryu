import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	ArrowLeft,
	ArrowUpRight,
	Check,
	ChevronRight,
	Circle,
	FileText,
	Folder,
	Image as ImageIcon,
	Layers,
	Play,
	Plus,
	Search,
	Sparkles,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
	type AppShowcase,
	type AppShowcaseFeature,
	type AppShowcaseVisualKey,
	appShowcases,
} from "./data/app-showcase.tsx";

/* -------------------------------------------------------------------------- */
/* Shared skeleton primitives                                                  */
/* -------------------------------------------------------------------------- */

function TrafficLights() {
	return (
		<div aria-hidden="true" className="flex items-center gap-1.5">
			<span className="size-2 rounded-full bg-foreground/15" />
			<span className="size-2 rounded-full bg-foreground/15" />
			<span className="size-2 rounded-full bg-foreground/15" />
		</div>
	);
}

function MockupWindow({
	children,
	className,
	label,
}: {
	children: ReactNode;
	className?: string;
	label: string;
}) {
	return (
		<div
			className={cn(
				"w-full overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-sm",
				className
			)}
			data-app-mockup
		>
			<div className="flex h-8 items-center gap-2 border-border border-b bg-muted/50 px-3">
				<TrafficLights />
				<span className="type-micro min-w-0 truncate font-mono text-muted-foreground">
					{label}
				</span>
				<span className="type-micro ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-muted-foreground">
					<span className="size-1.5 rounded-full bg-success" />
					ready
				</span>
			</div>
			{children}
		</div>
	);
}

function MockupSidebar({
	active,
	items,
}: {
	active: string;
	items: readonly string[];
}) {
	return (
		<aside className="hidden border-border border-r bg-muted/20 p-2 sm:block">
			<div className="mb-5 flex items-center gap-1.5 px-1.5">
				<span className="type-tiny flex size-4 items-center justify-center rounded bg-foreground font-semibold text-background">
					R
				</span>
				<span className="type-compact font-heading font-medium">Ryu</span>
			</div>
			<div className="space-y-0.5">
				{items.map((item) => (
					<div
						className={cn(
							"type-micro flex items-center gap-1.5 rounded px-1.5 py-1.5",
							item === active
								? "bg-foreground/10 font-medium text-foreground"
								: "text-muted-foreground"
						)}
						key={item}
					>
						<span
							className={cn(
								"size-1.5 rounded-full",
								item === active ? "bg-primary" : "bg-foreground/15"
							)}
						/>
						{item}
					</div>
				))}
			</div>
		</aside>
	);
}

function MiniButton({ children }: { children: ReactNode }) {
	return (
		<span className="type-micro inline-flex items-center rounded border border-border bg-background px-2 py-1 font-medium text-foreground">
			{children}
		</span>
	);
}

function MiniPill({
	children,
	active = false,
}: {
	children: ReactNode;
	active?: boolean;
}) {
	return (
		<span
			className={cn(
				"type-micro inline-flex items-center rounded-full border px-2 py-0.5 font-mono",
				active
					? "border-primary/30 bg-primary/10 text-foreground"
					: "border-border bg-muted/40 text-muted-foreground"
			)}
		>
			{children}
		</span>
	);
}

function MiniLines({
	count = 3,
	widths = ["w-full", "w-4/5", "w-3/5"],
}: {
	count?: number;
	widths?: string[];
}) {
	return (
		<div className="space-y-1.5">
			{Array.from({ length: count }, (_, index) => (
				<span
					className={cn(
						"block h-1 rounded-full bg-foreground/10",
						widths[index % widths.length]
					)}
					key={`line-${index}`}
				/>
			))}
		</div>
	);
}

/* -------------------------------------------------------------------------- */
/* App-specific mockups                                                       */
/* -------------------------------------------------------------------------- */

function SitesMockup({ compact = false }: { compact?: boolean }) {
	return (
		<MockupWindow label="Sites / northstar.studio">
			<div className="grid min-h-[18rem] grid-cols-1 bg-background sm:grid-cols-[6.5rem_1fr]">
				<MockupSidebar
					active="Projects"
					items={["Projects", "Pages", "Domains", "Settings"]}
				/>
				<div className="min-w-0 p-3 sm:p-4">
					<div className="flex items-center justify-between gap-2">
						<div className="min-w-0">
							<p className="type-tiny truncate font-mono text-muted-foreground">
								PROJECT / NORTHSTAR
							</p>
							<p className="mt-1 truncate font-heading font-medium text-xs">
								Launch page
							</p>
						</div>
						<MiniButton>Preview</MiniButton>
					</div>
					<div
						className={cn(
							"mt-3 grid gap-3",
							!compact && "xl:grid-cols-[1fr_7rem]"
						)}
					>
						<div className="overflow-hidden rounded-lg border border-border bg-card">
							<div className="type-tiny flex items-center justify-between border-border border-b px-2.5 py-2 font-mono text-muted-foreground">
								<span>northstar.studio</span>
								<MiniPill active>Draft</MiniPill>
							</div>
							<div className="p-3 sm:p-4">
								<div className="mb-5 flex items-center justify-between">
									<span className="type-micro font-heading font-semibold tracking-(--tracking-section)">
										NORTHSTAR
									</span>
									<span className="size-2 rounded-full bg-primary/70" />
								</div>
								<p className="max-w-[10rem] font-heading font-medium text-base leading-tight sm:text-xl">
									Tools for a sharper launch.
								</p>
								<p className="type-micro mt-2 max-w-[13rem] text-muted-foreground leading-relaxed">
									A small studio for teams making the next useful thing.
								</p>
								<div className="mt-5 flex items-center gap-2">
									<span className="type-tiny rounded bg-foreground px-2 py-1 text-background">
										Start here
									</span>
									<span className="type-tiny text-muted-foreground">
										Read the story →
									</span>
								</div>
							</div>
						</div>
						<div
							className={cn(
								"space-y-2",
								compact ? "hidden" : "hidden xl:block"
							)}
						>
							<div className="rounded-lg border border-border bg-muted/20 p-2.5">
								<div className="mb-2 flex items-center justify-between">
									<span className="type-micro font-medium">Pages</span>
									<Plus className="size-3 text-muted-foreground" />
								</div>
								<div className="type-tiny space-y-1.5 text-muted-foreground">
									<div className="flex items-center gap-1.5 text-foreground">
										<FileText className="size-2.5" />
										Home
									</div>
									<div className="flex items-center gap-1.5">
										<FileText className="size-2.5" />
										About
									</div>
									<div className="flex items-center gap-1.5">
										<FileText className="size-2.5" />
										Contact
									</div>
								</div>
							</div>
							<div className="rounded-lg border border-primary/20 bg-primary/5 p-2.5">
								<p className="type-micro font-medium">Ready to publish</p>
								<p className="type-tiny mt-1 text-muted-foreground">
									Version 12 · private
								</p>
								<span className="type-tiny mt-2 block rounded bg-primary px-2 py-1 text-center text-primary-foreground">
									Publish
								</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</MockupWindow>
	);
}

function DashboardsMockup() {
	const metrics = [
		["Open runs", "12", "↑ 18%"],
		["Needs review", "04", "today"],
		["Healthy sources", "96%", "live"],
		["Credits used", "38%", "this week"],
	] as const;
	return (
		<MockupWindow label="Dashboards / home">
			<div className="grid min-h-[18rem] grid-cols-1 bg-background sm:grid-cols-[6.5rem_1fr]">
				<MockupSidebar
					active="Home"
					items={["Home", "Boards", "Widgets", "Monitors"]}
				/>
				<div className="min-w-0 p-3 sm:p-4">
					<div className="flex items-center justify-between gap-2">
						<div>
							<p className="type-tiny font-mono text-muted-foreground">
								BOARD / OVERVIEW
							</p>
							<p className="mt-1 font-heading font-medium text-xs">
								Good morning, operator
							</p>
						</div>
						<div className="flex items-center gap-1.5">
							<MiniPill active>Live</MiniPill>
							<Plus className="size-3 text-muted-foreground" />
						</div>
					</div>
					<div className="mt-3 grid grid-cols-2 gap-2">
						{metrics.map(([label, value, note]) => (
							<div
								className="rounded-lg border border-border bg-card p-2.5"
								key={label}
							>
								<p className="type-tiny text-muted-foreground">{label}</p>
								<div className="mt-2 flex items-end justify-between gap-1">
									<span className="font-mono text-base tabular-nums sm:text-lg">
										{value}
									</span>
									<span className="type-tiny font-mono text-status-success">
										{note}
									</span>
								</div>
							</div>
						))}
					</div>
					<div className="mt-2 grid gap-2 sm:grid-cols-[1.1fr_0.9fr]">
						<div className="rounded-lg border border-border bg-card p-2.5">
							<div className="flex items-center justify-between">
								<span className="type-micro font-medium">Run volume</span>
								<span className="type-tiny font-mono text-muted-foreground">
									7 days
								</span>
							</div>
							<svg
								aria-hidden="true"
								className="mt-2 h-12 w-full overflow-visible text-primary"
								preserveAspectRatio="none"
								viewBox="0 0 240 48"
							>
								<path
									d="M0 38 C20 35 20 26 38 30 S60 40 77 26 S100 20 117 24 S145 15 160 19 S185 30 202 13 S226 12 240 5"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
								/>
								<path
									d="M0 48 L0 38 C20 35 20 26 38 30 S60 40 77 26 S100 20 117 24 S145 15 160 19 S185 30 202 13 S226 12 240 5 L240 48Z"
									fill="currentColor"
									opacity="0.08"
								/>
							</svg>
						</div>
						<div className="rounded-lg border border-border bg-card p-2.5">
							<div className="flex items-center justify-between">
								<span className="type-micro font-medium">Recent activity</span>
								<ChevronRight className="size-3 text-muted-foreground" />
							</div>
							<div className="mt-2 space-y-2">
								{[
									"Monitor recovered",
									"Quest completed",
									"Meeting starts soon",
								].map((item, index) => (
									<div className="flex items-center gap-2" key={item}>
										<span
											className={cn(
												"size-1.5 rounded-full",
												index === 1 ? "bg-primary" : "bg-success"
											)}
										/>
										<span className="type-tiny truncate text-muted-foreground">
											{item}
										</span>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		</MockupWindow>
	);
}

function VideoStudioMockup() {
	return (
		<MockupWindow label="Video Studio / launch-cut">
			<div className="grid min-h-[18rem] grid-rows-[1fr_6.5rem] bg-background">
				<div className="grid min-h-0 grid-cols-[1fr_7.5rem]">
					<div className="flex min-w-0 items-center justify-center bg-foreground/[0.04] p-3 sm:p-5">
						<div className="relative aspect-video w-full max-w-[19rem] overflow-hidden rounded border border-border bg-muted/50">
							<div className="type-miniature absolute inset-x-0 top-0 flex items-center justify-between px-2 py-1.5 font-mono text-muted-foreground">
								<span>00:18:42</span>
								<span>16:9</span>
							</div>
							<div className="absolute inset-5 flex flex-col justify-end sm:inset-7">
								<span className="font-heading font-medium text-base leading-none sm:text-xl">
									Make the next cut count.
								</span>
								<span className="mt-2 h-1 w-16 rounded-full bg-primary" />
							</div>
							<div className="absolute top-1/2 left-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background/80">
								<Play className="ml-0.5 size-3 fill-foreground" />
							</div>
						</div>
					</div>
					<div className="border-border border-l bg-muted/15 p-2.5">
						<div className="mb-3 flex items-center justify-between">
							<span className="type-micro font-medium">Inspector</span>
							<Layers className="size-3 text-muted-foreground" />
						</div>
						<div className="space-y-3">
							<div>
								<p className="type-tiny mb-1.5 text-muted-foreground">
									Selected layer
								</p>
								<div className="type-tiny rounded border border-primary/30 bg-primary/5 px-2 py-1.5">
									Title / Intro
								</div>
							</div>
							<div>
								<p className="type-tiny mb-1.5 text-muted-foreground">Timing</p>
								<MiniLines count={2} widths={["w-full", "w-2/3"]} />
							</div>
							<div>
								<p className="type-tiny mb-1.5 text-muted-foreground">
									Captions
								</p>
								<MiniPill active>synced</MiniPill>
							</div>
						</div>
					</div>
				</div>
				<div className="border-border border-t bg-muted/20 p-2.5">
					<div className="type-miniature mb-1.5 flex items-center justify-between font-mono text-muted-foreground">
						<span>00:00</span>
						<span>00:10</span>
						<span>00:20</span>
						<span>00:30</span>
						<span>00:40</span>
					</div>
					<div className="space-y-1.5">
						<div className="flex items-center gap-2">
							<span className="type-miniature w-8 shrink-0 font-mono text-muted-foreground">
								VIDEO
							</span>
							<div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-foreground/[0.06]">
								<span className="absolute inset-y-0 left-[4%] w-[31%] rounded-sm bg-primary/40" />
								<span className="absolute inset-y-0 left-[39%] w-[19%] rounded-sm bg-foreground/20" />
								<span className="absolute inset-y-0 left-[61%] w-[28%] rounded-sm bg-primary/25" />
							</div>
						</div>
						<div className="flex items-center gap-2">
							<span className="type-miniature w-8 shrink-0 font-mono text-muted-foreground">
								VOICE
							</span>
							<div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-foreground/[0.06]">
								<span className="absolute inset-y-0 left-[7%] w-[58%] rounded-sm bg-success/35" />
							</div>
						</div>
						<div className="flex items-center gap-2">
							<span className="type-miniature w-8 shrink-0 font-mono text-muted-foreground">
								TEXT
							</span>
							<div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-foreground/[0.06]">
								<span className="absolute inset-y-0 left-[39%] w-[20%] rounded-sm bg-foreground/20" />
								<span className="absolute inset-y-0 left-[70%] w-[19%] rounded-sm bg-primary/25" />
							</div>
						</div>
					</div>
				</div>
			</div>
		</MockupWindow>
	);
}

function SlidesMockup() {
	return (
		<MockupWindow label="Slides / launch-story">
			<div className="grid min-h-[18rem] grid-cols-[5.5rem_1fr] bg-background">
				<div className="border-border border-r bg-muted/20 p-2">
					<div className="mb-2 flex items-center justify-between">
						<span className="type-tiny font-medium">Frames</span>
						<Plus className="size-3 text-muted-foreground" />
					</div>
					<div className="space-y-2">
						{["01", "02", "03", "04"].map((number, index) => (
							<div
								className={cn(
									"rounded border p-1",
									index === 0
										? "border-primary bg-primary/5"
										: "border-border bg-card"
								)}
								key={number}
							>
								<div className="flex aspect-[4/3] items-end rounded-sm bg-muted/60 p-1">
									<span className="type-miniature font-mono text-muted-foreground">
										{number}
									</span>
									<span className="ml-auto h-1 w-4 rounded-full bg-foreground/20" />
								</div>
							</div>
						))}
					</div>
				</div>
				<div className="min-w-0 p-3 sm:p-4">
					<div className="flex items-center justify-between gap-2">
						<div>
							<p className="type-tiny font-mono text-muted-foreground">
								PROJECT / LAUNCH-STORY
							</p>
							<p className="mt-1 font-heading font-medium text-xs">Frame 01</p>
						</div>
						<div className="flex gap-1.5">
							<MiniButton>Preview</MiniButton>
							<MiniButton>Export</MiniButton>
						</div>
					</div>
					<div className="mt-3 flex min-h-[11rem] items-center justify-center rounded-lg border border-border bg-muted/20 p-3 sm:p-5">
						<div className="relative aspect-[4/3] w-full max-w-[19rem] overflow-hidden rounded bg-foreground p-4 text-background shadow-sm sm:p-5">
							<div className="flex items-center justify-between">
								<span className="type-tiny font-heading font-semibold tracking-(--tracking-section)">
									NORTHSTAR
								</span>
								<span className="type-miniature font-mono text-background/55">
									01 / 04
								</span>
							</div>
							<div className="absolute right-4 bottom-4 left-4 sm:right-5 sm:bottom-5 sm:left-5">
								<p className="max-w-[11rem] font-heading font-medium text-base leading-none sm:text-xl">
									A clearer way to start.
								</p>
								<div className="mt-3 flex items-center gap-1.5">
									<span className="size-1.5 rounded-full bg-primary" />
									<span className="h-px w-12 bg-background/30" />
								</div>
							</div>
						</div>
					</div>
					<div className="mt-3 flex items-center gap-2">
						<Sparkles className="size-3 text-primary" />
						<span className="type-tiny text-muted-foreground">
							Media tools ready · 4 frames · saved locally
						</span>
					</div>
				</div>
			</div>
		</MockupWindow>
	);
}

function SpacesMockup() {
	return (
		<MockupWindow label="Spaces / product-notes">
			<div className="grid min-h-[18rem] grid-cols-1 bg-background sm:grid-cols-[6.5rem_1fr]">
				<MockupSidebar
					active="Spaces"
					items={["Library", "Spaces", "Recent", "Shared"]}
				/>
				<div className="min-w-0 p-3 sm:p-4">
					<div className="flex items-center justify-between gap-2">
						<div>
							<p className="type-tiny font-mono text-muted-foreground">
								SPACE / PRODUCT-NOTES
							</p>
							<p className="mt-1 font-heading font-medium text-xs">
								Product notes
							</p>
						</div>
						<MiniButton>
							<Plus className="mr-1 size-2.5" />
							New doc
						</MiniButton>
					</div>
					<div className="relative mt-3">
						<Search className="absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground" />
						<div className="type-tiny rounded border border-border bg-muted/20 py-1.5 pr-2 pl-7 font-mono text-muted-foreground">
							Search this Space…
						</div>
					</div>
					<div className="mt-3 grid gap-3 sm:grid-cols-[0.85fr_1.15fr]">
						<div className="space-y-1.5">
							{[
								["launch-brief.md", "updated 2m"],
								["research-notes.md", "updated 1h"],
								["voice-and-tone.md", "updated yesterday"],
							].map(([name, note], index) => (
								<div
									className={cn(
										"flex items-center gap-2 rounded border px-2.5 py-2",
										index === 0
											? "border-primary/30 bg-primary/5"
											: "border-border bg-card"
									)}
									key={name}
								>
									<FileText className="size-3 shrink-0 text-muted-foreground" />
									<div className="min-w-0">
										<p className="type-tiny truncate font-mono">{name}</p>
										<p className="type-miniature mt-0.5 text-muted-foreground">
											{note}
										</p>
									</div>
								</div>
							))}
							<div className="type-tiny flex items-center gap-2 rounded border border-border border-dashed px-2.5 py-2 text-muted-foreground">
								<Folder className="size-3" />3 folders
							</div>
						</div>
						<div className="rounded-lg border border-border bg-card p-3">
							<div className="flex items-center justify-between">
								<span className="type-compact font-heading font-medium">
									launch-brief.md
								</span>
								<MiniPill active>indexed</MiniPill>
							</div>
							<div className="mt-3">
								<MiniLines
									count={3}
									widths={["w-full", "w-11/12", "w-4/5", "w-2/3"]}
								/>
							</div>
							<div className="mt-4 flex flex-wrap gap-1.5">
								<MiniPill>strategy</MiniPill>
								<MiniPill>launch</MiniPill>
								<MiniPill>source</MiniPill>
							</div>
							<div className="type-tiny mt-4 flex items-center gap-1.5 text-muted-foreground">
								<span className="size-1.5 rounded-full bg-primary" />
								Ready for agent recall
							</div>
						</div>
					</div>
				</div>
			</div>
		</MockupWindow>
	);
}

function CalendarMockup() {
	const days = Array.from({ length: 35 }, (_, index) => index - 1);
	const events = new Map<number, { label: string; className: string }>([
		[3, { label: "Research", className: "bg-primary/15 text-foreground" }],
		[9, { label: "Digest", className: "bg-success/15 text-foreground" }],
		[16, { label: "Review", className: "bg-foreground/10 text-foreground" }],
		[23, { label: "Publish", className: "bg-primary/15 text-foreground" }],
	]);
	return (
		<MockupWindow label="Calendar / scheduled runs">
			<div className="grid min-h-[18rem] grid-cols-1 bg-background sm:grid-cols-[6.5rem_1fr]">
				<MockupSidebar
					active="Calendar"
					items={["Calendar", "Automations", "Agents", "History"]}
				/>
				<div className="min-w-0 p-3 sm:p-4">
					<div className="flex items-center justify-between gap-2">
						<div>
							<p className="type-tiny font-mono text-muted-foreground">
								SCHEDULE / SEPTEMBER
							</p>
							<p className="mt-1 font-heading font-medium text-xs">
								September 2026
							</p>
						</div>
						<div className="flex gap-1.5">
							<MiniPill active>Month</MiniPill>
							<MiniPill>Agenda</MiniPill>
							<MiniButton>
								<Plus className="mr-1 size-2.5" />
								New
							</MiniButton>
						</div>
					</div>
					<div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
						<div className="grid grid-cols-7 border-border border-b bg-muted/20">
							{["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
								<span
									className="type-tiny py-1.5 text-center font-mono text-muted-foreground"
									key={`${day}-${index}`}
								>
									{day}
								</span>
							))}
						</div>
						<div className="grid grid-cols-7">
							{days.map((day, index) => {
								const event = events.get(day);
								return (
									<div
										className="min-h-[2.35rem] border-border border-r border-b p-1.5 last:border-r-0"
										key={`day-${index}`}
									>
										<span
											className={cn(
												"type-tiny font-mono",
												day === 16
													? "flex size-4 items-center justify-center rounded-full bg-foreground text-background"
													: day < 1
														? "text-muted-foreground/35"
														: "text-muted-foreground"
											)}
										>
											{day > 0 ? day : 30 + day}
										</span>
										{event ? (
											<span
												className={cn(
													"type-miniature mt-1 block truncate rounded px-1 py-0.5 font-medium",
													event.className
												)}
											>
												{event.label}
											</span>
										) : null}
									</div>
								);
							})}
						</div>
					</div>
					<div className="mt-2 flex items-center justify-between rounded border border-border bg-muted/20 px-2.5 py-2">
						<div className="flex items-center gap-2">
							<span className="size-1.5 rounded-full bg-success" />
							<span className="type-tiny">Next run · Research brief</span>
						</div>
						<span className="type-tiny font-mono text-muted-foreground">
							tomorrow · 09:00
						</span>
					</div>
				</div>
			</div>
		</MockupWindow>
	);
}

function CanvasNode({
	children,
	className,
	icon,
	label,
}: {
	children: ReactNode;
	className?: string;
	icon: ReactNode;
	label: string;
}) {
	return (
		<div
			className={cn(
				"absolute w-[7.5rem] rounded-lg border border-border bg-card p-2 shadow-sm",
				className
			)}
		>
			<div className="flex items-center gap-1.5">
				<span className="flex size-4 items-center justify-center rounded bg-muted text-muted-foreground">
					{icon}
				</span>
				<span className="type-tiny font-medium">{label}</span>
				<Circle className="ml-auto size-2.5 text-success" />
			</div>
			<div className="mt-2">{children}</div>
		</div>
	);
}

function CanvasMockup() {
	return (
		<MockupWindow label="Canvas / launch-system">
			<div className="grid min-h-[18rem] grid-cols-[1fr_7.5rem] bg-background">
				<div className="relative min-w-0 overflow-hidden bg-muted/10 p-3">
					<svg
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 h-full w-full text-foreground/20"
						preserveAspectRatio="none"
						viewBox="0 0 340 240"
					>
						<defs>
							<pattern
								height="12"
								id="canvas-dot-grid"
								patternUnits="userSpaceOnUse"
								width="12"
							>
								<circle cx="1" cy="1" fill="currentColor" r="0.7" />
							</pattern>
						</defs>
						<rect fill="url(#canvas-dot-grid)" height="100%" width="100%" />
					</svg>
					<svg
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 h-full w-full text-foreground/25"
						preserveAspectRatio="none"
						viewBox="0 0 340 240"
					>
						<path
							d="M90 70 C125 70 128 54 160 54"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
						<path
							d="M90 70 C125 70 128 145 160 145"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
						<path
							d="M240 54 C274 54 276 105 302 105"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
						<path
							d="M240 145 C274 145 276 105 302 105"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
					</svg>
					<div className="absolute inset-x-3 top-2 flex items-center justify-between">
						<span className="type-tiny font-mono text-muted-foreground">
							BOARD / LAUNCH-SYSTEM
						</span>
						<div className="flex gap-1.5">
							<MiniPill active>Run</MiniPill>
							<Plus className="size-3 text-muted-foreground" />
						</div>
					</div>
					<CanvasNode
						className="top-[3.35rem] left-3"
						icon={<ImageIcon className="size-2.5" />}
						label="Source image"
					>
						<div className="h-6 rounded bg-muted/60" />
					</CanvasNode>
					<CanvasNode
						className="top-[3.35rem] left-[46%]"
						icon={<Sparkles className="size-2.5" />}
						label="Compose"
					>
						<MiniLines count={2} widths={["w-full", "w-2/3"]} />
					</CanvasNode>
					<CanvasNode
						className="top-[9.1rem] left-[46%]"
						icon={<Play className="size-2.5" />}
						label="Motion"
					>
						<div className="h-3 rounded bg-primary/15" />
					</CanvasNode>
					<CanvasNode
						className="top-[6.45rem] right-2"
						icon={<Layers className="size-2.5" />}
						label="Output"
					>
						<div className="h-7 rounded bg-foreground/[0.06]" />
					</CanvasNode>
				</div>
				<div className="border-border border-l bg-muted/20 p-2.5">
					<div className="mb-3 flex items-center justify-between">
						<span className="type-micro font-medium">Node details</span>
						<ChevronRight className="size-3 text-muted-foreground" />
					</div>
					<p className="type-tiny text-muted-foreground">Selected</p>
					<p className="type-micro mt-1 font-mono">compose-02</p>
					<div className="mt-4 space-y-2">
						<MiniLines
							count={4}
							widths={["w-full", "w-4/5", "w-full", "w-3/5"]}
						/>
						<div className="flex flex-wrap gap-1">
							<MiniPill>image</MiniPill>
							<MiniPill>agent</MiniPill>
						</div>
					</div>
				</div>
			</div>
		</MockupWindow>
	);
}

const VISUALS = {
	calendar: CalendarMockup,
	canvas: CanvasMockup,
	dashboards: DashboardsMockup,
	sites: () => <SitesMockup />,
	slides: SlidesMockup,
	spaces: SpacesMockup,
	"video-studio": VideoStudioMockup,
} satisfies Record<AppShowcaseVisualKey, () => ReactNode>;

export function AppShowcaseVisual({
	app,
	compact = false,
}: {
	app: AppShowcase;
	compact?: boolean;
}) {
	const Visual = VISUALS[app.visual];
	return app.visual === "sites" ? (
		<SitesMockup compact={compact} />
	) : (
		<Visual />
	);
}

/* -------------------------------------------------------------------------- */
/* Public gallery and detail compositions                                     */
/* -------------------------------------------------------------------------- */

export function AppShowcaseCard({ app }: { app: AppShowcase }) {
	return (
		<Link
			className="group block min-w-0 rounded-2xl outline-offset-8 focus-visible:outline-2 focus-visible:outline-ring"
			data-app-showcase-card={app.slug}
			data-testid={`app-showcase-card-${app.slug}`}
			href={
				/* SAFETY: AppShowcase.slug is the closed AppShowcaseVisualKey union from the canonical authored catalog; /products/apps/[slug]/page.tsx owns these constructed nonliteral app routes. */ `/products/apps/${app.slug}` as Route
			}
		>
			<div
				aria-hidden="true"
				className="flex min-h-[19rem] items-center overflow-hidden rounded-2xl border border-border border-dashed bg-muted/20 p-2 transition-colors duration-200 group-hover:border-foreground/35 group-hover:bg-muted/35 sm:p-3"
				data-product-visual
			>
				<AppShowcaseVisual app={app} compact />
			</div>
			<div className="mt-5 flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="type-compact mb-2 flex flex-wrap items-center gap-2 font-mono text-muted-foreground">
						<span>{app.category}</span>
						<span aria-hidden="true">·</span>
						<span>{app.surfaceLabel}</span>
					</div>
					<h2 className="font-heading font-medium text-2xl tracking-tight group-hover:underline group-hover:underline-offset-4">
						{app.name}
					</h2>
					<p className="mt-2 max-w-sm text-muted-foreground text-sm leading-relaxed">
						{app.shortDescription}
					</p>
				</div>
				<ArrowUpRight
					aria-hidden="true"
					className="mt-1 size-5 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
				/>
			</div>
		</Link>
	);
}

export function AppShowcaseGallery({
	apps = appShowcases,
}: {
	/**
	 * The showcases to list. Defaults to every showcase; the web page passes
	 * only those whose app rollout is open.
	 */
	apps?: readonly AppShowcase[];
} = {}) {
	return (
		<div
			className="bg-background text-foreground"
			data-testid="app-showcase-page"
		>
			<section className="container mx-auto px-4 pt-24 pb-16 md:pt-32 md:pb-20">
				<div className="max-w-3xl">
					<p className="type-caption font-mono text-muted-foreground tracking-(--tracking-table-label)">
						RYU APPS / OFFICIAL SURFACES
					</p>
					<h1 className="mt-5 max-w-3xl font-heading font-medium text-4xl tracking-tighter md:text-6xl">
						Workspaces for the work agents make.
					</h1>
					<p className="mt-6 max-w-2xl text-lg text-muted-foreground leading-relaxed">
						Each Ryu app gives a kind of work a place to land — a site to
						publish, a board to watch, a timeline to finish, or a source of
						context to keep close.
					</p>
					<div className="mt-8 flex flex-wrap items-center gap-3">
						<Link
							className={cn(buttonVariants({ size: "lg", variant: "mono" }))}
							href="/download"
						>
							Get Ryu
						</Link>
						<Link
							className={cn(buttonVariants({ size: "lg", variant: "ghost" }))}
							href="/marketplace/apps"
						>
							Browse the marketplace
						</Link>
					</div>
				</div>
			</section>

			<section className="container mx-auto px-4 pb-24 md:pb-32">
				<div className="mb-12 flex flex-wrap items-end justify-between gap-4">
					<div>
						<p className="type-caption font-mono text-muted-foreground tracking-(--tracking-table-label)">
							BUILT BY RYU
						</p>
						<h2 className="mt-3 font-heading font-medium text-3xl tracking-tight md:text-4xl">
							Choose a surface for the job.
						</h2>
					</div>
					<p className="type-caption font-mono text-muted-foreground">
						{apps.length} featured apps
					</p>
				</div>
				<div
					className="grid grid-cols-1 gap-x-8 gap-y-16 md:grid-cols-2 xl:grid-cols-3"
					data-testid="app-showcase-grid"
				>
					{apps.map((app) => (
						<AppShowcaseCard app={app} key={app.slug} />
					))}
				</div>
			</section>
		</div>
	);
}

function FeatureRow({ feature }: { feature: AppShowcaseFeature }) {
	return (
		<li className="py-5">
			<div className="flex items-start gap-3">
				<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					<Check aria-hidden="true" className="size-3" />
				</span>
				<div>
					<h3 className="font-medium text-base">{feature.title}</h3>
					<p className="mt-1.5 max-w-xl text-muted-foreground text-sm leading-relaxed">
						{feature.description}
					</p>
				</div>
			</div>
		</li>
	);
}

function RelatedAppLink({ app }: { app: AppShowcase }) {
	return (
		<Link
			className="group flex items-center justify-between gap-4 py-3 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
			href={
				/* SAFETY: AppShowcase.slug is the closed AppShowcaseVisualKey union from the canonical authored catalog; /products/apps/[slug]/page.tsx owns these constructed nonliteral app routes. */ `/products/apps/${app.slug}` as Route
			}
		>
			<span>
				<span className="block font-heading font-medium text-lg group-hover:underline group-hover:underline-offset-4">
					{app.name}
				</span>
				<span className="mt-1 block text-muted-foreground text-sm">
					{app.tagline}
				</span>
			</span>
			<ArrowUpRight
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
			/>
		</Link>
	);
}

export function AppShowcaseDetail({
	app,
	docsHref,
	relatedApps,
}: {
	app: AppShowcase;
	docsHref: string;
	relatedApps: readonly AppShowcase[];
}) {
	const Icon = app.icon;
	return (
		<div
			className="bg-background text-foreground"
			data-testid={`app-showcase-detail-${app.slug}`}
		>
			<section className="container mx-auto px-4 pt-20 pb-16 md:pt-28 md:pb-24">
				<Link
					className="inline-flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
					href="/products/apps"
				>
					<ArrowLeft aria-hidden="true" className="size-4" />
					All Ryu Apps
				</Link>
				<div className="mt-10 grid items-center gap-12 lg:grid-cols-[0.78fr_1.22fr] lg:gap-16">
					<div className="min-w-0">
						<div className="type-compact flex flex-wrap items-center gap-2 font-mono text-muted-foreground">
							<span className="flex size-7 items-center justify-center rounded-lg bg-muted text-foreground">
								<Icon
									aria-hidden="true"
									className="size-4"
									strokeWidth={1.75}
								/>
							</span>
							<span>{app.category}</span>
							<span aria-hidden="true">·</span>
							<span>{app.surfaceLabel}</span>
						</div>
						<h1 className="mt-6 font-heading font-medium text-5xl tracking-tighter md:text-7xl">
							{app.name}
						</h1>
						<p className="mt-5 max-w-xl font-heading text-2xl leading-tight tracking-tight md:text-3xl">
							{app.tagline}
						</p>
						<p className="mt-5 max-w-xl text-base text-muted-foreground leading-relaxed">
							{app.shortDescription}
						</p>
						<div className="mt-8 flex flex-wrap items-center gap-3">
							<Link
								className={cn(buttonVariants({ size: "lg", variant: "mono" }))}
								href="/download"
							>
								Get Ryu
							</Link>
							<a
								className={cn(buttonVariants({ size: "lg", variant: "ghost" }))}
								href={docsHref}
								rel="noopener noreferrer"
								target="_blank"
							>
								Read the docs
							</a>
						</div>
						<p className="type-compact mt-5 font-mono text-muted-foreground">
							Official app · {app.manifestId}
						</p>
					</div>
					<div
						aria-hidden="true"
						className="flex min-h-[20rem] items-center overflow-hidden rounded-2xl border border-border border-dashed bg-muted/20 p-2 sm:p-3"
						data-product-visual
					>
						<AppShowcaseVisual app={app} />
					</div>
				</div>
			</section>

			<section className="container mx-auto px-4 pb-20 md:pb-28">
				<div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
					<div>
						<p className="type-caption font-mono text-muted-foreground tracking-(--tracking-table-label)">
							INSIDE {app.name.toUpperCase()}
						</p>
						<h2 className="mt-4 max-w-md font-heading font-medium text-3xl tracking-tight md:text-4xl">
							A focused surface for this part of the work.
						</h2>
					</div>
					<ul>
						{app.features.map((feature) => (
							<FeatureRow feature={feature} key={feature.title} />
						))}
					</ul>
				</div>
			</section>

			<section className="container mx-auto px-4 pb-24 md:pb-32">
				<div className="grid gap-10 md:grid-cols-[0.72fr_1.28fr] md:gap-20">
					<div>
						<p className="type-caption font-mono text-muted-foreground tracking-(--tracking-table-label)">
							KEEP EXPLORING
						</p>
						<h2 className="mt-3 font-heading font-medium text-2xl tracking-tight">
							More places to put Ryu to work.
						</h2>
					</div>
					<div>
						{relatedApps.map((relatedApp) => (
							<RelatedAppLink app={relatedApp} key={relatedApp.slug} />
						))}
					</div>
				</div>
			</section>
		</div>
	);
}
