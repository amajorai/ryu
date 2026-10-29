import {
	ArrowRight01Icon,
	CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Logo as GhostOrb } from "@ryu/ui/components/logo.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";
import "../../src/index.css";

type Stage = "defaults" | "connections" | "imports" | "profile";

const stages: Array<{ id: Stage; label: string }> = [
	{ id: "defaults", label: "Defaults" },
	{ id: "connections", label: "Connections" },
	{ id: "imports", label: "Import threads" },
	{ id: "profile", label: "Build profile" },
];

const integrations = [
	{ id: "gmail", label: "Gmail", description: "Recent email, read-only" },
	{ id: "notion", label: "Notion", description: "Pages and workspaces" },
	{ id: "slack", label: "Slack", description: "Messages and channels" },
	{ id: "github", label: "GitHub", description: "Repositories and activity" },
];

const threadGroups = [
	{ agent: "Claude Code", count: 12 },
	{ agent: "Codex", count: 4 },
	{ agent: "Cursor", count: 2 },
];

function ProviderIcon({ providerKey }: { providerKey: string }) {
	return (
		<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
			<ProviderBrandLogo providerKey={providerKey} size={20} />
		</div>
	);
}

function LaneCard({
	children,
	label,
	model,
	provider,
}: {
	children: string;
	label: string;
	model: string;
	provider: string;
}) {
	return (
		<div data-testid={`lane-${label}`}>
			<SettingsCard className="flex flex-col gap-3">
				<div className="flex items-start gap-3">
					<ProviderIcon providerKey={provider} />
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">{children}</p>
						<p className="mt-1 text-muted-foreground text-xs">{label} lane</p>
					</div>
					<span className="rounded-full bg-success/10 px-2 py-1 text-success text-xs dark:text-success">
						Configured
					</span>
				</div>
				<div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/40 p-3 text-xs">
					<div>
						<p className="text-muted-foreground">Provider</p>
						<p className="mt-1 font-medium">{provider}</p>
					</div>
					<div>
						<p className="text-muted-foreground">Model</p>
						<p className="mt-1 font-medium">{model}</p>
					</div>
				</div>
				<p className="text-muted-foreground text-xs">
					Uses the universal agent and model picker, including effort controls.
				</p>
			</SettingsCard>
		</div>
	);
}

function ConnectionsStage() {
	const [query, setQuery] = useState("");
	const [connected, setConnected] = useState<Set<string>>(new Set(["gmail"]));
	const filtered = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return integrations.filter(
			(item) =>
				!normalized ||
				item.label.toLowerCase().includes(normalized) ||
				item.description.toLowerCase().includes(normalized)
		);
	}, [query]);

	return (
		<div className="flex flex-col gap-3" data-testid="connections-stage">
			<div className="relative">
				<Input
					aria-label="Search connections"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search Gmail, Notion, Slack, GitHub, or more"
					value={query}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				{filtered.map((integration) => {
					const isConnected = connected.has(integration.id);
					return (
						<div
							data-testid={`connection-${integration.id}`}
							key={integration.id}
						>
							<SettingsCard className="flex items-center gap-3">
								<ProviderIcon providerKey={integration.id} />
								<div className="min-w-0 flex-1">
									<p className="font-medium text-sm">{integration.label}</p>
									<p className="text-muted-foreground text-xs">
										{isConnected
											? "Connected · read-only"
											: integration.description}
									</p>
								</div>
								<Button
									onClick={() =>
										setConnected((previous) => {
											const next = new Set(previous);
											if (next.has(integration.id)) {
												next.delete(integration.id);
											} else {
												next.add(integration.id);
											}
											return next;
										})
									}
									size="sm"
									variant={isConnected ? "ghost" : "default"}
								>
									{isConnected ? "Connected" : "Connect"}
								</Button>
							</SettingsCard>
						</div>
					);
				})}
			</div>
			<SettingsCard className="border-dashed">
				<p className="font-medium text-sm">More integrations</p>
				<p className="mt-1 text-muted-foreground text-xs">
					Search the full Composio catalog or connect another source later.
				</p>
			</SettingsCard>
		</div>
	);
}

function ImportsStage() {
	const [autoImport, setAutoImport] = useState(true);
	const [imported, setImported] = useState(false);
	const total = threadGroups.reduce((sum, group) => sum + group.count, 0);
	return (
		<div className="flex flex-col gap-3" data-testid="imports-stage">
			<SettingsCard className="flex flex-col gap-2">
				{threadGroups.map((group) => (
					<div
						className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2"
						key={group.agent}
					>
						<span className="text-sm">{group.agent}</span>
						<span className="font-medium text-sm">{group.count} threads</span>
					</div>
				))}
				<div className="mt-2 flex items-center justify-between border-t pt-3 text-sm">
					<span>Total available</span>
					<span className="font-semibold">{total}</span>
				</div>
			</SettingsCard>
			<SettingsCard className="flex items-center justify-between gap-4">
				<div>
					<p className="font-medium text-sm">Auto-import new threads</p>
					<p className="mt-1 text-muted-foreground text-xs">
						Keep future agent sessions searchable in Ryu.
					</p>
				</div>
				<Switch
					aria-label="Auto-import new threads"
					checked={autoImport}
					onCheckedChange={setAutoImport}
				/>
			</SettingsCard>
			<Button onClick={() => setImported(true)}>
				{imported ? `Imported ${total} conversations` : "Confirm import"}
			</Button>
		</div>
	);
}

function ProfileStage() {
	const [backgrounded, setBackgrounded] = useState(false);
	const [skipped, setSkipped] = useState(false);
	const [elapsed, setElapsed] = useState(21);

	useEffect(() => {
		const timer = window.setInterval(
			() => setElapsed((value) => value + 1),
			1000
		);
		return () => window.clearInterval(timer);
	}, []);

	if (skipped) {
		return (
			<SettingsCard
				className="flex flex-col gap-3"
				data-testid="profile-skipped"
			>
				<p className="font-medium text-sm">Profile setup skipped</p>
				<p className="text-muted-foreground text-sm">
					No durable profile chat or memories were created. You can run this
					later.
				</p>
				<Button onClick={() => setSkipped(false)} variant="ghost">
					Review again
				</Button>
			</SettingsCard>
		);
	}

	return (
		<div className="flex flex-col gap-3" data-testid="profile-stage">
			<SettingsCard className="flex flex-col gap-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="font-medium text-sm">
							{backgrounded
								? "Profile chat is running in the background"
								: "Building your initial profile"}
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{backgrounded
								? "You can open it from Chat and resume the stream."
								: `Reading your sources · ${elapsed}s`}
						</p>
					</div>
					<span className="rounded-full bg-primary/10 px-2 py-1 text-primary text-xs">
						{backgrounded ? "Chat created" : "In progress"}
					</span>
				</div>
				<div className="space-y-3 text-sm">
					{[
						"Reviewing recent 90-day connections…",
						"Comparing imported agent sessions…",
						"Writing verified facts to user + organization memory…",
					].map((line, index) => (
						<div className="flex items-center gap-2" key={line}>
							<HugeiconsIcon
								className={
									index === 2 && !backgrounded
										? "animate-pulse text-muted-foreground"
										: "text-success"
								}
								icon={CheckmarkCircle02Icon}
								size={16}
							/>
							<span
								className={
									index === 2 && !backgrounded ? "text-muted-foreground" : ""
								}
							>
								{line}
							</span>
						</div>
					))}
				</div>
			</SettingsCard>
			<SettingsCard className="border-warning/30 bg-warning/5">
				<p className="font-medium text-sm">Local model note</p>
				<p className="mt-1 text-muted-foreground text-xs">
					Local models may produce a weaker initial setup. For the best result,
					use an ACP agent or the Ryu cloud model.
				</p>
			</SettingsCard>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Button onClick={() => setSkipped(true)} variant="ghost">
					Skip for now
				</Button>
				{backgrounded ? null : (
					<Button onClick={() => setBackgrounded(true)}>
						Run in background
						<HugeiconsIcon icon={ArrowRight01Icon} size={16} />
					</Button>
				)}
			</div>
		</div>
	);
}

function ProofApp() {
	const [stage, setStage] = useState<Stage>("defaults");
	return (
		<div className="min-h-screen bg-background text-foreground">
			<div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 p-6 md:p-10">
				<div className="flex items-center gap-3">
					<GhostOrb size="42px" variant="outline" />
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
							Onboarding proof
						</p>
						<p className="font-semibold text-lg">
							Defaults, connections, imports, profile
						</p>
					</div>
				</div>
				<PageHeader
					subtitle="A paid owner on a selected organization, with the complete bootstrap path visible."
					title="Start with an agent that already knows your work"
				/>
				<div className="flex flex-wrap gap-2" data-testid="onboarding-stepper">
					{stages.map((item, index) => (
						<Button
							key={item.id}
							onClick={() => setStage(item.id)}
							variant={stage === item.id ? "default" : "outline"}
						>
							<span className="mr-1 text-xs">{index + 1}</span>
							{item.label}
						</Button>
					))}
				</div>
				<div className="grid gap-3 sm:grid-cols-3">
					<SettingsCard>
						<p className="text-muted-foreground text-xs">Node</p>
						<p className="mt-1 font-medium text-sm">Local · ready</p>
					</SettingsCard>
					<SettingsCard>
						<p className="text-muted-foreground text-xs">Organization</p>
						<p className="mt-1 font-medium text-sm">Acme · Owner</p>
					</SettingsCard>
					<SettingsCard>
						<p className="text-muted-foreground text-xs">Plan</p>
						<p className="mt-1 font-medium text-sm">Paid · Composio enabled</p>
					</SettingsCard>
				</div>
				{stage === "defaults" ? (
					<div
						className="grid gap-3 md:grid-cols-2"
						data-testid="defaults-stage"
					>
						<LaneCard label="local" model="Gemma 4" provider="local">
							Ryu · default local agent
						</LaneCard>
						<LaneCard label="cloud" model="openrouter/auto" provider="Ryu">
							Ryu · default cloud agent
						</LaneCard>
					</div>
				) : null}
				{stage === "connections" ? <ConnectionsStage /> : null}
				{stage === "imports" ? <ImportsStage /> : null}
				{stage === "profile" ? <ProfileStage /> : null}
				<div className="flex items-center justify-between border-t pt-4 text-muted-foreground text-xs">
					<span>Ryu provider · managed-openrouter · auto model</span>
					<span>Memory scopes: user + organization</span>
				</div>
			</div>
		</div>
	);
}

const proofWindow =
	/* SAFETY: This private optional __onboardingProofRoot holder is authored only by this module, which stores the complete native createRoot result and reuses it on later evaluation. The view preserves the browser Window and does not describe an external payload. */ window as typeof window & {
		__onboardingProofRoot?: ReturnType<typeof createRoot>;
	};
const proofRoot =
	proofWindow.__onboardingProofRoot ??
	createRoot(document.getElementById("root")!);
proofWindow.__onboardingProofRoot = proofRoot;
proofRoot.render(<ProofApp />);
