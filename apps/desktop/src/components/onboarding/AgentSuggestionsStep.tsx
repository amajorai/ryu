import { useLiteralMessages, useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo.tsx";
import { Check, ChevronDown, Sparkles, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	AGENT_IDENTITY_MODE_OPTIONS,
	AgentIdentityModePicker,
} from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
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
			className="relative flex size-12 shrink-0 items-center justify-center"
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
					size="42px"
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
					size="42px"
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
			<div className="flex items-center gap-2 text-xs">
				<span className="text-muted-foreground">Identity</span>
				<span className="rounded-full bg-muted px-3 py-1 font-medium">
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
	return (
		<div data-testid={`agent-suggestion-${suggestion.id}`}>
			<SettingsCard
				className={
					selected ? "bg-primary/10 ring-1 ring-primary/30" : undefined
				}
			>
				<button
					aria-label={`${selected ? "Deselect" : "Select"} ${suggestion.name}`}
					aria-pressed={selected}
					className="flex w-full items-center gap-3 text-left"
					disabled={disabled}
					onClick={onToggle}
					type="button"
				>
					<RyuExpressiveAvatar palette={palette} suggestionId={suggestion.id} />
					<div className="min-w-0 flex-1 space-y-1">
						<h2 className="font-medium text-base">{title}</h2>
						<p className="font-medium text-muted-foreground text-sm leading-relaxed">
							{description}
						</p>
					</div>
					<span
						className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}
					>
						{selected ? <Check className="size-3.5" /> : null}
					</span>
				</button>

				{connectedApps.length > 0 ? (
					<div className="mt-3 ml-14 flex flex-wrap items-center gap-1.5">
						<span className="type-caption mr-1 text-muted-foreground">
							Connected apps
						</span>
						{connectedApps.map((app) => (
							<span
								className="type-caption inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2 py-1 text-muted-foreground"
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

				<div className="mt-3 ml-14 flex flex-col gap-3">
					<div className="rounded-lg bg-background/50 px-3 py-2">
						<div className="type-caption flex items-center gap-1.5 font-medium text-muted-foreground uppercase tracking-wide">
							<Sparkles className="size-3" />
							Why this showed up
						</div>
						<p className="mt-1 text-xs leading-relaxed">{suggestion.reason}</p>
					</div>

					<div className="flex items-start gap-2">
						<Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
						<div
							className="flex min-w-0 flex-wrap gap-1.5"
							data-testid="suggested-tools"
						>
							{suggestion.tools.map((tool) => (
								<span
									className="type-caption rounded-full border border-border/70 bg-background/60 px-2 py-1 text-muted-foreground"
									key={tool}
								>
									{toolLabel(tool)}
								</span>
							))}
						</div>
					</div>

					<SuggestionIdentity
						disabled={disabled}
						identityMode={identityMode}
						onIdentityModeChange={onIdentityModeChange}
						suggestion={suggestion}
					/>

					<details
						className="group rounded-lg border border-border/60 bg-background/40"
						open
					>
						<summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-muted-foreground text-xs [&::-webkit-details-marker]:hidden">
							<span>Review prompt setup</span>
							<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
						</summary>
						<p
							className="max-h-40 overflow-y-auto whitespace-pre-wrap border-border/60 border-t px-3 py-2 text-muted-foreground text-xs leading-relaxed"
							data-testid="suggested-prompt"
						>
							{suggestion.systemPrompt}
						</p>
					</details>

					<div className="flex items-start gap-2 text-muted-foreground text-xs leading-relaxed">
						<Checkbox
							aria-label={tl("I reviewed {name}", { name: suggestion.name })}
							checked={reviewed}
							disabled={disabled}
							onCheckedChange={(checked) => onReview(checked === true)}
						/>
						<span>
							I reviewed this draft&apos;s prompt and tools before adding it.
						</span>
					</div>
				</div>
			</SettingsCard>
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
		<div className="flex w-full max-w-xl flex-col gap-3 pb-4">
			<div className="flex flex-col gap-3">
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
				<p className="text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}

			<div className="sticky bottom-0 flex items-center justify-between gap-3 bg-background/80 py-2 backdrop-blur-sm">
				<Button disabled={busy} onClick={onSkip} variant="ghost">
					Skip for now
				</Button>
				<Button
					disabled={selectedCount === 0 || pendingReviewCount > 0 || busy}
					loading={busy}
					onClick={onCreate}
					size="lg"
					variant="mono"
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
				</Button>
			</div>
		</div>
	);
}
