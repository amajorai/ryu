// apps/desktop/src/components/chat/CloudTaskBackendChooser.tsx
//
// "Run on" for a new cloud task whose agent is Claude Code or Codex: Auto (the
// session's agent order and account, otherwise the defaults; the owner's plan first,
// then the Ryu Box), one of the owner's plan backends on one of their accounts, or the
// Ryu Box. Shown only to the node owner who turned plans on in Settings, and only
// before the chat's first message: a session stays on the account it started on.
// Under the select it says where the agent runs for the pinned choice, and warns when
// a Claude or ChatGPT plan could be used from a datacenter IP (see
// src/lib/cloud-agent-mode.ts).

import { CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG } from "@ryu/auth/lib/feature-flags";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	BACKEND_PROVIDER,
	CLOUD_TASK_BACKEND_LABELS,
	type CloudTaskBackendId,
	fetchCloudTaskBackends,
	fetchPlanAccounts,
	PLAN_BACKEND_EXECUTOR,
	type PlanAccountView,
} from "@/src/lib/api/cloud-task-backends.ts";
import {
	backendAgentMode,
	CLOUD_AGENT_MODE_LABELS,
	planFromDatacenter,
} from "@/src/lib/cloud-agent-mode.ts";
import {
	AUTO_BACKEND_CHOICE,
	type CloudTaskBackendChoice,
	useCloudTaskBackendChoices,
} from "@/src/lib/cloud-task-backend-choice.ts";
import {
	DatacenterPlanWarning,
	useNodeManaged,
} from "./DatacenterPlanWarning.tsx";

type PlanBackendId = Exclude<CloudTaskBackendId, "ryu-box">;

interface Option {
	accountId: string;
	backend: PlanBackendId;
	label: string;
}

const optionValue = (option: Option, strict: boolean) =>
	`${option.backend}|${option.accountId}${strict ? "|strict" : ""}`;

const PLAN_CLI_EXECUTORS = new Set(["claude-code", "codex"]);

/**
 * Whether the choice may put a Claude or ChatGPT plan on a datacenter IP: the
 * pinned backend itself, or a Ryu Box that Auto or a non-strict pin falls back to
 * with Claude Code or Codex as the agent.
 */
function warnsOfDatacenterPlan(
	choice: CloudTaskBackendChoice,
	executor: string,
	nodeManaged: boolean
): boolean {
	if (choice.kind === "pinned") {
		if (planFromDatacenter(choice.backend, executor, nodeManaged)) {
			return true;
		}
		if (choice.strict) {
			return false;
		}
	}
	return PLAN_CLI_EXECUTORS.has(executor);
}

export function CloudTaskBackendChooser({
	executor,
	scope,
	target,
}: {
	executor: string;
	scope: string;
	target: ApiTarget;
}) {
	const flagEnabled = useFeatureFlag(CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG);
	const tl = useLiteralMessages();
	const [options, setOptions] = useState<Option[]>([]);
	const choice = useCloudTaskBackendChoices(
		(state) => state.choices[scope] ?? AUTO_BACKEND_CHOICE
	);
	const setChoice = useCloudTaskBackendChoices((state) => state.setChoice);
	const { url, token, userJwt } = target;
	const nodeManaged = useNodeManaged(url);

	useEffect(() => {
		setOptions([]);
		if (!flagEnabled) {
			return;
		}
		const controller = new AbortController();
		const node = { url, token, userJwt };
		Promise.all([
			fetchCloudTaskBackends(node, controller.signal),
			fetchPlanAccounts(node, controller.signal).catch(() => null),
		])
			.then(([view, accounts]) => {
				if (controller.signal.aborted || !view?.settings?.enabled) {
					return;
				}
				const next: Option[] = [];
				for (const { backend } of view.backends) {
					if (
						backend === "ryu-box" ||
						PLAN_BACKEND_EXECUTOR[backend] !== executor
					) {
						continue;
					}
					const provider = BACKEND_PROVIDER[backend];
					const own: PlanAccountView[] = (accounts ?? []).filter(
						(account) => account.provider === provider
					);
					if (own.length <= 1) {
						next.push({
							accountId: own[0]?.id ?? "default",
							backend,
							label: CLOUD_TASK_BACKEND_LABELS[backend],
						});
						continue;
					}
					for (const account of own) {
						next.push({
							accountId: account.id,
							backend,
							label: `${CLOUD_TASK_BACKEND_LABELS[backend]} · ${account.label}`,
						});
					}
				}
				setOptions(next);
			})
			.catch(() => {
				// No chooser on an older or unreachable Core; Auto still applies.
			});
		return () => controller.abort();
	}, [flagEnabled, url, token, userJwt, executor]);

	if (options.length === 0) {
		return null;
	}
	let value = "auto";
	if (choice.kind === "pinned") {
		value =
			choice.backend === "ryu-box"
				? "ryu-box"
				: `${choice.backend}|${choice.accountId ?? "default"}${choice.strict ? "|strict" : ""}`;
	}
	const modeLabel =
		choice.kind === "pinned"
			? CLOUD_AGENT_MODE_LABELS[backendAgentMode(choice.backend, executor)]
			: null;
	const warn = warnsOfDatacenterPlan(choice, executor, nodeManaged);
	return (
		<>
			<NativeSelect
				aria-label="Run on"
				className="h-7 text-xs"
				onChange={(event) => {
					const next = event.target.value;
					if (next === "auto") {
						setChoice(scope, AUTO_BACKEND_CHOICE);
						return;
					}
					if (next === "ryu-box") {
						setChoice(scope, {
							kind: "pinned",
							backend: "ryu-box",
							strict: true,
						});
						return;
					}
					const [backend, accountId, mode] = next.split("|");
					const picked = options.find(
						(option) =>
							option.backend === backend && option.accountId === accountId
					);
					if (picked) {
						setChoice(scope, {
							kind: "pinned",
							backend: picked.backend,
							strict: mode === "strict",
							accountId: picked.accountId,
						});
					}
				}}
				value={value}
			>
				<NativeSelectOption value="auto">Run on: Auto</NativeSelectOption>
				{options.flatMap((option) => [
					<NativeSelectOption
						key={optionValue(option, false)}
						value={optionValue(option, false)}
					>
						{tl("Run on: {label}, then Ryu Box (agent in the cloud)", {
							label: option.label,
						})}
					</NativeSelectOption>,
					<NativeSelectOption
						key={optionValue(option, true)}
						value={optionValue(option, true)}
					>
						{tl("Run on: {label} only", { label: option.label })}
					</NativeSelectOption>,
				])}
				<NativeSelectOption value="ryu-box">
					Run on: Ryu Box (agent in the cloud)
				</NativeSelectOption>
			</NativeSelect>
			{modeLabel ? (
				<span className="text-muted-foreground text-xs">
					{tl("Runs as: {mode}", { mode: modeLabel })}
				</span>
			) : null}
			{warn ? <DatacenterPlanWarning className="basis-full" /> : null}
		</>
	);
}
