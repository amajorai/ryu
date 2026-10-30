import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { useLiteralMessages, useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useState } from "react";
import {
	AGENT_IDENTITY_MODE_OPTIONS,
	AgentIdentityModePicker,
} from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { suggestionIdentityMode } from "@/src/lib/agent-suggestion.ts";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";
import type { OnboardingAgentSuggestion } from "@/src/lib/api/onboarding-profile.ts";

export interface OnboardingConnectedApp {
	logo: ReactNode;
	name: string;
	slug: string;
}

const EXPRESSIVE_PALETTES = [
	{
		bg: "oklch(97% 0.035 80)",
		c1: "oklch(75% 0.19 30)",
		c2: "oklch(56% 0.18 35)",
		c3: "oklch(70% 0.16 60)",
	},
	{
		bg: "oklch(96% 0.035 310)",
		c1: "oklch(72% 0.2 325)",
		c2: "oklch(55% 0.2 305)",
		c3: "oklch(70% 0.16 270)",
	},
	{
		bg: "oklch(96% 0.035 165)",
		c1: "oklch(72% 0.18 160)",
		c2: "oklch(51% 0.16 175)",
		c3: "oklch(70% 0.15 205)",
	},
	{
		bg: "oklch(96% 0.03 240)",
		c1: "oklch(72% 0.18 245)",
		c2: "oklch(52% 0.19 265)",
		c3: "oklch(70% 0.15 210)",
	},
	{
		bg: "oklch(97% 0.03 15)",
		c1: "oklch(72% 0.2 10)",
		c2: "oklch(54% 0.19 350)",
		c3: "oklch(70% 0.15 45)",
	},
] as const;

const TOOL_LABELS = new Map<string, string>([
	["memory.search", "Memory search"],
	["memory.store", "Save memories"],
	["routines.create", "Create routines"],
	["routines.list", "View routines"],
	["search_conversations.search", "Search past chats"],
	["skills.load", "Load skills"],
	["skills.search", "Search skills"],
	["spaces.list_documents", "List Space documents"],
	["spaces.search", "Search Spaces"],
	["web.crawl", "Crawl the web"],
	["web.extract", "Read web pages"],
	["web.search", "Search the web"],
	["workspace.open_panel", "Open a Ryu panel"],
	["workspace.open_tab", "Open a Ryu page"],
]);

function toolLabel(tool: string): string {
	return (
		TOOL_LABELS.get(tool) ??
		tool
			.split(".")
			.at(-1)
			?.replaceAll("_", " ")
			.replace(/\b\w/g, (letter) => letter.toUpperCase()) ??
		tool
	);
}

function paletteForSuggestion(seed: string) {
	let hash = 0;
	for (const character of seed) {
		hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
	}
	const index = Math.abs(hash) % EXPRESSIVE_PALETTES.length;
	return EXPRESSIVE_PALETTES[index] ?? EXPRESSIVE_PALETTES[0];
}

function RyuExpressiveAvatar({
	palette,
	suggestionId,
}: {
	palette: (typeof EXPRESSIVE_PALETTES)[number];
	suggestionId: string;
}) {
	return (
		<span
			aria-hidden="true"
			className="relative flex size-8 shrink-0 items-center justify-center"
			data-avatar-colors={`${palette.c1}|${palette.c2}|${palette.c3}`}
			data-testid={`agent-suggestion-avatar-${suggestionId}`}
		>
			<span
				className="pointer-events-none absolute inset-0 flex items-center justify-center"
				data-siri-orb="fill"
			>
				<RyuLogo
					animated
					className="size-full"
					colors={palette}
					showEyes={false}
					size="28px"
					variant="default"
				/>
			</span>
			<span
				className="pointer-events-none absolute inset-0 flex items-center justify-center text-white"
				data-expressive-face="true"
			>
				<RyuLogo
					animated
					animation="random"
					className="size-full"
					colors={palette}
					expression="random"
					eyeScale={2}
					size="28px"
					variant="expressive"
				/>
			</span>
		</span>
	);
}

/**
 * How a suggested agent will work: the chosen mode as a pill, and a Change
 * control that opens the same compact cards the agent editor shows.
 */
function SuggestionIdentity({
	disabled,
	identityMode,
	onIdentityModeChange,
	suggestion,
}: {
	disabled: boolean;
	identityMode: AgentIdentityMode;
	onIdentityModeChange: (mode: AgentIdentityMode) => void;
	suggestion: OnboardingAgentSuggestion;
}) {
	const tl = useLiteralMessages();
	const [choosing, setChoosing] = useState(false);
	return (
		<div
			className="flex flex-col gap-2"
			data-testid={`agent-suggestion-identity-${suggestion.id}`}
		>
			<div className="flex items-center gap-2 text-detail">
				<span className="text-muted-foreground">Identity</span>
				<span className="font-medium">
					{AGENT_IDENTITY_MODE_OPTIONS[identityMode].title}
				</span>
				<Button
					aria-expanded={choosing}
					aria-label={
						choosing
							? tl("Done choosing how {name} works", {
									name: suggestion.name,
								})
							: tl("Change how {name} works", { name: suggestion.name })
					}
					disabled={disabled}
					onClick={() => setChoosing((open) => !open)}
					size="sm"
					type="button"
					variant="link"
				>
					{choosing ? "Done" : "Change"}
				</Button>
			</div>
			{choosing ? (
				<AgentIdentityModePicker
					aria-label={tl("How should {name} work?", {
						name: suggestion.name,
					})}
					disabled={disabled}
					onChange={onIdentityModeChange}
					size="compact"
					value={identityMode}
				/>
			) : null}
		</div>
	);
}

function SuggestionCard({
	connectedApps,
	disabled,
	identityMode,
	onIdentityModeChange,
	onToggle,
	onReview,
	reviewed,
	selected,
	suggestion,
}: {
	connectedApps: readonly OnboardingConnectedApp[];
	disabled: boolean;
	identityMode: AgentIdentityMode;
	onIdentityModeChange: (mode: AgentIdentityMode) => void;
	onToggle: () => void;
	onReview: (reviewed: boolean) => void;
	reviewed: boolean;
	selected: boolean;
	suggestion: OnboardingAgentSuggestion;
}) {
	const tl = useLiteralMessages();
	const palette = paletteForSuggestion(suggestion.id);
	const title = useLocalizedText(suggestion.name, { literal: true });
	const description = useLocalizedText(suggestion.description, {
		literal: true,
	});
	const [expanded, setExpanded] = useState(false);
	// Selecting a draft opens its details: the review below is what adds it.
	const open = expanded || selected;
	return (
		<div
			className={cn(
				"rounded-lg px-3 py-2 transition-colors duration-150",
				selected && "bg-accent"
			)}
			data-testid={`agent-suggestion-${suggestion.id}`}
		>
			<div className="flex items-center gap-3">
				<button
					aria-label={
						selected
							? tl("Deselect {name}", { name: suggestion.name })
							: tl("Select {name}", { name: suggestion.name })
					}
					aria-pressed={selected}
					className="flex min-w-0 flex-1 items-center gap-3 text-left"
					disabled={disabled}
					onClick={onToggle}
					type="button"
				>
					<span
						aria-hidden="true"
						className={cn(
							"flex size-4 shrink-0 items-center justify-center rounded-full border",
							selected
								? "border-primary bg-primary text-primary-foreground"
								: "border-border"
						)}
					>
						{selected ? (
							<HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
						) : null}
					</span>
					<RyuExpressiveAvatar palette={palette} suggestionId={suggestion.id} />
					{/* Phrasing content only: this sits inside the toggle button. */}
					<span className="block min-w-0 flex-1">
						<span className="block font-medium text-sm">{title}</span>
						<span className="block truncate text-detail text-muted-foreground">
							{description}
						</span>
					</span>
				</button>
				<Button
					aria-expanded={open}
					disabled={selected}
					onClick={() => setExpanded((current) => !current)}
					size="sm"
					type="button"
					variant="ghost-muted"
				>
					Details
					<HugeiconsIcon
						className={cn("transition-transform", open && "rotate-180")}
						icon={ArrowDown01Icon}
						size={14}
					/>
				</Button>
			</div>

			{open ? (
				<div className="mt-3 ml-18 flex flex-col gap-3 text-detail">
					<div>
						<p className="text-muted-foreground">Why this showed up</p>
						<p className="text-pretty">{suggestion.reason}</p>
					</div>

					{connectedApps.length > 0 ? (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span className="text-muted-foreground">Connected apps</span>
							{connectedApps.map((app) => (
								<span
									className="inline-flex items-center gap-1"
									data-testid={`connected-app-${app.slug}`}
									key={app.slug}
								>
									<span className="flex size-4 shrink-0 items-center justify-center overflow-hidden [&_img]:size-4">
										{app.logo}
									</span>
									<span>{app.name}</span>
								</span>
							))}
						</div>
					) : null}

					<div
						className="flex min-w-0 flex-wrap gap-x-3 gap-y-1"
						data-testid="suggested-tools"
					>
						<span className="text-muted-foreground">Tools</span>
						{suggestion.tools.map((tool) => (
							<span key={tool}>{toolLabel(tool)}</span>
						))}
					</div>

					<SuggestionIdentity
						disabled={disabled}
						identityMode={identityMode}
						onIdentityModeChange={onIdentityModeChange}
						suggestion={suggestion}
					/>

					<div>
						<p className="text-muted-foreground">Review prompt setup</p>
						<p
							className="max-h-40 overflow-y-auto whitespace-pre-wrap text-pretty"
							data-testid="suggested-prompt"
						>
							{suggestion.systemPrompt}
						</p>
					</div>

					<label className="flex items-start gap-2 text-muted-foreground">
						<Checkbox
							aria-label={tl("I reviewed {name}", { name: suggestion.name })}
							checked={reviewed}
							disabled={disabled}
							onCheckedChange={(checked) => onReview(checked === true)}
						/>
						<span>
							I reviewed this draft&apos;s prompt and tools before adding it.
						</span>
					</label>
				</div>
			) : null}
		</div>
	);
}

export function AgentSuggestionsStep({
	busy,
	connectedApps,
	error,
	identityModes,
	onCreate,
	onIdentityModeChange,
	onSkip,
	onToggle,
	onReview,
	reviewed,
	selected,
	suggestions,
}: {
	busy: boolean;
	connectedApps: readonly OnboardingConnectedApp[];
	error?: string | null;
	/** The identity mode chosen per suggestion id; a missing one acts as you. */
	identityModes: ReadonlyMap<string, AgentIdentityMode>;
	onCreate: () => void;
	onIdentityModeChange: (id: string, mode: AgentIdentityMode) => void;
	onSkip: () => void;
	onToggle: (id: string) => void;
	onReview: (id: string, reviewed: boolean) => void;
	reviewed: ReadonlySet<string>;
	selected: ReadonlySet<string>;
	suggestions: readonly OnboardingAgentSuggestion[];
}) {
	const tl = useLiteralMessages();
	const selectedCount = selected.size;
	const pendingReviewCount = suggestions.filter(
		(suggestion) => selected.has(suggestion.id) && !reviewed.has(suggestion.id)
	).length;
	return (
		<>
			<div className="flex flex-col gap-1">
				{suggestions.map((suggestion) => (
					<SuggestionCard
						connectedApps={connectedApps}
						disabled={busy}
						identityMode={suggestionIdentityMode(identityModes, suggestion.id)}
						key={suggestion.id}
						onIdentityModeChange={(mode) =>
							onIdentityModeChange(suggestion.id, mode)
						}
						onReview={(next) => onReview(suggestion.id, next)}
						onToggle={() => onToggle(suggestion.id)}
						reviewed={reviewed.has(suggestion.id)}
						selected={selected.has(suggestion.id)}
						suggestion={suggestion}
					/>
				))}
			</div>

			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}

			<OnboardingActions className="sticky bottom-0 justify-between bg-background py-2">
				<OnboardingCta disabled={busy} onClick={onSkip} tone="secondary">
					Skip for now
				</OnboardingCta>
				<OnboardingCta
					disabled={selectedCount === 0 || pendingReviewCount > 0 || busy}
					loading={busy}
					onClick={onCreate}
				>
					{pendingReviewCount > 0
						? tl(
								"Review {pendingReviewCount, plural, one {# selected draft} other {# selected drafts}}",
								{ pendingReviewCount }
							)
						: selectedCount > 0
							? tl(
									"Add {selectedCount, plural, one {# agent} other {# agents}}",
									{ selectedCount }
								)
							: "Select an agent"}
				</OnboardingCta>
			</OnboardingActions>
		</>
	);
}
