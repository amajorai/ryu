import { ArrowDown01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { ScrollArea } from "@ryu/ui/components/scroll-area";
import { useEffect, useId, useMemo, useState } from "react";
import type {
	SkillTargetChoice as ApiSkillTargetChoice,
	SkillAgentTarget,
} from "@/src/lib/api/skills.ts";

export type SkillTargetChoice = ApiSkillTargetChoice;

const FEATURED_TARGET_IDS = [
	"claude-code",
	"codex",
	"cursor",
	"gemini-cli",
	"grok",
];

/** Stable picker order: detected registry order, the five product defaults,
 * then every other supported agent by display name. Duplicate ids appear once. */
export function orderSkillTargets(
	targets: SkillAgentTarget[]
): SkillAgentTarget[] {
	const byId = new Map<string, SkillAgentTarget>();
	for (const target of targets) {
		if (!byId.has(target.id)) {
			byId.set(target.id, target);
		}
	}
	const ordered: SkillAgentTarget[] = [];
	const add = (target: SkillAgentTarget | undefined) => {
		if (!target || ordered.some((candidate) => candidate.id === target.id)) {
			return;
		}
		ordered.push(target);
	};
	for (const target of byId.values()) {
		if (target.detected) {
			add(target);
		}
	}
	for (const id of FEATURED_TARGET_IDS) {
		add(byId.get(id));
	}
	for (const target of [...byId.values()].sort((left, right) =>
		left.name.localeCompare(right.name)
	)) {
		add(target);
	}
	return ordered;
}

export interface SkillTargetListProps {
	onTargetIdsChange: (targetIds: string[]) => void;
	selectedTargetIds: string[];
	targets: SkillAgentTarget[];
}

/** Reusable controlled target rows shared by the install dialog and Gateway. */
export function SkillTargetList({
	targets,
	selectedTargetIds,
	onTargetIdsChange,
}: SkillTargetListProps) {
	const listId = useId();
	const selected = useMemo(
		() => new Set(selectedTargetIds),
		[selectedTargetIds]
	);
	return (
		<div className="flex flex-col gap-1">
			{targets.map((target) => {
				const path = target.resolvedGlobalPath ?? target.globalSkillsDir;
				const unavailableLabel =
					target.globalSkillsDir === null
						? "Project-only target"
						: (target.unavailableReason ?? "Unavailable");
				const checkboxId = `${listId}-skill-target-${target.id}`;
				return (
					<label
						className="flex min-h-12 items-center gap-3 rounded-2xl px-3 py-2 hover:bg-muted/60 has-disabled:cursor-not-allowed has-disabled:opacity-60"
						htmlFor={checkboxId}
						key={target.id}
					>
						<Checkbox
							aria-label={target.name}
							checked={selected.has(target.id)}
							disabled={!target.selectable}
							id={checkboxId}
							onCheckedChange={(checked) => {
								if (checked) {
									onTargetIdsChange([...selectedTargetIds, target.id]);
									return;
								}
								onTargetIdsChange(
									selectedTargetIds.filter((id) => id !== target.id)
								);
							}}
						/>
						<span className="min-w-0 flex-1">
							<span className="flex items-center gap-2">
								<span className="font-medium text-sm">{target.name}</span>
								{target.detected ? (
									<Badge variant="secondary">Detected</Badge>
								) : null}
								{target.selectable ? null : (
									<Badge variant="outline">{unavailableLabel}</Badge>
								)}
							</span>
							{path ? (
								<span className="block truncate font-mono text-muted-foreground text-xs">
									{path}
								</span>
							) : null}
						</span>
					</label>
				);
			})}
		</div>
	);
}

export interface SkillTargetDialogProps {
	actionLabel: "Export" | "Install";
	initialChoice: SkillTargetChoice;
	onCancel: () => void;
	onConfirm: (choice: SkillTargetChoice) => void;
	open: boolean;
	targets: SkillAgentTarget[];
}

function normalizedSearch(value: string): string {
	return value.toLocaleLowerCase().replaceAll(/\s+/g, "");
}

export function SkillTargetDialog({
	actionLabel,
	initialChoice,
	onCancel,
	onConfirm,
	open,
	targets,
}: SkillTargetDialogProps) {
	const [selectedTargetIds, setSelectedTargetIds] = useState(
		initialChoice.targetIds
	);
	const [remember, setRemember] = useState(initialChoice.remember);
	const [showAll, setShowAll] = useState(false);
	const [query, setQuery] = useState("");

	useEffect(() => {
		if (!open) {
			return;
		}
		setSelectedTargetIds(initialChoice.targetIds);
		setRemember(initialChoice.remember);
		setShowAll(false);
		setQuery("");
	}, [initialChoice.remember, initialChoice.targetIds, open]);

	const orderedTargets = useMemo(() => orderSkillTargets(targets), [targets]);
	const compactTargets = useMemo(
		() => orderedTargets.filter((target) => target.detected || target.featured),
		[orderedTargets]
	);
	const visibleTargets = useMemo(() => {
		if (!showAll) {
			return compactTargets;
		}
		const normalizedQuery = normalizedSearch(query);
		if (!normalizedQuery) {
			return orderedTargets;
		}
		return orderedTargets.filter((target) =>
			normalizedSearch(`${target.name} ${target.id}`).includes(normalizedQuery)
		);
	}, [compactTargets, orderedTargets, query, showAll]);

	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					onCancel();
				}
			}}
			open={open}
		>
			<DialogContent className="sm:max-w-lg" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Use this skill with local agents</DialogTitle>
					<DialogDescription>
						Ryu will copy the skill and its supporting files to the selected
						agents on this computer.
					</DialogDescription>
				</DialogHeader>

				<ScrollArea className="max-h-[min(50vh,28rem)]">
					<SkillTargetList
						onTargetIdsChange={setSelectedTargetIds}
						selectedTargetIds={selectedTargetIds}
						targets={visibleTargets}
					/>
				</ScrollArea>

				<Collapsible onOpenChange={setShowAll} open={showAll}>
					<CollapsibleTrigger
						aria-label="Show all supported agents"
						className="flex w-full items-center justify-between rounded-2xl px-3 py-2 font-medium text-sm hover:bg-muted"
					>
						Show all supported agents
						<HugeiconsIcon
							className="size-4 transition-transform data-[open=true]:rotate-180"
							icon={ArrowDown01Icon}
						/>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="relative mt-2">
							<HugeiconsIcon
								aria-hidden="true"
								className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
								icon={Search01Icon}
							/>
							<Input
								aria-label="Search supported agents"
								className="pl-9"
								onInput={(event) => setQuery(event.currentTarget.value)}
								placeholder="Search agents"
								role="searchbox"
								type="search"
								value={query}
							/>
						</div>
					</CollapsibleContent>
				</Collapsible>

				<label
					className="flex items-center gap-3 rounded-2xl px-3 py-2 font-medium text-sm"
					htmlFor="remember-skill-targets"
				>
					<Checkbox
						aria-label="Remember for future skill installs"
						checked={remember}
						id="remember-skill-targets"
						onCheckedChange={setRemember}
					/>
					Remember for future skill installs
				</label>

				<DialogFooter>
					<Button onClick={onCancel} variant="ghost">
						Cancel
					</Button>
					<Button
						onClick={() =>
							onConfirm({ remember, targetIds: selectedTargetIds })
						}
					>
						{actionLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
