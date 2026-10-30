import { cn } from "@ryu/ui/lib/utils";
import {
	ChevronRight,
	FileText,
	Layers,
	Play,
	Plus,
	Sparkles,
} from "lucide-react";
import {
	MiniButton,
	MiniLines,
	MiniPill,
	MockupSidebar,
	MockupWindow,
} from "./app-showcase-primitives.tsx";

/* -------------------------------------------------------------------------- */
/* App-specific mockups                                                       */
/* -------------------------------------------------------------------------- */

export function SitesMockup({ compact = false }: { compact?: boolean }) {
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

export function DashboardsMockup() {
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

export function VideoStudioMockup() {
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

export function SlidesMockup() {
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
