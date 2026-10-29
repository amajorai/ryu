import {
	Activity01Icon,
	FingerPrintIcon,
	Robot01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Icon } from "@ryu/ui/components/icon.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { useMemo, useState } from "react";
import { AgentPassportPanel } from "@/src/components/agents/AgentPassportPanel.tsx";
import { AgentRunHistoryView } from "@/src/components/agents/AgentRunHistoryView.tsx";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	PluginAgentProfileTab,
	PluginCompanion,
} from "@/src/lib/api/plugins.ts";
import type { ConnectionPhase } from "@/src/lib/connectivity.ts";
import { ownedCompanionId } from "@/src/lib/plugin-file-handlers.ts";
import PluginCompanionPage from "@/src/pages/PluginCompanionPage.tsx";

type NativeProfileView = "activity" | "identity" | "passport";

const NATIVE_PROFILE_VIEWS = new Set<string>([
	"activity",
	"identity",
	"passport",
]);

/** An app-contributed profile tab resolved to a companion the shell can mount. */
interface ContributedProfileTab extends PluginAgentProfileTab {
	companionId: string;
	value: string;
}

/** Keep only tabs whose companion belongs to the contributing plugin, keyed by
 *  plugin so two apps can reuse a tab id. Apps own these tabs: disabling the
 *  app removes its tab. */
function contributedProfileTabs(
	tabs: PluginAgentProfileTab[],
	companions: PluginCompanion[]
): ContributedProfileTab[] {
	const resolved: ContributedProfileTab[] = [];
	for (const tab of tabs) {
		const companionId = ownedCompanionId(tab.companion, tab.plugin, companions);
		if (companionId) {
			resolved.push({
				...tab,
				companionId,
				value: `plugin:${tab.plugin}:${tab.id}`,
			});
		}
	}
	return resolved.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

interface AgentActivityPanelProps {
	agent: AgentSummary;
	connectionPhase: ConnectionPhase;
	organizationId: string | null;
	target: ApiTarget;
}

export function AgentActivityTrigger({
	agentName,
	onOpen,
}: {
	agentName: string;
	onOpen: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<button
			aria-label={tl("Open {agentName} profile and activity", { agentName })}
			className="flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			onClick={onOpen}
			title={tl("{agentName} profile and activity", { agentName })}
			type="button"
		>
			<HugeiconsIcon className="size-4" icon={Robot01Icon} />
		</button>
	);
}

function connectionStatus(phase: ConnectionPhase) {
	switch (phase) {
		case "online":
			return { label: "Connected", dot: "bg-success" };
		case "checking":
			return { label: "Connecting", dot: "bg-warning" };
		case "offline":
			return { label: "Offline", dot: "bg-muted-foreground/50" };
		case "node-unreachable":
			return { label: "Node unreachable", dot: "bg-destructive" };
	}
}

function safetyLabel(value: AgentSummary["safetyProfile"]): string {
	return value
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function IdentityView({ agent }: { agent: AgentSummary }) {
	const facts = [
		{ label: "Agent ID", value: agent.id, mono: true },
		{ label: "Lifecycle", value: agent.lifecycleStatus, mono: false },
		{
			label: "Safety profile",
			value: safetyLabel(agent.safetyProfile),
			mono: false,
		},
		{ label: "Runtime", value: agent.engine ?? "Not reported", mono: false },
		{ label: "Model", value: agent.model ?? "Not pinned", mono: false },
		{ label: "Version", value: agent.version ?? "Unversioned", mono: false },
	];

	return (
		<div className="space-y-3 px-1" data-testid="agent-identity-view">
			<section className="rounded-xl border bg-card p-4">
				<h3 className="font-medium text-sm">Agent identity</h3>
				<p className="mt-1 text-muted-foreground text-xs">
					{agent.description || "No description recorded."}
				</p>
				<dl className="mt-4 flex flex-col divide-y">
					{facts.map(({ label, mono, value }) => (
						<div
							className="flex items-start justify-between gap-3 py-2.5"
							key={label}
						>
							<dt className="shrink-0 text-muted-foreground text-xs">
								{label}
							</dt>
							<dd
								className={`min-w-0 break-all text-right text-xs ${mono ? "font-mono" : "font-medium"}`}
							>
								{value}
							</dd>
						</div>
					))}
				</dl>
			</section>
		</div>
	);
}

export function AgentActivityPanel({
	agent,
	connectionPhase,
	organizationId,
	target,
}: AgentActivityPanelProps) {
	const tl = useLiteralMessages();
	const status = connectionStatus(connectionPhase);
	const { agent_profile_tabs: profileTabs, companions } =
		usePluginContributions();
	const contributedTabs = useMemo(
		() => contributedProfileTabs(profileTabs ?? [], companions),
		[profileTabs, companions]
	);
	const [selectedView, setSelectedView] = useState<string>("activity");
	// Fall back to Activity when the selected app tab disappears (app disabled).
	const activeView =
		NATIVE_PROFILE_VIEWS.has(selectedView) ||
		contributedTabs.some((tab) => tab.value === selectedView)
			? selectedView
			: ("activity" satisfies NativeProfileView);
	const tabCount = NATIVE_PROFILE_VIEWS.size + contributedTabs.length;

	return (
		<div
			className="flex h-full min-h-0 flex-col"
			data-testid="agent-activity-panel"
		>
			<header className="flex shrink-0 flex-col items-center gap-2 border-b px-4 py-5 text-center">
				<div className="flex size-20 items-center justify-center overflow-hidden rounded-full border bg-muted/30 p-1">
					<AgentAvatar
						className="size-full object-cover"
						engine={engineForAgent(agent)}
						glyph={agent.avatarGlyph}
						size="80px"
					/>
				</div>
				<div className="min-w-0">
					<h2 className="truncate font-medium text-xl">{agent.name}</h2>
					{agent.title ? (
						<p className="mt-0.5 text-muted-foreground text-sm">
							{agent.title}
						</p>
					) : null}
				</div>
				<div
					aria-label={tl("Node status: {status}", { status: tl(status.label) })}
					className="inline-flex items-center gap-2 text-muted-foreground text-sm"
				>
					<span
						aria-hidden="true"
						className={`size-2 rounded-full ${status.dot}`}
					/>
					{status.label}
				</div>
			</header>

			<Tabs
				className="flex min-h-0 flex-1 flex-col"
				inset="agent-activity"
				onValueChange={(value) => {
					if (typeof value === "string") {
						setSelectedView(value);
					}
				}}
				spacing="relaxed"
				value={activeView}
			>
				<TabsList
					aria-label={tl("{agentName} profile views", {
						agentName: agent.name,
					})}
					className="grid h-10 w-full shrink-0"
					manageLayout={false}
					persistLayout={false}
					style={{
						gridTemplateColumns: `repeat(${tabCount}, minmax(0, 1fr))`,
					}}
					variant="segmented"
				>
					<TabsTrigger aria-label="Activity" title="Activity" value="activity">
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4"
							icon={Activity01Icon}
						/>
					</TabsTrigger>
					<TabsTrigger
						aria-label="Agent passport"
						title="Agent passport"
						value="passport"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4"
							icon={Shield01Icon}
						/>
					</TabsTrigger>
					{contributedTabs.map((tab) => (
						<TabsTrigger
							aria-label={tab.title}
							key={tab.value}
							title={tab.title}
							value={tab.value}
						>
							{tab.icon ? (
								<Icon className="size-4" icon={tab.icon} size={16} />
							) : (
								<span className="truncate text-xs" title={tab.title}>
									{tab.title}
								</span>
							)}
						</TabsTrigger>
					))}
					<TabsTrigger aria-label="Identity" title="Identity" value="identity">
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4"
							icon={FingerPrintIcon}
						/>
					</TabsTrigger>
				</TabsList>

				{activeView === "activity" ? (
					<TabsContent
						className="min-h-0 flex-1 overflow-y-auto"
						inset="agent-activity"
						value="activity"
					>
						<AgentRunHistoryView agentId={agent.id} compact />
					</TabsContent>
				) : null}
				{activeView === "passport" ? (
					<TabsContent
						className="min-h-0 flex-1 overflow-y-auto"
						inset="agent-activity"
						value="passport"
					>
						<AgentPassportPanel
							agent={agent}
							organizationId={organizationId}
							target={target}
						/>
					</TabsContent>
				) : null}
				{contributedTabs.map((tab) =>
					activeView === tab.value ? (
						<TabsContent
							className="min-h-0 flex-1 overflow-hidden"
							inset="agent-activity"
							key={tab.value}
							value={tab.value}
						>
							<PluginCompanionPage
								companionId={tab.companionId}
								mountContext={{
									surface: "agent-profile",
									agentId: agent.id,
									agentName: agent.name,
								}}
							/>
						</TabsContent>
					) : null
				)}
				{activeView === "identity" ? (
					<TabsContent
						className="min-h-0 flex-1 overflow-y-auto"
						inset="agent-activity"
						value="identity"
					>
						<IdentityView agent={agent} />
					</TabsContent>
				) : null}
			</Tabs>
		</div>
	);
}
