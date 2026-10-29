// apps/desktop/src/components/chat/CloudTaskBackendChooser.tsx
//
// "Run on" for a new cloud task whose agent is Claude Code or Codex: Auto (the
// session's agent order and account, otherwise the defaults; the owner's plan first,
// then the Ryu Box), one of the owner's plan backends on one of their accounts, or the
// Ryu Box. Shown only to the node owner who turned plans on in Settings, and only
// before the chat's first message: a session stays on the account it started on.

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
	AUTO_BACKEND_CHOICE,
	useCloudTaskBackendChoices,
} from "@/src/lib/cloud-task-backend-choice.ts";

type PlanBackendId = Exclude<CloudTaskBackendId, "ryu-box">;

interface Option {
	accountId: string;
	backend: PlanBackendId;
	label: string;
}

const optionValue = (option: Option, strict: boolean) =>
	`${option.backend}|${option.accountId}${strict ? "|strict" : ""}`;

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
	return (
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
					{tl("Run on: {label}, Ryu Box if unavailable", {
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
			<NativeSelectOption value="ryu-box">Run on: Ryu Box</NativeSelectOption>
		</NativeSelect>
	);
}
