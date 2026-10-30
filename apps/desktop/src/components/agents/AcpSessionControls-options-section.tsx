// apps/desktop/src/components/agents/AcpSessionControls-options-section.tsx
//
// The "Session defaults" section of the agent-edit ACP session controls: the
// agent's own model / approval mode / reasoning-effort pickers.

import {
	FullAccessSelectionProvider,
	useFullAccessSelectionGuard,
} from "@ryu/blocks/composer/full-access-warning.tsx";
import { RangeSlider } from "@ryu/ui/components/motion/range-slider.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { LEVEL_RAMP_CLASS, levelFillColor } from "@/src/lib/level-ramp.ts";
import {
	SettingsCard,
	SettingsSection,
} from "../settings/shared/settings-items.tsx";

/** Engine-catalog fallback inputs. This surface only shows what the AGENT
 *  advertises — the engine model has its own field on the same page — so the
 *  fallback branch is fed an empty list and its section self-hides. */
const NO_MODEL_OPTIONS: never[] = [];
const noopModelChange = () => {
	// The engine-catalog branch is not rendered here; see NO_MODEL_OPTIONS.
};

/**
 * One agent-advertised session control, rendered as a settings row.
 *
 * An ORDERED scale (reasoning effort: off → low → … → max) is a stepped slider
 * with the shared cool → hot fill ramp, exactly as the composer renders it
 * (`EffortSliderRow`) — same control, same colours, whether you meet it in the
 * chat bar or here. `LEVEL_RAMP_CLASS` on the wrapper is what makes the top of
 * that ramp resolve; without it the fill silently disappears. Everything else is
 * an unordered set and gets a select.
 */
function AcpOptionRow({ section }: { section: ComposerSettingsSection }) {
	const selectionGuard = useFullAccessSelectionGuard();
	const activeIndex = Math.max(
		0,
		section.items.findIndex((it) => it.id === section.value)
	);
	const active = section.items[activeIndex];

	if (section.variant === "slider") {
		return (
			<div className={cn("flex flex-col gap-1.5", LEVEL_RAMP_CLASS)}>
				<div className="flex items-center justify-between gap-2">
					<span className="font-medium text-sm">{section.label}</span>
					<span className="max-w-[160px] truncate text-muted-foreground text-xs">
						{active?.name}
					</span>
				</div>
				<RangeSlider
					aria-label={section.ariaLabel}
					className="h-8"
					fillColor={levelFillColor(activeIndex, section.items.length)}
					formatValueText={(v) =>
						section.items[Math.round(v)]?.name ?? String(v)
					}
					max={section.items.length - 1}
					min={0}
					onValueChange={(next) => {
						const picked = section.items[Math.round(next)];
						if (picked && picked.id !== section.value) {
							section.onChange(picked.id);
						}
					}}
					step={1}
					value={activeIndex}
				/>
				<div className="flex items-center justify-between gap-1">
					{section.items.map((item, i) => (
						<span
							className={cn(
								"flex-1 truncate text-xs leading-none",
								i === 0 && "text-left",
								i === section.items.length - 1 && "text-right",
								i > 0 && i < section.items.length - 1 && "text-center",
								i === activeIndex
									? "text-foreground"
									: "text-muted-foreground/70"
							)}
							key={item.id}
						>
							{item.name}
						</span>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="font-medium text-sm">{section.label}</span>
				{active?.description ? (
					<span className="text-muted-foreground text-xs">
						{active.description}
					</span>
				) : null}
			</div>
			<Select
				onValueChange={(next) => {
					if (next) {
						const item = section.items.find(
							(candidate) => candidate.id === next
						);
						selectionGuard?.request(
							item ?? { id: next, name: next },
							() => section.onChange(next),
							section.label
						);
					}
				}}
				value={section.value ?? ""}
			>
				<SelectTrigger className="w-56 shrink-0">
					<SelectValue placeholder="Default" />
				</SelectTrigger>
				<SelectContent>
					{section.items.map((item) => (
						<SelectItem key={item.id} value={item.id}>
							{item.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * The agent's OWN session controls — model, approval mode, reasoning effort and
 * whatever else it advertises — configurable per agent, on the agent's page.
 *
 * These are the same sections the composer builds
 * (`useComposerAcpSections`, keyed by agent rather than by live chat session)
 * writing through the same per-agent store (`src/lib/acp-selections.ts`), so a
 * pick made here is the pick a new chat with this agent starts on, and the chat
 * bar shows it already selected. That shared store is the point: at Ryu Work
 * mode the composer stops carrying these controls at all, and this
 * page is where they continue to live.
 */
export function AcpSessionOptionsSection({ agentId }: { agentId: string }) {
	const { agents } = useAgents();
	const agentName = agents.find((agent) => agent.id === agentId)?.name;
	const { modelSection, extraSections } = useComposerAcpSections({
		agentId,
		agents,
		engineModel: null,
		modelOptions: NO_MODEL_OPTIONS,
		onEngineModelChange: noopModelChange,
	});

	const modelAsSection: ComposerSettingsSection = {
		key: "model",
		label: "Model",
		ariaLabel: "Select model",
		items: modelSection.items,
		value: modelSection.value,
		onChange: modelSection.onChange,
		loading: modelSection.loading,
	};
	// Deliberately NOT `modelSection.renderContent`: that body is the composer's
	// grouped/searchable dropdown, built to live inside a menu. A settings row
	// wants a plain select over the same items.
	const sections = [modelAsSection, ...extraSections].filter(
		(section) => section.items.length > 0
	);
	const probing = modelSection.loading && sections.length === 0;

	if (probing) {
		return (
			<SettingsSection
				caption="Asking the agent which models and modes it supports…"
				title="Session defaults"
			>
				<SettingsCard>
					<SkeletonRows label="Detecting…" rows={2} />
				</SettingsCard>
			</SettingsSection>
		);
	}
	// A local agent advertises no session config at all, so this whole block is
	// absent rather than empty.
	if (sections.length === 0) {
		return null;
	}

	return (
		<SettingsSection
			caption="Default model, approval mode and reasoning effort for new chats with this agent."
			title="Session defaults"
		>
			<FullAccessSelectionProvider agentName={agentName}>
				<SettingsCard className="flex flex-col gap-4">
					{sections.map((section) => (
						<AcpOptionRow key={section.key} section={section} />
					))}
				</SettingsCard>
			</FullAccessSelectionProvider>
		</SettingsSection>
	);
}
