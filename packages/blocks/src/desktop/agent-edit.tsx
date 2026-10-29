"use client";
import type { CSSProperties } from "react";
import styles from "./agent-edit.module.css";

// Presentational layer of the desktop one-page agent editor. The live app
// (`apps/desktop/src/pages/AgentEditPage.tsx` + its `components/agents/*`
// sub-components) is a thin container that owns all state, hooks, and API
// calls and renders these views with real data + handlers; the storyboard
// renders the same views with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.
//
// Everything here is presentational: props + no-op default handlers, no hooks
// at module scope, no Tauri / context / stores / `@/...` app imports. Only
// `@ryu/ui/*`, icons, and `react` types. The PlateJS markdown editor used by
// the real "Instructions" field and Prompt Studio cannot render as a pure
// server component, so the block accepts an injected editor node (or falls
// back to a read-only textarea) instead of importing PlateJS.

import {
	Add01Icon,
	ArrowDown01Icon,
	Brain01Icon,
	CheckmarkBadge04Icon,
	Clock01Icon,
	Copy01Icon,
	Delete01Icon,
	GitBranchIcon,
	GridIcon,
	Link01Icon,
	LockedIcon,
	Message01Icon,
	Refresh01Icon,
	Search01Icon,
	Tick01Icon,
	Tick02Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import {
	type RenderableBackdrop,
	resolveMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Input } from "@ryu/ui/components/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@ryu/ui/components/input-group";
import { Label } from "@ryu/ui/components/label";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Separator } from "@ryu/ui/components/separator";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import { Textarea } from "@ryu/ui/components/textarea";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	AgentBannerDialog,
	type AgentBannerPreferenceStore,
	AgentBannerWash,
	AgentProfileBannerFade,
	resolveAgentBanner,
	useAgentBannerPrefs,
} from "./agent-banner-dialog.tsx";
import { formatToolDisplayName } from "./agent-elements/tools/tool-registry.ts";
import {
	AGENT_INTEGRATION_SNIPPET_LANGS,
	type AgentIntegrationSnippetLang,
} from "./agent-integration-snippets.ts";
import {
	AGENT_ACCOUNT_ACCESS_SETTING_ID,
	AGENT_SETTINGS_ENTRIES,
	AGENT_TAB_LABELS,
	type AgentSettingsEntry,
	type AgentSettingsTab,
	revealAgentSetting,
	searchAgentSettings,
} from "./agent-settings-search.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

// ── Memory / Spaces slot (live) ────────────────────────────────────────────────

/** The five memory scope levels an agent may recall from. Leaving all personal
 * levels unchecked means "all personal levels" — the back-compat default Core
 * applies for agents configured before this slot existed. Organization memory
 * stays explicit because it is shared with every member of the organization. */
const MEMORY_READ_LEVELS: { hint: string; label: string; value: string }[] = [
	{
		value: "agent",
		label: "Agent",
		hint: "Memories scoped to this agent.",
	},
	{
		value: "user",
		label: "User",
		hint: "Personal memories for the signed-in user.",
	},
	{
		value: "node",
		label: "Node",
		hint: "Memories shared across this device / node.",
	},
	{
		value: "project",
		label: "Project",
		hint: "Memories scoped to the active project.",
	},
	{
		value: "org",
		label: "Organization",
		hint: "Memories shared across this organization.",
	},
];

export interface MemorySpacesCardProps {
	disabled?: boolean;
	memoryReadLevels: Set<string>;
	memorySpaceIds: Set<string>;
	memoryWriteEnabled: boolean;
	onMemoryWriteEnabledChange?: (v: boolean) => void;
	onToggleMemoryReadLevel?: (level: string) => void;
	onToggleMemorySpace?: (id: string) => void;
	/** Show the per-scope recall checkboxes. The simple editor hides them and
	 *  keeps Core's default (all personal levels). */
	showReadLevels?: boolean;
	spaces: SpaceRow[];
}

/** Live Memory / Spaces slot: pick readable Spaces, recallable memory levels,
 * and whether the agent may record new memories. Replaces the old "coming soon"
 * SlotCard. */
export function MemorySpacesCard({
	spaces,
	memorySpaceIds,
	onToggleMemorySpace,
	memoryReadLevels,
	onToggleMemoryReadLevel,
	memoryWriteEnabled,
	onMemoryWriteEnabledChange,
	disabled = false,
	showReadLevels = true,
}: MemorySpacesCardProps) {
	return (
		<SettingsSection
			caption={
				showReadLevels
					? "Give this agent long-term memory. Choose which Spaces it may read for retrieval, which memory levels it may recall, and whether it may record new memories."
					: "Choose which Spaces this agent may read, and whether it may remember new things."
			}
			headerAction={
				memorySpaceIds.size > 0 ? (
					<Badge variant="secondary">{memorySpaceIds.size}</Badge>
				) : undefined
			}
			title="Memory & Spaces"
		>
			<SettingsCard className="flex flex-col gap-4">
				<div className="flex flex-col gap-2">
					<span className="font-medium text-sm">Readable Spaces</span>
					<p className="text-muted-foreground text-xs">
						Vector Spaces this agent may inject into chat for retrieval. Leave
						all unchecked to inject none.
					</p>
					{spaces.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No Spaces yet. Create one on the Spaces page to grant access.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							{spaces.map((space) => {
								const checkId = `memory-space-${space.id}`;
								return (
									<div className="flex items-center gap-3" key={space.id}>
										<Checkbox
											checked={memorySpaceIds.has(space.id)}
											disabled={disabled}
											id={checkId}
											onCheckedChange={() => onToggleMemorySpace?.(space.id)}
										/>
										<Label htmlFor={checkId} variant="agent-choice">
											{space.name}
										</Label>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{showReadLevels ? <Separator /> : null}

				{showReadLevels ? (
					<div className="flex flex-col gap-2">
						<span className="font-medium text-sm">Memory levels</span>
						<p className="text-muted-foreground text-xs">
							Which memory scopes this agent may recall from. Leave all
							unchecked to allow all personal levels (agent, user, node, and
							project).
						</p>
						<div className="flex flex-col gap-2">
							{MEMORY_READ_LEVELS.map((level) => {
								const checkId = `memory-level-${level.value}`;
								return (
									<div className="flex items-start gap-3" key={level.value}>
										<Checkbox
											checked={memoryReadLevels.has(level.value)}
											disabled={disabled}
											id={checkId}
											onCheckedChange={() =>
												onToggleMemoryReadLevel?.(level.value)
											}
										/>
										<Label htmlFor={checkId} variant="agent-choice">
											<span className="font-medium">{level.label}</span>
											<span className="block text-muted-foreground text-xs">
												{level.hint}
											</span>
										</Label>
									</div>
								);
							})}
						</div>
					</div>
				) : null}
			</SettingsCard>

			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={memoryWriteEnabled}
							disabled={disabled}
							id="memory-write-enabled"
							onCheckedChange={onMemoryWriteEnabledChange}
						/>
					}
					description="When on, the agent may record new memories during a session. When off, it can only recall existing ones."
					title="Allow writing memories"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

// ── Live preview card (ChatGPT/Notion-style agent summary) ─────────────────────

/** Placeholder text for the model-id input, varying by options + routing. */
function modelIdPlaceholder(hasOptions: boolean, routing: string): string {
	if (hasOptions) {
		return "…or type a custom model id";
	}
	if (routing === "gateway") {
		return "Model id the Gateway routes (e.g. gpt-4o)";
	}
	return "Model id for this provider";
}

function PreviewChip({
	icon,
	children,
}: {
	icon: ReactNode;
	children: ReactNode;
}) {
	return (
		<span className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs">
			<span className="shrink-0 text-muted-foreground">{icon}</span>
			<span className="truncate">{children}</span>
		</span>
	);
}

export interface AgentPreviewCardProps {
	builtIn: boolean;
	displayName: string;
	instructions: string;
	locked: boolean;
	modelLabel: string | null;
	name: string;
	scheduleSummary: string | null;
	toneLabel: string | null;
	tools: string[];
}

export function AgentPreviewCard({
	builtIn,
	displayName,
	instructions,
	locked,
	modelLabel,
	name,
	scheduleSummary,
	toneLabel,
	tools,
}: AgentPreviewCardProps) {
	const heading = displayName.trim() || name.trim() || "New agent";
	const subtitle =
		name.trim() && name.trim() !== heading ? name.trim() : "Agent";
	const hasMeta = Boolean(
		modelLabel || toneLabel || scheduleSummary || tools.length > 0
	);

	let badge: ReactNode = null;
	if (builtIn) {
		badge = (
			<Badge className="ml-auto shrink-0" variant="secondary">
				<HugeiconsIcon className="size-3" icon={LockedIcon} />
				Built-in
			</Badge>
		);
	} else if (locked) {
		badge = (
			<Badge className="ml-auto shrink-0" variant="secondary">
				<HugeiconsIcon className="size-3" icon={LockedIcon} />
				Locked
			</Badge>
		);
	}

	return (
		<div className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
			<div className="flex items-center gap-3">
				<div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
					<RyuLogo size="24px" tone="foreground" variant="outline" />
				</div>
				<div className="flex min-w-0 flex-col">
					<span className="truncate font-medium text-base leading-tight">
						{heading}
					</span>
					<span className="truncate text-muted-foreground text-xs">
						{subtitle}
					</span>
				</div>
				{badge}
			</div>

			{hasMeta ? (
				<div className="flex flex-wrap gap-1.5">
					{modelLabel ? (
						<PreviewChip
							icon={<HugeiconsIcon className="size-3" icon={Message01Icon} />}
						>
							{modelLabel}
						</PreviewChip>
					) : null}
					{toneLabel ? (
						<PreviewChip
							icon={<HugeiconsIcon className="size-3" icon={Brain01Icon} />}
						>
							{toneLabel}
						</PreviewChip>
					) : null}
					{scheduleSummary ? (
						<PreviewChip
							icon={<HugeiconsIcon className="size-3" icon={Clock01Icon} />}
						>
							{scheduleSummary}
						</PreviewChip>
					) : null}
					{tools.map((tool) => (
						<PreviewChip
							icon={<HugeiconsIcon className="size-3" icon={Wrench01Icon} />}
							key={tool}
						>
							{tool}
						</PreviewChip>
					))}
				</div>
			) : null}

			<Separator />

			<div className="flex flex-col gap-2">
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Instructions
				</span>
				{instructions.trim() ? (
					<div className="max-h-72 overflow-auto">
						<p className="whitespace-pre-wrap text-foreground/90 text-sm leading-relaxed">
							{instructions.trim()}
						</p>
					</div>
				) : (
					<p className="text-muted-foreground text-sm italic">
						No instructions yet. Describe how this agent should behave on the
						left.
					</p>
				)}
			</div>
		</div>
	);
}

// ── Claude Code gateway routing (per-agent) ───────────────────────────────────
// The real container wraps this in its Settings primitives + toast; the
// presentational shape is a labelled switch row + a "keep in mind" note.

export interface ClaudeGatewayConfigViewProps {
	enabled?: boolean;
	/** A line shown under the switch while the agent's account access is
	 * limited, since this routing can decide whether its engine starts. */
	limitedNotice?: string | null;
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function ClaudeGatewayConfigView({
	enabled = true,
	limitedNotice = null,
	loaded = true,
	onToggle,
}: ClaudeGatewayConfigViewProps) {
	return (
		<SettingsSection
			caption={
				<>
					Route Claude Code's model traffic through the Ryu gateway so the
					firewall, PII/DLP redaction, and audit log govern it. Your Claude
					Pro/Max subscription is preserved — the gateway forwards your own
					login upstream unchanged and never uses an API key. Don't set{" "}
					<code>ANTHROPIC_API_KEY</code> or <code>ANTHROPIC_AUTH_TOKEN</code> —
					either overrides your subscription and switches you to API billing.
					The proxy is loopback-only: it only governs Claude Code running on
					this machine, so your subscription login never leaves your device.
				</>
			}
			title="Gateway routing"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={enabled}
							disabled={!loaded}
							id="claude-gateway-routing"
							onCheckedChange={onToggle}
						/>
					}
					description="On (default): Claude Code routes subscription egress through the local gateway (loopback-only), which applies request-side redaction + audit before forwarding your login upstream. Turn it off to keep direct egress. Takes effect the next time Claude Code starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
			{limitedNotice ? (
				<p
					className="px-3.5 text-status-warning text-xs leading-snug"
					role="status"
				>
					{limitedNotice}
				</p>
			) : null}
		</SettingsSection>
	);
}

// ── Codex gateway routing (per-agent) ─────────────────────────────────────────
// Mirrors the Claude Code view; Codex's ChatGPT-login (subscription) traffic is
// routed through the gateway passthrough while the OAuth + ChatGPT-Account-ID are
// forwarded upstream unchanged.

export interface CodexGatewayConfigViewProps {
	enabled?: boolean;
	/** A line shown under the switch while the agent's account access is
	 * limited, since this routing can decide whether its engine starts. */
	limitedNotice?: string | null;
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function CodexGatewayConfigView({
	enabled = true,
	limitedNotice = null,
	loaded = true,
	onToggle,
}: CodexGatewayConfigViewProps) {
	return (
		<SettingsSection
			caption={
				<>
					Route Codex's model traffic through the Ryu gateway so the firewall,
					PII/DLP redaction, and audit log govern it. This governs your{" "}
					<strong>ChatGPT-login</strong> (subscription) Codex — the gateway
					forwards your own OAuth login and account id upstream unchanged and
					never injects an API key, so your subscription billing is preserved.
					The proxy is loopback-only: it only governs Codex running on this
					machine, so your subscription login never leaves your device.
				</>
			}
			title="Gateway routing"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={enabled}
							disabled={!loaded}
							id="codex-gateway-routing"
							onCheckedChange={onToggle}
						/>
					}
					description="On (default): Codex routes subscription egress through the local gateway (loopback-only), which applies request-side redaction + audit before forwarding your login upstream. Turn it off to keep direct egress. Takes effect the next time Codex starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
			{limitedNotice ? (
				<p
					className="px-3.5 text-status-warning text-xs leading-snug"
					role="status"
				>
					{limitedNotice}
				</p>
			) : null}
		</SettingsSection>
	);
}

// ── Generic per-agent gateway routing (BYO OpenAI-compatible agents) ──────────
// The "point any agent at the Ryu gateway via the OpenAI base-URL swap" toggle.
// Like the Claude/Codex views, this is Gateway-governed by default, but it is
// honest about scope: it only takes effect for an agent whose client
// reads OPENAI_BASE_URL — i.e. an OpenAI-compatible BYO agent.

export interface GatewayRoutingConfigViewProps {
	enabled?: boolean;
	/** A line shown under the switch while the agent's account access is
	 * limited, since this routing can decide whether its engine starts. */
	limitedNotice?: string | null;
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function GatewayRoutingConfigView({
	enabled = true,
	limitedNotice = null,
	loaded = true,
	onToggle,
}: GatewayRoutingConfigViewProps) {
	return (
		<SettingsSection
			caption={
				<>
					Point this agent at the Ryu gateway instead of a provider. When on,
					Ryu injects <code>OPENAI_BASE_URL</code> + <code>OPENAI_API_KEY</code>{" "}
					(the local gateway) into the agent at launch, so its model calls are
					governed by the firewall, PII/DLP redaction, budgets, and audit log —
					no manual environment wiring on your part. This only takes effect for
					agents that read <code>OPENAI_BASE_URL</code> (an OpenAI-compatible
					agent); agents that speak another wire format or use their own gateway
					ignore it. The gateway is loopback-only, so the agent's traffic is
					governed on this machine before it leaves your device.
				</>
			}
			title="Gateway routing"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={enabled}
							disabled={!loaded}
							id="agent-gateway-routing"
							onCheckedChange={onToggle}
						/>
					}
					description="On (default): the agent's OpenAI-compatible endpoint uses the local gateway (loopback-only), where its traffic is governed. Turn it off to keep direct provider egress. Takes effect the next time the agent starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
			{limitedNotice ? (
				<p
					className="px-3.5 text-status-warning text-xs leading-snug"
					role="status"
				>
					{limitedNotice}
				</p>
			) : null}
		</SettingsSection>
	);
}

// ── Ryu Pi config (model + provider for the managed Pi) ───────────────────────

export interface PiProviderMeta {
	authKind?: string;
	configured?: boolean;
	id: string;
	label: string;
	/** "gateway" | "direct" — kept as a loose string to match Core's catalog. */
	routing?: string;
	suggestedModels?: string[];
}

/** One pickable model row for the Pi config searchable picker. */
export interface PiModelOption {
	group?: string | null;
	id: string;
	name: string;
}

/** A compact id/label option shared by the editor's injected selectors. */
export interface SlotOption {
	id: string;
	label: string;
}

export interface RyuPiConfigViewProps {
	apiKey?: string;
	apiTypeItems?: SlotOption[];
	canSave?: boolean;
	configDir?: string | null;
	customApi?: string;
	customBaseUrl?: string;
	/** Custom-provider fields. */
	customId?: string;
	error?: string | null;
	isCustomNew?: boolean;
	loading?: boolean;
	model?: string;
	/** Pickable models (grouped by provider). Renders a searchable picker above the free-text id box. */
	modelOptions?: PiModelOption[];
	/** True while provider model discovery is in flight. */
	modelsLoading?: boolean;
	onApiKeyChange?: (v: string) => void;
	onCustomApiChange?: (v: string) => void;
	onCustomBaseUrlChange?: (v: string) => void;
	onCustomIdChange?: (v: string) => void;
	onModelChange?: (v: string) => void;
	onProviderChange?: (v: string) => void;
	onSave?: () => void;
	onThinkingLevelChange?: (v: string) => void;
	/** Selected provider id (or the custom sentinel). */
	provider?: string;
	providerItems?: SlotOption[];
	/** "gateway" | "direct" — loose string to match Core's catalog payload. */
	routing?: string;
	saved?: boolean;
	saveError?: string | null;
	saving?: boolean;
	selectedMeta?: PiProviderMeta | null;
	showApiKey?: boolean;
	thinkingItems?: SlotOption[];
	thinkingLevel?: string;
}

function LabeledSelect({
	id,
	label,
	items,
	value,
	placeholder,
	onValueChange,
}: {
	id: string;
	label: string;
	items: SlotOption[];
	value: string;
	placeholder?: string;
	onValueChange?: (v: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Select
				items={items.map((i) => ({ value: i.id, label: i.label }))}
				onValueChange={(v) => onValueChange?.(v ?? "")}
				value={value}
			>
				<SelectTrigger className="w-full" id={id}>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent>
					{items.map((opt) => (
						<SelectItem key={opt.id} value={opt.id}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function CredentialHint({ meta }: { meta: PiProviderMeta }) {
	if (meta.configured) {
		return (
			<span className="flex items-center gap-1 text-muted-foreground text-xs">
				<HugeiconsIcon
					className="size-3 text-status-success"
					icon={CheckmarkBadge04Icon}
				/>
				Credential configured
			</span>
		);
	}
	let hint: string | null = null;
	if (meta.authKind === "api-key") {
		hint = "No credential yet — add an API key below.";
	} else if (meta.authKind === "subscription") {
		hint = "Subscription provider — sign in with Pi /login.";
	}
	if (!hint) {
		return null;
	}
	return <span className="text-muted-foreground text-xs">{hint}</span>;
}

function sortPiModelGroups(
	groups: { label: string | null; items: PiModelOption[] }[]
): { label: string | null; items: PiModelOption[] }[] {
	const rank = (label: string | null): number => (label === "Local" ? 0 : 1);
	return [...groups].sort((a, b) => {
		const ra = rank(a.label);
		const rb = rank(b.label);
		if (ra !== rb) {
			return ra - rb;
		}
		return (a.label ?? "").localeCompare(b.label ?? "");
	});
}

function PiModelPicker({
	id,
	options,
	value,
	onValueChange,
	loading,
}: {
	id: string;
	options: PiModelOption[];
	value: string;
	onValueChange?: (v: string) => void;
	loading?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLowerCase();

	const groups = useMemo(() => {
		const filtered = normalizedQuery
			? options.filter((model) => {
					const hay =
						`${model.name} ${model.id} ${model.group ?? ""}`.toLowerCase();
					return hay.includes(normalizedQuery);
				})
			: options;

		const grouped: { label: string | null; items: PiModelOption[] }[] = [];
		for (const model of filtered) {
			const label = model.group ?? null;
			const existing = grouped.find((g) => g.label === label);
			if (existing) {
				existing.items.push(model);
			} else {
				grouped.push({ label, items: [model] });
			}
		}
		return sortPiModelGroups(grouped);
	}, [options, normalizedQuery]);

	const hasGroups = groups.some((g) => g.label !== null);
	const selectedLabel =
		options.find((o) => o.id === value)?.name ?? value ?? "Pick a model";

	const renderRow = (model: PiModelOption) => {
		const isActive = model.id === value;
		return (
			<Button
				appearance="agent-model-option"
				key={model.id}
				onClick={() => {
					onValueChange?.(model.id);
					setOpen(false);
					setQuery("");
				}}
				type="button"
				variant={isActive ? "secondary" : "ghost"}
			>
				<span className="flex w-full items-center gap-2">
					<span className="flex-1 truncate" title={model.name}>
						{model.name}
					</span>
					{isActive ? (
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={Tick02Icon}
							size={16}
							strokeWidth={2}
						/>
					) : null}
				</span>
			</Button>
		);
	};

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						appearance="agent-model-picker"
						aria-labelledby={id}
						id={id}
						type="button"
						variant="outline"
					>
						<span className="truncate">{selectedLabel}</span>
						<HugeiconsIcon
							className="shrink-0 opacity-50"
							icon={ArrowDown01Icon}
							size={16}
						/>
					</Button>
				}
			/>
			<PopoverContent
				align="start"
				className="w-[min(300px,var(--available-width))]"
				spacing="flush"
			>
				<div className="flex max-h-80 flex-col">
					<div className="sticky top-0 z-10">
						<Input
							aria-label="Filter models"
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search models…"
							size="agent-detail"
							value={query}
						/>
					</div>
					<div className="scroll-fade min-h-0 flex-1 overflow-y-auto p-1">
						{loading ? (
							<p className="flex items-center gap-2 px-3 py-4 text-muted-foreground text-xs">
								<Spinner className="size-3" /> Loading models…
							</p>
						) : null}
						{!loading && groups.length === 0 ? (
							<p className="px-3 py-4 text-center text-muted-foreground text-xs">
								No models match &ldquo;{query.trim()}&rdquo;
							</p>
						) : null}
						{loading || hasGroups
							? groups.map((group) => (
									<div key={group.label ?? "__ungrouped__"}>
										{group.label ? (
											<div className="type-caption px-3 pt-2 pb-1 font-medium text-muted-foreground">
												{group.label}
											</div>
										) : null}
										{group.items.map(renderRow)}
									</div>
								))
							: groups.flatMap((g) => g.items).map(renderRow)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function RyuPiConfigView({
	loading,
	error,
	routing = "gateway",
	configDir,
	provider = "",
	providerItems = [],
	selectedMeta,
	isCustomNew = false,
	customId = "",
	customApi = "openai-completions",
	customBaseUrl = "",
	apiTypeItems = [],
	model = "",
	modelOptions = [],
	modelsLoading = false,
	thinkingLevel = "",
	thinkingItems = [],
	showApiKey = false,
	apiKey = "",
	canSave = false,
	saving,
	saved,
	saveError,
	onProviderChange,
	onCustomIdChange,
	onCustomApiChange,
	onCustomBaseUrlChange,
	onModelChange,
	onThinkingLevelChange,
	onApiKeyChange,
	onSave,
}: RyuPiConfigViewProps) {
	if (loading) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground text-sm">
				<Spinner className="size-4" /> Loading Pi configuration…
			</div>
		);
	}
	if (error) {
		return (
			<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-status-destructive">
				Failed to load Pi configuration: {error}
			</div>
		);
	}

	return (
		<SettingsSection
			caption={
				<>
					The Ryu agent runs Core&apos;s own Pi against an isolated config
					(never your personal <code>~/.pi</code>). Pick the provider and model
					Pi should use.
				</>
			}
			headerAction={
				<Badge
					size="compact"
					variant={routing === "gateway" ? "default" : "secondary"}
				>
					{routing === "gateway" ? "Gateway governed" : "Direct egress"}
				</Badge>
			}
			title="Pi model & provider"
		>
			<SettingsCard className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<LabeledSelect
						id="pi-provider"
						items={providerItems}
						label="Provider"
						onValueChange={onProviderChange}
						placeholder="Select a provider"
						value={provider}
					/>
					{selectedMeta && !isCustomNew ? (
						<CredentialHint meta={selectedMeta} />
					) : null}
				</div>

				{isCustomNew ? (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="pi-custom-id">Provider id</Label>
							<Input
								id="pi-custom-id"
								onChange={(e) => onCustomIdChange?.(e.target.value)}
								placeholder="ollama"
								value={customId}
							/>
						</div>
						<LabeledSelect
							id="pi-custom-api"
							items={apiTypeItems}
							label="API type"
							onValueChange={(v) =>
								onCustomApiChange?.(v || "openai-completions")
							}
							value={customApi}
						/>
						<div className="flex flex-col gap-1.5 sm:col-span-2">
							<Label htmlFor="pi-custom-url">Base URL</Label>
							<Input
								id="pi-custom-url"
								onChange={(e) => onCustomBaseUrlChange?.(e.target.value)}
								placeholder="http://localhost:11434/v1"
								value={customBaseUrl}
							/>
						</div>
					</div>
				) : null}

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="pi-model">Model</Label>
					{modelOptions.length > 0 ? (
						<PiModelPicker
							id="pi-model"
							loading={modelsLoading}
							onValueChange={onModelChange}
							options={modelOptions}
							value={model}
						/>
					) : null}
					<Input
						id={modelOptions.length > 0 ? "pi-model-custom" : "pi-model"}
						onChange={(e) => onModelChange?.(e.target.value)}
						placeholder={modelIdPlaceholder(modelOptions.length > 0, routing)}
						value={model}
					/>
				</div>

				<LabeledSelect
					id="pi-thinking"
					items={thinkingItems}
					label="Thinking level"
					onValueChange={(v) => onThinkingLevelChange?.(v || "")}
					value={thinkingLevel}
				/>

				{showApiKey ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="pi-key">API key</Label>
						<Input
							autoComplete="off"
							id="pi-key"
							onChange={(e) => onApiKeyChange?.(e.target.value)}
							placeholder={
								selectedMeta?.configured
									? "Stored — leave blank to keep"
									: "Stored in auth.json"
							}
							type="password"
							value={apiKey}
						/>
						<span className="text-muted-foreground text-xs">
							Direct-provider calls bypass the Ryu Gateway. The key is written
							only to Ryu&apos;s isolated Pi config.
						</span>
					</div>
				) : null}

				{saveError ? (
					<p className="text-status-destructive text-xs">{saveError}</p>
				) : null}
				<div className="flex items-center gap-3">
					<Button
						disabled={!canSave}
						loading={saving}
						onClick={onSave}
						type="button"
					>
						Save Pi config
					</Button>
					{saved && !saving ? (
						<span className="flex items-center gap-1 text-status-success text-xs">
							<HugeiconsIcon className="size-3" icon={CheckmarkBadge04Icon} />
							Saved
						</span>
					) : null}
					{configDir ? (
						<span
							className="type-compact ml-auto truncate text-muted-foreground"
							title={configDir}
						>
							{configDir}
						</span>
					) : null}
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

// ── Bring external agent (BYOA) ───────────────────────────────────────────────

export interface AgentByoaViewProps {
	agentId: string;
	copied?: "url" | "key" | null;
	error?: string | null;
	gatewayUrl?: string | null;
	generatedKey?: string | null;
	hasKey?: boolean;
	loading?: boolean;
	onCopyKey?: () => void;
	onCopyUrl?: () => void;
	onGenerate?: () => void;
	saving?: boolean;
}

export function AgentByoaView({
	agentId,
	loading,
	error,
	hasKey = false,
	gatewayUrl,
	generatedKey,
	saving,
	copied,
	onCopyUrl,
	onCopyKey,
	onGenerate,
}: AgentByoaViewProps) {
	return (
		<SettingsSection
			caption="Point any OpenAI-compatible agent (OpenClaw, Hermes, LangChain, etc.) at the Ryu gateway as its base URL. It authenticates with the key below, and the gateway applies Ryu's firewall, per-agent budget, and routing — without changing the agent code."
			headerAction={
				hasKey ? <Badge variant="secondary">Key registered</Badge> : undefined
			}
			title="Bring external agent"
		>
			<SettingsCard className="flex flex-col gap-3">
				{loading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<Spinner className="size-3" />
						Loading…
					</div>
				) : null}
				{!loading && error ? (
					<p className="text-status-destructive text-xs">{error}</p>
				) : null}
				{loading || error ? null : (
					<div className="flex flex-col gap-3">
						{gatewayUrl ? (
							<div className="flex flex-col gap-1.5">
								<Label size="compact">Gateway base URL</Label>
								<div className="flex items-center gap-2">
									<Input
										readOnly
										size="compact"
										value={`${gatewayUrl}/v1`}
										variant="code"
									/>
									<Button
										aria-label={
											copied === "url"
												? "Copied gateway URL"
												: "Copy gateway URL"
										}
										onClick={onCopyUrl}
										size="icon-sm"
										variant="ghost"
									>
										{copied === "url" ? (
											<HugeiconsIcon
												className="size-3 text-status-success"
												icon={Tick01Icon}
											/>
										) : (
											<HugeiconsIcon className="size-3" icon={Copy01Icon} />
										)}
									</Button>
								</div>
								<p className="text-muted-foreground text-xs">
									Set this as your agent's{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										base_url
									</code>{" "}
									or{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										OPENAI_BASE_URL
									</code>
									.
								</p>
							</div>
						) : null}

						{generatedKey ? (
							<div className="flex flex-col gap-1.5">
								<Label size="compact" spacing="tight">
									Gateway API key
									<span className="type-compact rounded bg-warning/10 px-1 text-status-warning dark:bg-warning/30">
										Copy now — not shown again
									</span>
								</Label>
								<div className="flex items-center gap-2">
									<Input
										readOnly
										size="compact"
										value={generatedKey}
										variant="code"
									/>
									<Button
										aria-label={
											copied === "key" ? "Copied API key" : "Copy API key"
										}
										onClick={onCopyKey}
										size="icon-sm"
										variant="ghost"
									>
										{copied === "key" ? (
											<HugeiconsIcon
												className="size-3 text-status-success"
												icon={Tick01Icon}
											/>
										) : (
											<HugeiconsIcon className="size-3" icon={Copy01Icon} />
										)}
									</Button>
								</div>
								<p className="text-muted-foreground text-xs">
									Set this as your agent's{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										api_key
									</code>{" "}
									or{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										OPENAI_API_KEY
									</code>
									. The gateway applies Ryu's firewall and per-agent budget to
									all requests tagged with{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										x-ryu-agent-id: {agentId}
									</code>
									.
								</p>
							</div>
						) : null}
						{!generatedKey && hasKey ? (
							<p className="text-muted-foreground text-xs">
								A key is registered for this agent. Regenerate to rotate it.
							</p>
						) : null}

						<Button
							className="self-start"
							loading={saving}
							onClick={onGenerate}
							size="sm"
							variant={hasKey ? "outline" : "default"}
						>
							{!saving && (
								<HugeiconsIcon className="size-3" icon={Refresh01Icon} />
							)}
							{hasKey ? "Regenerate key" : "Generate gateway key"}
						</Button>
					</div>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}

// ── Integrations ─────────────────────────────────────────────────────────────

interface IntegrationCardProps {
	code: string;
	description: string;
	icon: ReactNode;
	title: string;
}

function IntegrationCard({
	code,
	description,
	icon,
	title,
}: IntegrationCardProps) {
	return (
		<div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-background p-3.5">
			<div className="flex items-center gap-2">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
					{icon}
				</div>
				<h4 className="min-w-0 font-medium text-sm">{title}</h4>
			</div>
			<p className="text-muted-foreground text-xs leading-relaxed">
				{description}
			</p>
			<pre className="type-compact max-h-40 overflow-auto rounded-md bg-muted/70 p-2.5 font-mono leading-relaxed">
				<code translate="no">{code}</code>
			</pre>
		</div>
	);
}

export interface AgentIntegrationsViewProps {
	agentId: string;
	byoaPanel?: ReactNode;
	copied?: boolean;
	coreUrl: string;
	githubActionsSnippet: string;
	hasToken?: boolean;
	lang?: AgentIntegrationSnippetLang;
	onCopy?: () => void;
	onLangChange?: (lang: AgentIntegrationSnippetLang) => void;
	onOpenDocs?: () => void;
	snippet: string;
}

export function AgentIntegrationsView({
	agentId,
	byoaPanel,
	copied = false,
	coreUrl,
	githubActionsSnippet,
	hasToken = false,
	lang = "typescript",
	onCopy,
	onLangChange,
	onOpenDocs,
	snippet,
}: AgentIntegrationsViewProps) {
	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Call the saved agent from a Node app, Python service, Go program, or any client that can send JSON over HTTP. The agent's tools, rules, and Gateway policies still apply."
				headerAction={
					<div className="flex items-center gap-1.5">
						<Badge typography="code" variant="secondary">
							<span translate="no">{agentId}</span>
						</Badge>
						<Badge variant="outline">HTTP + SSE</Badge>
					</div>
				}
				title="Call your agent from code"
			>
				<SettingsCard className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-1">
						{AGENT_INTEGRATION_SNIPPET_LANGS.map((option) => (
							<Button
								aria-pressed={lang === option.id}
								key={option.id}
								onClick={() => onLangChange?.(option.id)}
								size="sm"
								type="button"
								variant={lang === option.id ? "secondary" : "ghost"}
							>
								{option.label}
							</Button>
						))}
						<Button
							aria-label={copied ? "Code sample copied" : "Copy code sample"}
							className="ml-auto"
							onClick={onCopy}
							size="icon-sm"
							type="button"
							variant="ghost"
						>
							{copied ? (
								<HugeiconsIcon
									aria-hidden="true"
									className="size-3 text-status-success"
									icon={Tick01Icon}
								/>
							) : (
								<HugeiconsIcon
									aria-hidden="true"
									className="size-3"
									icon={Copy01Icon}
								/>
							)}
						</Button>
					</div>

					<pre className="type-caption max-h-[28rem] overflow-auto rounded-md border bg-background p-3 font-mono leading-relaxed">
						<code translate="no">{snippet}</code>
					</pre>
					<p className="text-muted-foreground text-xs">
						The TypeScript example uses{" "}
						<code
							className="type-caption rounded bg-muted px-1 font-mono"
							translate="no"
						>
							@ryuhq/client
						</code>{" "}
						to call a saved agent. Use{" "}
						<code
							className="type-caption rounded bg-muted px-1 font-mono"
							translate="no"
						>
							@ryuhq/sdk
						</code>{" "}
						when you are authoring a new agent, tool, or app.
					</p>

					<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
						<p className="text-muted-foreground">
							Endpoint{" "}
							<code
								className="type-caption rounded bg-muted px-1 font-mono"
								translate="no"
							>
								{coreUrl}/api/chat/stream
							</code>
						</p>
						{onOpenDocs ? (
							<Button
								onClick={onOpenDocs}
								size="sm"
								type="button"
								variant="link"
							>
								Read integration docs
							</Button>
						) : null}
					</div>

					<p aria-live="polite" className="text-muted-foreground text-xs">
						{hasToken ? (
							<>
								This node requires auth. Keep its token in{" "}
								<code
									className="type-caption rounded bg-muted px-1 font-mono"
									translate="no"
								>
									RYU_TOKEN
								</code>
								and out of source control.
							</>
						) : (
							"This local node currently accepts requests without a token."
						)}
					</p>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Use the path that matches where the work happens. Accounts and app permissions stay in the Connections tab."
				title="Other ways to use this agent"
			>
				<div className="grid gap-3 md:grid-cols-3">
					<IntegrationCard
						code={githubActionsSnippet}
						description="Run the saved agent from pull requests, releases, and other CI jobs."
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4"
								icon={GitBranchIcon}
							/>
						}
						title="GitHub Actions"
					/>
					<IntegrationCard
						code={
							"bunx create-ryu-app my-agent-app --template ryu-app\nbunx ryu pack ."
						}
						description="Wrap an agent tool or result in an interactive widget that renders inside chat."
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4"
								icon={GridIcon}
							/>
						}
						title="Build a Ryu App"
					/>
					<IntegrationCard
						code={`ryu-mcp serve\nRYU_CORE_URL=${coreUrl}${
							hasToken ? "\nRYU_CORE_TOKEN=$RYU_TOKEN" : ""
						}`}
						description="Expose governed Ryu tools to Claude, Codex, or another MCP host."
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4"
								icon={Link01Icon}
							/>
						}
						title="MCP host"
					/>
				</div>
			</SettingsSection>

			{byoaPanel}
		</div>
	);
}

// ── Evals view ─────────────────────────────────────────────────────────────────

export interface EvalStat {
	label: string;
	tone?: string;
	value: string;
}

export interface EvalCaseRow {
	/** Substring-match label already formatted (e.g. "100%") or null for "—". */
	matchLabel: string | null;
	prompt: string;
	responseText: string;
	scoreLabel: string;
	scoreTone?: string;
}

export interface AuditRow {
	id: string;
	isError?: boolean;
	latencyLabel: string;
	model: string;
	scoreLabel: string;
	time: string;
	tokens: number;
}

/** One per-evaluator aggregate row (from `aggregate.evaluators`). */
export interface EvaluatorResultRow {
	/** Honesty: false when the evaluator never actually executed. */
	didExecute?: boolean;
	/** Executed-case count, e.g. "4 / 4" or "not run (0)". */
	executed: string;
	id: string;
	/** Mean score formatted (e.g. "82%"). */
	meanScore: string;
	/** Display name (falls back to the id when the catalog lacks it). */
	name: string;
	/** Pass rate formatted (e.g. "3/4" or "75%"). */
	passRate: string;
	/** Tone class for the score cell. */
	tone?: string;
}

export interface AgentEvalsViewProps {
	cases?: EvalCaseRow[];
	/**
	 * The shared evaluator catalog picker (offline mode), injected by the
	 * container so this presentational block stays app-decoupled. Rendered inside
	 * the Run-evals card so selection sits next to the Run button.
	 */
	catalog?: ReactNode;
	/** Per-evaluator aggregate rows for the selected offline evaluators. */
	evaluatorRows?: EvaluatorResultRow[];
	historyEntries?: AuditRow[];
	historyLoading?: boolean;
	historyReachable?: boolean | null;
	model?: string;
	/**
	 * Why Run is disabled when no model is set (e.g. the node has no default
	 * model configured). Shown under the model field; `null` hides it.
	 */
	modelHint?: string | null;
	onModelChange?: (v: string) => void;
	onReloadHistory?: () => void;
	onRun?: () => void;
	runError?: string | null;
	running?: boolean;
	stats?: EvalStat[];
}

function EvalStatCard({ label, value, tone }: EvalStat) {
	return (
		<div className="flex flex-col gap-0.5 rounded-lg border bg-muted/30 p-2">
			<span className="type-compact text-muted-foreground uppercase tracking-wide">
				{label}
			</span>
			<span className={`font-medium text-sm ${tone ?? ""}`}>{value}</span>
		</div>
	);
}

export function AgentEvalsView({
	model = "",
	modelHint = null,
	running,
	runError,
	stats = [],
	cases = [],
	catalog,
	evaluatorRows = [],
	historyLoading,
	historyReachable,
	historyEntries = [],
	onModelChange,
	onRun,
	onReloadHistory,
}: AgentEvalsViewProps) {
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
			<SettingsSection
				caption="Scores latency · tokens · policy · expected-match."
				title="Run evals"
			>
				<SettingsCard className="flex flex-col gap-3">
					<div className="flex flex-wrap items-end gap-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="eval-model" size="compact">
								Model
							</Label>
							<Input
								className="w-56"
								id="eval-model"
								onChange={(e) => onModelChange?.(e.target.value)}
								placeholder="Model id"
								size="compact"
								value={model}
							/>
						</div>
						<Button
							disabled={!model.trim()}
							loading={running}
							onClick={onRun}
							size="sm"
						>
							{running ? "Running…" : "Run evals"}
						</Button>
					</div>

					{modelHint ? (
						<p className="text-muted-foreground text-xs">{modelHint}</p>
					) : null}

					{runError ? (
						<p className="text-status-destructive text-xs">{runError}</p>
					) : null}

					{catalog ? (
						<div className="rounded-lg border bg-muted/20 p-3">{catalog}</div>
					) : null}

					{stats.length > 0 ? (
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							{stats.map((s) => (
								<EvalStatCard
									key={s.label}
									label={s.label}
									tone={s.tone}
									value={s.value}
								/>
							))}
						</div>
					) : null}

					{cases.length > 0 ? (
						<div className="overflow-hidden rounded-lg border">
							<table className="w-full text-left text-xs">
								<thead className="bg-muted/50 text-muted-foreground">
									<tr>
										<th className="px-2 py-1.5 font-medium">Prompt</th>
										<th className="px-2 py-1.5 font-medium">Response</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Match
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Score
										</th>
									</tr>
								</thead>
								<tbody>
									{cases.map((c, i) => (
										<tr
											className="border-t align-top"
											key={`${c.prompt.slice(0, 16)}-${i}`}
										>
											<td
												className="max-w-40 truncate px-2 py-1.5"
												title={c.prompt}
											>
												{c.prompt}
											</td>
											<td
												className="max-w-64 truncate px-2 py-1.5 text-muted-foreground"
												title={c.responseText}
											>
												{c.responseText}
											</td>
											<td className="px-2 py-1.5 text-right tabular-nums">
												{c.matchLabel ?? "—"}
											</td>
											<td
												className={`px-2 py-1.5 text-right font-medium tabular-nums ${c.scoreTone ?? ""}`}
											>
												{c.scoreLabel}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}

					{evaluatorRows.length > 0 ? (
						<div className="overflow-hidden rounded-lg border">
							<table className="w-full text-left text-xs">
								<thead className="bg-muted/50 text-muted-foreground">
									<tr>
										<th className="px-2 py-1.5 font-medium">Evaluator</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Mean score
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Pass rate
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Executed
										</th>
									</tr>
								</thead>
								<tbody>
									{evaluatorRows.map((r) => (
										<tr className="border-t align-top" key={r.id}>
											<td className="px-2 py-1.5">
												<span className="font-medium">{r.name}</span>
												{r.didExecute === false ? (
													<Badge
														appearance="agent-count"
														className="ml-1.5"
														variant="outline"
													>
														not run
													</Badge>
												) : null}
											</td>
											<td
												className={`px-2 py-1.5 text-right font-medium tabular-nums ${r.tone ?? ""}`}
											>
												{r.meanScore}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
												{r.passRate}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
												{r.executed}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Recent model calls through the gateway."
				headerAction={
					<Button
						aria-label="Reload run history"
						loading={historyLoading}
						onClick={onReloadHistory}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-3.5" icon={Refresh01Icon} />
					</Button>
				}
				title="Run history"
			>
				<SettingsCard className="flex flex-col gap-3">
					{historyReachable === false ? (
						<p className="text-muted-foreground text-xs">
							Gateway audit is unavailable (gateway down or auditing disabled).
						</p>
					) : null}

					{historyEntries.length === 0 && historyReachable !== false ? (
						<p className="text-muted-foreground text-xs">
							{historyLoading ? "Loading…" : "No runs recorded yet."}
						</p>
					) : null}

					{historyEntries.length > 0 ? (
						<div className="overflow-auto rounded-lg border">
							<table className="w-full text-left text-xs">
								<thead className="bg-muted/50 text-muted-foreground">
									<tr>
										<th className="px-2 py-1.5 font-medium">Time</th>
										<th className="px-2 py-1.5 font-medium">Model</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Tokens
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Latency
										</th>
										<th className="px-2 py-1.5 text-right font-medium">
											Score
										</th>
									</tr>
								</thead>
								<tbody>
									{historyEntries.map((e) => (
										<tr className="border-t" key={e.id}>
											<td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
												{e.time}
											</td>
											<td className="max-w-40 truncate px-2 py-1.5">
												{e.isError ? (
													<Badge variant="destructive">error</Badge>
												) : null}
												{e.model}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
												{formatCount(e.tokens) ?? "—"}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
												{e.latencyLabel}
											</td>
											<td className="px-2 py-1.5 text-right tabular-nums">
												{e.scoreLabel}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}

// ── Settings form (the main editor body) ──────────────────────────────────────

export interface ToneOptionItem {
	label: string;
	value: string;
}

export interface SkillRow {
	description?: string | null;
	enabled?: boolean;
	id: string;
	name: string;
}

/** A Space the agent may be granted read access to (Memory / Spaces slot). */
export interface SpaceRow {
	id: string;
	name: string;
}

export interface ComposioActionRow {
	description?: string | null;
	displayName: string;
	name: string;
}

export interface ComposioTriggerRow {
	displayName: string;
	name: string;
}

/** One connected account an event trigger may watch (already filtered to the
 *  accounts this agent may use). */
export interface ComposioAccountOption {
	id: string;
	/** Short human label, e.g. "gmail · Active". */
	label: string;
	/** Whose account it is: one of yours (the default), or one connected to
	 *  this agent's own identity. */
	owner?: "agent" | "you";
	toolkit: string;
}

/** The picker label of a trigger account, naming whose account it is when the
 *  agent may watch both kinds. */
export function triggerAccountLabel(account: ComposioAccountOption): string {
	if (account.owner === "agent") {
		return `This agent's account · ${account.label}`;
	}
	if (account.owner === "you") {
		return `Your account · ${account.label}`;
	}
	return account.label;
}

export interface TriggerSubRow {
	id: string;
	/** Whether it watches an account connected to the agent's own identity. */
	ownAccount?: boolean;
	/** Whether the identity and account access on screen stop its events
	 *  (the account it watches is no longer allowed). */
	paused?: boolean;
	toolkit: string;
	triggerSlug: string;
}

export interface AgentSettingsFormProps {
	/** Injected: which accounts this agent may use (the allowlist editor),
	 *  rendered under Connections in place of `identityPanel`. */
	accountAccessPanel?: ReactNode;
	acpCommand: string;
	/** Injected: ACP auth ("Login with X") + session list controls for external
	 *  agents. Self-hides for agents that report no auth methods or sessions. */
	acpSessionPanel?: ReactNode;

	// Advanced inference (injected — it is its own coupled component)
	advancedInference?: ReactNode;
	/** Optional icon node shown in the identity header (the agent's logo). */
	agentIcon?: ReactNode;
	/** Injected compact setup composer that combines instructions and model choice. */
	agentSetupComposer?: ReactNode;
	/** Optional role/title badge shown beside the agent name. */
	agentTitle?: string;
	/** Stable id and node preference store for the shared agent banner. */
	bannerAgentId?: string;
	bannerPreferenceStore?: AgentBannerPreferenceStore;
	/** Injected: the current agent's Gateway token budget editor. */
	budgetPanel?: ReactNode;
	/** Injected: the per-agent Calendar view, rendered as its own tab. Omit to
	 *  hide the tab. */
	calendarPanel?: ReactNode;
	/** Injected: the per-agent capability controls (tools / thinking / vision,
	 *  orchestration), rendered in the Advanced tab. */
	capabilitiesPanel?: ReactNode;
	/** Injected: the per-agent Channels panel (control-plane bot bindings). */
	channelsPanel?: ReactNode;

	// Model slots
	chatModel: string;
	/** Injected shared provider/model command picker for the live desktop app. */
	chatModelPicker?: ReactNode;
	chatSlotDisabled?: boolean;
	/** Injected: ClaudeGatewayConfig for `acp:claude`. */
	claudeConfig?: ReactNode;
	/** Injected: CodexGatewayConfig for `acp:codex`. */
	codexConfig?: ReactNode;
	/** Connected accounts the trigger picker may offer. Omit to keep the
	 *  free-text account id field (hosts without a connection list). */
	composioAccounts?: ComposioAccountOption[];
	composioActions: ComposioActionRow[];
	composioActionsLoading?: boolean;

	// Composio actions
	composioConfigured: boolean;
	composioToolkit: string | null;
	composioToolkitItems: SlotOption[];
	composioTriggers: ComposioTriggerRow[];
	connectedAccountId: string;
	customCron: string;
	customTone: string;
	dailyTime: string;
	/** One-line agent description (identity header). */
	description?: string;
	/** Injected: the live employee badge, shown as a pinned profile artifact. */
	employeeBadge?: ReactNode;
	engineOptions: SlotOption[];
	/** Injected: the Evals view, rendered as its own tab. Omit to hide the tab. */
	evalsPanel?: ReactNode;
	/** Injected: lifecycle (draft/trial/active) and safety profile controls,
	 *  rendered at the top of Tools & knowledge in every mode — schedules need an
	 *  Active agent, so the simple editor cannot hide it. */
	executionPolicyPanel?: ReactNode;

	// Save
	formError?: string | null;
	/** Injected: generic GatewayRoutingConfig for BYO/other ACP agents. */
	gatewayRoutingConfig?: ReactNode;

	/** Injected: the bot's optional goal and main-thread reply length, which
	 *  persist on their own (scope guidance). Rendered under the instructions. */
	goalPanel?: ReactNode;
	/** Compact health grade shown in the agent profile header. */
	healthBadge?: ReactNode;
	/** Injected deterministic configuration health scorecard. */
	healthPanel?: ReactNode;
	/** Injected: the per-agent run-history view (chats + automated runs),
	 *  rendered as its own tab. Omit to hide the tab. */
	historyPanel?: ReactNode;
	/** Injected: whether the agent acts as you, has its own identity, or both.
	 *  Rendered at the top of Tools & knowledge in every mode. */
	identityModePanel?: ReactNode;
	/** Injected: the per-agent Identity Vault profile picker (empty = none).
	 *  Superseded by `accountAccessPanel`, which carries the same picker. */
	identityPanel?: ReactNode;
	/** Open on this indexed setting (an `AGENT_SETTINGS_ENTRIES` id): switch to
	 *  the tab that holds it once that tab is shown, and flash the row once. */
	initialSettingId?: string;
	/** Optional starting tab for storyboards and other presentational hosts. */
	initialTab?: AgentSettingsTab;
	/** Injected rich editor node for Instructions; falls back to a textarea. */
	instructionsEditor?: ReactNode;

	/** Injected: code samples and external integration paths for this agent. */
	integrationsPanel?: ReactNode;
	isBuiltIn: boolean;
	isLocked: boolean;
	isNew: boolean;
	/** Injected: ModelLaunchConfigSection when a tunable local engine is picked. */
	launchConfig?: ReactNode;
	marketplaceWallpapers?: readonly RenderableBackdrop[];

	// Memory / Spaces slot
	/** Memory scope levels the agent may recall from (subset of
	 * agent/user/node/project/org). Empty = all personal levels (the back-compat
	 * default); organization memory must be explicit. */
	memoryReadLevels: Set<string>;
	/** Space IDs the agent may read for retrieval. Empty = no Spaces injected. */
	memorySpaceIds: Set<string>;
	/** Whether the agent may record new memories during a session. */
	memoryWriteEnabled: boolean;
	// Identity
	name: string;
	/** Injected: the traceable identity + activity ledger for this agent,
	 *  rendered as its own tab beside run history. */
	observabilityPanel?: ReactNode;
	onAcpCommandChange?: (v: string) => void;
	/** Open the Customize store on the Agents tab to install more engines. */
	onAddMoreAgentProviders?: () => void;
	onAddRule?: () => void;
	onAgentTitleChange?: (v: string) => void;
	onCancel?: () => void;
	onChatModelChange?: (v: string) => void;
	/** Clear the currently-shown toolkit's actions from the selection. */
	onClearComposio?: () => void;
	onComposioToolkitChange?: (v: string | null) => void;
	onConnectedAccountIdChange?: (v: string) => void;
	onCreateAndChat?: () => void;
	onCustomCronChange?: (v: string) => void;
	onCustomToneChange?: (v: string) => void;
	onDailyTimeChange?: (v: string) => void;
	onDeleteTrigger?: (id: string) => void;
	onDescriptionChange?: (v: string) => void;
	onInstallWallpaper?: (
		wallpaper: RenderableBackdrop
	) => boolean | Promise<boolean>;
	onMemoryWriteEnabledChange?: (v: boolean) => void;
	onNameChange?: (v: string) => void;
	/** Simple mode only: open the advanced editor (the Agent workspace). Omit when the
	 *  viewer has no Console access; the link is then not offered. */
	onOpenAdvanced?: () => void;
	onOpenPromptStudio?: () => void;
	onPersonaDisplayNameChange?: (v: string) => void;
	/** Select the reusable personality profile assigned to this agent. */
	onPersonalityProfileChange?: (v: string) => void;
	onRemoveRule?: (index: number) => void;
	onRuleChange?: (index: number, value: string) => void;
	onSave?: () => void;
	onScheduleEnabledChange?: (v: boolean) => void;
	onSchedulePhraseChange?: (v: string) => void;
	/** Select every action of the currently-shown toolkit ("all tools"). */
	onSelectAllComposio?: () => void;
	onSubscribeTrigger?: () => void;
	onToggleComposio?: (name: string) => void;
	onToggleMemoryReadLevel?: (level: string) => void;
	onToggleMemorySpace?: (id: string) => void;
	onToggleSkill?: (id: string) => void;
	onToggleTool?: (name: string) => void;
	onToneChange?: (v: string) => void;
	onTriggerSlugChange?: (v: string) => void;
	onWeeklyDayChange?: (v: string) => void;
	onWeeklyTimeChange?: (v: string) => void;
	/** Injected: history-backed cost optimizations (cheaper model, unused
	 *  tools), rendered beside Quality tests. Omit to hide the view. */
	optimizationsPanel?: ReactNode;
	/** Whether the identity on screen gives the agent accounts of its own, so
	 *  the trigger picker can point to them when it has none to offer. */
	ownAccountsAllowed?: boolean;
	passportPanel?: ReactNode;

	// Persona
	personaDisplayName: string;
	/** Current personality profile id, or the caller's sentinel for the agent's own voice. */
	personalityProfile?: string;
	/** Available plugin/user personality profiles, including the agent's own voice option. */
	personalityProfiles?: SlotOption[];
	/** Injected: RyuPiConfig for the `ryu` agent. */
	piConfig?: ReactNode;

	// Preview — retained for back-compat (storyboard). The two-pane editor no
	// longer renders a preview aside; the live builder chat is the left pane.
	preview?: AgentPreviewCardProps;
	/** Injected: the Prompt Studio editor, rendered as its own tab. Omit to hide
	 *  the tab (e.g. for brand-new agents that have no record yet). */
	promptStudioPanel?: ReactNode;

	/** Injected: persistent agent routines with run destinations and controls. */
	routinesPanel?: ReactNode;

	// Rules
	rules: string[];
	/** Injected Agent Edit panel supplied by a plugin (for example Rules). */
	rulesPanel?: ReactNode;
	saveDisabled?: boolean;
	saving?: boolean;
	scheduleEnabled?: boolean;
	schedulePhrase: string;
	selectedComposio: Set<string>;
	selectedSkills: Set<string>;
	selectedTools: Set<string>;
	/** True when the "Run a custom agent command…" engine option is selected. */
	showAcpCommand?: boolean;

	// Composio event triggers
	showComposioTriggers?: boolean;
	/** Hide the model tab/step for the simplified interface preset. */
	showModelPanel?: boolean;
	/** Essentials only (Bot): Behavior, Tools & knowledge, and Triggers.
	 *  Every other tab stays in the advanced editor (the Agent workspace). */
	simple?: boolean;
	skills: SkillRow[];

	// Skills
	skillsLoading?: boolean;
	/** Spaces available to grant this agent read access to (Memory / Spaces slot). */
	spaces: SpaceRow[];
	subscribing?: boolean;
	systemPrompt: string;
	tone: string;
	toneOptions: ToneOptionItem[];
	tools: string[];

	// Tools
	toolsLoading?: boolean;
	triggerError?: string | null;
	triggerSlug: string;
	triggerSubs: TriggerSubRow[];
	/** Injected: complete agent-definition history with diff and restore. */
	versionHistoryPanel?: ReactNode;
	weeklyDay: string;
	weeklyTime: string;
}

const WEEKDAYS = [
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
	"sunday",
];

const SCHEDULE_PHRASE_ITEMS = [
	{ value: "everyminute", label: "Every minute" },
	{ value: "hourly", label: "Every hour" },
	{ value: "daily", label: "Every day at…" },
	{ value: "weekdays", label: "Weekdays at…" },
	{ value: "weekends", label: "Weekends at…" },
	{ value: "weekly", label: "Every week on…" },
	{ value: "custom", label: "Custom cron" },
];

const PROFILE_DITHER_SETTINGS = {
	color: "#B497CF",
	edgeFade: 0.5,
	enableRipples: true,
	patternDensity: 1,
	patternScale: 2,
	pixelSize: 3,
	rippleIntensityScale: 1,
	rippleSpeed: 0.3,
	rippleThickness: 0.1,
	speed: 0.5,
	transparent: true,
	variant: "square",
} as const;

function squarePixelTileDataUri(): string {
	const spacing =
		PROFILE_DITHER_SETTINGS.pixelSize *
		PROFILE_DITHER_SETTINGS.patternScale *
		PROFILE_DITHER_SETTINGS.patternDensity;
	const dot = PROFILE_DITHER_SETTINGS.pixelSize;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${spacing}" height="${spacing}" viewBox="0 0 ${spacing} ${spacing}"><rect width="${dot}" height="${dot}" fill="${PROFILE_DITHER_SETTINGS.color}"/></svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

interface ProfileDitherStyle extends CSSProperties {
	"--agent-profile-dither-fade"?: string;
	"--agent-profile-dither-image"?: string;
	"--agent-profile-dither-size"?: string;
}
function DitherLayer({ className }: { className?: string }) {
	const spacing =
		PROFILE_DITHER_SETTINGS.pixelSize *
		PROFILE_DITHER_SETTINGS.patternScale *
		PROFILE_DITHER_SETTINGS.patternDensity;
	return (
		<div
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-0",
				styles.dither,
				className
			)}
			style={
				{
					"--agent-profile-dither-image": squarePixelTileDataUri(),
					"--agent-profile-dither-size": `${spacing}px ${spacing}px`,
					"--agent-profile-dither-fade": `${Math.round((1 - PROFILE_DITHER_SETTINGS.edgeFade) * 100)}%`,
				} satisfies ProfileDitherStyle as ProfileDitherStyle
			}
		/>
	);
}

/** The editor's identity row: picture, name, one-line description, and the save
 *  actions. Deliberately small — the profile card (banner, badge, lanyard) is a
 *  cosmetic extra and lives under Advanced, not above every setting. */
function ProfileHeader({
	agentIcon,
	builtIn,
	description,
	healthBadge,
	isLocked,
	isNew,
	modelLabel,
	name,
	onCreateAndChat,
	onDescriptionChange,
	onNameChange,
	onSave,
	saveDisabled,
	saving,
}: {
	agentIcon?: ReactNode;
	builtIn: boolean;
	description?: string;
	healthBadge?: ReactNode;
	isLocked: boolean;
	isNew: boolean;
	modelLabel: string;
	name: string;
	onCreateAndChat?: () => void;
	onDescriptionChange?: (v: string) => void;
	onNameChange?: (v: string) => void;
	onSave?: () => void;
	saveDisabled?: boolean;
	saving?: boolean;
}) {
	return (
		<section aria-label="Agent profile" className="flex items-start gap-4">
			<div className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-card">
				{agentIcon ?? <RyuLogo size="28px" tone="foreground" />}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Label className="sr-only" htmlFor="agent-name">
					Name
				</Label>
				<Input
					disabled={isLocked}
					id="agent-name"
					onChange={(e) => onNameChange?.(e.target.value)}
					placeholder="Name your agent"
					value={name}
					variant="agent-profile-name"
				/>
				<Label className="sr-only" htmlFor="agent-description">
					Description
				</Label>
				<Input
					disabled={isLocked}
					id="agent-description"
					onChange={(e) => onDescriptionChange?.(e.target.value)}
					placeholder="What is it for? e.g. Drafts replies to support email"
					value={description ?? ""}
					variant="agent-profile-description"
				/>
				<div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					<span className="truncate">{modelLabel || "No model selected"}</span>
					{builtIn ? <Badge variant="outline">Core</Badge> : null}
					{healthBadge}
					{isLocked ? (
						<Badge variant="secondary">
							<HugeiconsIcon className="size-3" icon={LockedIcon} />
							Locked
						</Badge>
					) : null}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button
					disabled={saveDisabled}
					onClick={onCreateAndChat}
					size="sm"
					variant="ghost"
				>
					{isNew ? "Create & chat" : "Chat"}
				</Button>
				<Button
					disabled={saveDisabled}
					loading={saving}
					onClick={onSave}
					size="sm"
				>
					{isNew ? "Create agent" : "Save"}
				</Button>
			</div>
		</section>
	);
}

/** Cosmetic profile extras: the banner (with its customise dialog), the
 *  lanyard badge, the short badge text, and the persona display name. Advanced
 *  only — none of it changes what the agent does. */
function ProfileCardSection({
	agentTitle,
	badge,
	bannerAgentId,
	bannerPreferenceStore,
	isLocked,
	marketplaceWallpapers = [],
	name,
	onAgentTitleChange,
	onInstallWallpaper,
	onPersonaDisplayNameChange,
	personaDisplayName,
}: {
	agentTitle: string;
	badge?: ReactNode;
	bannerAgentId?: string;
	bannerPreferenceStore?: AgentBannerPreferenceStore;
	isLocked: boolean;
	marketplaceWallpapers?: readonly RenderableBackdrop[];
	name: string;
	onAgentTitleChange?: (v: string) => void;
	onInstallWallpaper?: (
		wallpaper: RenderableBackdrop
	) => boolean | Promise<boolean>;
	onPersonaDisplayNameChange?: (v: string) => void;
	personaDisplayName: string;
}) {
	// Prefs live in their own module with the dialog that edits them, so this
	// section only has to know how to PAINT one.
	const {
		error: bannerStorageError,
		loading: bannerLoading,
		prefs,
		reset,
		update,
	} = useAgentBannerPrefs(bannerAgentId ?? name, bannerPreferenceStore, name);
	const bannerIdentity = bannerAgentId ?? name;
	const banner = resolveAgentBanner(bannerIdentity, prefs);
	const marketplaceWallpaper = resolveMarketplaceWallpaperSelection(
		prefs.wallpaper
	);

	return (
		<SettingsSection
			caption="How this agent looks on its profile and badge. Nothing here changes what it does."
			title="Profile card"
		>
			<div
				className={cn(
					"relative min-h-36 overflow-hidden rounded-lg",
					styles.banner
				)}
			>
				{marketplaceWallpaper ? (
					<Backdrop
						className="absolute inset-0"
						definition={marketplaceWallpaper}
						live={false}
						params={marketplaceWallpaper.initialParams}
					/>
				) : (
					<AgentBannerWash banner={banner} />
				)}
				{isLocked ? null : (
					<div className="absolute top-3 left-3 z-10">
						<AgentBannerDialog
							agent={bannerIdentity}
							loading={bannerLoading}
							marketplaceWallpapers={marketplaceWallpapers}
							onInstallWallpaper={onInstallWallpaper}
							onReset={reset}
							onUpdate={update}
							prefs={prefs}
							storageError={bannerStorageError}
						/>
					</div>
				)}
				<AgentProfileBannerFade />
				{badge ? (
					<div className="absolute top-3 right-3 bottom-3 hidden w-32 sm:block">
						<div className="relative h-full overflow-hidden rounded-lg border border-white/25 bg-background/12 shadow-2xl backdrop-blur">
							<DitherLayer className="opacity-45" />
							<div className="absolute inset-0">{badge}</div>
						</div>
					</div>
				) : null}
			</div>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Input
							className="w-56"
							disabled={isLocked}
							id="agent-title"
							maxLength={48}
							onChange={(e) => onAgentTitleChange?.(e.target.value)}
							placeholder="e.g. CTO"
							size="agent-row"
							value={agentTitle}
						/>
					}
					description="Shown beside the name."
					title="Badge"
				/>
				<SettingsItem
					actions={
						<Input
							className="w-56"
							disabled={isLocked}
							id="persona-display-name"
							onChange={(e) => onPersonaDisplayNameChange?.(e.target.value)}
							placeholder="e.g. Aria"
							size="agent-row"
							value={personaDisplayName}
						/>
					}
					description="The name it introduces itself with, if different."
					title="Display name"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

interface EditorTab {
	content: ReactNode;
	hint: string;
	id: AgentSettingsTab;
	label: string;
}

export function AgentSettingsForm(props: AgentSettingsFormProps) {
	const {
		name,
		agentTitle = "",
		onNameChange,
		description,
		onDescriptionChange,
		onAgentTitleChange,
		agentIcon,
		channelsPanel,
		isBuiltIn,
		isNew,
		isLocked,
		instructionsEditor,
		initialTab,
		initialSettingId,
		agentSetupComposer,
		goalPanel,
		promptStudioPanel,
		rulesPanel,
		evalsPanel,
		calendarPanel,
		historyPanel,
		healthPanel,
		healthBadge,
		observabilityPanel,
		optimizationsPanel,
		passportPanel,
		routinesPanel,
		systemPrompt,
		versionHistoryPanel,
		onOpenPromptStudio,
		rules,
		onRuleChange,
		onRemoveRule,
		onAddRule,
		onAddMoreAgentProviders,
		personaDisplayName,
		onPersonaDisplayNameChange,
		personalityProfile = "",
		personalityProfiles = [],
		onPersonalityProfileChange,
		tone,
		toneOptions,
		onToneChange,
		customTone,
		onCustomToneChange,
		toolsLoading,
		tools,
		selectedTools,
		onToggleTool,
		composioConfigured,
		composioToolkit,
		composioToolkitItems,
		onComposioToolkitChange,
		composioActionsLoading,
		composioActions,
		selectedComposio,
		onToggleComposio,
		onSelectAllComposio,
		onClearComposio,
		skillsLoading,
		skills,
		selectedSkills,
		onToggleSkill,
		spaces,
		memorySpaceIds,
		onToggleMemorySpace,
		memoryReadLevels,
		onToggleMemoryReadLevel,
		memoryWriteEnabled,
		onMemoryWriteEnabledChange,
		capabilitiesPanel,
		executionPolicyPanel,
		identityModePanel,
		identityPanel,
		accountAccessPanel,
		composioAccounts,
		chatModel,
		chatModelPicker,
		showModelPanel = true,
		engineOptions,
		onChatModelChange,
		chatSlotDisabled,
		showAcpCommand,
		acpCommand,
		acpSessionPanel,
		onAcpCommandChange,
		piConfig,
		claudeConfig,
		codexConfig,
		gatewayRoutingConfig,
		budgetPanel,
		integrationsPanel,
		scheduleEnabled,
		onScheduleEnabledChange,
		schedulePhrase,
		onSchedulePhraseChange,
		dailyTime,
		onDailyTimeChange,
		weeklyDay,
		onWeeklyDayChange,
		weeklyTime,
		onWeeklyTimeChange,
		customCron,
		onCustomCronChange,
		showComposioTriggers,
		triggerSubs,
		onDeleteTrigger,
		composioTriggers,
		triggerSlug,
		onTriggerSlugChange,
		connectedAccountId,
		onConnectedAccountIdChange,
		subscribing,
		triggerError,
		onSubscribeTrigger,
		advancedInference,
		employeeBadge,
		formError,
		saving,
		saveDisabled,
		onCreateAndChat,
		onSave,
		onCancel,
		onOpenAdvanced,
		ownAccountsAllowed = false,
		simple = false,
	} = props;

	// Single tab strip for the whole editor: the config sections plus the
	// folded-in Prompt Studio / Evals / Calendar views. Controlled so the
	// "Open Prompt Studio" shortcut can switch tabs programmatically.
	// Opens on Behavior — what the agent does is the first question, not which
	// engine serves it.
	const [activeTab, setActiveTab] = useState<AgentSettingsTab>(
		initialTab ?? "behavior"
	);
	// Sixty-odd settings behind nine pills: the same "which tab is it under"
	// problem the settings dialogs already solved with a row-level index. Same
	// answer here — `agent-settings-search.ts` indexes the ROWS, and picking a hit
	// switches to its tab and flashes it.
	const [settingsQuery, setSettingsQuery] = useState("");
	const [capabilityQuery, setCapabilityQuery] = useState("");
	// Scopes the reveal to the editor body, so a row title that also appears in
	// the search results list can't win over the real row in the panel.
	const editorRef = useRef<HTMLDivElement | null>(null);
	const settingsHits = useMemo(
		() => searchAgentSettings(settingsQuery),
		[settingsQuery]
	);
	const showTimeField =
		schedulePhrase === "daily" ||
		schedulePhrase === "weekdays" ||
		schedulePhrase === "weekends";
	const modelLabel =
		engineOptions.find((option) => option.id === chatModel)?.label ?? chatModel;
	const hasMergedSetup = Boolean(agentSetupComposer);
	const showStandaloneModelPanel = showModelPanel && !hasMergedSetup;
	// Simple mode keeps three tabs. Without the merged composer, the model
	// picker sits inside Behavior instead of earning a fourth tab.
	const showModelTab = showStandaloneModelPanel && !simple;
	// The simple editor drops the Connections tab, so Account access moves
	// under Identity there and the copy names that place.
	const simpleAccountAccess =
		simple && Boolean(identityModePanel) && Boolean(accountAccessPanel);
	const accountAccessPath = simpleAccountAccess
		? "Tools & knowledge → Identity"
		: "Connections → Account access";
	const showInlineModel = showStandaloneModelPanel && simple;

	// ── Panels ───────────────────────────────────────────────────────────────────
	// Each panel is built once and placed into the tab strip below. New and
	// existing agents share the same editor: a short form, not a wizard.

	const modelPanel = (
		<>
			{/* 2. Model & provider */}
			<SettingsSection
				caption="The engine and model used for all chat turns."
				title="Model & provider"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							chatModelPicker ??
							(engineOptions.length === 0 ? (
								<span className="text-muted-foreground text-xs">
									No options installed yet.
								</span>
							) : (
								<Select
									disabled={chatSlotDisabled}
									items={engineOptions.map((opt) => ({
										value: opt.id,
										label: opt.label,
									}))}
									onValueChange={(v) => onChatModelChange?.(v ?? "")}
									value={chatModel}
								>
									<SelectTrigger
										appearance="editor-row"
										className="w-64 shrink-0"
										id="slot-chat-model"
									>
										<SelectValue placeholder="Select chat model" />
									</SelectTrigger>
									<SelectContent>
										{engineOptions.map((opt) => (
											<SelectItem key={opt.id} value={opt.id}>
												{opt.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							))
						}
						title="Chat model"
					/>
					{onAddMoreAgentProviders ? (
						<Button
							appearance="agent-integration-option"
							onClick={onAddMoreAgentProviders}
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							Add more agent providers
						</Button>
					) : null}
				</SettingsGroup>
			</SettingsSection>

			{showAcpCommand ? (
				<SettingsSection
					caption={
						<>
							Type the command that launches your agent on this computer. For
							example: <code>goose acp</code>, <code>opencode acp</code>, or{" "}
							<code>npx -y my-agent --acp</code>.
						</>
					}
					title="Command to start your agent"
				>
					<SettingsCard>
						<label className="sr-only" htmlFor="acp-command">
							Command to start your agent
						</label>
						<input
							className="w-full rounded-lg border bg-card px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
							disabled={isLocked}
							id="acp-command"
							onChange={(e) => onAcpCommandChange?.(e.target.value)}
							placeholder="goose acp"
							spellCheck={false}
							value={acpCommand}
						/>
					</SettingsCard>
				</SettingsSection>
			) : null}

			{piConfig}
			{claudeConfig}
			{codexConfig}
			{budgetPanel}
			{gatewayRoutingConfig}
			{acpSessionPanel}
		</>
	);

	// Accounts the trigger picker offers: those for the integration picked under
	// Connections. Toolkit slugs compare case-insensitively, as Core keys them.
	const triggerToolkit = composioToolkit?.toLowerCase() ?? "";
	const triggerAccounts = (composioAccounts ?? []).filter(
		(account) => account.toolkit.toLowerCase() === triggerToolkit
	);

	const triggersPanel = (
		<>
			{/* 3. Trigger — schedule + Composio event triggers */}
			{routinesPanel ?? (
				<SettingsSection
					caption="Run this agent automatically on a schedule."
					title="Schedule"
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Switch
									checked={scheduleEnabled}
									disabled={isLocked}
									id="schedule-toggle"
									onCheckedChange={onScheduleEnabledChange}
								/>
							}
							title="Run on a schedule"
						/>
						{scheduleEnabled ? (
							<SettingsItem
								actions={
									<Select
										disabled={isLocked}
										items={SCHEDULE_PHRASE_ITEMS}
										onValueChange={(v) => onSchedulePhraseChange?.(v ?? "")}
										value={schedulePhrase}
									>
										<SelectTrigger
											appearance="editor-row"
											className="w-44 shrink-0"
											id="schedule-phrase"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{SCHEDULE_PHRASE_ITEMS.map((opt) => (
												<SelectItem key={opt.value} value={opt.value}>
													{opt.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								}
								title="Frequency"
							/>
						) : null}
						{scheduleEnabled && showTimeField ? (
							<SettingsItem
								actions={
									<Input
										aria-label="Time"
										className="h-8 w-32"
										disabled={isLocked}
										id="daily-time"
										onChange={(e) => onDailyTimeChange?.(e.target.value)}
										type="time"
										value={dailyTime}
									/>
								}
								title="Time"
							/>
						) : null}
						{scheduleEnabled && schedulePhrase === "weekly" ? (
							<SettingsItem
								actions={
									<Select
										disabled={isLocked}
										items={WEEKDAYS.map((d) => ({
											value: d,
											label: d.charAt(0).toUpperCase() + d.slice(1),
										}))}
										onValueChange={(v) => onWeeklyDayChange?.(v ?? "")}
										value={weeklyDay}
									>
										<SelectTrigger
											appearance="editor-row"
											className="w-36 shrink-0"
											id="weekly-day"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{WEEKDAYS.map((d) => (
												<SelectItem key={d} value={d}>
													{d.charAt(0).toUpperCase() + d.slice(1)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								}
								title="Day"
							/>
						) : null}
						{scheduleEnabled && schedulePhrase === "weekly" ? (
							<SettingsItem
								actions={
									<Input
										aria-label="Time"
										className="h-8 w-32"
										disabled={isLocked}
										id="weekly-time"
										onChange={(e) => onWeeklyTimeChange?.(e.target.value)}
										type="time"
										value={weeklyTime}
									/>
								}
								title="Time"
							/>
						) : null}
						{scheduleEnabled && schedulePhrase === "custom" ? (
							<SettingsItem
								actions={
									<Input
										aria-label="Cron expression"
										className="w-44"
										disabled={isLocked}
										id="custom-cron"
										onChange={(e) => onCustomCronChange?.(e.target.value)}
										placeholder="e.g. 0 9 * * 1-5"
										size="agent-row"
										value={customCron}
										variant="code"
									/>
								}
								description="Standard 5-field cron: minute hour day month weekday."
								title="Cron expression"
							/>
						) : null}
					</SettingsGroup>
				</SettingsSection>
			)}

			{showComposioTriggers ? (
				<SettingsSection
					caption="Choose exact connected-app events to watch. Ryu redacts likely secrets, then the node's default model uses these instructions to decide whether to show a private Island suggestion. For channel messages or actions, bind the event to an explicit workflow. Trigger checks cannot use tools."
					title="Event triggers"
				>
					<SettingsCard className="flex flex-col gap-3">
						{triggerSubs.length > 0 ? (
							<div className="flex flex-col gap-1.5">
								{triggerSubs.map((sub) => (
									<div className="flex items-center gap-2 text-sm" key={sub.id}>
										<HugeiconsIcon
											className="size-3.5 text-muted-foreground"
											icon={Clock01Icon}
										/>
										<span className="min-w-0 flex-1 truncate">
											{sub.triggerSlug}
											<span className="text-muted-foreground text-xs">
												{" "}
												({sub.toolkit})
											</span>
										</span>
										{sub.ownAccount ? (
											<Badge variant="secondary">Its own account</Badge>
										) : null}
										{sub.paused ? (
											<Badge variant="outline">
												Paused: account not allowed
											</Badge>
										) : null}
										<Button
											aria-label="Remove trigger"
											onClick={() => onDeleteTrigger?.(sub.id)}
											size="icon-sm"
											variant="ghost"
										>
											<HugeiconsIcon className="size-4" icon={Delete01Icon} />
										</Button>
									</div>
								))}
							</div>
						) : null}

						{composioToolkit ? (
							<>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="composio-trigger">Trigger event</Label>
									<Select
										disabled={isLocked}
										items={composioTriggers.map((t) => ({
											value: t.name,
											label: t.displayName,
										}))}
										onValueChange={(v) => onTriggerSlugChange?.(v ?? "")}
										value={triggerSlug}
									>
										<SelectTrigger className="w-full" id="composio-trigger">
											<SelectValue placeholder="Pick a trigger event" />
										</SelectTrigger>
										<SelectContent>
											{composioTriggers.map((t) => (
												<SelectItem key={t.name} value={t.name}>
													{t.displayName}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="composio-account">Account to watch</Label>
									{composioAccounts ? (
										triggerAccounts.length > 0 ? (
											<Select
												disabled={isLocked}
												items={triggerAccounts.map((account) => ({
													value: account.id,
													label: triggerAccountLabel(account),
												}))}
												onValueChange={(v) =>
													onConnectedAccountIdChange?.(v ?? "")
												}
												value={connectedAccountId}
											>
												<SelectTrigger className="w-full" id="composio-account">
													<SelectValue placeholder="Pick a connected account" />
												</SelectTrigger>
												<SelectContent>
													{triggerAccounts.map((account) => (
														<SelectItem key={account.id} value={account.id}>
															{triggerAccountLabel(account)}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										) : (
											<p className="text-muted-foreground text-xs">
												No connected {composioToolkit} account this agent may
												use. Connect one in Store → Connections
												{ownAccountsAllowed
													? `, connect one for the agent under ${accountAccessPath} → Agent's own accounts,`
													: ""}{" "}
												or allow one under {accountAccessPath}.
											</p>
										)
									) : (
										<>
											<Input
												disabled={isLocked}
												id="composio-account"
												onChange={(e) =>
													onConnectedAccountIdChange?.(e.target.value)
												}
												placeholder="Paste the account id from your Composio dashboard"
												value={connectedAccountId}
											/>
											<p className="text-muted-foreground text-xs">
												The id of the connected account whose selected events
												this agent should watch. You'll find it in your Composio
												dashboard.
											</p>
										</>
									)}
								</div>
								{triggerError ? (
									<p className="text-status-destructive text-xs">
										{triggerError}
									</p>
								) : null}
								<Button
									className="self-start"
									disabled={isLocked}
									loading={subscribing}
									onClick={onSubscribeTrigger}
									size="sm"
									variant="outline"
								>
									{!subscribing && (
										<HugeiconsIcon className="size-4" icon={Add01Icon} />
									)}
									Add trigger
								</Button>
							</>
						) : (
							<p className="text-muted-foreground text-xs">
								Pick an integration under Connections first.
							</p>
						)}
					</SettingsCard>
				</SettingsSection>
			) : null}
		</>
	);

	const normalizedCapabilityQuery = capabilityQuery.trim().toLowerCase();
	const filteredTools = tools.filter((toolName) =>
		formatToolDisplayName(toolName)
			.toLowerCase()
			.includes(normalizedCapabilityQuery)
	);
	const filteredSkills = skills.filter((skill) =>
		[skill.name, skill.description, skill.id]
			.filter(Boolean)
			.some((value) => value?.toLowerCase().includes(normalizedCapabilityQuery))
	);
	const enableAllCapabilities = () => {
		for (const tool of tools) {
			if (!selectedTools.has(tool)) {
				onToggleTool?.(tool);
			}
		}
		for (const skill of skills) {
			if (skill.enabled && !selectedSkills.has(skill.id)) {
				onToggleSkill?.(skill.id);
			}
		}
	};
	const disableAllCapabilities = () => {
		for (const tool of tools) {
			if (selectedTools.has(tool)) {
				onToggleTool?.(tool);
			}
		}
		for (const skill of skills) {
			if (selectedSkills.has(skill.id)) {
				onToggleSkill?.(skill.id);
			}
		}
	};
	const toolsPanel = (
		<>
			{/* Identity: whose accounts the agent works with. Essential tab, so the
			    simple editor (Ryu Bot) keeps it too. The simple editor has no
			    Connections tab, so Account access renders here instead. */}
			{identityModePanel ? (
				<div data-setting-id="agent.identity-mode">
					<SettingsSection
						caption={
							simpleAccountAccess
								? "Whose accounts this agent works with, and which accounts exactly."
								: "Whose accounts this agent works with. Choose which accounts exactly under Connections → Account access."
						}
						title="Identity"
					>
						{simpleAccountAccess ? (
							<div className="flex flex-col gap-5">
								{identityModePanel}
								<div data-setting-id="agent.account-access">
									{accountAccessPanel}
								</div>
							</div>
						) : (
							identityModePanel
						)}
					</SettingsSection>
				</div>
			) : null}
			{/* Lifecycle + safety: what an available agent may do. */}
			{executionPolicyPanel}
			{/* 4. Tools + skills — one readable settings surface. */}
			<SettingsSection
				caption="New agents start with every available tool and enabled skill. Turn off anything this agent should not use."
				headerAction={
					<div className="flex items-center gap-2">
						<Button
							disabled={isLocked || toolsLoading || skillsLoading}
							onClick={enableAllCapabilities}
							size="sm"
							variant="ghost"
						>
							Enable all
						</Button>
						<Button
							disabled={isLocked || toolsLoading || skillsLoading}
							onClick={disableAllCapabilities}
							size="sm"
							variant="ghost"
						>
							Disable all
						</Button>
						<InputGroup className="w-64">
							<InputGroupAddon>
								<HugeiconsIcon className="size-4" icon={Search01Icon} />
							</InputGroupAddon>
							<InputGroupInput
								aria-label="Search tools and skills"
								onChange={(event) => setCapabilityQuery(event.target.value)}
								placeholder="Search tools and skills…"
								value={capabilityQuery}
							/>
						</InputGroup>
					</div>
				}
				title="Tools & skills"
			>
				<SettingsCard className="flex flex-col gap-4">
					{toolsLoading ? (
						<div className="flex items-center gap-2 text-muted-foreground text-xs">
							<Spinner className="size-3" />
							Loading tools…
						</div>
					) : null}
					{!toolsLoading && tools.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No tools available. Install MCP servers to add tools.
						</p>
					) : null}
					{!toolsLoading && tools.length > 0 ? (
						<div className="grid gap-2 md:grid-cols-2">
							{filteredTools.map((toolName) => {
								const checkId = `tool-${toolName}`;
								return (
									<div
										className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 px-3 py-2.5"
										key={toolName}
									>
										<Label
											className="min-w-0"
											htmlFor={checkId}
											variant="agent-choice"
										>
											<span className="block truncate">
												{formatToolDisplayName(toolName)}
											</span>
											<span
												className="block truncate text-muted-foreground text-xs"
												title={toolName}
											>
												{toolName}
											</span>
										</Label>
										<Switch
											checked={selectedTools.has(toolName)}
											disabled={isLocked}
											id={checkId}
											onCheckedChange={() => onToggleTool?.(toolName)}
										/>
									</div>
								);
							})}
						</div>
					) : null}
					<div className="border-t pt-4">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<h3 className="font-medium text-sm">Skills</h3>
								<p className="text-muted-foreground text-xs">
									New agents start with every globally enabled skill. Turn off
									individual skills to narrow this agent.
								</p>
							</div>
							<Badge variant="secondary">{selectedSkills.size} enabled</Badge>
						</div>
						{skillsLoading ? (
							<div className="flex items-center gap-2 text-muted-foreground text-xs">
								<Spinner className="size-3" />
								Loading skills…
							</div>
						) : null}
						{!skillsLoading && skills.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								No Skills installed. Browse and install from the Skills page.
							</p>
						) : null}
						{!skillsLoading && skills.length > 0 ? (
							<div className="grid gap-2 md:grid-cols-2">
								{filteredSkills.map((skill) => {
									const checkId = `skill-${skill.id}`;
									return (
										<div
											className="flex items-start justify-between gap-3 rounded-xl border bg-muted/20 px-3 py-2.5"
											key={skill.id}
										>
											<Label
												className="min-w-0"
												htmlFor={checkId}
												variant="agent-choice"
											>
												<span
													className="block truncate font-medium"
													title={skill.name}
												>
													{skill.name}
												</span>
												{skill.description ? (
													<span
														className="block truncate text-muted-foreground text-xs"
														title={skill.description}
													>
														{skill.description}
													</span>
												) : null}
												{skill.enabled ? null : (
													<span className="text-muted-foreground text-xs">
														Disabled globally
													</span>
												)}
											</Label>
											<Switch
												checked={selectedSkills.has(skill.id)}
												disabled={isLocked}
												id={checkId}
												onCheckedChange={() => onToggleSkill?.(skill.id)}
											/>
										</div>
									);
								})}
							</div>
						) : null}
					</div>
				</SettingsCard>
			</SettingsSection>

			{/* What the agent may read and remember. Grouped with tools and skills
			    because "what it can do" and "what it knows" are one question to a
			    user — it used to be buried under Advanced. */}
			<MemorySpacesCard
				disabled={isLocked}
				memoryReadLevels={memoryReadLevels}
				memorySpaceIds={memorySpaceIds}
				memoryWriteEnabled={memoryWriteEnabled}
				onMemoryWriteEnabledChange={onMemoryWriteEnabledChange}
				onToggleMemoryReadLevel={onToggleMemoryReadLevel}
				onToggleMemorySpace={onToggleMemorySpace}
				showReadLevels={!simple}
				spaces={spaces}
			/>
		</>
	);

	const connectionsPanel = (
		<>
			{/* 5. Connections — Composio actions + Identities + Channels */}
			<SettingsSection
				caption={
					composioConfigured
						? "Attach third-party actions (sending email, creating issues, …) from your connected integrations."
						: "Add a Composio API key in Gateway → API keys, then connect accounts in Marketplace → Connections, to attach actions like sending email or creating issues."
				}
				headerAction={
					selectedComposio.size > 0 ? (
						<Badge variant="secondary">{selectedComposio.size}</Badge>
					) : undefined
				}
				title="Connections"
			>
				{composioConfigured ? (
					<SettingsCard className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="composio-toolkit">Integration</Label>
							<Select
								disabled={isLocked}
								items={composioToolkitItems.map((t) => ({
									value: t.id,
									label: t.label,
								}))}
								onValueChange={(v) => onComposioToolkitChange?.(v ?? null)}
								value={composioToolkit ?? ""}
							>
								<SelectTrigger className="w-full" id="composio-toolkit">
									<SelectValue placeholder="Pick an integration (Gmail, GitHub, …)" />
								</SelectTrigger>
								<SelectContent>
									{composioToolkitItems.map((t) => (
										<SelectItem key={t.id} value={t.id}>
											{t.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{composioToolkit ? (
							<div className="flex flex-col gap-2">
								{composioActions.length > 0 && !composioActionsLoading ? (
									<div className="flex items-center justify-between">
										<span className="text-muted-foreground text-xs">
											{composioActions.every((a) =>
												selectedComposio.has(a.name)
											)
												? "All tools enabled"
												: `${
														composioActions.filter((a) =>
															selectedComposio.has(a.name)
														).length
													} of ${composioActions.length} selected`}
										</span>
										<div className="flex gap-2">
											<Button
												disabled={
													isLocked ||
													composioActions.every((a) =>
														selectedComposio.has(a.name)
													)
												}
												onClick={() => onSelectAllComposio?.()}
												size="sm"
												type="button"
												variant="outline"
											>
												All tools
											</Button>
											<Button
												disabled={
													isLocked ||
													!composioActions.some((a) =>
														selectedComposio.has(a.name)
													)
												}
												onClick={() => onClearComposio?.()}
												size="sm"
												type="button"
												variant="ghost"
											>
												Clear
											</Button>
										</div>
									</div>
								) : null}
								{composioActionsLoading ? (
									<div className="flex items-center gap-2 text-muted-foreground text-xs">
										<Spinner className="size-3" />
										Loading actions…
									</div>
								) : null}
								{!composioActionsLoading && composioActions.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										No actions found for this integration.
									</p>
								) : null}
								{!composioActionsLoading && composioActions.length > 0
									? composioActions.map((action) => {
											const checkId = `composio-${action.name}`;
											return (
												<div
													className="flex items-start gap-3"
													key={action.name}
												>
													<Checkbox
														checked={selectedComposio.has(action.name)}
														disabled={isLocked}
														id={checkId}
														onCheckedChange={() =>
															onToggleComposio?.(action.name)
														}
													/>
													<Label htmlFor={checkId} variant="agent-choice">
														<span className="font-medium">
															{action.displayName}
														</span>
														{action.description ? (
															<span className="block text-muted-foreground text-xs">
																{action.description}
															</span>
														) : null}
													</Label>
												</div>
											);
										})
									: null}
							</div>
						) : null}

						{selectedComposio.size > 0 ? (
							<div className="flex flex-wrap gap-1.5 border-t pt-3">
								{Array.from(selectedComposio).map((cname) => (
									<Badge key={cname} variant="outline">
										{cname}
										<button
											aria-label={`Remove ${cname}`}
											className="text-muted-foreground hover:text-foreground"
											disabled={isLocked}
											onClick={() => onToggleComposio?.(cname)}
											type="button"
										>
											×
										</button>
									</Badge>
								))}
							</div>
						) : null}
					</SettingsCard>
				) : null}
			</SettingsSection>

			{accountAccessPanel ? (
				<div data-setting-id="agent.account-access">
					<SettingsSection
						caption="Which of your accounts and the agent's own accounts it may use. What is offered here follows its Identity setting."
						title="Account access"
					>
						{accountAccessPanel}
					</SettingsSection>
				</div>
			) : (
				identityPanel
			)}
			{channelsPanel}
		</>
	);

	const rulesSection = (
		<>
			{/* 6. Rules */}
			<SettingsSection
				caption="Short, always-on directives folded into this agent's instructions."
				title="Rules"
			>
				<SettingsCard className="flex flex-col gap-2">
					{rules.map((rule, index) => (
						<div className="flex items-center gap-2" key={`rule-${index}`}>
							<Input
								aria-label={`Rule ${index + 1}`}
								disabled={isLocked}
								onChange={(e) => onRuleChange?.(index, e.target.value)}
								placeholder="e.g. Always cite your sources"
								value={rule}
							/>
							<Button
								aria-label="Remove rule"
								disabled={isLocked}
								onClick={() => onRemoveRule?.(index)}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Delete01Icon} />
							</Button>
						</div>
					))}
					<Button
						className="self-start"
						disabled={isLocked}
						onClick={onAddRule}
						size="sm"
						variant="outline"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add rule
					</Button>
				</SettingsCard>
			</SettingsSection>
		</>
	);

	const behaviorPanel = (
		<>
			{/* 7. Instructions — the output: prompt + personality */}
			<SettingsSection
				caption={
					agentSetupComposer
						? "Write its instructions and choose its agent and model from one simple composer."
						: "Describe how this agent should behave, what it should avoid, and how it should respond."
				}
				headerAction={
					isNew ? undefined : (
						<button
							className="cursor-pointer font-medium text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
							onClick={() =>
								promptStudioPanel
									? setActiveTab("prompt-studio")
									: onOpenPromptStudio?.()
							}
							type="button"
						>
							Open Prompt Studio
						</button>
					)
				}
				title={agentSetupComposer ? "Instructions & model" : "Instructions"}
			>
				{/* `bare`: the editor (injected PlateJS, or the fallback textarea) is a
				    tall bordered box that fills the card edge to edge, so the card
				    surface only draws a second edge a few pixels outside the first. */}
				<SettingsCard bare>
					{agentSetupComposer ?? instructionsEditor ?? (
						<Textarea
							className="min-h-32"
							disabled={isLocked}
							id="agent-prompt"
							readOnly
							value={systemPrompt}
						/>
					)}
				</SettingsCard>
			</SettingsSection>

			{goalPanel}

			{showInlineModel ? modelPanel : null}

			<SettingsSection title="Personality & tone">
				<SettingsGroup>
					{personalityProfiles.length > 1 ? (
						<SettingsItem
							actions={
								<Select
									disabled={isLocked}
									items={personalityProfiles.map((profile) => ({
										label: profile.label,
										value: profile.id,
									}))}
									onValueChange={(v) => onPersonalityProfileChange?.(v ?? "")}
									value={personalityProfile}
								>
									<SelectTrigger
										appearance="editor-row"
										className="w-56 shrink-0"
										id="agent-personality-profile"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{personalityProfiles.map((profile) => (
											<SelectItem key={profile.id} value={profile.id}>
												{profile.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							title="Personality profile"
						/>
					) : null}
					<SettingsItem
						actions={
							<Select
								disabled={isLocked}
								items={toneOptions}
								onValueChange={(v) => onToneChange?.(v ?? "")}
								value={tone}
							>
								<SelectTrigger
									appearance="editor-row"
									className="w-56 shrink-0"
									id="persona-tone"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{toneOptions.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Tone"
					/>
					{tone === "custom" ? (
						<SettingsItem
							actions={
								<Input
									className="h-8 w-64"
									disabled={isLocked}
									id="persona-custom-tone"
									onChange={(e) => onCustomToneChange?.(e.target.value)}
									placeholder="e.g. Concise and technical, with a dry wit"
									value={customTone}
								/>
							}
							title="Custom tone"
						/>
					) : null}
				</SettingsGroup>
			</SettingsSection>

			{/* Always-on directives read as part of "how it behaves", so they sit
			    with the instructions instead of owning a tab of their own. */}
			{rulesPanel ?? rulesSection}
		</>
	);

	const advancedPanel = (
		<section aria-label="Advanced" className="flex flex-col gap-6">
			<ProfileCardSection
				agentTitle={agentTitle}
				badge={employeeBadge}
				bannerAgentId={props.bannerAgentId}
				bannerPreferenceStore={props.bannerPreferenceStore}
				isLocked={isLocked}
				marketplaceWallpapers={props.marketplaceWallpapers}
				name={name}
				onAgentTitleChange={onAgentTitleChange}
				onInstallWallpaper={props.onInstallWallpaper}
				onPersonaDisplayNameChange={onPersonaDisplayNameChange}
				personaDisplayName={personaDisplayName}
			/>
			{capabilitiesPanel}
			{advancedInference}
		</section>
	);

	// Evals / Calendar / History are all read-only views of what the agent has
	// already done, so they share one "Activity" tab with an inner strip instead
	// of spending three pills of the top-level tab bar.
	const activityViews: { content: ReactNode; id: string; label: string }[] = [];
	if (passportPanel) {
		activityViews.push({
			content: passportPanel,
			id: "passport",
			label: "Agent passport",
		});
	}
	if (observabilityPanel) {
		activityViews.push({
			content: observabilityPanel,
			id: "observability",
			label: "Observability",
		});
	}
	if (evalsPanel) {
		activityViews.push({
			content: evalsPanel,
			id: "evals",
			label: "Quality tests",
		});
	}
	if (optimizationsPanel) {
		activityViews.push({
			content: optimizationsPanel,
			id: "optimizations",
			label: "Optimizations",
		});
	}
	if (historyPanel) {
		activityViews.push({
			content: historyPanel,
			id: "history",
			label: "Run history",
		});
	}
	if (calendarPanel) {
		activityViews.push({
			content: calendarPanel,
			id: "calendar",
			label: "Calendar",
		});
	}

	const firstActivityView = activityViews[0];
	const activityPanel = firstActivityView ? (
		<Tabs defaultValue={firstActivityView.id} spacing="comfortable">
			<TabsList variant="line">
				{activityViews.map((view) => (
					<TabsTrigger key={view.id} value={view.id}>
						{view.label}
					</TabsTrigger>
				))}
			</TabsList>
			{activityViews.map((view) => (
				<TabsContent key={view.id} layout="agent-activity" value={view.id}>
					{view.content}
				</TabsContent>
			))}
		</Tabs>
	) : null;

	// Two tiers, like the agent profiles in Grok, Notion, and Meta: a few
	// essentials everyone needs (what it does, what it can use, when it runs),
	// then everything else behind them. Simple mode (Bot) shows only the
	// essentials; the advanced tier lives in the Agent workspace.
	const essentialTabs: EditorTab[] = [
		{
			content: behaviorPanel,
			hint: "What this agent does, which model runs it, and how it answers.",
			id: "behavior",
			label: "Behavior",
		},
		...(showModelTab
			? [
					{
						content: modelPanel,
						hint: "Which AI runs this agent.",
						id: "model" as const,
						label: "Model",
					},
				]
			: []),
		{
			content: toolsPanel,
			hint: "What it may use, read, and remember.",
			id: "tools",
			label: "Tools & knowledge",
		},
		{
			content: triggersPanel,
			hint: "When it should run on its own, without you asking.",
			id: "triggers",
			label: "Triggers",
		},
	];
	const advancedTabs: EditorTab[] = simple
		? []
		: [
				{
					content: connectionsPanel,
					hint: "Apps it acts through, the accounts it may use, and where you can reach it.",
					id: "connections",
					label: "Connections",
				},
				...(integrationsPanel
					? [
							{
								content: integrationsPanel,
								hint: "Call this agent from code, CI, MCP hosts, or a Ryu App.",
								id: "integrations" as const,
								label: "Integrations",
							},
						]
					: []),
				...(healthPanel
					? [
							{
								content: healthPanel,
								hint: "Common setup checks that update as you edit this agent.",
								id: "health" as const,
								label: "Health",
							},
						]
					: []),
				...(activityPanel
					? [
							{
								content: activityPanel,
								hint: "What this agent has done, and how well it scored.",
								id: "activity" as const,
								label: "Activity",
							},
						]
					: []),
				...(promptStudioPanel
					? [
							{
								content: promptStudioPanel,
								hint: "Write and version the full instructions with the editor.",
								id: "prompt-studio" as const,
								label: "Prompt Studio",
							},
						]
					: []),
				...(versionHistoryPanel
					? [
							{
								content: versionHistoryPanel,
								hint: "Compare and restore complete saved agent configurations.",
								id: "versions" as const,
								label: "Versions",
							},
						]
					: []),
				{
					content: advancedPanel,
					hint: "Profile card, model capabilities, orchestration, and engine defaults.",
					id: "advanced",
					label: "Advanced",
				},
			];
	const editorTabs = [...essentialTabs, ...advancedTabs];
	const availableTabIds = new Set(editorTabs.map((tab) => tab.id));

	// A tab can disappear underneath the selection (the model panel merges into
	// the composer, an injected panel is withdrawn, or the editor switches to
	// simple mode). Fall back to Behavior instead of rendering an empty body.
	const activeTabAvailable = editorTabs.some((tab) => tab.id === activeTab);
	useEffect(() => {
		if (!activeTabAvailable) {
			setActiveTab("behavior");
		}
	}, [activeTabAvailable]);

	// A host asked to open on one setting. Its tab can arrive a render late (the
	// panel waits on the record), so this waits for the tab, then reveals once.
	// The simple editor shows Account access under Identity instead.
	const initialSettingTab = (() => {
		const entry = AGENT_SETTINGS_ENTRIES.find(
			(candidate) => candidate.id === initialSettingId
		);
		if (!entry) {
			return null;
		}
		const tab =
			entry.id === AGENT_ACCOUNT_ACCESS_SETTING_ID && simpleAccountAccess
				? "tools"
				: entry.tab;
		return availableTabIds.has(tab) ? { entry, tab } : null;
	})();
	const initialSettingShown = useRef(false);
	const cancelInitialReveal = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (initialSettingShown.current || !initialSettingTab) {
			return;
		}
		initialSettingShown.current = true;
		setActiveTab(initialSettingTab.tab);
		cancelInitialReveal.current = revealAgentSetting(
			initialSettingTab.entry,
			editorRef.current ?? document
		);
	}, [initialSettingTab]);
	useEffect(() => () => cancelInitialReveal.current?.(), []);

	const activeHint = editorTabs.find((tab) => tab.id === activeTab)?.hint ?? "";

	// A hit filed under an absent tab would switch to a pill that isn't there
	// and leave the editor showing nothing. Drop those instead of a dead row.
	const visibleHits = settingsHits.filter((hit) =>
		availableTabIds.has(hit.tab)
	);

	// Switch to the hit's tab, then flash the row. The reveal polls, because the
	// panel is a commit (or, for one that fetches first, a few hundred ms) away
	// from being in the DOM when this runs.
	const handleSelectSetting = (entry: AgentSettingsEntry) => {
		setActiveTab(entry.tab);
		setSettingsQuery("");
		revealAgentSetting(entry, editorRef.current ?? document);
	};

	const actions = (
		<>
			{formError ? (
				<p className="text-sm text-status-destructive">{formError}</p>
			) : null}

			<div className="flex gap-2">
				{isNew ? (
					<>
						<Button
							disabled={saveDisabled}
							loading={saving}
							onClick={onCreateAndChat}
						>
							Create &amp; chat
						</Button>
						<Button disabled={saveDisabled} onClick={onSave} variant="ghost">
							Create agent
						</Button>
					</>
				) : (
					<Button disabled={saveDisabled} loading={saving} onClick={onSave}>
						Save changes
					</Button>
				)}
				<Button onClick={onCancel} variant="ghost">
					Cancel
				</Button>
			</div>

			{isLocked ? (
				<p className="text-muted-foreground text-xs">
					This agent is locked. Unlock it to make changes.
				</p>
			) : null}
		</>
	);

	// Search only earns its place once the advanced tier is there; four
	// essentials tabs are short enough to scan.
	const settingsSearch = simple ? null : (
		<div className="relative w-full shrink-0 sm:w-56">
			<HugeiconsIcon
				className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
				icon={Search01Icon}
			/>
			<Input
				aria-label="Search agent settings"
				leadingAdornment="compact"
				onChange={(e) => setSettingsQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setSettingsQuery("");
					}
					// Enter takes the top hit — the shortest path when you already know
					// the name of the setting and just typed enough of it.
					const firstHit = visibleHits[0];
					if (e.key === "Enter" && firstHit) {
						e.preventDefault();
						handleSelectSetting(firstHit);
					}
				}}
				placeholder="Search settings…"
				size="settings-search"
				value={settingsQuery}
			/>
			{settingsQuery.trim() ? (
				<div className="absolute top-9 right-0 z-30 max-h-80 w-full min-w-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
					{visibleHits.length === 0 ? (
						<p className="px-2.5 py-2 text-muted-foreground text-sm">
							No settings match “{settingsQuery.trim()}”.
						</p>
					) : (
						visibleHits.map((hit) => (
							<button
								className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-accent"
								key={hit.id}
								onClick={() => handleSelectSetting(hit)}
								type="button"
							>
								<span className="font-medium text-sm">{hit.label}</span>
								{/* Where it lives, so a hit is a direction and not just a
								    name. */}
								<span className="text-muted-foreground text-xs">
									{AGENT_TAB_LABELS[hit.tab]}
									{hit.group ? ` › ${hit.group}` : ""}
								</span>
							</button>
						))
					)}
				</div>
			) : null}
		</div>
	);

	return (
		<div className="mx-auto w-full max-w-3xl" ref={editorRef}>
			<div className="flex min-w-0 flex-col gap-6">
				<ProfileHeader
					agentIcon={agentIcon}
					builtIn={isBuiltIn}
					description={description}
					healthBadge={simple ? undefined : healthBadge}
					isLocked={isLocked}
					isNew={isNew}
					modelLabel={modelLabel}
					name={name}
					onCreateAndChat={onCreateAndChat}
					onDescriptionChange={onDescriptionChange}
					onNameChange={onNameChange}
					onSave={onSave}
					saveDisabled={saveDisabled}
					saving={saving}
				/>

				<Tabs onValueChange={setActiveTab} spacing="relaxed" value={activeTab}>
					<div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
						{/* Unmanaged: children render in order, so the divider stays between
						    the two tiers, and an overflowing strip scrolls with arrows instead
						    of folding tabs into a menu. */}
						<TabsList
							className="min-w-0 max-w-full"
							manageLayout={false}
							variant="pills"
						>
							{essentialTabs.map((tab) => (
								<TabsTrigger key={tab.id} value={tab.id}>
									{tab.label}
								</TabsTrigger>
							))}
							{advancedTabs.length > 0 ? (
								<Separator
									className="mx-1 h-4 self-center"
									orientation="vertical"
								/>
							) : null}
							{advancedTabs.map((tab) => (
								<TabsTrigger key={tab.id} tone="muted" value={tab.id}>
									{tab.label}
								</TabsTrigger>
							))}
						</TabsList>
						{settingsSearch}
						{simple && onOpenAdvanced ? (
							<Button onClick={onOpenAdvanced} size="sm" variant="ghost-muted">
								Advanced settings in the Agent workspace
							</Button>
						) : null}
					</div>

					{activeHint ? (
						<p className="px-1 text-muted-foreground text-xs">{activeHint}</p>
					) : null}

					{editorTabs.map((tab) => (
						<TabsContent key={tab.id} layout="agent-settings" value={tab.id}>
							{tab.content}
						</TabsContent>
					))}
				</Tabs>

				{actions}
			</div>
		</div>
	);
}

// ── Prompt Studio (faithful reconstruction) ───────────────────────────────────
// The real Prompt Studio embeds a PlateJS markdown editor, which cannot render
// as a pure presentational server component. The container renders the real
// `PromptStudio` directly; this view is only used by the storyboard to show the
// shape. It accepts an injected editor node so the live path can pass the real
// editor if it ever becomes server-renderable.

export interface AgentPromptStudioViewProps {
	editor?: ReactNode;
	formError?: string | null;
	onCancel?: () => void;
	onSave?: () => void;
	saveDisabled?: boolean;
	saving?: boolean;
	systemPrompt?: string;
}

export function AgentPromptStudioView({
	editor,
	systemPrompt = "",
	formError,
	saving,
	saveDisabled,
	onSave,
	onCancel,
}: AgentPromptStudioViewProps) {
	return (
		<div className="mx-auto flex max-w-2xl flex-col gap-6">
			{editor ?? (
				<section className="flex flex-col gap-2">
					<h2 className="font-medium text-base">Prompt Studio</h2>
					<p className="text-muted-foreground text-xs">
						PlateJS markdown editor for the system prompt.
					</p>
					<div className="rounded-lg border bg-card p-4 text-sm leading-relaxed">
						<pre className="whitespace-pre-wrap font-sans">{systemPrompt}</pre>
					</div>
				</section>
			)}

			{formError ? (
				<p className="text-sm text-status-destructive">{formError}</p>
			) : null}

			<div className="flex gap-2">
				<Button disabled={saveDisabled} loading={saving} onClick={onSave}>
					Save prompt
				</Button>
				<Button onClick={onCancel} variant="ghost">
					Cancel
				</Button>
			</div>
		</div>
	);
}
