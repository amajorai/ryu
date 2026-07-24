"use client";

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
	ArrowRight01Icon,
	Brain01Icon,
	CheckmarkBadge04Icon,
	Clock01Icon,
	Copy01Icon,
	Delete01Icon,
	LockedIcon,
	Message01Icon,
	Refresh01Icon,
	Tick01Icon,
	Tick02Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient";
import type { DitherColor } from "@ryu/ui/components/dither-kit/palette";
import { Input } from "@ryu/ui/components/input";
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
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

// ── Slot card ─────────────────────────────────────────────────────────────────

export interface SlotOption {
	id: string;
	label: string;
}

export interface SlotCardProps {
	available?: boolean;
	description: string;
	disabled?: boolean;
	id: string;
	label: string;
	onChange?: (value: string) => void;
	options: SlotOption[];
	value: string;
}

export function SlotCard({
	id,
	label,
	description,
	options,
	value,
	onChange,
	available = true,
	disabled = false,
}: SlotCardProps) {
	const selectId = `slot-${id}`;
	return (
		<fieldset aria-label={`${label} slot`} className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<span className="font-medium text-sm">{label}</span>
				{available ? null : (
					<Badge className="ml-auto text-[10px]" variant="secondary">
						Coming soon
					</Badge>
				)}
			</div>
			<p className="text-muted-foreground text-xs">{description}</p>
			{available ? (
				<div className="flex flex-col gap-1">
					<Label className="sr-only" htmlFor={selectId}>
						{label}
					</Label>
					{options.length === 0 ? (
						<p className="text-muted-foreground text-xs">
							No options installed yet.
						</p>
					) : (
						<Select
							disabled={disabled}
							items={options.map((opt) => ({
								value: opt.id,
								label: opt.label,
							}))}
							onValueChange={(v) => onChange?.(v ?? "")}
							value={value}
						>
							<SelectTrigger className="w-full" id={selectId}>
								<SelectValue placeholder={`Select ${label.toLowerCase()}`} />
							</SelectTrigger>
							<SelectContent>
								{options.map((opt) => (
									<SelectItem key={opt.id} value={opt.id}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</div>
			) : (
				<div className="rounded border border-dashed px-3 py-2">
					<span className="text-muted-foreground text-xs">
						Slot available once configured
					</span>
				</div>
			)}
		</fieldset>
	);
}

// ── Memory / Spaces slot (live) ────────────────────────────────────────────────

/** The three memory scope levels an agent may recall from. Leaving all three
 * unchecked means "all levels" — the back-compat default Core applies for
 * agents configured before this slot existed. */
const MEMORY_READ_LEVELS: { hint: string; label: string; value: string }[] = [
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
];

export interface MemorySpacesCardProps {
	disabled?: boolean;
	memoryReadLevels: Set<string>;
	memorySpaceIds: Set<string>;
	memoryWriteEnabled: boolean;
	onMemoryWriteEnabledChange?: (v: boolean) => void;
	onToggleMemoryReadLevel?: (level: string) => void;
	onToggleMemorySpace?: (id: string) => void;
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
}: MemorySpacesCardProps) {
	return (
		<SettingsSection
			caption="Give this agent long-term memory. Choose which Spaces it may read for retrieval, which memory levels it may recall, and whether it may record new memories."
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
										<Label
											className="cursor-pointer font-normal text-sm"
											htmlFor={checkId}
										>
											{space.name}
										</Label>
									</div>
								);
							})}
						</div>
					)}
				</div>

				<Separator />

				<div className="flex flex-col gap-2">
					<span className="font-medium text-sm">Memory levels</span>
					<p className="text-muted-foreground text-xs">
						Which memory scopes this agent may recall from. Leave all unchecked
						to allow all three levels.
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
									<Label
										className="cursor-pointer font-normal text-sm"
										htmlFor={checkId}
									>
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
			<Badge className="ml-auto shrink-0 gap-1" variant="secondary">
				<HugeiconsIcon className="size-3" icon={LockedIcon} />
				Built-in
			</Badge>
		);
	} else if (locked) {
		badge = (
			<Badge className="ml-auto shrink-0 gap-1" variant="secondary">
				<HugeiconsIcon className="size-3" icon={LockedIcon} />
				Locked
			</Badge>
		);
	}

	return (
		<div className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
			<div className="flex items-center gap-3">
				<div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
					<RyuLogo className="text-foreground" size="24px" variant="outline" />
				</div>
				<div className="flex min-w-0 flex-col">
					<span className="truncate font-semibold text-base leading-tight">
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
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function ClaudeGatewayConfigView({
	enabled = false,
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
					description="Off (default): Claude Code talks to Anthropic directly and its traffic is not governed. On: it routes through the local gateway (loopback-only) which applies request-side redaction + audit, then forwards your subscription login upstream. Takes effect the next time Claude Code starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

// ── Codex gateway routing (per-agent) ─────────────────────────────────────────
// Mirrors the Claude Code view; Codex's ChatGPT-login (subscription) traffic is
// routed through the gateway passthrough while the OAuth + ChatGPT-Account-ID are
// forwarded upstream unchanged.

export interface CodexGatewayConfigViewProps {
	enabled?: boolean;
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function CodexGatewayConfigView({
	enabled = false,
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
					description="Off (default): Codex talks to OpenAI directly on your subscription and that traffic is not governed. On: it routes through the local gateway (loopback-only) which applies request-side redaction + audit, then forwards your subscription login upstream. Takes effect the next time Codex starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

// ── Generic per-agent gateway routing (BYO OpenAI-compatible agents) ──────────
// The "point any agent at the Ryu gateway via the OpenAI base-URL swap" toggle.
// Unlike the Claude/Codex views (subscription passthroughs that are always true),
// this is honest about scope: it only takes effect for an agent whose client
// reads OPENAI_BASE_URL — i.e. an OpenAI-compatible BYO agent.

export interface GatewayRoutingConfigViewProps {
	enabled?: boolean;
	loaded?: boolean;
	onToggle?: (next: boolean) => void;
}

export function GatewayRoutingConfigView({
	enabled = false,
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
					description="Off (default): the agent talks to its provider directly and its traffic is not governed. On: Ryu swaps its OpenAI-compatible endpoint to the local gateway (loopback-only). Takes effect the next time the agent starts."
					title="Route through Ryu Gateway"
				/>
			</SettingsGroup>
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
					className="size-3 text-emerald-500"
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
				className="h-auto w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left font-medium text-sm"
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
					<span className="flex-1 truncate">{model.name}</span>
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
			<PopoverTrigger asChild>
				<Button
					aria-labelledby={id}
					className="w-full justify-between font-normal"
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
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-[min(300px,var(--radix-popover-content-available-width))] p-0"
			>
				<div className="flex max-h-80 flex-col">
					<div className="sticky top-0 z-10 border-border/60 border-b bg-popover p-2">
						<Input
							aria-label="Filter models"
							className="h-8 text-[13px]"
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search models…"
							value={query}
						/>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto p-1">
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
											<div className="px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground">
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
			<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive text-sm">
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
					className="text-[10px]"
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
					<p className="text-destructive text-xs">{saveError}</p>
				) : null}
				<div className="flex items-center gap-3">
					<Button disabled={!canSave} onClick={onSave} type="button">
						{saving ? <Spinner className="size-4" /> : null}
						Save Pi config
					</Button>
					{saved && !saving ? (
						<span className="flex items-center gap-1 text-emerald-500 text-xs">
							<HugeiconsIcon className="size-3" icon={CheckmarkBadge04Icon} />
							Saved
						</span>
					) : null}
					{configDir ? (
						<span className="ml-auto truncate text-[10px] text-muted-foreground">
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
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
					<p className="text-destructive text-xs">{error}</p>
				) : null}
				{loading || error ? null : (
					<div className="flex flex-col gap-3">
						{gatewayUrl ? (
							<div className="flex flex-col gap-1.5">
								<Label className="text-xs">Gateway base URL</Label>
								<div className="flex items-center gap-2">
									<Input
										className="h-8 font-mono text-xs"
										readOnly
										value={`${gatewayUrl}/v1`}
									/>
									<Button
										className="shrink-0"
										onClick={onCopyUrl}
										size="icon-sm"
										variant="ghost"
									>
										{copied === "url" ? (
											<HugeiconsIcon
												className="size-3 text-green-600"
												icon={Tick01Icon}
											/>
										) : (
											<HugeiconsIcon className="size-3" icon={Copy01Icon} />
										)}
									</Button>
								</div>
								<p className="text-muted-foreground text-xs">
									Set this as your agent's{" "}
									<code className="rounded bg-muted px-1 font-mono text-[11px]">
										base_url
									</code>{" "}
									or{" "}
									<code className="rounded bg-muted px-1 font-mono text-[11px]">
										OPENAI_BASE_URL
									</code>
									.
								</p>
							</div>
						) : null}

						{generatedKey ? (
							<div className="flex flex-col gap-1.5">
								<Label className="flex items-center gap-1 text-xs">
									Gateway API key
									<span className="rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
										Copy now — not shown again
									</span>
								</Label>
								<div className="flex items-center gap-2">
									<Input
										className="h-8 font-mono text-xs"
										readOnly
										value={generatedKey}
									/>
									<Button
										className="shrink-0"
										onClick={onCopyKey}
										size="icon-sm"
										variant="ghost"
									>
										{copied === "key" ? (
											<HugeiconsIcon
												className="size-3 text-green-600"
												icon={Tick01Icon}
											/>
										) : (
											<HugeiconsIcon className="size-3" icon={Copy01Icon} />
										)}
									</Button>
								</div>
								<p className="text-muted-foreground text-xs">
									Set this as your agent's{" "}
									<code className="rounded bg-muted px-1 font-mono text-[11px]">
										api_key
									</code>{" "}
									or{" "}
									<code className="rounded bg-muted px-1 font-mono text-[11px]">
										OPENAI_API_KEY
									</code>
									. The gateway applies Ryu's firewall and per-agent budget to
									all requests tagged with{" "}
									<code className="rounded bg-muted px-1 font-mono text-[11px]">
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
							disabled={saving}
							onClick={onGenerate}
							size="sm"
							variant={hasKey ? "outline" : "default"}
						>
							{saving ? (
								<Spinner className="size-3" />
							) : (
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

// ── Connect with code ─────────────────────────────────────────────────────────

export type SnippetLang = "curl" | "typescript" | "sdk";

export const SNIPPET_LANGS: { id: SnippetLang; label: string }[] = [
	{ id: "curl", label: "cURL" },
	{ id: "typescript", label: "TypeScript" },
	{ id: "sdk", label: "Ryu SDK" },
];

export interface AgentConnectViewProps {
	agentId: string;
	copied?: boolean;
	hasToken?: boolean;
	lang?: SnippetLang;
	onCopy?: () => void;
	onLangChange?: (lang: SnippetLang) => void;
	snippet: string;
}

export function AgentConnectView({
	agentId,
	hasToken = false,
	lang = "curl",
	snippet,
	copied,
	onLangChange,
	onCopy,
}: AgentConnectViewProps) {
	return (
		<SettingsSection
			caption={
				<>
					Call this agent from your own code. Point requests at this node's
					address with the agent id{" "}
					<code className="rounded bg-muted px-1 font-mono text-[11px]">
						{agentId}
					</code>
					{hasToken ? (
						<>
							{" "}
							and your node token. The reply streams in Vercel AI SDK format.
						</>
					) : (
						<>. This local node accepts unauthenticated requests.</>
					)}
				</>
			}
			headerAction={
				<Badge className="font-mono" variant="secondary">
					{agentId}
				</Badge>
			}
			title="Connect with code"
		>
			<SettingsCard className="flex flex-col gap-3">
				<div className="flex items-center gap-1">
					{SNIPPET_LANGS.map((l) => (
						<Button
							key={l.id}
							onClick={() => onLangChange?.(l.id)}
							size="sm"
							variant={lang === l.id ? "secondary" : "ghost"}
						>
							{l.label}
						</Button>
					))}
					<Button
						className="ml-auto"
						onClick={onCopy}
						size="icon-sm"
						variant="ghost"
					>
						{copied ? (
							<HugeiconsIcon
								className="size-3 text-green-600"
								icon={Tick01Icon}
							/>
						) : (
							<HugeiconsIcon className="size-3" icon={Copy01Icon} />
						)}
					</Button>
				</div>

				<pre className="overflow-x-auto rounded-md border bg-background p-3 font-mono text-[11px] leading-relaxed">
					<code>{snippet}</code>
				</pre>

				{hasToken ? (
					<p className="text-muted-foreground text-xs">
						Replace{" "}
						<code className="rounded bg-muted px-1 font-mono text-[11px]">
							YOUR_NODE_TOKEN
						</code>{" "}
						with this node's auth token (the machine secret used to reach Core).
					</p>
				) : null}
			</SettingsCard>
		</SettingsSection>
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
			<span className="text-[10px] text-muted-foreground uppercase tracking-wide">
				{label}
			</span>
			<span className={`font-semibold text-sm ${tone ?? ""}`}>{value}</span>
		</div>
	);
}

export function AgentEvalsView({
	model = "",
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
							<Label className="text-xs" htmlFor="eval-model">
								Model
							</Label>
							<Input
								className="h-8 w-56 text-xs"
								id="eval-model"
								onChange={(e) => onModelChange?.(e.target.value)}
								placeholder="Model id"
								value={model}
							/>
						</div>
						<Button
							disabled={running || !model.trim()}
							onClick={onRun}
							size="sm"
						>
							{running ? <Spinner /> : null}
							{running ? "Running…" : "Run evals"}
						</Button>
					</div>

					{runError ? (
						<p className="text-destructive text-xs">{runError}</p>
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
											// biome-ignore lint/suspicious/noArrayIndexKey: cases are positional and stable per run
											key={`${c.prompt.slice(0, 16)}-${i}`}
										>
											<td className="max-w-40 truncate px-2 py-1.5">
												{c.prompt}
											</td>
											<td className="max-w-64 truncate px-2 py-1.5 text-muted-foreground">
												{c.responseText}
											</td>
											<td className="px-2 py-1.5 text-right">
												{c.matchLabel ?? "—"}
											</td>
											<td
												className={`px-2 py-1.5 text-right font-medium ${c.scoreTone ?? ""}`}
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
														className="ml-1.5 px-1 py-0 text-[10px]"
														variant="outline"
													>
														not run
													</Badge>
												) : null}
											</td>
											<td
												className={`px-2 py-1.5 text-right font-medium ${r.tone ?? ""}`}
											>
												{r.meanScore}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground">
												{r.passRate}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground">
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
						disabled={historyLoading}
						onClick={onReloadHistory}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon
							className={`size-3.5 ${historyLoading ? "animate-spin" : ""}`}
							icon={Refresh01Icon}
						/>
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
													<Badge className="gap-1" variant="destructive">
														error
													</Badge>
												) : null}
												{e.model}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground">
												{e.tokens}
											</td>
											<td className="px-2 py-1.5 text-right text-muted-foreground">
												{e.latencyLabel}
											</td>
											<td className="px-2 py-1.5 text-right">{e.scoreLabel}</td>
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

export interface TriggerSubRow {
	id: string;
	toolkit: string;
	triggerSlug: string;
}

export interface AgentSettingsFormProps {
	acpCommand: string;
	/** Injected: ACP auth ("Login with X") + session list controls for external
	 *  agents. Self-hides for agents that report no auth methods or sessions. */
	acpSessionPanel?: ReactNode;

	// Advanced inference (injected — it is its own coupled component)
	advancedInference?: ReactNode;
	/** Optional icon node shown in the identity header (the agent's logo). */
	agentIcon?: ReactNode;
	byoaPanel?: ReactNode;
	/** Injected: the per-agent Calendar view, rendered as its own tab. Omit to
	 *  hide the tab. */
	calendarPanel?: ReactNode;
	/** Injected: the per-agent capability controls (tools / thinking / vision),
	 *  rendered at the top of the Tools tab. */
	capabilitiesPanel?: ReactNode;
	/** Injected: the per-agent Channels panel (control-plane bot bindings). */
	channelsPanel?: ReactNode;

	// Model slots
	chatModel: string;
	chatSlotDisabled?: boolean;
	/** Injected: ClaudeGatewayConfig for `acp:claude`. */
	claudeConfig?: ReactNode;
	/** Injected: CodexGatewayConfig for `acp:codex`. */
	codexConfig?: ReactNode;
	composioActions: ComposioActionRow[];
	composioActionsLoading?: boolean;

	// Composio actions
	composioConfigured: boolean;
	composioToolkit: string | null;
	composioToolkitItems: SlotOption[];
	composioTriggers: ComposioTriggerRow[];
	connectedAccountId: string;

	// Connect / BYOA panels (injected — own hooks)
	connectPanel?: ReactNode;
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

	// Save
	formError?: string | null;
	/** Injected: generic GatewayRoutingConfig for BYO/other ACP agents. */
	gatewayRoutingConfig?: ReactNode;
	/** Injected: the per-agent run-history view (chats + automated runs),
	 *  rendered as its own tab. Omit to hide the tab. */
	historyPanel?: ReactNode;
	/** Injected: the per-agent Identity Vault profile picker (empty = none). */
	identityPanel?: ReactNode;
	/** Injected rich editor node for Instructions; falls back to a textarea. */
	instructionsEditor?: ReactNode;
	isBuiltIn: boolean;
	isLocked: boolean;
	isNew: boolean;
	/** Injected: ModelLaunchConfigSection when a tunable local engine is picked. */
	launchConfig?: ReactNode;

	// Memory / Spaces slot
	/** Memory scope levels the agent may recall from (subset of user/node/project).
	 * Empty = all three levels (the back-compat default). */
	memoryReadLevels: Set<string>;
	/** Space IDs the agent may read for retrieval. Empty = no Spaces injected. */
	memorySpaceIds: Set<string>;
	/** Whether the agent may record new memories during a session. */
	memoryWriteEnabled: boolean;
	moreSlotsOpen?: boolean;
	// Identity
	name: string;
	onAcpCommandChange?: (v: string) => void;
	/** Open the Customize store on the Agents tab to install more engines. */
	onAddMoreAgentProviders?: () => void;
	onAddRule?: () => void;
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
	onMemoryWriteEnabledChange?: (v: boolean) => void;
	onNameChange?: (v: string) => void;
	onOpenPromptStudio?: () => void;
	onPersonaDisplayNameChange?: (v: string) => void;
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
	onToggleMoreSlots?: () => void;
	onToggleSkill?: (id: string) => void;
	onToggleTool?: (name: string) => void;
	onToneChange?: (v: string) => void;
	onTriggerSlugChange?: (v: string) => void;
	onWeeklyDayChange?: (v: string) => void;
	onWeeklyTimeChange?: (v: string) => void;

	// Persona
	personaDisplayName: string;
	/** Injected: RyuPiConfig for the `ryu` agent. */
	piConfig?: ReactNode;

	// Preview — retained for back-compat (storyboard). The two-pane editor no
	// longer renders a preview aside; the live builder chat is the left pane.
	preview?: AgentPreviewCardProps;
	/** Injected: the Prompt Studio editor, rendered as its own tab. Omit to hide
	 *  the tab (e.g. for brand-new agents that have no record yet). */
	promptStudioPanel?: ReactNode;

	// Rules
	rules: string[];
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

// Banner palette. "Random" here means DETERMINISTICALLY random: the colour and
// direction are derived from the agent name, so every agent gets a different
// wash but the same agent looks the same on every render and every machine.
// Both are overridable via props so a user can pick their own.
const BANNER_COLORS: readonly DitherColor[] = [
	"purple",
	"blue",
	"green",
	"pink",
	"orange",
	"red",
];
const BANNER_DIRECTIONS: readonly GradientDirection[] = [
	"up",
	"down",
	"left",
	"right",
];

/** Swatch fills for the colour picker — indicative only; the real fill is the
 *  dithered canvas, which cannot be shown in a 16px dot. */
const BANNER_SWATCHES: Record<DitherColor, string> = {
	purple: "#b497cf",
	blue: "#7aa2f7",
	green: "#9ece6a",
	pink: "#e39ac7",
	orange: "#e0a363",
	red: "#e06c75",
	grey: "#9aa0a6",
};

/** Stable 32-bit hash of a string — same seed in, same banner out. */
function bannerHash(seed: string): number {
	let h = 2_166_136_261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16_777_619);
	}
	return Math.abs(h);
}

/**
 * The user's banner override for one agent.
 *
 * Persisted to localStorage rather than onto the agent record: this is a purely
 * cosmetic, per-machine preference, and a Core schema change (plus migration and
 * sync) buys nothing for it. With no override the deterministic hash default
 * applies, so every agent has a sensible banner without anyone choosing one.
 */
interface BannerPrefs {
	/** A palette name, or a HUE (0–360) for a custom colour. DitherGradient's
	 *  `from` is `DitherColor | number`, so a hue needs no extra plumbing. */
	color?: DitherColor | number;
	direction?: GradientDirection;
}

/** Hex (#rrggbb) → hue, so a native colour input can drive the dither fill.
 *  Only the hue is kept: the kit derives its own saturation/lightness so the
 *  wash stays consistent with the rest of the palette. */
function hexToHue(hex: string): number {
	const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
	if (!m) {
		return 0;
	}
	const n = Number.parseInt(m[1], 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) {
		return 0;
	}
	let h: number;
	if (max === r) {
		h = ((g - b) / d) % 6;
	} else if (max === g) {
		h = (b - r) / d + 2;
	} else {
		h = (r - g) / d + 4;
	}
	return Math.round((((h * 60) % 360) + 360) % 360);
}

/** Hue → hex, so the colour input shows the currently-selected custom hue. */
function hueToHex(hue: number): string {
	const h = ((hue % 360) + 360) % 360;
	const s = 0.85;
	const l = 0.58;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		h < 60
			? [c, x, 0]
			: h < 120
				? [x, c, 0]
				: h < 180
					? [0, c, x]
					: h < 240
						? [0, x, c]
						: h < 300
							? [x, 0, c]
							: [c, 0, x];
	const to = (v: number) =>
		Math.round((v + m) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${to(r)}${to(g)}${to(b)}`;
}

const bannerPrefsKey = (agent: string) => `ryu:agent-banner:${agent}`;

function loadBannerPrefs(agent: string): BannerPrefs {
	try {
		const raw = localStorage.getItem(bannerPrefsKey(agent));
		const prefs = raw ? (JSON.parse(raw) as BannerPrefs) : {};
		// A stale/hand-edited `color` string that isn't a known swatch reaches
		// `fillOf` → `PALETTE[color].fill`, which throws during canvas paint and
		// crashes the editor on open. Numbers are always valid (treated as a hue);
		// drop any string that isn't a palette swatch so the banner falls back to
		// its derived default instead of exploding.
		if (
			typeof prefs.color === "string" &&
			!BANNER_COLORS.includes(prefs.color as DitherColor)
		) {
			prefs.color = undefined;
		}
		return prefs;
	} catch {
		// Corrupt or unavailable storage must never break the editor.
		return {};
	}
}

function saveBannerPrefs(agent: string, prefs: BannerPrefs): void {
	try {
		localStorage.setItem(bannerPrefsKey(agent), JSON.stringify(prefs));
	} catch {
		// Non-fatal: the banner falls back to the derived default next load.
	}
}

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

function DitherLayer({ className }: { className?: string }) {
	const spacing =
		PROFILE_DITHER_SETTINGS.pixelSize *
		PROFILE_DITHER_SETTINGS.patternScale *
		PROFILE_DITHER_SETTINGS.patternDensity;
	return (
		<div
			aria-hidden
			className={cn("pointer-events-none absolute inset-0", className)}
			style={{
				backgroundImage: squarePixelTileDataUri(),
				backgroundPosition: "0 0",
				backgroundSize: `${spacing}px ${spacing}px`,
				maskImage: `radial-gradient(circle at 50% 50%, black ${Math.round(
					(1 - PROFILE_DITHER_SETTINGS.edgeFade) * 100
				)}%, transparent 100%)`,
				WebkitMaskImage: `radial-gradient(circle at 50% 50%, black ${Math.round(
					(1 - PROFILE_DITHER_SETTINGS.edgeFade) * 100
				)}%, transparent 100%)`,
				opacity: 0.38,
			}}
		/>
	);
}

function ProfileStat({ label, value }: { label: string; value: ReactNode }) {
	return (
		<span className="inline-flex items-baseline gap-1 text-sm">
			<span className="font-semibold text-foreground">{value}</span>
			<span className="text-muted-foreground">{label}</span>
		</span>
	);
}

function ProfileHeader({
	agentIcon,
	badge,
	bannerColor,
	bannerDirection,
	builtIn,
	description,
	isLocked,
	modelLabel,
	name,
	onDescriptionChange,
	onNameChange,
	saveDisabled,
	saving,
	selectedSkills,
	selectedTools,
	onCancel,
	onCreateAndChat,
	onSave,
}: {
	agentIcon?: ReactNode;
	badge?: ReactNode;
	/** Banner wash colour. Omit to derive one from `name` (stable per agent). */
	bannerColor?: DitherColor;
	/** Banner wash direction. Omit to derive one from `name`. */
	bannerDirection?: GradientDirection;
	builtIn: boolean;
	description?: string;
	isLocked: boolean;
	modelLabel: string;
	name: string;
	onCancel?: () => void;
	onCreateAndChat?: () => void;
	onDescriptionChange?: (v: string) => void;
	onNameChange?: (v: string) => void;
	onSave?: () => void;
	saveDisabled?: boolean;
	saving?: boolean;
	selectedSkills: Set<string>;
	selectedTools: Set<string>;
}) {
	// Lazily read once per agent so the picker reflects a previous choice, and
	// re-read when the agent changes (the editor reuses this component).
	const [prefs, setPrefs] = useState<BannerPrefs>(() => loadBannerPrefs(name));
	useEffect(() => {
		setPrefs(loadBannerPrefs(name));
	}, [name]);

	const updatePrefs = (next: BannerPrefs) => {
		const merged = { ...prefs, ...next };
		setPrefs(merged);
		saveBannerPrefs(name, merged);
	};

	return (
		<section
			aria-label="Agent profile"
			className="overflow-hidden rounded-lg border bg-card"
		>
			<div
				className="relative min-h-48 overflow-hidden"
				style={{
					background:
						"linear-gradient(135deg, hsl(222 18% 7%), hsl(222 12% 13%) 58%, hsl(224 10% 22%))",
				}}
			>
				<DitherGradient
					className="absolute inset-0"
					direction={
						bannerDirection ??
						prefs.direction ??
						BANNER_DIRECTIONS[
							bannerHash(`${name}:dir`) % BANNER_DIRECTIONS.length
						]
					}
					from={
						bannerColor ??
						prefs.color ??
						BANNER_COLORS[bannerHash(name) % BANNER_COLORS.length]
					}
					opacity={0.55}
				/>
				{/* Banner customisation. Sits on the banner itself rather than in a
				    settings tab so the effect is visible while choosing. Unlocked
				    agents only — a locked/built-in agent's chrome is not editable. */}
				{isLocked ? null : (
					<div className="absolute top-3 left-3 z-10 flex items-center gap-1.5">
						{BANNER_COLORS.map((c) => {
							const active =
								(prefs.color ??
									BANNER_COLORS[bannerHash(name) % BANNER_COLORS.length]) === c;
							return (
								<button
									aria-label={`Banner colour ${c}`}
									aria-pressed={active}
									className={`size-4 rounded-full border transition-transform hover:scale-110 ${
										active
											? "border-white ring-2 ring-white/60"
											: "border-white/40"
									}`}
									key={c}
									onClick={() => updatePrefs({ color: c })}
									style={{ backgroundColor: BANNER_SWATCHES[c] }}
									type="button"
								/>
							);
						})}
						{/* Custom colour: any hue, not just the six presets. Stored as a
						    number so `from` takes it directly. */}
						<label
							className={`relative size-4 cursor-pointer overflow-hidden rounded-full border transition-transform hover:scale-110 ${
								typeof prefs.color === "number"
									? "border-white ring-2 ring-white/60"
									: "border-white/40"
							}`}
							style={{
								background:
									typeof prefs.color === "number"
										? hueToHex(prefs.color)
										: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)",
							}}
							title="Custom colour"
						>
							<input
								aria-label="Custom banner colour"
								className="absolute inset-0 cursor-pointer opacity-0"
								onChange={(e) =>
									updatePrefs({ color: hexToHue(e.target.value) })
								}
								type="color"
								value={
									typeof prefs.color === "number"
										? hueToHex(prefs.color)
										: "#b497cf"
								}
							/>
						</label>
						<span className="mx-1 h-4 w-px bg-white/25" />
						{BANNER_DIRECTIONS.map((d) => {
							const active =
								(prefs.direction ??
									BANNER_DIRECTIONS[
										bannerHash(`${name}:dir`) % BANNER_DIRECTIONS.length
									]) === d;
							return (
								<button
									aria-label={`Banner direction ${d}`}
									aria-pressed={active}
									className={`rounded px-1.5 py-0.5 text-[10px] uppercase transition-colors ${
										active
											? "bg-white/85 text-black"
											: "bg-black/35 text-white/80 hover:bg-black/50"
									}`}
									key={d}
									onClick={() => updatePrefs({ direction: d })}
									type="button"
								>
									{d}
								</button>
							);
						})}
					</div>
				)}
				<div
					aria-hidden
					className="absolute inset-0 opacity-30"
					style={{
						backgroundImage:
							"repeating-linear-gradient(120deg, transparent 0 18px, rgba(255,255,255,0.08) 18px 19px, transparent 19px 34px)",
						transform: `translateX(${PROFILE_DITHER_SETTINGS.speed * 12}px)`,
					}}
				/>
				<div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background/78 to-transparent" />
				<div className="absolute right-4 bottom-4 hidden h-48 w-44 sm:block">
					{badge ? (
						<div className="relative h-full overflow-hidden rounded-lg border border-white/25 bg-background/12 shadow-2xl backdrop-blur">
							<DitherLayer className="opacity-45" />
							<div className="absolute inset-0">{badge}</div>
						</div>
					) : null}
				</div>
			</div>

			<div className="px-4 pb-5 sm:px-6">
				<div className="-mt-12 flex items-end justify-between gap-3">
					<div className="relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-full border-4 border-background bg-card shadow-sm">
						{agentIcon ?? <RyuLogo className="text-foreground" size="42px" />}
					</div>
					<div className="flex shrink-0 items-center gap-2 pb-3">
						<Button onClick={onCancel} size="sm" variant="outline">
							Cancel
						</Button>
						<Button
							disabled={saveDisabled}
							onClick={onCreateAndChat}
							size="sm"
							variant="outline"
						>
							{saving ? <Spinner className="size-3" /> : null}
							Chat
						</Button>
						<Button disabled={saveDisabled} onClick={onSave} size="sm">
							{saving ? <Spinner className="size-3" /> : null}
							Save
						</Button>
					</div>
				</div>

				<div className="mt-3 flex flex-col gap-3">
					<div className="min-w-0">
						<Label className="sr-only" htmlFor="agent-name">
							Name
						</Label>
						<Input
							className="h-auto border-0 bg-transparent px-0 font-bold text-2xl shadow-none focus-visible:ring-0"
							disabled={isLocked}
							id="agent-name"
							onChange={(e) => onNameChange?.(e.target.value)}
							placeholder="Name your agent"
							value={name}
						/>
						<p className="truncate text-muted-foreground text-sm">
							{modelLabel || "No model selected"}
						</p>
					</div>
					<Label className="sr-only" htmlFor="agent-description">
						Description
					</Label>
					<Input
						className="h-auto border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
						disabled={isLocked}
						id="agent-description"
						onChange={(e) => onDescriptionChange?.(e.target.value)}
						placeholder="Add a short description"
						value={description ?? ""}
					/>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<ProfileStat label="tools" value={selectedTools.size} />
						<ProfileStat label="skills" value={selectedSkills.size} />
						<ProfileStat label="status" value={builtIn ? "Core" : "Custom"} />
						{isLocked ? (
							<Badge className="gap-1" variant="secondary">
								<HugeiconsIcon className="size-3" icon={LockedIcon} />
								Locked
							</Badge>
						) : null}
					</div>
				</div>
			</div>
		</section>
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
export function AgentSettingsForm(props: AgentSettingsFormProps) {
	const {
		name,
		onNameChange,
		description,
		onDescriptionChange,
		agentIcon,
		channelsPanel,
		isBuiltIn,
		isNew,
		isLocked,
		instructionsEditor,
		promptStudioPanel,
		evalsPanel,
		calendarPanel,
		historyPanel,
		systemPrompt,
		onOpenPromptStudio,
		rules,
		onRuleChange,
		onRemoveRule,
		onAddRule,
		onAddMoreAgentProviders,
		personaDisplayName,
		onPersonaDisplayNameChange,
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
		identityPanel,
		chatModel,
		engineOptions,
		onChatModelChange,
		chatSlotDisabled,
		showAcpCommand,
		acpCommand,
		acpSessionPanel,
		onAcpCommandChange,
		launchConfig,
		piConfig,
		claudeConfig,
		codexConfig,
		gatewayRoutingConfig,
		moreSlotsOpen,
		onToggleMoreSlots,
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
		connectPanel,
		byoaPanel,
		employeeBadge,
		formError,
		saving,
		saveDisabled,
		onCreateAndChat,
		onSave,
		onCancel,
	} = props;

	// Single tab strip for the whole editor: the config sections plus the
	// folded-in Prompt Studio / Evals / Calendar views. Controlled so the
	// "Open Prompt Studio" shortcut can switch tabs programmatically.
	const [activeTab, setActiveTab] = useState("model");

	const showTimeField =
		schedulePhrase === "daily" ||
		schedulePhrase === "weekdays" ||
		schedulePhrase === "weekends";
	const modelLabel =
		engineOptions.find((option) => option.id === chatModel)?.label ?? chatModel;

	return (
		<div className="mx-auto w-full max-w-5xl">
			<div className="flex min-w-0 flex-col gap-7">
				<ProfileHeader
					agentIcon={agentIcon}
					badge={employeeBadge}
					builtIn={isBuiltIn}
					description={description}
					isLocked={isLocked}
					modelLabel={modelLabel}
					name={name}
					onCancel={onCancel}
					onCreateAndChat={onCreateAndChat}
					onDescriptionChange={onDescriptionChange}
					onNameChange={onNameChange}
					onSave={onSave}
					saveDisabled={saveDisabled}
					saving={saving}
					selectedSkills={selectedSkills}
					selectedTools={selectedTools}
				/>

				<Tabs className="gap-4" onValueChange={setActiveTab} value={activeTab}>
					<TabsList className="flex-wrap" variant="pills">
						<TabsTrigger value="model">Model</TabsTrigger>
						<TabsTrigger value="trigger">Trigger</TabsTrigger>
						<TabsTrigger value="tools">Tools</TabsTrigger>
						<TabsTrigger value="connections">Connections</TabsTrigger>
						<TabsTrigger value="rules">Rules</TabsTrigger>
						<TabsTrigger value="instructions">Instructions</TabsTrigger>
						<TabsTrigger value="advanced">Advanced</TabsTrigger>
						{promptStudioPanel ? (
							<TabsTrigger value="prompt-studio">Prompt Studio</TabsTrigger>
						) : null}
						{evalsPanel ? <TabsTrigger value="evals">Evals</TabsTrigger> : null}
						{calendarPanel ? (
							<TabsTrigger value="calendar">Calendar</TabsTrigger>
						) : null}
						{historyPanel ? (
							<TabsTrigger value="history">History</TabsTrigger>
						) : null}
					</TabsList>

					<TabsContent className="flex flex-col gap-6" value="model">
						{/* 2. Model & provider */}
						<SettingsSection
							caption="The engine and model used for all chat turns."
							title="Model & provider"
						>
							<SettingsGroup>
								<SettingsItem
									actions={
										engineOptions.length === 0 ? (
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
													className="h-8 w-64 flex-shrink-0 text-sm"
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
										)
									}
									title="Chat model"
								/>
								{onAddMoreAgentProviders ? (
									<Button
										className="h-auto w-full justify-start gap-2 rounded-none px-3.5 py-2.5 font-normal text-sm"
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
										Type the command that launches your agent on this computer.
										For example: <code>goose acp</code>,{" "}
										<code>opencode acp</code>, or{" "}
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

						{launchConfig}
						{piConfig}
						{claudeConfig}
						{codexConfig}
						{gatewayRoutingConfig}
						{acpSessionPanel}
					</TabsContent>

					<TabsContent className="flex flex-col gap-6" value="trigger">
						{/* 3. Trigger — schedule + Composio event triggers */}
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
													className="h-8 w-44 flex-shrink-0 text-sm"
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
													className="h-8 w-36 flex-shrink-0 text-sm"
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
												className="h-8 w-44 font-mono"
												disabled={isLocked}
												id="custom-cron"
												onChange={(e) => onCustomCronChange?.(e.target.value)}
												placeholder="e.g. 0 9 * * 1-5"
												value={customCron}
											/>
										}
										description="Standard 5-field cron: minute hour day month weekday."
										title="Cron expression"
									/>
								) : null}
							</SettingsGroup>
						</SettingsSection>

						{showComposioTriggers ? (
							<SettingsSection
								caption="Fire this agent when a Composio event arrives (a new Slack message, a GitHub commit, …)."
								title="Event triggers"
							>
								<SettingsCard className="flex flex-col gap-3">
									{triggerSubs.length > 0 ? (
										<div className="flex flex-col gap-1.5">
											{triggerSubs.map((sub) => (
												<div
													className="flex items-center gap-2 text-sm"
													key={sub.id}
												>
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
													<Button
														aria-label="Remove trigger"
														onClick={() => onDeleteTrigger?.(sub.id)}
														size="icon-sm"
														variant="ghost"
													>
														<HugeiconsIcon
															className="size-4"
															icon={Delete01Icon}
														/>
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
													<SelectTrigger
														className="w-full"
														id="composio-trigger"
													>
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
												<Label htmlFor="composio-account">
													Account to watch
												</Label>
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
													The id of the account whose events should start this
													agent. You'll find it in your Composio dashboard.
												</p>
											</div>
											{triggerError ? (
												<p className="text-destructive text-xs">
													{triggerError}
												</p>
											) : null}
											<Button
												className="self-start"
												disabled={isLocked || subscribing}
												onClick={onSubscribeTrigger}
												size="sm"
												variant="outline"
											>
												{subscribing ? (
													<Spinner className="size-3" />
												) : (
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
					</TabsContent>

					<TabsContent className="flex flex-col gap-6" value="tools">
						{/* Capabilities (tools / thinking / vision) — gates the controls below. */}
						{capabilitiesPanel}
						{/* 4. Tools — MCP tools + Skills */}
						<SettingsSection
							caption="The MCP tools this agent may call."
							headerAction={
								selectedTools.size > 0 ? (
									<Badge variant="secondary">{selectedTools.size}</Badge>
								) : undefined
							}
							title="Tools"
						>
							<SettingsCard className="flex flex-col gap-2">
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
									<div className="flex flex-col gap-2">
										{tools.map((toolName) => {
											const checkId = `tool-${toolName}`;
											return (
												<div className="flex items-center gap-3" key={toolName}>
													<Checkbox
														checked={selectedTools.has(toolName)}
														disabled={isLocked}
														id={checkId}
														onCheckedChange={() => onToggleTool?.(toolName)}
													/>
													<Label
														className="cursor-pointer font-normal text-sm"
														htmlFor={checkId}
													>
														{toolName}
													</Label>
												</div>
											);
										})}
									</div>
								) : null}
							</SettingsCard>
						</SettingsSection>

						<SettingsSection
							caption="Limit this agent to specific skills. Leave all unchecked to allow every enabled skill."
							headerAction={
								selectedSkills.size > 0 ? (
									<Badge variant="secondary">{selectedSkills.size}</Badge>
								) : undefined
							}
							title="Skills"
						>
							<SettingsCard className="flex flex-col gap-2">
								{skillsLoading ? (
									<div className="flex items-center gap-2 text-muted-foreground text-xs">
										<Spinner className="size-3" />
										Loading skills…
									</div>
								) : null}
								{!skillsLoading && skills.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										No Skills installed. Browse and install from the Skills
										page.
									</p>
								) : null}
								{!skillsLoading && skills.length > 0 ? (
									<div className="flex flex-col gap-2">
										{skills.map((skill) => {
											const checkId = `skill-${skill.id}`;
											return (
												<div className="flex items-start gap-3" key={skill.id}>
													<Checkbox
														checked={selectedSkills.has(skill.id)}
														disabled={isLocked}
														id={checkId}
														onCheckedChange={() => onToggleSkill?.(skill.id)}
													/>
													<Label
														className="cursor-pointer font-normal text-sm"
														htmlFor={checkId}
													>
														<span className="font-medium">{skill.name}</span>
														{skill.enabled ? null : (
															<span className="ml-1.5 text-muted-foreground text-xs">
																(disabled globally)
															</span>
														)}
														{skill.description ? (
															<span className="block text-muted-foreground text-xs">
																{skill.description}
															</span>
														) : null}
													</Label>
												</div>
											);
										})}
									</div>
								) : null}
							</SettingsCard>
						</SettingsSection>
					</TabsContent>

					<TabsContent className="flex flex-col gap-6" value="connections">
						{/* 5. Connections — Composio actions + Identities + Channels */}
						<SettingsSection
							caption={
								composioConfigured
									? "Attach third-party actions (sending email, creating issues, …) from your connected integrations."
									: "Add a Composio API key in Gateway → Keys, then connect accounts in Marketplace → Connections, to attach actions like sending email or creating issues."
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
											onValueChange={(v) =>
												onComposioToolkitChange?.(v ?? null)
											}
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
											{!composioActionsLoading &&
											composioActions.length === 0 ? (
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
																<Label
																	className="cursor-pointer font-normal text-sm"
																	htmlFor={checkId}
																>
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
												<Badge className="gap-1" key={cname} variant="outline">
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

						{identityPanel}
						{channelsPanel}
					</TabsContent>

					<TabsContent className="flex flex-col gap-6" value="rules">
						{/* 6. Rules */}
						<SettingsSection
							caption="Short, always-on directives folded into this agent's instructions."
							title="Rules"
						>
							<SettingsCard className="flex flex-col gap-2">
								{rules.map((rule, index) => (
									<div
										className="flex items-center gap-2"
										// biome-ignore lint/suspicious/noArrayIndexKey: rules are positional and edited in place
										key={`rule-${index}`}
									>
										<Input
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
					</TabsContent>

					<TabsContent className="flex flex-col gap-6" value="instructions">
						{/* 7. Instructions — the output: prompt + personality */}
						<SettingsSection
							caption="Describe how this agent should behave, what it should avoid, and how it should respond."
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
							title="Instructions"
						>
							<SettingsCard>
								{instructionsEditor ?? (
									<Textarea
										className="min-h-32"
										disabled={isLocked}
										id="agent-prompt"
										readOnly={isLocked}
										value={systemPrompt}
									/>
								)}
							</SettingsCard>
						</SettingsSection>

						<SettingsSection title="Personality & tone">
							<SettingsGroup>
								<SettingsItem
									actions={
										<Input
											className="h-8 w-56"
											disabled={isLocked}
											id="persona-display-name"
											onChange={(e) =>
												onPersonaDisplayNameChange?.(e.target.value)
											}
											placeholder="e.g. Aria"
											value={personaDisplayName}
										/>
									}
									title="Display name"
								/>
								<SettingsItem
									actions={
										<Select
											disabled={isLocked}
											items={toneOptions}
											onValueChange={(v) => onToneChange?.(v ?? "")}
											value={tone}
										>
											<SelectTrigger
												className="h-8 w-56 flex-shrink-0 text-sm"
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
					</TabsContent>

					<TabsContent className="flex flex-col gap-6" value="advanced">
						{/* Advanced — collapsible-style group at the bottom */}
						<section aria-label="Advanced" className="flex flex-col gap-5">
							<MemorySpacesCard
								disabled={isLocked}
								memoryReadLevels={memoryReadLevels}
								memorySpaceIds={memorySpaceIds}
								memoryWriteEnabled={memoryWriteEnabled}
								onMemoryWriteEnabledChange={onMemoryWriteEnabledChange}
								onToggleMemoryReadLevel={onToggleMemoryReadLevel}
								onToggleMemorySpace={onToggleMemorySpace}
								spaces={spaces}
							/>

							<button
								className="-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/50"
								onClick={onToggleMoreSlots}
								type="button"
							>
								<span className="font-semibold text-sm">Advanced slots</span>
								<Badge className="text-[10px]" variant="secondary">
									Coming soon
								</Badge>
								<span className="ml-auto text-muted-foreground">
									<HugeiconsIcon
										className="size-4"
										icon={moreSlotsOpen ? ArrowDown01Icon : ArrowRight01Icon}
									/>
								</span>
							</button>

							{moreSlotsOpen ? (
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<SettingsCard>
										<SlotCard
											available={false}
											description="Speech-to-text model for voice input."
											id="stt"
											label="Speech-to-text"
											options={[]}
											value=""
										/>
									</SettingsCard>
									<SettingsCard>
										<SlotCard
											available={false}
											description="Text-to-speech model for voice output."
											id="tts"
											label="Text-to-speech"
											options={[]}
											value=""
										/>
									</SettingsCard>
									<SettingsCard>
										<SlotCard
											available={false}
											description="Image generation model for visual tasks."
											id="image-model"
											label="Image model"
											options={[]}
											value=""
										/>
									</SettingsCard>
									<SettingsCard>
										<SlotCard
											available={false}
											description="Gateway policy ref for firewall, PII filtering, and budget."
											id="policy"
											label="Gateway policy"
											options={[]}
											value=""
										/>
									</SettingsCard>
								</div>
							) : null}

							{advancedInference}
							{connectPanel}
							{byoaPanel}
						</section>
					</TabsContent>

					{promptStudioPanel ? (
						<TabsContent className="flex flex-col gap-5" value="prompt-studio">
							{promptStudioPanel}
						</TabsContent>
					) : null}

					{evalsPanel ? (
						<TabsContent className="flex flex-col gap-5" value="evals">
							{evalsPanel}
						</TabsContent>
					) : null}

					{calendarPanel ? (
						<TabsContent className="flex flex-col gap-5" value="calendar">
							{calendarPanel}
						</TabsContent>
					) : null}

					{historyPanel ? (
						<TabsContent className="flex flex-col gap-5" value="history">
							{historyPanel}
						</TabsContent>
					) : null}
				</Tabs>

				{formError ? (
					<p className="text-destructive text-sm">{formError}</p>
				) : null}

				<div className="flex gap-2">
					{isNew ? (
						<>
							<Button disabled={saveDisabled} onClick={onCreateAndChat}>
								{saving ? <Spinner /> : null}
								Create &amp; chat
							</Button>
							<Button disabled={saveDisabled} onClick={onSave} variant="ghost">
								Save
							</Button>
						</>
					) : (
						<Button disabled={saveDisabled} onClick={onSave}>
							{saving ? <Spinner /> : null}
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
					<h2 className="font-semibold text-base">Prompt Studio</h2>
					<p className="text-muted-foreground text-xs">
						PlateJS markdown editor for the system prompt.
					</p>
					<div className="rounded-lg border bg-card p-4 text-sm leading-relaxed">
						<pre className="whitespace-pre-wrap font-sans">{systemPrompt}</pre>
					</div>
				</section>
			)}

			{formError ? (
				<p className="text-destructive text-sm">{formError}</p>
			) : null}

			<div className="flex gap-2">
				<Button disabled={saveDisabled} onClick={onSave}>
					{saving ? <Spinner /> : null}
					Save prompt
				</Button>
				<Button onClick={onCancel} variant="ghost">
					Cancel
				</Button>
			</div>
		</div>
	);
}
