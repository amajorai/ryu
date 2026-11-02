"use client";

import { cn } from "@ryu/ui/lib/utils";
import { copyMarker as t } from "./copy-marker.ts";
import { LiteralText } from "./literal-text.tsx";
import { MinimalCard, Node, WindowFrame } from "./mockups.tsx";
import { WindowDots } from "./visuals-primitives.tsx";

// Workspace, standalone-service and bot hero visuals. Re-exported from
// ./visuals.tsx, which stays the public import path.

/** The public OS story: app windows are opened from one workspace dock. */
export function OsVisual() {
	const apps = ["Launcher", "Chat", "Spaces", "Skills", "Review"];
	return (
		<WindowFrame title="OS">
			<div aria-hidden="true" className="relative h-36 sm:h-44">
				<span className="absolute start-0 top-2 flex h-24 w-3/5 flex-col overflow-hidden rounded-lg border border-border bg-muted/50 sm:h-28">
					<WindowDots />
				</span>
				<span className="absolute end-0 top-8 flex h-24 w-1/2 flex-col overflow-hidden rounded-lg border border-foreground/30 bg-background sm:top-10 sm:h-28">
					<WindowDots />
					<span className="flex flex-1 flex-col justify-center gap-1.5 px-3 pb-2">
						<span className="ms-auto block h-3 w-2/5 rounded-full rounded-se-sm bg-foreground/80" />
						<span className="block h-3 w-3/5 rounded-full rounded-ss-sm border border-border bg-foreground/5" />
						<span className="ms-auto block h-3 w-1/3 rounded-full rounded-se-sm bg-foreground/80" />
					</span>
				</span>
			</div>
			<ul
				aria-label="Dock"
				className="mx-auto mt-4 flex w-fit max-w-full items-center justify-center gap-1.5 rounded-2xl border border-border px-2 py-1.5"
			>
				{apps.map((app) => (
					<li
						className={cn(
							"rounded-lg px-2.5 py-1 text-xs",
							app === "Chat"
								? "bg-foreground text-background"
								: "text-muted-foreground",
							app === "Review" ? "hidden sm:block" : ""
						)}
						key={app}
					>
						{app}
					</li>
				))}
			</ul>
		</WindowFrame>
	);
}

/** Ryu Connect: one API between your app and hosted MCP servers, Skills, and tools. */
export function ConnectVisual() {
	const kinds = [t("MCP servers"), t("Skills"), t("Tools")];
	return (
		<div className="flex w-full flex-col items-center px-1 py-6">
			<Node className="w-44 py-2.5 text-sm">Your app</Node>
			<span aria-hidden="true" className="h-6 w-px bg-foreground/30" />
			<Node className="w-44 py-2.5 text-sm" emphasis>
				Connect
			</Node>
			<span aria-hidden="true" className="h-5 w-px bg-foreground/30" />
			<div className="relative grid w-full max-w-sm grid-cols-3 gap-3">
				<span
					aria-hidden="true"
					className="absolute inset-x-[16.67%] top-0 h-px bg-foreground/30"
				/>
				{kinds.map((kind) => (
					<div className="flex flex-col items-center" key={kind}>
						<span aria-hidden="true" className="h-5 w-px bg-foreground/30" />
						<Node className="w-full whitespace-nowrap py-2.5 text-sm">
							<LiteralText text={kind} />
						</Node>
					</div>
				))}
			</div>
		</div>
	);
}

/** The isolated, persistent workspace behind a Ryu Box run. */
export function BoxVisual() {
	return (
		<div className="flex w-full items-center justify-center gap-0 px-2 py-8 sm:px-6">
			<BoxWindow />
			<span
				aria-hidden="true"
				className="h-px w-6 shrink-0 bg-foreground/30 sm:w-10"
			/>
			<BoxWindow forked />
		</div>
	);
}

/** One Box workspace drawn as a small window of file lines; the fork carries its only label. */
function BoxWindow({ forked = false }: { forked?: boolean }) {
	return (
		<div
			className={cn(
				"relative flex w-full max-w-44 flex-col overflow-hidden rounded-lg border bg-background",
				forked ? "border-foreground/40" : "border-border"
			)}
		>
			<WindowDots />
			<span aria-hidden="true" className="space-y-2 px-3 pt-2 pb-4">
				<span className="block h-1.5 w-3/4 rounded-full bg-foreground/15" />
				<span className="block h-1.5 w-1/2 rounded-full bg-foreground/10" />
				<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
			</span>
			{forked ? (
				<span className="absolute end-2 top-1 rounded-md border border-border px-1.5 py-0.5 text-muted-foreground text-xs">
					Fork
				</span>
			) : null}
		</div>
	);
}

/** The standalone event inbox behind Ryu Notify: delivery, live updates, and replies. */
export function NotifyVisual() {
	const events = [
		{ label: "Deploy complete", dot: "bg-foreground/40" },
		{ label: "Build 62%", dot: "animate-pulse bg-foreground" },
		{ label: "Restore backup?", dot: "bg-foreground/20" },
	];
	return (
		<MinimalCard>
			<div className="space-y-2">
				{events.map((event) => (
					<div
						className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-3"
						key={event.label}
					>
						<span
							aria-hidden="true"
							className={cn("size-1.5 shrink-0 rounded-full", event.dot)}
						/>
						<span className="truncate text-foreground/80 text-sm">
							{event.label}
						</span>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

/** Standalone Ryu Sites: a saved version passes its deploy scan and goes live. */
export function SitesVisual() {
	const rows = [t("Saved"), t("Secret scan"), t("Live")];
	return (
		<MinimalCard>
			<div className="flex min-h-48 flex-col justify-center space-y-2">
				{rows.map((label, i) => (
					<div
						className={cn(
							"flex items-center gap-2.5 rounded-lg border px-3 py-3",
							i === rows.length - 1 ? "border-foreground/40" : "border-border"
						)}
						key={label}
					>
						<span
							aria-hidden="true"
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								i === rows.length - 1 ? "bg-foreground" : "bg-foreground/40"
							)}
						/>
						<span className="text-foreground/80 text-sm">
							<LiteralText text={label} />
						</span>
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

/** The API-first Agent Inboxes product, distinct from the event inbox. */
export function MailVisual() {
	const flows = [
		{ label: "Received", arrow: "↓" },
		{ label: "Sent", arrow: "↑" },
	];
	return (
		<MinimalCard>
			<div className="space-y-4">
				<div className="flex items-center gap-2.5">
					<Node className="py-2 text-sm" emphasis>
						Agent
					</Node>
					<span className="rounded-full border border-border px-2.5 py-1 text-muted-foreground text-sm">
						research@…
					</span>
				</div>
				<div className="space-y-2">
					{flows.map((flow) => (
						<div
							className="flex items-center gap-3 rounded-lg border border-border px-3 py-3"
							key={flow.label}
						>
							<span
								aria-hidden="true"
								className="text-muted-foreground text-sm"
							>
								{flow.arrow}
							</span>
							<span className="text-foreground/80 text-sm">{flow.label}</span>
							<span
								aria-hidden="true"
								className="ms-auto block h-1.5 w-1/3 rounded-full bg-foreground/10"
							/>
						</div>
					))}
				</div>
			</div>
		</MinimalCard>
	);
}

/**
 * Ryu Messaging: one conversation across channels, with each send's hold and
 * settled charge shown as states, not prices (rates come from AWS).
 */
export function MessagingVisual() {
	const messages = [
		{
			channel: "SMS",
			to: "+65 •••• 4821",
			state: "delivered",
			tone: "success",
		},
		{ channel: "WhatsApp", to: "+44 •••• 1907", state: "held", tone: "info" },
		{ channel: "Voice", to: "+1 •••• 5530", state: "settled", tone: "success" },
	];
	return (
		<WindowFrame title="Ryu Messaging · outbound">
			<div className="space-y-3">
				<div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
					<span className="type-caption font-mono text-foreground/75">
						/api/messaging
					</span>
					<span className="type-compact inline-flex items-center gap-1.5 text-foreground/55">
						<span className="size-1.5 rounded-full bg-success" />
						AWS price, no markup
					</span>
				</div>
				<div className="space-y-2">
					{messages.map((message) => (
						<div
							className="flex items-center gap-2 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2"
							key={message.channel}
						>
							<span
								className={cn(
									"size-1.5 rounded-full",
									message.tone === "success" ? "bg-success" : "bg-info"
								)}
							/>
							<span className="min-w-0 flex-1">
								<span className="type-caption block truncate text-foreground/75">
									{message.channel}
								</span>
								<span className="type-micro block truncate font-mono text-muted-foreground">
									{message.to}
								</span>
							</span>
							<span className="type-micro font-mono text-muted-foreground/70">
								{message.state}
							</span>
						</div>
					))}
				</div>
			</div>
		</WindowFrame>
	);
}

/**
 * Ryu Hire is early access: an illustrative specialist list with no prices,
 * because no Hire run, estimate, or charge exists yet.
 */
export function HireVisual() {
	const hires = [t("Policy analyst"), t("Release reviewer"), t("Inbox triage")];
	return (
		<MinimalCard>
			<div className="space-y-2">
				{hires.map((name, index) => (
					<div
						className={cn(
							"rounded-lg border px-3 py-3 text-foreground/80 text-sm",
							index === 0 ? "border-foreground/30" : "border-border"
						)}
						key={name}
					>
						<LiteralText text={name} />
					</div>
				))}
			</div>
		</MinimalCard>
	);
}

const BOT_THREADS = [
	{ id: "a", tone: "bg-foreground/60", bar: "w-3/4" },
	{ id: "b", tone: "bg-foreground/35", bar: "w-2/3" },
	{ id: "c", tone: "bg-foreground/25", bar: "w-4/5" },
	{ id: "d", tone: "bg-foreground/15", bar: "w-1/2" },
	{ id: "e", tone: "bg-foreground/15", bar: "w-3/5" },
];

/**
 * The Bot workspace, text-free: a thread list on the left and the open thread
 * on the right, with a request, the returned result, and a review action.
 */
export function BotHeroVisual() {
	return (
		<WindowFrame className="w-full rounded-2xl" contentClassName="p-0">
			<div aria-hidden="true" className="grid min-h-64 grid-cols-[38%_1fr]">
				<div className="space-y-3 bg-muted/30 p-4">
					{BOT_THREADS.map((thread, index) => (
						<div
							className={cn(
								"flex items-center gap-2.5 rounded-lg px-2 py-2",
								index === 0 && "bg-background"
							)}
							key={thread.id}
						>
							<span
								className={cn("size-6 shrink-0 rounded-full", thread.tone)}
							/>
							<span
								className={cn(
									"block h-1.5 rounded-full bg-foreground/15",
									thread.bar
								)}
							/>
						</div>
					))}
				</div>
				<div className="flex flex-col gap-3 p-4">
					<div className="ms-auto w-2/5 rounded-2xl rounded-se-sm bg-foreground px-3 py-3">
						<span className="block h-1.5 w-full rounded-full bg-background/40" />
					</div>
					<div className="w-4/5 space-y-2 rounded-2xl rounded-ss-sm bg-muted px-3 py-3">
						<span className="block h-1.5 w-full rounded-full bg-foreground/15" />
						<span className="block h-1.5 w-5/6 rounded-full bg-foreground/10" />
						<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
					</div>
					<span className="h-6 w-16 rounded-full border border-border" />
					<div className="mt-auto flex items-center gap-2 rounded-full border border-border px-3 py-2">
						<span className="block h-1.5 w-1/3 rounded-full bg-foreground/10" />
						<span className="ms-auto size-5 rounded-full bg-foreground/80" />
					</div>
				</div>
			</div>
		</WindowFrame>
	);
}
