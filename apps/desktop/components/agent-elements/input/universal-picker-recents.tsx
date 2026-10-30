import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComposerSettingItem } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { AgentAvatar, AgentLogo } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { PickerRef } from "@/src/lib/picker-favorites.ts";
import pickerStyles from "./universal-picker-body.module.css";
import type { ProviderEntry } from "./universal-picker-types.ts";

export const SEARCH_THRESHOLD = 6;

/** Case-insensitive substring match over a target's searchable text. */
export function matches(
	query: string,
	...fields: (string | null | undefined)[]
): boolean {
	if (!query) {
		return true;
	}
	return fields.some((f) => (f ?? "").toLowerCase().includes(query));
}

interface RecentPickerModel {
	effort?: string;
	model: ComposerSettingItem;
	provider: ProviderEntry;
	ref: Extract<PickerRef, { kind: "model" }>;
}

export function recentModels(
	refs: readonly PickerRef[] | undefined,
	providers: ProviderEntry[]
): RecentPickerModel[] {
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	const rows: RecentPickerModel[] = [];
	for (const ref of refs ?? []) {
		if (ref.kind !== "model") {
			continue;
		}
		const provider = byId.get(ref.providerId);
		const model = provider?.models.find((item) => item.id === ref.modelId);
		if (!(provider && model)) {
			continue;
		}
		rows.push({ effort: ref.effort, model, provider, ref });
	}
	return rows;
}

export function recentAgents(
	refs: readonly PickerRef[] | undefined,
	agents: AgentSummary[],
	ryuAgent: AgentSummary | null
): Array<{ agent: AgentSummary; ref: Extract<PickerRef, { kind: "agent" }> }> {
	const byId = new Map(
		[...(ryuAgent ? [ryuAgent] : []), ...agents].map((agent) => [
			agent.id,
			agent,
		])
	);
	const rows: Array<{
		agent: AgentSummary;
		ref: Extract<PickerRef, { kind: "agent" }>;
	}> = [];
	for (const ref of refs ?? []) {
		if (ref.kind !== "agent") {
			continue;
		}
		const agent = byId.get(ref.agentId);
		if (agent) {
			rows.push({ agent, ref });
		}
	}
	return rows;
}

function RecentEffortMeter({ effort }: { effort?: string }) {
	const tl = useLiteralMessages();
	if (!effort) {
		return null;
	}
	const levels = ["off", "low", "medium", "high", "max"];
	const activeIndex = Math.max(0, levels.indexOf(effort.toLowerCase()));
	const label = effort.charAt(0).toUpperCase() + effort.slice(1);
	return (
		<span
			aria-label={tl("Effort: {label}", { label })}
			className="inline-flex h-4 shrink-0 items-end gap-px text-primary"
			data-composer-effort-meter="true"
			role="img"
			title={tl("Effort: {label}", { label })}
		>
			{levels.map((level, index) => (
				<span
					aria-hidden="true"
					className={cn(
						"w-1",
						pickerStyles.effortPip,
						index <= activeIndex ? "bg-current" : "bg-muted-foreground/25"
					)}
					data-effort-index={index}
					key={level}
				/>
			))}
		</span>
	);
}

export function RecentModelRow({
	effort,
	model,
	modelRef,
	onRemove,
	onSelect,
	provider,
	testId,
}: Omit<RecentPickerModel, "ref"> & {
	modelRef: RecentPickerModel["ref"];
	onRemove?: (ref: PickerRef) => void;
	onSelect: (ref: PickerRef) => void;
	testId?: string;
}) {
	const tl = useLiteralMessages();
	const commandNavigation = useProviderCommandNavigation();
	const content = (
		<>
			<AgentLogo
				className="size-4 shrink-0"
				engine={provider.engineKey}
				size="16px"
			/>
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-center gap-2">
					<span className="min-w-0 flex-1 truncate">{model.name}</span>
					<RecentEffortMeter effort={effort} />
				</span>
				<span className="block truncate text-muted-foreground text-xs">
					{provider.label}
				</span>
			</span>
			{onRemove ? (
				<Button
					appearance="picker-remove"
					aria-label={tl("Remove {name} from recent", { name: model.name })}
					className="shrink-0"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove(modelRef);
					}}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} />
				</Button>
			) : null}
		</>
	);
	if (commandNavigation) {
		return (
			<CommandItem
				className="group/recent min-w-0"
				data-testid={testId ?? "recent-model-row"}
				onSelect={() => onSelect(modelRef)}
				value={`recent ${model.name} ${provider.label}`}
			>
				{content}
			</CommandItem>
		);
	}
	return (
		<DropdownMenuItem
			className="group/recent min-w-0"
			closeOnClick={false}
			data-testid={testId ?? "recent-model-row"}
			onClick={() => onSelect(modelRef)}
			spacing="comfortable"
		>
			{content}
		</DropdownMenuItem>
	);
}

export function RecentAgentRow({
	agent,
	agentRef,
	onRemove,
	onSelect,
	testId,
}: {
	agent: AgentSummary;
	agentRef: Extract<PickerRef, { kind: "agent" }>;
	onRemove?: (ref: PickerRef) => void;
	onSelect: (ref: PickerRef) => void;
	testId?: string;
}) {
	const tl = useLiteralMessages();
	const commandNavigation = useProviderCommandNavigation();
	const content = (
		<>
			<AgentAvatar
				className="size-4 shrink-0 object-contain"
				engine={agent.engine ?? agent.id}
				glyph={agent.avatarGlyph}
				size="16px"
			/>
			<span className="min-w-0 flex-1 truncate">{agent.name}</span>
			{onRemove ? (
				<Button
					appearance="picker-remove"
					aria-label={tl("Remove {name} from recent", { name: agent.name })}
					className="shrink-0"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove(agentRef);
					}}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} />
				</Button>
			) : null}
		</>
	);
	if (commandNavigation) {
		return (
			<CommandItem
				className="group/recent min-w-0"
				data-testid={testId ?? "recent-agent-row"}
				onSelect={() => onSelect(agentRef)}
				value={`recent ${agent.name}`}
			>
				{content}
			</CommandItem>
		);
	}
	return (
		<DropdownMenuItem
			className="group/recent min-w-0"
			closeOnClick={false}
			data-testid={testId ?? "recent-agent-row"}
			onClick={() => onSelect(agentRef)}
			spacing="comfortable"
		>
			{content}
		</DropdownMenuItem>
	);
}
