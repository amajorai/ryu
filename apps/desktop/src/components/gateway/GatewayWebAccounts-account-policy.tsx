import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Field, FieldGroup, FieldLabel } from "@ryu/ui/components/field.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useId, useRef, useState } from "react";
import type {
	GatewayWebAccount,
	GatewayWebPolicy,
} from "@/src/lib/api/web-service-accounts.ts";

export function AccountPolicy({
	account,
	index,
	label,
	disabled,
	onSave,
	onReplace,
	onRemove,
}: {
	account: GatewayWebAccount;
	index: number;
	label: string;
	disabled: boolean;
	onSave: (policy: GatewayWebPolicy) => Promise<boolean>;
	onReplace: () => void;
	onRemove: () => Promise<boolean>;
}) {
	const fieldId = useId();
	const tl = useLiteralMessages();
	const incoming = {
		...account.policy,
		name: account.policy.name || `Account ${index + 1}`,
	};
	const [draft, setDraft] = useState(incoming);
	const previous = useRef(incoming);
	useEffect(() => {
		const next = {
			...account.policy,
			name: account.policy.name || `Account ${index + 1}`,
		};
		const old = previous.current;
		setDraft((current) => ({
			name: current.name === old.name ? next.name : current.name,
			enabled: current.enabled === old.enabled ? next.enabled : current.enabled,
			priority:
				current.priority === old.priority ? next.priority : current.priority,
		}));
		previous.current = next;
	}, [account.policy, index]);
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
		<div className="flex flex-col gap-3 border-border border-t pt-3">
			<FieldGroup className="flex flex-row flex-wrap items-end">
				<Field className="min-w-40 flex-1">
					<FieldLabel htmlFor={`${fieldId}-name`}>Account name</FieldLabel>
					<Input
						aria-label={tl("{label} {name} name", {
							label,
							name: incoming.name,
						})}
						disabled={disabled}
						id={`${fieldId}-name`}
						maxLength={80}
						onChange={(event) =>
							setDraft({ ...draft, name: event.target.value })
						}
						value={draft.name}
					/>
				</Field>
				<Field className="w-24">
					<FieldLabel htmlFor={`${fieldId}-priority`}>Priority</FieldLabel>
					<Input
						aria-label={tl("{label} {name} priority", {
							label,
							name: incoming.name,
						})}
						disabled={disabled}
						id={`${fieldId}-priority`}
						max={65_535}
						min={0}
						onChange={(event) =>
							setDraft({ ...draft, priority: Number(event.target.value) })
						}
						step={1}
						type="number"
						value={draft.priority}
					/>
				</Field>
				<Field className="w-auto" orientation="horizontal">
					<Switch
						aria-label={tl("Enable {label} {name}", {
							label,
							name: incoming.name,
						})}
						checked={draft.enabled}
						disabled={disabled}
						id={`${fieldId}-enabled`}
						onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
					/>
					<FieldLabel htmlFor={`${fieldId}-enabled`}>
						<span className="sr-only">
							{tl("Enable {label} {name}", { label, name: incoming.name })}
						</span>
						<span aria-hidden="true">Enabled</span>
					</FieldLabel>
				</Field>
			</FieldGroup>
			{account.context.kind === "google_pse" ? (
				<p className="text-muted-foreground text-xs">
					{tl(
						"Engine: {engineId} · {confirmed, select, true {Existing customer confirmed} other {Existing customer not confirmed}}",
						{
							engineId: account.context.engine_id,
							confirmed: String(account.context.existing_customer_acknowledged),
						}
					)}
				</p>
			) : null}
			{account.context.kind === "search_api" ? (
				<p className="text-muted-foreground text-xs">Engine: Google</p>
			) : null}
			<p className="text-muted-foreground text-xs">
				Key hidden · Lower priority numbers are tried first.
			</p>
			{account.diagnostic ? (
				<p className="text-status-warning text-xs">
					{account.diagnostic === "google_pse_discontinued"
						? "Google Custom Search access has ended. Choose another search provider."
						: "This account is inactive until existing-customer eligibility is confirmed."}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={disabled || !changed || !valid}
					onClick={() => onSave({ ...draft, name: draft.name.trim() })}
					size="sm"
					variant="outline"
				>
					Save account
				</Button>
				<Button
					aria-label={tl("Replace {label} {name}", {
						label,
						name: incoming.name,
					})}
					disabled={disabled}
					onClick={onReplace}
					size="sm"
					variant="secondary"
				>
					Replace key or context
				</Button>
				<Button
					aria-label={tl("Remove {label} {name}", {
						label,
						name: incoming.name,
					})}
					disabled={disabled}
					onClick={onRemove}
					size="sm"
					variant="ghost"
				>
					Remove
				</Button>
			</div>
		</div>
	);
}
