import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useRef, useState } from "react";
import type { CloudSpeechPolicy } from "@/src/lib/api/cloud-speech-accounts.ts";

export function CloudSpeechAccountRow({
	accountId,
	label,
	policy,
	disabled,
	onConfigure,
	onRemove,
}: {
	accountId: string;
	label: string;
	policy: CloudSpeechPolicy;
	disabled: boolean;
	onConfigure: (policy: CloudSpeechPolicy) => Promise<boolean>;
	onRemove: () => Promise<boolean>;
}) {
	const tl = useLiteralMessages();
	const incoming = {
		...policy,
		name: policy.name || `Account ${accountId.slice(0, 8)}`,
	};
	const [draft, setDraft] = useState(incoming);
	const [expanded, setExpanded] = useState(false);
	const previous = useRef(incoming);
	useEffect(() => {
		const next = {
			...policy,
			name: policy.name || `Account ${accountId.slice(0, 8)}`,
		};
		const old = previous.current;
		setDraft((current) => ({
			name: current.name === old.name ? next.name : current.name,
			enabled: current.enabled === old.enabled ? next.enabled : current.enabled,
			priority:
				current.priority === old.priority ? next.priority : current.priority,
		}));
		previous.current = next;
	}, [accountId, policy]);
	const changed =
		draft.name !== incoming.name ||
		draft.enabled !== incoming.enabled ||
		draft.priority !== incoming.priority;
	const valid =
		draft.name.trim().length > 0 &&
		draft.name.length <= 80 &&
		Number.isInteger(draft.priority) &&
		draft.priority >= 0 &&
		draft.priority <= 65_535;
	return (
		<div className="space-y-2 px-3 py-2 text-sm">
			<div className="flex items-center justify-between gap-3">
				<span>
					{policy.name ? `${policy.name} · ` : ""}
					{label} · {accountId.slice(0, 8)}
					{policy.enabled ? "" : " · Disabled"}
					{policy.priority
						? ` · ${tl("Priority {priority}", { priority: String(policy.priority) })}`
						: ""}
				</span>
				<div className="flex gap-2">
					<Button
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
						size="sm"
						variant="ghost"
					>
						Routing
					</Button>
					<Button
						disabled={disabled}
						onClick={() => void onRemove()}
						size="sm"
						variant="outline"
					>
						Remove
					</Button>
				</div>
			</div>
			{expanded ? (
				<div className="grid gap-2 sm:grid-cols-[1fr_7rem_auto_auto] sm:items-end">
					<label className="space-y-1 text-xs">
						Account name
						<Input
							aria-label={tl("{label} account name", { label })}
							disabled={disabled}
							maxLength={80}
							onChange={(event) =>
								setDraft({ ...draft, name: event.target.value })
							}
							value={draft.name}
						/>
					</label>
					<label className="space-y-1 text-xs">
						Priority
						<Input
							aria-label={tl("{label} priority", { label })}
							disabled={disabled}
							max={65_535}
							min={0}
							onChange={(event) =>
								setDraft({ ...draft, priority: Number(event.target.value) })
							}
							type="number"
							value={draft.priority}
						/>
					</label>
					<div className="flex items-center gap-2 pb-2 text-xs">
						<Switch
							aria-label={tl("{label} enabled", { label })}
							checked={draft.enabled}
							disabled={disabled}
							onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
						/>
						Enabled
					</div>
					<Button
						disabled={disabled || !changed || !valid}
						onClick={() =>
							void onConfigure({ ...draft, name: draft.name.trim() }).then(
								(saved) => {
									if (saved) {
										setExpanded(false);
									}
								}
							)
						}
						size="sm"
						variant="outline"
					>
						Save routing
					</Button>
				</div>
			) : null}
		</div>
	);
}
