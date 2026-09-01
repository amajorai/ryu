import { Button } from "@ryu/ui/components/button";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { PageHeader } from "@ryu/ui/components/page-header";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
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
			className="flex size-12 shrink-0 items-center justify-center"
			data-avatar-colors={`${palette.c1}|${palette.c2}|${palette.c3}`}
			data-testid={`agent-suggestion-avatar-${suggestionId}`}
			style={{ color: palette.c2 }}
		>
			<RyuLogo
				animated
				animation="random"
				className="size-full"
				colors={palette}
				expression="random"
				size="42px"
				variant="expressive"
			/>
		</span>
	);
}

function SuggestionCard({
	connectedApps,
	disabled,
	onToggle,
	selected,
	suggestion,
}: {
	connectedApps: readonly OnboardingConnectedApp[];
	disabled: boolean;
	onToggle: () => void;
	selected: boolean;
	suggestion: OnboardingAgentSuggestion;
}) {
	const palette = paletteForSuggestion(suggestion.id);
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
					<PageHeader
						as="h2"
						className="min-w-0 flex-1"
						stagger={false}
						subtitle={suggestion.description}
						title={suggestion.name}
					/>
					<span
						className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}
					>
						{selected ? <Check className="size-3.5" /> : null}
					</span>
				</button>

				{connectedApps.length > 0 ? (
					<div className="mt-3 ml-14 flex flex-wrap items-center gap-1.5">
						{connectedApps.map((app) => (
							<span
								className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
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
			</SettingsCard>
		</div>
	);
}

export function AgentSuggestionsStep({
	busy,
	connectedApps,
	error,
	onCreate,
	onSkip,
	onToggle,
	selected,
	suggestions,
}: {
	busy: boolean;
	connectedApps: readonly OnboardingConnectedApp[];
	error?: string | null;
	onCreate: () => void;
	onSkip: () => void;
	onToggle: (id: string) => void;
	selected: ReadonlySet<string>;
	suggestions: readonly OnboardingAgentSuggestion[];
}) {
	const selectedCount = selected.size;
	return (
		<div className="flex w-full max-w-xl flex-col gap-3 pb-4">
			<div className="flex flex-col gap-3">
				{suggestions.map((suggestion) => (
					<SuggestionCard
						connectedApps={connectedApps}
						disabled={busy}
						key={suggestion.id}
						onToggle={() => onToggle(suggestion.id)}
						selected={selected.has(suggestion.id)}
						suggestion={suggestion}
					/>
				))}
			</div>

			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}

			<div className="sticky bottom-0 flex items-center justify-between gap-3 bg-background/80 py-2 backdrop-blur-sm">
				<Button disabled={busy} onClick={onSkip} variant="ghost">
					Skip for now
				</Button>
				<Button
					disabled={selectedCount === 0 || busy}
					loading={busy}
					onClick={onCreate}
					size="lg"
					variant="mono"
				>
					{selectedCount > 0
						? `Add ${selectedCount} agent${selectedCount === 1 ? "" : "s"}`
						: "Select an agent"}
				</Button>
			</div>
		</div>
	);
}
