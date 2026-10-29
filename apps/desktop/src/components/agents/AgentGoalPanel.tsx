/**
 * The bot's own goal and its main-thread reply length, stored in Core's
 * `agent:<id>` scope guidance. Both are optional. Core injects the goal into the
 * system prompt of every thread this bot runs (in every project) and the brief
 * instruction into its main threads, so saving a change asks first: the bot's
 * threads each take one prompt-cache miss on their next turn.
 *
 * Per-project goals for the same bot live in the Projects app (the
 * `project:<p>/agent:<a>` scope).
 */

import { promptEditCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useEffect, useState } from "react";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	agentScope,
	fetchScopeGuidance,
	type ScopeGuidance,
	setScopeGuidance,
} from "@/src/lib/api/hierarchy.ts";

/** Mirrors Core's `MAX_GOAL_CHARS`. */
const MAX_GOAL_CHARS = 2000;

type BriefChoice = "inherit" | "off" | "on";

function briefChoice(value: boolean | null | undefined): BriefChoice {
	if (value === true) {
		return "on";
	}
	return value === false ? "off" : "inherit";
}

function briefValue(choice: BriefChoice): boolean | null {
	if (choice === "on") {
		return true;
	}
	return choice === "off" ? false : null;
}

export function AgentGoalPanel({
	agentId,
	disabled,
	target,
}: {
	agentId: string;
	disabled?: boolean;
	target: ApiTarget;
}) {
	const [stored, setStored] = useState<ScopeGuidance | null>(null);
	const [goal, setGoal] = useState("");
	const [brief, setBrief] = useState<BriefChoice>("inherit");
	const [saving, setSaving] = useState(false);
	const [confirmation, setConfirmation] =
		useState<PromptCacheConfirmation | null>(null);

	useEffect(() => {
		let live = true;
		fetchScopeGuidance(target, agentScope(agentId))
			.then((value) => {
				if (!live) {
					return;
				}
				setStored(value);
				setGoal(value.goal);
				setBrief(briefChoice(value.briefReplies));
			})
			.catch(() => {
				if (live) {
					setStored({ briefReplies: null, goal: "" });
				}
			});
		return () => {
			live = false;
		};
	}, [agentId, target]);

	const changed: string[] = [];
	if (stored && goal.trim() !== stored.goal.trim()) {
		changed.push("The bot's goal");
	}
	if (stored && briefValue(brief) !== (stored.briefReplies ?? null)) {
		changed.push("Main-thread reply length");
	}

	async function apply() {
		setSaving(true);
		try {
			const next: ScopeGuidance = {
				briefReplies: briefValue(brief),
				goal: goal.trim(),
			};
			await setScopeGuidance(target, agentScope(agentId), next);
			setStored(next);
			setGoal(next.goal);
			toast.success("Goal saved");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not save");
		} finally {
			setSaving(false);
		}
	}

	function save() {
		const warning = promptEditCacheWarning(changed, "bot");
		if (warning) {
			setConfirmation(warning);
		}
	}

	return (
		<SettingsSection
			caption="Optional. Every thread this bot runs carries its goal; set a different goal per project in that project's settings."
			headerAction={
				<Button
					disabled={disabled || saving || changed.length === 0}
					onClick={save}
					size="xs"
					variant="outline"
				>
					Save goal
				</Button>
			}
			title="Goal"
		>
			<SettingsCard className="space-y-3">
				<Textarea
					aria-label="Bot goal"
					className="min-h-20"
					disabled={disabled || stored === null}
					maxLength={MAX_GOAL_CHARS}
					onChange={(event) => setGoal(event.target.value)}
					placeholder="What should this bot keep working toward?"
					value={goal}
				/>
				<label className="flex items-center justify-between gap-3 text-sm">
					<span>Main thread replies</span>
					<NativeSelect
						disabled={disabled || stored === null}
						onChange={(event) =>
							setBrief(
								/* SAFETY: The rendered select options use only values from this domain union. */ event
									.target.value as BriefChoice
							)
						}
						value={brief}
					>
						<NativeSelectOption value="inherit">
							Brief (default)
						</NativeSelectOption>
						<NativeSelectOption value="on">Brief</NativeSelectOption>
						<NativeSelectOption value="off">Full length</NativeSelectOption>
					</NativeSelect>
				</label>
			</SettingsCard>
			<PromptCacheConfirmDialog
				confirmation={confirmation}
				onApply={() => {
					setConfirmation(null);
					apply().catch(() => undefined);
				}}
				onCancel={() => setConfirmation(null)}
			/>
		</SettingsSection>
	);
}
