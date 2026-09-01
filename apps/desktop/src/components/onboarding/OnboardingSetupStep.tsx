import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ONBOARDING_CONTENT_DELAY_MS } from "@ryu/blocks/desktop/onboarding";
import { SvglIcon, type SvglSpec } from "@ryu/blocks/web/svgl-icon.tsx";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Logo as GhostOrb } from "@ryu/ui/components/logo";
import { PageHeader } from "@ryu/ui/components/page-header";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { Switch } from "@ryu/ui/components/switch";
import { AnimatePresence, motion } from "framer-motion";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import { ConnectionPermissionDialog } from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import {
	AgentSuggestionsStep,
	type OnboardingConnectedApp,
} from "@/src/components/onboarding/AgentSuggestionsStep.tsx";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import type { NativeThread } from "@/src/lib/api/agent-threads.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import type {
	OnboardingAgentSuggestion,
	ProfileJobStatus,
} from "@/src/lib/api/onboarding-profile.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";

export type OnboardingSetupKind =
	| "local-default"
	| "organization"
	| "providers"
	| "connections"
	| "cloud-default"
	| "imports"
	| "profile"
	| "agent-suggestions";

export interface OnboardingOrganization {
	id: string;
	isPersonal: boolean;
	logo: string | null;
	name: string;
	role: string | null;
	slug: string;
}

export interface OnboardingThreadGroup {
	agentId: string;
	agentName: string;
	threads: NativeThread[];
}

const INTEGRATION_SVGL: readonly [string, SvglSpec][] = [
	// SVGL's bundled Google mark is the closest local mark for Gmail and the
	// Google Workspace family when Composio does not return a toolkit logo.
	["gmail", "google"],
	["googlemail", "google"],
	["google-drive", "google"],
	["googledrive", "google"],
	["google-docs", "google"],
	["googledocs", "google"],
	["google-sheets", "google"],
	["googlesheets", "google"],
	["google-calendar", "google"],
	["googlecalendar", "google"],
	["notion", "notion"],
	["slack", "slack"],
	["github", { light: "github_light", dark: "github_dark" }],
	["linear", "linear"],
	["discord", "discord"],
	["figma", "figma"],
	["stripe", "stripe"],
	["dropbox", "dropbox"],
	["zoom", "zoom"],
	["asana", "asana-logo"],
	["cloudflare", "cloudflare"],
	["vercel", "vercel"],
];

function svglForIntegration(haystack: string): SvglSpec | null {
	const normalized = haystack.toLowerCase();
	for (const [needle, spec] of INTEGRATION_SVGL) {
		if (normalized.includes(needle)) {
			return spec;
		}
	}
	return null;
}

function ConnectedAppLogo({
	name,
	slug,
	toolkit,
}: {
	name: string;
	slug: string;
	toolkit?: ComposioToolkit;
}) {
	const spec = svglForIntegration(`${slug} ${name}`);
	if (spec) {
		return <SvglIcon size={16} spec={spec} />;
	}
	if (toolkit?.logo) {
		return (
			// biome-ignore lint/performance/noImgElement: Composio supplies toolkit logos
			<img alt="" className="size-4 object-contain" src={toolkit.logo} />
		);
	}
	return (
		<span className="flex size-4 items-center justify-center rounded bg-muted font-medium text-[9px]">
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

function connectedAppDetails(
	connections: readonly ComposioConnection[],
	toolkits: readonly ComposioToolkit[]
): OnboardingConnectedApp[] {
	const apps = new Map<string, OnboardingConnectedApp>();
	for (const connection of connections) {
		if (!connection.active) {
			continue;
		}
		const slug = connection.toolkit.trim().toLowerCase();
		if (!slug || apps.has(slug)) {
			continue;
		}
		const toolkit = toolkits.find((item) => item.slug === connection.toolkit);
		const fallback = connection.toolkit
			.split(/[-_]+/)
			.filter(Boolean)
			.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
			.join(" ");
		const name = toolkit?.name.trim() || fallback;
		if (name) {
			apps.set(slug, {
				logo: <ConnectedAppLogo name={name} slug={slug} toolkit={toolkit} />,
				name,
				slug,
			});
		}
	}
	return [...apps.values()];
}

interface OnboardingSetupStepProps {
	agentSuggestions: OnboardingAgentSuggestion[];
	agentSuggestionsError: string | null;
	agentSuggestionsSelected: ReadonlySet<string>;
	agentSuggestionsSubmitting: boolean;
	allowedAgentIds: readonly string[];
	allowedProviderIds?: readonly string[];
	alreadyBuilt: boolean | null;
	autoImport: boolean;
	cloudSelection: AgentSelection;
	connectingToolkit: string | null;
	connectionQuery: string;
	connections: ComposioConnection[];
	connectionsCheckFailed: boolean;
	defaultProviderIds: readonly string[];
	freeCloud: boolean;
	importing: boolean;
	kind: OnboardingSetupKind;
	localSelection: AgentSelection;
	onBackgroundProfile: () => void;
	onCancelProfile: () => void;
	onChooseOrganization: (organizationId: string) => void;
	onCloudSelectionChange: (selection: AgentSelection) => void;
	onConfigureProvider: (providerId: string, apiKey: string) => void;
	onConnectToolkit: (
		toolkit: ComposioToolkit,
		accessLevel: ConnectionAccessLevel
	) => Promise<void>;
	onContinue: () => void;
	onContinueBackgroundProfile: () => void;
	onCreateAgentSuggestions: () => void;
	onImportThreads: () => void;
	onLocalSelectionChange: (selection: AgentSelection) => void;
	onSearchConnections: (query: string) => void;
	onSkip: () => void;
	onToggleAgentSuggestion: (id: string) => void;
	onToggleAutoImport: (enabled: boolean) => void;
	organizations: OnboardingOrganization[];
	piProviders: PiProvider[];
	profileJob: ProfileJobStatus | null;
	profileStartedAt: number | null;
	providerBusyId: string | null;
	selectedOrganizationId: string | null;
	target: ApiTarget;
	threadGroups: OnboardingThreadGroup[];
	toolkits: ComposioToolkit[];
}

function Shell({
	title,
	subtitle,
	children,
}: {
	children: ReactNode;
	subtitle: string;
	title: string;
}) {
	return (
		<div className="scroll-fade h-full w-full overflow-y-auto">
			<div
				className="flex min-h-full w-full flex-col items-center justify-center gap-8 p-8"
				data-tauri-drag-region="true"
			>
				<StaggerReveal>
					<div className="shrink-0">
						<GhostOrb size="50px" variant="outline" />
					</div>
					<PageHeader stagger={false} subtitle={subtitle} title={title} />
				</StaggerReveal>
				<div className="w-full max-w-xl">
					<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS} wrap>
						{children}
					</StaggerReveal>
				</div>
			</div>
		</div>
	);
}

function ContinueRow({
	onContinue,
	onSkip,
	continueLabel = "Continue",
	skipLabel = "Skip for now",
	disabled = false,
}: {
	continueLabel?: string;
	disabled?: boolean;
	onContinue: () => void;
	onSkip?: () => void;
	skipLabel?: string;
}) {
	return (
		<div className="flex items-center justify-between gap-3 pt-1">
			{onSkip ? (
				<Button disabled={disabled} onClick={onSkip} variant="ghost">
					{skipLabel}
				</Button>
			) : (
				<span />
			)}
			<Button disabled={disabled} onClick={onContinue} size="lg" variant="mono">
				{continueLabel}
			</Button>
		</div>
	);
}

function LanePicker({
	cloud,
	selection,
	target,
	allowedAgentIds,
	allowedProviderIds,
	onChange,
	onContinue,
	onSkip,
}: {
	allowedAgentIds: readonly string[];
	allowedProviderIds?: readonly string[];
	cloud: boolean;
	onChange: (selection: AgentSelection) => void;
	onContinue: () => void;
	onSkip?: () => void;
	selection: AgentSelection;
	target: ApiTarget;
}) {
	const isEmpty = !(
		selection.agent_id ||
		selection.model ||
		selection.provider
	);
	return (
		<SettingsCard className="flex flex-col gap-5">
			<div>
				<p className="font-medium text-sm">
					{cloud ? "Default cloud agent" : "Default local agent"}
				</p>
				<p className="mt-1 text-muted-foreground text-xs">
					{cloud
						? "Normal chats use this lane when it is configured. ACP agents keep their own model and permissions."
						: "Plugins, side-model calls, and local utility work use this lane so they stay useful even when cloud access is unavailable."}
				</p>
			</div>
			<AgentSelectionField
				allowedAgentIds={allowedAgentIds}
				allowedProviderIds={allowedProviderIds}
				ariaLabel={
					cloud ? "Choose default cloud agent" : "Choose default local agent"
				}
				onChange={onChange}
				preserveRyuRoute
				target={target}
				value={selection}
			/>
			{cloud ? null : (
				<div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-muted-foreground text-xs">
					Local models can produce a weaker initial setup. For the profile
					build, we recommend a stronger ACP agent or the Ryu cloud model.
				</div>
			)}
			{cloud && isEmpty ? (
				<p className="text-muted-foreground text-xs">
					No cloud default is configured yet. Chats will use your local default.
				</p>
			) : null}
			<ContinueRow
				continueLabel={cloud && isEmpty ? "Use local for now" : "Save default"}
				onContinue={onContinue}
				onSkip={onSkip}
			/>
		</SettingsCard>
	);
}

function OrganizationPicker({
	organizations,
	selectedOrganizationId,
	onChoose,
	onContinue,
}: {
	onChoose: (id: string) => void;
	onContinue: () => void;
	organizations: OnboardingOrganization[];
	selectedOrganizationId: string | null;
}) {
	return (
		<SettingsCard className="flex flex-col gap-3">
			{organizations.map((organization) => {
				const selected = selectedOrganizationId === organization.id;
				return (
					<button
						className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/5" : "border-border/70 hover:bg-muted/40"}`}
						key={organization.id}
						onClick={() => onChoose(organization.id)}
						type="button"
					>
						{organization.logo ? (
							// biome-ignore lint/performance/noImgElement: org logos are user-provided
							<img
								alt=""
								className="size-9 rounded-lg object-cover"
								src={organization.logo}
							/>
						) : (
							<div className="flex size-9 items-center justify-center rounded-lg bg-muted font-medium text-sm">
								{organization.name.slice(0, 1).toUpperCase()}
							</div>
						)}
						<span className="min-w-0 flex-1">
							<span className="block truncate font-medium text-sm">
								{organization.name}
							</span>
							<span className="block truncate text-muted-foreground text-xs">
								{organization.isPersonal
									? "Personal workspace"
									: organization.slug}
							</span>
						</span>
						<span className="text-muted-foreground text-xs capitalize">
							{organization.role ?? "member"}
						</span>
					</button>
				);
			})}
			<ContinueRow disabled={!selectedOrganizationId} onContinue={onContinue} />
		</SettingsCard>
	);
}

function ProviderLogo({ provider }: { provider: PiProvider }) {
	const hasBrand = Boolean(svglForProvider(`${provider.id} ${provider.label}`));
	return (
		<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
			{hasBrand ? (
				<ProviderBrandLogo
					providerKey={`${provider.id} ${provider.label}`}
					size={20}
				/>
			) : (
				<span className="font-medium text-sm">
					{provider.label.slice(0, 1).toUpperCase()}
				</span>
			)}
		</div>
	);
}

function ProviderSetup({
	providers,
	defaultProviderIds,
	freeCloud,
	busyId,
	onConfigure,
	onContinue,
}: {
	busyId: string | null;
	defaultProviderIds: readonly string[];
	freeCloud: boolean;
	onConfigure: (providerId: string, apiKey: string) => void;
	onContinue: () => void;
	providers: PiProvider[];
}) {
	const [keys, setKeys] = useState<Record<string, string>>({});
	const visible = providers.filter(
		(provider) =>
			provider.id !== "local" &&
			provider.id !== "gateway" &&
			(!freeCloud || provider.id !== "managed-openrouter")
	);
	const configuredCount = visible.filter(
		(provider) =>
			provider.configured || defaultProviderIds.includes(provider.id)
	).length;
	return (
		<div className="flex flex-col gap-3">
			<div
				className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-muted-foreground text-xs"
				data-testid="onboarding-provider-check"
			>
				{configuredCount > 0
					? [
							"Provider keys already set up — ",
							configuredCount,
							" configured provider",
							configuredCount === 1 ? "" : "s",
							" found on this node.",
						].join("")
					: "Connect a provider key if you want a cloud lane on the free plan. Keys stay on this node and are never shown again."}
			</div>
			{visible.map((provider) => {
				const key = keys[provider.id] ?? "";
				const configured =
					provider.configured || defaultProviderIds.includes(provider.id);
				return (
					<SettingsCard className="flex flex-col gap-3" key={provider.id}>
						<div className="flex items-center gap-3">
							<ProviderLogo provider={provider} />
							<div className="min-w-0 flex-1">
								<p className="font-medium text-sm">{provider.label}</p>
								<p className="text-muted-foreground text-xs">
									{configured
										? "Configured on this node"
										: provider.authKind === "subscription"
											? "Sign in to use this provider"
											: "API key"}
								</p>
							</div>
							{configured ? (
								<span className="text-success text-xs">Ready</span>
							) : null}
						</div>
						{configured ? null : (
							<div className="flex gap-2">
								<Input
									aria-label={`${provider.label} API key`}
									onChange={(event) =>
										setKeys((current) => ({
											...current,
											[provider.id]: event.target.value,
										}))
									}
									placeholder="Paste an API key"
									type="password"
									value={key}
								/>
								<Button
									disabled={!key.trim() || busyId === provider.id}
									loading={busyId === provider.id}
									onClick={() => onConfigure(provider.id, key.trim())}
									size="sm"
								>
									Connect
								</Button>
							</div>
						)}
					</SettingsCard>
				);
			})}
			<ContinueRow onContinue={onContinue} />
		</div>
	);
}

function ToolkitLogo({ toolkit }: { toolkit: ComposioToolkit }) {
	const hasBrand = Boolean(svglForProvider(`${toolkit.slug} ${toolkit.name}`));
	if (hasBrand) {
		return (
			<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
				<ProviderBrandLogo
					providerKey={`${toolkit.slug} ${toolkit.name}`}
					size={20}
				/>
			</div>
		);
	}
	if (toolkit.logo) {
		return (
			<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted p-2">
				{/* biome-ignore lint/performance/noImgElement: Composio supplies toolkit logos */}
				<img alt="" className="size-5 object-contain" src={toolkit.logo} />
			</div>
		);
	}
	return (
		<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted font-medium text-sm">
			{toolkit.name.slice(0, 1).toUpperCase()}
		</div>
	);
}

function ConnectionSetup({
	connectionsCheckFailed,
	connections,
	toolkits,
	query,
	connectingToolkit,
	onConnect,
	onContinue,
	onQuery,
}: {
	connectionsCheckFailed: boolean;
	connections: ComposioConnection[];
	connectingToolkit: string | null;
	onConnect: (
		toolkit: ComposioToolkit,
		accessLevel: ConnectionAccessLevel
	) => Promise<void>;
	onContinue: () => void;
	onQuery: (query: string) => void;
	query: string;
	toolkits: ComposioToolkit[];
}) {
	const [pendingToolkit, setPendingToolkit] = useState<ComposioToolkit | null>(
		null
	);
	const curated = useMemo(() => {
		const preferred = ["gmail", "notion", "slack", "github"];
		return preferred
			.map((slug) =>
				toolkits.find((toolkit) => {
					const toolkitSlug = toolkit.slug.toLowerCase();
					return (
						toolkitSlug === slug ||
						toolkitSlug.startsWith(`${slug}_`) ||
						toolkitSlug.startsWith(`${slug}-`)
					);
				})
			)
			.filter((toolkit): toolkit is ComposioToolkit => Boolean(toolkit));
	}, [toolkits]);
	const [showMore, setShowMore] = useState(false);
	const visible = showMore
		? toolkits
		: curated.length > 0
			? curated
			: toolkits.slice(0, 4);
	const connectionMap = new Map<string, ComposioConnection>();
	for (const connection of connections) {
		if (!connectionMap.has(connection.toolkit) || connection.active) {
			connectionMap.set(connection.toolkit, connection);
		}
	}
	return (
		<div className="flex flex-col gap-3">
			{connectionsCheckFailed ? (
				<SettingsCard className="flex flex-col gap-4">
					<p className="text-muted-foreground text-sm">
						Ryu could not verify your existing connections, so onboarding will
						not start another one.
					</p>
					<ContinueRow onContinue={onContinue} />
				</SettingsCard>
			) : null}
			{connectionsCheckFailed ? null : (
				<>
					{connections.some((connection) => connection.active) ? (
						<SettingsCard data-testid="onboarding-connections-check">
							<p className="font-medium text-sm">Connections already set up</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Ryu found{" "}
								{connections.filter((connection) => connection.active).length}{" "}
								connected source
								{connections.filter((connection) => connection.active)
									.length === 1
									? ""
									: "s"}
								. Existing connections will be left unchanged.
							</p>
						</SettingsCard>
					) : null}
					<div className="relative">
						<HugeiconsIcon
							className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							className="pl-9"
							onChange={(event) => onQuery(event.target.value)}
							placeholder="Search Gmail, Notion, Slack, GitHub, or more"
							value={query}
						/>
					</div>
					{toolkits.length === 0 ? (
						<SettingsCard>
							<p className="font-medium text-sm">Connections are optional</p>
							<p className="mt-1 text-muted-foreground text-sm">
								Composio is not configured on this node yet. You can continue
								now and add connections later in Settings → Connections.
							</p>
						</SettingsCard>
					) : (
						<div className="grid gap-3 sm:grid-cols-2">
							{visible
								.filter((toolkit) => {
									const term = query.trim().toLowerCase();
									return (
										!term ||
										toolkit.name.toLowerCase().includes(term) ||
										toolkit.slug.toLowerCase().includes(term)
									);
								})
								.map((toolkit) => {
									const connection = connectionMap.get(toolkit.slug);
									return (
										<SettingsCard
											className="flex items-center gap-3"
											key={toolkit.slug}
										>
											<ToolkitLogo toolkit={toolkit} />
											<div className="min-w-0 flex-1">
												<p className="truncate font-medium text-sm">
													{toolkit.name}
												</p>
												<p className="text-muted-foreground text-xs">
													{connection?.active
														? "Connected"
														: "Choose an access level before connecting"}
												</p>
											</div>
											<Button
												disabled={connection?.active}
												loading={connectingToolkit === toolkit.slug}
												onClick={() => setPendingToolkit(toolkit)}
												size="sm"
											>
												{connection?.active ? "Connected" : "Connect"}
											</Button>
										</SettingsCard>
									);
								})}
						</div>
					)}
					{!showMore && toolkits.length > curated.length ? (
						<Button
							className="self-start"
							onClick={() => setShowMore(true)}
							variant="ghost"
						>
							More integrations
						</Button>
					) : null}
					<ContinueRow onContinue={onContinue} />
				</>
			)}
			<ConnectionPermissionDialog
				connectionName={pendingToolkit?.name ?? "this integration"}
				connectionType="Composio"
				currentLevel={
					pendingToolkit
						? connectionMap.get(pendingToolkit.slug)?.accessLevel
						: undefined
				}
				onConfirm={async (accessLevel) => {
					if (!pendingToolkit) {
						return;
					}
					await onConnect(pendingToolkit, accessLevel);
					setPendingToolkit(null);
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPendingToolkit(null);
					}
				}}
				open={pendingToolkit !== null}
			/>
		</div>
	);
}

function ImportSetup({
	autoImport,
	groups,
	importing,
	onImport,
	onSkip,
	onToggle,
}: {
	autoImport: boolean;
	groups: OnboardingThreadGroup[];
	importing: boolean;
	onImport: () => void;
	onSkip: () => void;
	onToggle: (enabled: boolean) => void;
}) {
	const total = groups.reduce((sum, group) => sum + group.threads.length, 0);
	return (
		<SettingsCard className="flex flex-col gap-4">
			{groups.map((group) => (
				<div
					className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2"
					key={group.agentId}
				>
					<div>
						<p className="font-medium text-sm">{group.agentName}</p>
						<p className="text-muted-foreground text-xs">
							{group.threads.length} thread
							{group.threads.length === 1 ? "" : "s"} found
						</p>
					</div>
					<span className="font-mono text-muted-foreground text-xs">
						{group.threads.length}
					</span>
				</div>
			))}
			{total === 0 ? (
				<p className="text-muted-foreground text-sm">
					No importable threads were found on this node.
				</p>
			) : null}
			<div className="flex items-center justify-between gap-3 border-border/70 border-t pt-3">
				<div>
					<p className="font-medium text-sm">Auto-import future threads</p>
					<p className="text-muted-foreground text-xs">
						Keep new agent sessions available in Ryu automatically.
					</p>
				</div>
				<Switch checked={autoImport} onCheckedChange={onToggle} />
			</div>
			<ContinueRow
				continueLabel={total > 0 ? "Import threads" : "Continue"}
				disabled={importing}
				onContinue={total > 0 ? onImport : onSkip}
				onSkip={onSkip}
			/>
		</SettingsCard>
	);
}

const PROFILE_LINES = [
	"Reviewing your connected sources",
	"Looking for patterns in what you do",
	"Learning how your agent group fits together",
	"Drafting useful memories",
	"Checking recommendations before sharing them",
];

function ProfileSetup({
	alreadyBuilt,
	job,
	startedAt,
	onStart,
	onSkip,
	onBackground,
	onCancel,
	onContinueAfterBackground,
}: {
	alreadyBuilt: boolean | null;
	job: ProfileJobStatus | null;
	onBackground: () => void;
	onCancel: () => void;
	onContinueAfterBackground: () => void;
	onSkip: () => void;
	onStart: () => void;
	startedAt: number | null;
}) {
	const [lineIndex, setLineIndex] = useState(0);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!job || (job.state !== "queued" && job.state !== "building")) {
			return;
		}
		const interval = window.setInterval(() => {
			setLineIndex((current) => (current + 1) % PROFILE_LINES.length);
			setNow(Date.now());
		}, 1800);
		return () => window.clearInterval(interval);
	}, [job]);
	const elapsed = startedAt ? now - startedAt : 0;
	if (!job) {
		if (alreadyBuilt === null) {
			return (
				<SettingsCard
					className="flex flex-col gap-4"
					data-testid="onboarding-profile-check"
				>
					<p className="text-muted-foreground text-sm">
						Ryu could not verify whether a profile already exists, so onboarding
						will not start another profile build.
					</p>
					<ContinueRow continueLabel="Continue" onContinue={onSkip} />
				</SettingsCard>
			);
		}
		return (
			<SettingsCard
				className="flex flex-col gap-4"
				data-testid="onboarding-profile-check"
			>
				<p className="text-muted-foreground text-sm">
					{alreadyBuilt
						? "You already did this before. Ryu can rebuild the starting profile from your current connected sources and imported conversations."
						: "Ryu can create a starting profile from your connected sources and imported conversations. It will only draft facts and recommendations for you to review."}
				</p>
				{alreadyBuilt ? null : (
					<div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-muted-foreground text-xs">
						Local models may produce a weaker initial setup. We suggest using an
						ACP agent or the Ryu cloud model for this step.
					</div>
				)}
				<ContinueRow
					continueLabel={alreadyBuilt ? "Rebuild Profile" : "Build my profile"}
					onContinue={onStart}
					onSkip={onSkip}
				/>
			</SettingsCard>
		);
	}
	if (job.state === "failed") {
		return (
			<SettingsCard className="flex flex-col gap-4">
				<p className="font-medium text-sm">
					The profile build needs another try
				</p>
				<p className="text-muted-foreground text-xs">
					{job.error ?? "The agent could not finish the first draft."}
				</p>
				<ContinueRow
					continueLabel="Try again"
					onContinue={onStart}
					onSkip={onSkip}
				/>
			</SettingsCard>
		);
	}
	if (job.state === "completed") {
		const suggestionCount = job.agentSuggestions.length;
		return (
			<SettingsCard className="flex flex-col gap-4">
				<p className="font-medium text-sm">
					{suggestionCount > 0
						? `Your profile and ${suggestionCount} agent draft${suggestionCount === 1 ? "" : "s"} are ready`
						: "Your starting profile is ready"}
				</p>
				<p className="text-muted-foreground text-xs">
					Ryu wrote a user profile and a shared organization profile. You can
					review the source-backed draft in the new chat
					{suggestionCount > 0
						? " and choose which suggested agents to add."
						: "."}
				</p>
				<ContinueRow continueLabel="Continue" onContinue={onSkip} />
			</SettingsCard>
		);
	}
	return (
		<SettingsCard className="flex flex-col gap-4">
			<div
				aria-live="polite"
				className="min-h-14 rounded-lg bg-muted/40 px-3 py-3 text-sm"
				role="status"
			>
				<AnimatePresence mode="wait">
					<motion.span
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: -5 }}
						initial={{ opacity: 0, y: 5 }}
						key={PROFILE_LINES[lineIndex]}
					>
						{PROFILE_LINES[lineIndex]}
					</motion.span>
				</AnimatePresence>
			</div>
			<p className="text-muted-foreground text-xs">
				{job.materialized
					? "Your profile chat is running in the background. Wait here to review agent drafts when it finishes, or continue setup now."
					: "The connected content is read-only and treated as untrusted data. Recommendations never change your agents or external accounts automatically."}
			</p>
			<div className="flex items-center justify-between text-muted-foreground text-xs">
				<span>{Math.floor(elapsed / 1000)}s elapsed</span>
				{elapsed >= 20_000 && !job.materialized ? (
					<Button onClick={onBackground} size="sm" variant="outline">
						Run in background
					</Button>
				) : null}
			</div>
			<div className="flex items-center justify-between gap-3">
				<Button onClick={onCancel} variant="ghost">
					Skip and cancel
				</Button>
				{job.materialized ? (
					<Button onClick={onContinueAfterBackground} size="sm" variant="mono">
						Continue setup
					</Button>
				) : null}
			</div>
		</SettingsCard>
	);
}

export function OnboardingSetupStep(props: OnboardingSetupStepProps) {
	const { kind } = props;
	if (kind === "local-default") {
		return (
			<Shell
				subtitle="Choose the local default used by plugins and utility work. Ryu starts with Gemma 4."
				title="Set your local default"
			>
				<LanePicker
					allowedAgentIds={props.allowedAgentIds}
					cloud={false}
					onChange={props.onLocalSelectionChange}
					onContinue={props.onContinue}
					selection={props.localSelection}
					target={props.target}
				/>
			</Shell>
		);
	}
	if (kind === "organization") {
		return (
			<Shell
				subtitle="Choose the workspace Ryu should open with. You can switch organizations later."
				title="Choose your organization"
			>
				<OrganizationPicker
					onChoose={props.onChooseOrganization}
					onContinue={props.onContinue}
					organizations={props.organizations}
					selectedOrganizationId={props.selectedOrganizationId}
				/>
			</Shell>
		);
	}
	if (kind === "providers") {
		return (
			<Shell
				subtitle="Connect a provider only if you want cloud chats on the free plan. You can add more later."
				title="Configure provider keys"
			>
				<ProviderSetup
					busyId={props.providerBusyId}
					defaultProviderIds={props.defaultProviderIds}
					freeCloud={props.freeCloud}
					onConfigure={props.onConfigureProvider}
					onContinue={props.onContinue}
					providers={props.piProviders}
				/>
			</Shell>
		);
	}
	if (kind === "connections") {
		return (
			<Shell
				subtitle="Connect Gmail, Notion, Slack, GitHub, or another Composio source. You can connect more later."
				title="Connect your accounts"
			>
				<ConnectionSetup
					connectingToolkit={props.connectingToolkit}
					connections={props.connections}
					connectionsCheckFailed={props.connectionsCheckFailed}
					onConnect={props.onConnectToolkit}
					onContinue={props.onContinue}
					onQuery={props.onSearchConnections}
					query={props.connectionQuery}
					toolkits={props.toolkits}
				/>
			</Shell>
		);
	}
	if (kind === "cloud-default") {
		return (
			<Shell
				subtitle={
					props.freeCloud
						? "Choose a configured BYOK provider, or keep cloud unset and use local chats."
						: "Paid plans start with Ryu on managed OpenRouter. You can choose another configured provider."
				}
				title="Set your cloud default"
			>
				<LanePicker
					allowedAgentIds={props.allowedAgentIds}
					allowedProviderIds={props.allowedProviderIds}
					cloud
					onChange={props.onCloudSelectionChange}
					onContinue={props.onContinue}
					onSkip={props.freeCloud ? props.onSkip : undefined}
					selection={props.cloudSelection}
					target={props.target}
				/>
			</Shell>
		);
	}
	if (kind === "imports") {
		return (
			<Shell
				subtitle="Bring existing agent sessions into Ryu as searchable conversations."
				title="Import existing threads"
			>
				<ImportSetup
					autoImport={props.autoImport}
					groups={props.threadGroups}
					importing={props.importing}
					onImport={props.onImportThreads}
					onSkip={props.onSkip}
					onToggle={props.onToggleAutoImport}
				/>
			</Shell>
		);
	}
	if (kind === "agent-suggestions") {
		return (
			<Shell
				subtitle="Choose the helpers you want to add."
				title="Suggested agents for your work"
			>
				<AgentSuggestionsStep
					busy={props.agentSuggestionsSubmitting}
					connectedApps={connectedAppDetails(props.connections, props.toolkits)}
					error={props.agentSuggestionsError}
					onCreate={props.onCreateAgentSuggestions}
					onSkip={props.onSkip}
					onToggle={props.onToggleAgentSuggestion}
					selected={props.agentSuggestionsSelected}
					suggestions={props.agentSuggestions}
				/>
			</Shell>
		);
	}
	return (
		<Shell
			subtitle="Give Ryu a useful starting point without changing your accounts or agents."
			title="Build your initial profile"
		>
			<ProfileSetup
				alreadyBuilt={props.alreadyBuilt}
				job={props.profileJob}
				onBackground={props.onBackgroundProfile}
				onCancel={props.onCancelProfile}
				onContinueAfterBackground={props.onContinueBackgroundProfile}
				onSkip={props.onSkip}
				onStart={props.onContinue}
				startedAt={props.profileStartedAt}
			/>
		</Shell>
	);
}
