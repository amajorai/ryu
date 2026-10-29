import { cn } from "@ryu/ui/lib/utils";
import { Bot, Globe, Key, Shield, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { MinimalCard, Node, Terminal, Wire } from "../../mockups.tsx";
import { MockCard, StatusRow } from "../../product-row-visuals.tsx";
import type { CtaLink } from "../../sections.tsx";
import { readTheDocsCta } from "../resources.tsx";

/* Shared CTAs and the small page-specific visuals the catalogue entries use. */

export const EARLY_ACCESS: CtaLink = {
	label: "Get early access",
	href: "https://j14.notion.site/2940023f0e838023810ce36edf2e3893?pvs=105",
	external: true,
};
export const BOOK_DEMO: CtaLink = {
	label: "Book a demo",
	href: "https://cal.com/amajor/ryu-demo",
	external: true,
};
export const DOWNLOAD: CtaLink = { label: "Download", href: "/download" };
export const SEE_PLANS: CtaLink = {
	label: "See plans",
	href: "/pricing#plans",
};
/** How hosted agents run on Ryu Cloud nodes. */
export const HOSTED_AGENTS_DOCS = "/docs/billing/hosted-agents";
/** The getting-started guide, for visitors who are not buying hosting yet. */
export const START_HERE_DOCS = "/docs/start-here";
/** The buyer-side guide to browsing and installing, not the author guide. */
export const MARKETPLACE_DOCS = "/docs/surfaces/desktop/user-guide/store";

/** Docs paths are resolved against the docs site, not this one. */
export const readTheDocs = readTheDocsCta;

/* Small page-specific visuals --------------------------------------- */

/** Card header shared by the small status-card visuals on this page. */
export function CardHeader({ title, meta }: { title: string; meta?: string }) {
	return (
		<div className="flex items-center justify-between gap-3 px-1 pb-1">
			<span className="font-medium text-foreground text-sm">{title}</span>
			{meta ? (
				<span className="text-muted-foreground text-xs">{meta}</span>
			) : null}
		</div>
	);
}

/** One vertical connector between the stacked nodes of a flow diagram. */
export function FlowStem() {
	return <span aria-hidden="true" className="h-5 w-px bg-foreground/30" />;
}

/**
 * A text-free flow node: an outlined chip holding one icon or a quiet dot.
 * `emphasis` marks the node the diagram is about.
 */
export function ShapeNode({
	children,
	className,
	emphasis,
}: {
	children?: ReactNode;
	className?: string;
	emphasis?: boolean;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex h-10 items-center justify-center rounded-xl border px-3",
				emphasis
					? "border-foreground/40 bg-foreground/5 text-foreground"
					: "border-border bg-muted/50 text-foreground/60",
				className
			)}
		>
			{children ?? <span className="size-2.5 rounded-full bg-foreground/30" />}
		</span>
	);
}

/**
 * Chat channels reach one agent on the node (services.md C2, C9); its model
 * and tool calls go through the Gateway (services.md C13). Shapes only: four
 * channels, the agent, the Gateway, and the model.
 */
export function CloudChannelsVisual() {
	const channels = ["a", "b", "c", "d"];
	return (
		<div
			aria-hidden="true"
			className="flex w-full flex-col items-center rounded-2xl border border-border bg-card px-5 py-8"
		>
			<div className="relative grid w-full max-w-sm grid-cols-4 gap-3">
				{channels.map((channel) => (
					<div className="flex flex-col items-center" key={channel}>
						<ShapeNode className="w-full" />
						<FlowStem />
					</div>
				))}
				<span
					aria-hidden="true"
					className="absolute inset-x-[12.5%] bottom-0 h-px bg-foreground/30"
				/>
			</div>
			<FlowStem />
			<ShapeNode className="h-12 w-32" emphasis>
				<Bot className="size-5" />
			</ShapeNode>
			<FlowStem />
			<ShapeNode className="w-32">
				<Shield className="size-4" />
			</ShapeNode>
			<FlowStem />
			<ShapeNode className="w-32">
				<Sparkles className="size-4" />
			</ShapeNode>
		</div>
	);
}

/** Passport makes the fetch and redacts echoed credentials (gateway.md P4). */
export function PassportFetchVisual() {
	return (
		<MockCard>
			<div className="mb-2 flex items-center gap-2">
				<ShapeNode>
					<Bot className="size-4" />
				</ShapeNode>
				<Wire className="flex-1" />
				<ShapeNode emphasis>
					<Key className="size-4" />
				</ShapeNode>
				<Wire className="flex-1" delays={[]} />
				<ShapeNode>
					<Globe className="size-4" />
				</ShapeNode>
			</div>
			<StatusRow label="Page content" value="Returned" />
			<StatusRow label="Echoed credential" value="Redacted" />
		</MockCard>
	);
}

/**
 * The hero's version 3 again, this time with a leaked key: the deploy rescan
 * finds it and stops the deploy (services.md S2). Rows match the hero card.
 */
export function SitesDeployVisual() {
	return (
		<div className="w-full space-y-2 px-1 py-2">
			<CardHeader title="Saved version" />
			<StatusRow label="Secret scan" value="Credential found" />
			<StatusRow label="Deploy" value="Blocked" />
		</div>
	);
}

/** Agent Skills let a coding agent set up and drive Ryu (gateway.md S6). */
export function CodingAgentSkillsVisual() {
	return (
		<div className="flex w-full flex-col items-center px-1 py-6">
			<Node className="w-44 py-2.5 text-sm">Your coding agent</Node>
			<FlowStem />
			<Node className="w-44 py-2.5 text-sm" emphasis>
				Ryu server
			</Node>
			<FlowStem />
			<Node className="w-44 py-2.5 text-sm">Agents and models</Node>
		</div>
	);
}

/** Inbound mail is accepted only with a valid signature (services.md M3). */
export function MailVerifyVisual() {
	return (
		<div className="w-full space-y-3 px-1 py-2">
			<div className="flex items-center gap-2">
				<Node>Mail provider</Node>
				<Wire className="flex-1" />
				<Node emphasis>Signature check</Node>
				<Wire className="flex-1" delays={[]} />
				<Node>Inbox</Node>
			</div>
			<StatusRow label="Valid signature" value="Accepted" />
			<StatusRow label="Invalid signature" value="Rejected" />
		</div>
	);
}

/**
 * `/resume <conversation-id>` (apps/cli/src/core/commands.ts:415-423) reopens a
 * Core conversation; the chat prints "Resumed: <title>" (surfaces/chat/index.tsx:1694).
 */
export function CliResumeVisual() {
	return (
		<Terminal
			lines={[
				{ prompt: true, text: "ryu-cli" },
				{ text: "/resume 7f3c2a" },
				{ text: "Resumed: Release notes draft", muted: true },
				{ text: "› Draft the notes for the 2.4 release", muted: true },
			]}
		/>
	);
}

/**
 * Devices reach the node directly over Wi-Fi (Mode B), or through a phone that
 * only forwards ciphertext over Bluetooth (Mode A); apps/hardware/README.md:18-35.
 */
export function DeviceLinkVisual() {
	return (
		<div className="w-full space-y-10 px-1 pt-6 pb-8">
			<div className="flex items-center gap-2">
				<Node>Device</Node>
				<LabeledWire label="Wi-Fi" />
				<Node emphasis>Server</Node>
			</div>
			<div className="flex items-center gap-2">
				<Node>Device</Node>
				<LabeledWire label="Bluetooth" still />
				<Node>Phone</Node>
				<Wire className="flex-1" delays={[]} />
				<Node emphasis>Server</Node>
			</div>
		</div>
	);
}

/** A wire with a small link label above it. */
export function LabeledWire({
	label,
	still,
}: {
	label: string;
	still?: boolean;
}) {
	return (
		<div className="relative min-w-8 flex-1">
			<span className="absolute inset-x-0 bottom-full mb-1.5 text-center text-muted-foreground text-xs">
				{label}
			</span>
			<Wire className="w-full" delays={still ? [] : undefined} />
		</div>
	);
}

/**
 * An illustrative agent brief: its tools and where it stops for approval.
 * Where it runs is the page's feature row (services.md A5).
 */
export function AgentBriefVisual() {
	return (
		<MinimalCard>
			<div className="space-y-2">
				<CardHeader title="Weekly sales summary" />
				<StatusRow label="Tools" value="CRM · Email" />
				<StatusRow label="Approval" value="Before send" />
			</div>
		</MinimalCard>
	);
}

/**
 * The agent runs on a Ryu cloud node or on your own machines (services.md A5).
 */
export function AgentHostVisual() {
	return (
		<div className="flex w-full flex-col items-center px-1 py-6">
			<Node className="w-44 py-2.5 text-sm" emphasis>
				Your agent
			</Node>
			<FlowStem />
			<div className="relative grid w-full max-w-sm grid-cols-2 gap-3">
				<span
					aria-hidden="true"
					className="absolute inset-x-1/4 top-0 h-px bg-foreground/30"
				/>
				{["Ryu cloud node", "Your machines"].map((host) => (
					<div className="flex flex-col items-center" key={host}>
						<FlowStem />
						<Node className="w-full py-2.5 text-sm">{host}</Node>
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * The lease contract from the desktop preview: a clean workspace with no host
 * login, ending in a receipt with duration and cost (ComputeShareSurface.tsx:75-93).
 * No price exists yet, so the receipt shows only the duration.
 */
export function ComputeReceiptVisual() {
	return (
		<MinimalCard>
			<div className="space-y-2">
				<CardHeader meta="Planned" title="Lease receipt" />
				<StatusRow label="Duration" value="1 hour" />
				<StatusRow label="Workspace" value="Cleared" />
			</div>
		</MinimalCard>
	);
}

/** The planned host boundary (ComputeShareSurface.tsx:399, 488-490). */
export function SharePackageVisual() {
	return (
		<MinimalCard>
			<div className="space-y-2">
				<CardHeader meta="Planned" title="Host boundary" />
				<StatusRow label="Node token" value="Stays here" />
				<StatusRow label="Host files" value="Stay here" />
				<StatusRow label="Job output" value="To the renter" />
			</div>
		</MinimalCard>
	);
}

/** A failed probe and the firewall setting it points to. */
export function RedTeamTuneVisual() {
	return (
		<MockCard>
			<CardHeader meta="1 of 10 failed" title="Security sweep" />
			<StatusRow label="Jailbreak resistance" value="Needs attention" />
			<StatusRow label="Firewall · jailbreak detection" value="Block" />
		</MockCard>
	);
}

/**
 * One connected app with the actions an agent may call: reads run, risky
 * verbs ask first, and actions outside the allowlist are blocked
 * (gateway.md N5, N9).
 */
export function ConnectionsScopeVisual() {
	return (
		<MockCard>
			<CardHeader meta="Connected" title="Gmail" />
			<StatusRow label="Read messages" value="Allowed" />
			<StatusRow label="Send a reply" value="Asks first" />
			<StatusRow label="Delete messages" value="Not allowed" />
		</MockCard>
	);
}

/**
 * Scheduled and event-driven runs keep going on the cloud node while your own
 * devices are off (services.md C3, C10).
 */
export function CloudScheduleVisual() {
	return (
		<MockCard>
			<CardHeader meta="Your devices off" title="Your cloud node" />
			<StatusRow label="Every Monday, 9:00" value="Ran" />
			<StatusRow label="New support email" value="Ran" />
		</MockCard>
	);
}

/**
 * Agent's run trace records model and tool calls with timing and errors
 * (packages/core-client/src/runs.ts:52-66).
 */
export function RunTraceVisual() {
	const spans = [
		{ name: "Gemma 4", result: "1.2s" },
		{ name: "Search tickets", result: "0.3s" },
		{ name: "Send email", result: "Failed" },
		{ name: "Gemma 4", result: "0.9s" },
	];
	return (
		<ol className="w-full space-y-2 px-1 py-2">
			{spans.map((span, index) => (
				<li key={`${span.name}-${index.toString()}`}>
					<StatusRow label={span.name} value={span.result} />
				</li>
			))}
		</ol>
	);
}

/**
 * Server chats live on Core and show on every device; on-device chats never
 * upload (workspaces.md M4; apps/native/README.md:38).
 */
export function MobileSyncVisual() {
	return (
		<div className="w-full space-y-6 px-1 py-4">
			<div className="flex items-center gap-2">
				<Node>Phone</Node>
				<Wire className="flex-1" />
				<Node emphasis>Server</Node>
				<Wire className="flex-1" delays={[0.3, 0.7]} />
				<Node>Desktop</Node>
			</div>
			<StatusRow label="On-device chats" value="Stay on the phone" />
		</div>
	);
}

/**
 * A workflow run checkpoints each finished step and can wait for approval
 * (core.md W9: workflow/mod.rs:23-27, store.rs:82-96).
 */
export function WorkflowResumeVisual() {
	return (
		<MockCard>
			<CardHeader meta="Resumed" title="Weekly report" />
			<StatusRow label="Gather data" value="Saved" />
			<StatusRow label="Draft report" value="Saved" />
			<StatusRow label="Approval" value="Waiting" />
		</MockCard>
	);
}

/**
 * Reading the active tab needs your grant; page actions ask once first
 * (workspaces.md X7; apps/extension/README.md:39).
 */
export function TabConsentVisual() {
	return (
		<div className="w-full space-y-2 px-1 py-2">
			<CardHeader title="This tab" />
			<StatusRow label="Read the page" value="Allowed" />
			<StatusRow label="Fill a form" value="Asks first" />
			<StatusRow label="Download a file" value="Asks first" />
		</div>
	);
}

export const SKILLS_GITHUB: CtaLink = {
	label: "Agent skills on GitHub",
	href: "https://github.com/amajorai/ryu/tree/main/apps/skills",
	external: true,
};
