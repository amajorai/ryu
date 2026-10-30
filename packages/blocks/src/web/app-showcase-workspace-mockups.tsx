import { cn } from "@ryu/ui/lib/utils";
import {
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
import type { ReactNode } from "react";
import {
	MiniButton,
	MiniLines,
	MiniPill,
	MockupSidebar,
	MockupWindow,
} from "./app-showcase-primitives.tsx";

export function SpacesMockup() {
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

export function CalendarMockup() {
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

export function CanvasMockup() {
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
