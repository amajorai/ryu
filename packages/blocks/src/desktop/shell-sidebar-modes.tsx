"use client";
import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { EntityAvatar } from "@ryu/ui/components/entity-avatar.tsx";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { useState } from "react";
import { Section } from "./shell-rows.tsx";

const BOT_MODE_AGENTS = [
	{
		id: "ryu",
		name: "Ryu",
		preview: "Follow-up draft is ready",
		stamp: "9:41 AM",
		threads: ["Refactor the auth flow", "Auth flow follow-up"],
	},
	{
		id: "claude-code",
		name: "Claude Code",
		preview: "Reviewed the launch checklist",
		stamp: "Yesterday",
		threads: ["Plan the launch checklist", "Launch checklist review"],
	},
	{
		id: "codex",
		name: "Codex",
		preview: "Found two files to update",
		stamp: "Mon",
		threads: ["Debug the SSE stream", "SSE fix follow-up"],
	},
] as const;

const TRUST_MODE_AI = [
	{
		id: "chatgpt",
		name: "ChatGPT",
		preview: "Subscription connected",
		stamp: "Now",
	},
	{
		id: "claude",
		name: "Claude",
		preview: "Context protected",
		stamp: "Now",
	},
	{
		id: "local",
		name: "Ryu local",
		preview: "Private fallback",
		stamp: "Local",
	},
] as const;

const TRUST_MODE_HISTORY = [
	"Acme follow-up",
	"Inbox review",
	"Weekly update",
	"Expense report",
] as const;

function BotModeAgentRow({
	id,
	name,
	preview,
	stamp,
	threads,
}: (typeof BOT_MODE_AGENTS)[number]) {
	const tl = useLiteralMessages();
	return (
		<SidebarMenuItem>
			<button
				aria-label={tl("Chat with {name}", { name })}
				className="group/agent-row flex min-h-14 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
				data-testid={`hero-bot-agent-${id}`}
				type="button"
			>
				<EntityAvatar className="size-9 shrink-0" name={name} />
				<span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
					<span className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-sm">{name}</span>
						<span className="type-compact shrink-0 text-muted-foreground tabular-nums">
							{stamp}
						</span>
					</span>
					<span className="truncate text-muted-foreground text-xs">
						{preview}
					</span>
				</span>
			</button>
			<div className="relative ml-7 border-sidebar-border/70 border-l pl-2">
				<div className="type-compact px-2 py-1 text-muted-foreground uppercase tracking-(--tracking-eyebrow)">
					Threads
				</div>
				<SidebarMenu>
					{threads.map((thread) => (
						<SidebarMenuItem key={thread}>
							<SidebarMenuButton className="h-8" purpose="showcase-thread">
								<HugeiconsIcon
									className="size-3.5 text-muted-foreground"
									icon={GitBranchIcon}
								/>
								<span className="truncate">{thread}</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</div>
		</SidebarMenuItem>
	);
}

function TrustModeAiRow({
	id,
	name,
	preview,
	stamp,
}: (typeof TRUST_MODE_AI)[number]) {
	const tl = useLiteralMessages();
	return (
		<SidebarMenuItem>
			<button
				aria-label={tl("Use {name}", { name })}
				className="group/ai-row flex min-h-14 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
				data-testid={`hero-trust-ai-${id}`}
				type="button"
			>
				<EntityAvatar className="size-9 shrink-0" name={name} />
				<span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
					<span className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-sm">{name}</span>
						<span className="type-compact shrink-0 text-muted-foreground tabular-nums">
							{stamp}
						</span>
					</span>
					<span className="truncate text-muted-foreground text-xs">
						{preview}
					</span>
				</span>
			</button>
		</SidebarMenuItem>
	);
}

function TrustModeHistoryRow({ title }: { title: string }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton className="h-10">
				<span className="min-w-0 truncate text-sidebar-foreground/85">
					{title}
				</span>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

export function TrustModeSidebarContent() {
	const [activeTab, setActiveTab] = useState<"ai" | "history">("ai");

	return (
		<div
			className="flex min-h-0 flex-1 flex-col"
			data-testid="hero-trust-mode-sidebar"
		>
			<Tabs
				className="min-h-0 flex-1"
				onValueChange={(value) => {
					if (value === "ai" || value === "history") {
						setActiveTab(value);
					}
				}}
				value={activeTab}
			>
				<div className="px-2 pt-1">
					<TabsList className="w-full" manageLayout={false}>
						<TabsTrigger className="flex-1" value="ai">
							AI tools
						</TabsTrigger>
						<TabsTrigger className="flex-1" value="history">
							History
						</TabsTrigger>
					</TabsList>
				</div>

				<div className="scroll-fade no-scrollbar min-h-0 flex-1 overflow-auto px-2 pt-2">
					{activeTab === "ai" ? (
						<SidebarMenu>
							{TRUST_MODE_AI.map((item) => (
								<TrustModeAiRow key={item.id} {...item} />
							))}
						</SidebarMenu>
					) : (
						<SidebarMenu>
							{TRUST_MODE_HISTORY.map((title) => (
								<TrustModeHistoryRow key={title} title={title} />
							))}
						</SidebarMenu>
					)}
				</div>
			</Tabs>
		</div>
	);
}

export function BotModeSidebarContent() {
	return (
		<div
			className="scroll-fade no-scrollbar min-h-0 flex-1 overflow-auto px-2 pt-2"
			data-testid="hero-bot-mode-sidebar"
		>
			<Section label="Agents">
				{BOT_MODE_AGENTS.map((agent) => (
					<BotModeAgentRow key={agent.name} {...agent} />
				))}
			</Section>
		</div>
	);
}
