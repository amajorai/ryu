import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useRef, useState } from "react";
import { SpendLimitConfirm } from "@/src/components/settings/shared/provider-key-safety.tsx";
import type {
	ByokProvider,
	GatewayProviderAccount,
} from "@/src/lib/api/gateway.ts";
import { gatewayAccountErrorMessage } from "./shared.tsx";

export function AccountEditor({
	account,
	slug,
	label,
	disabled,
	quotaRouting,
	onSave,
	onRemove,
	onReplace,
}: {
	account: GatewayProviderAccount;
	slug: ByokProvider;
	label: string;
	disabled: boolean;
	quotaRouting: boolean;
	onSave: (account: GatewayProviderAccount) => Promise<void>;
	onRemove: () => Promise<void>;
	onReplace?: (key: string) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	const [draft, setDraft] = useState(account);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [replacement, setReplacement] = useState("");
	const [limitConfirmed, setLimitConfirmed] = useState(false);
	const previousAccount = useRef(account);
	useEffect(() => {
		const previous = previousAccount.current;
		setDraft((current) => ({
			...account,
			name: current.name === previous.name ? account.name : current.name,
			enabled:
				current.enabled === previous.enabled
					? account.enabled
					: current.enabled,
			priority:
				current.priority === previous.priority
					? account.priority
					: current.priority,
			drainThresholdPercent:
				(current.drainThresholdPercent ?? null) ===
				(previous.drainThresholdPercent ?? null)
					? account.drainThresholdPercent
					: current.drainThresholdPercent,
		}));
		previousAccount.current = account;
	}, [account]);
	const credentialEditable = !account.source || account.source === "stored";
	const submit = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(gatewayAccountErrorMessage(cause, "Account update failed"));
		} finally {
			setBusy(false);
		}
	};
	const changed =
		draft.name !== account.name ||
		draft.enabled !== account.enabled ||
		draft.priority !== account.priority ||
		(draft.drainThresholdPercent ?? null) !==
			(account.drainThresholdPercent ?? null);
	const validDrain =
		draft.drainThresholdPercent == null ||
		(Number.isInteger(draft.drainThresholdPercent) &&
			draft.drainThresholdPercent >= 0 &&
			draft.drainThresholdPercent <= 100);
	return (
		<div className="space-y-2 border-border border-t pt-3">
			<div className="flex flex-wrap items-end gap-3">
				<label className="min-w-40 flex-1 space-y-1 text-xs">
					<span>Account name</span>
					<Input
						aria-label={tl("{label} {name} name", {
							label,
							name: account.name,
						})}
						disabled={disabled || busy}
						maxLength={80}
						onChange={(event) =>
							setDraft({ ...draft, name: event.target.value })
						}
						value={draft.name}
					/>
				</label>
				<label className="w-24 space-y-1 text-xs">
					<span>Priority</span>
					<Input
						aria-label={tl("{label} {name} priority", {
							label,
							name: account.name,
						})}
						disabled={disabled || busy}
						max={65_535}
						min={0}
						onChange={(event) =>
							setDraft({ ...draft, priority: Number(event.target.value) })
						}
						step={1}
						type="number"
						value={draft.priority}
					/>
				</label>
				{quotaRouting ? (
					<label className="w-36 space-y-1 text-xs">
						<span>Drain override (%)</span>
						<Input
							aria-label={tl("{label} {name} drain override", {
								label,
								name: account.name,
							})}
							disabled={disabled || busy}
							max={100}
							min={0}
							onChange={(event) =>
								setDraft({
									...draft,
									drainThresholdPercent:
										event.target.value === ""
											? null
											: Number(event.target.value),
								})
							}
							placeholder="Provider default"
							step={1}
							type="number"
							value={draft.drainThresholdPercent ?? ""}
						/>
					</label>
				) : null}
				<div className="flex h-9 items-center gap-2 text-xs">
					<Switch
						aria-label={tl("Enable {label} {name}", {
							label,
							name: account.name,
						})}
						checked={draft.enabled}
						disabled={disabled || busy}
						onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
					/>
					<span>{draft.enabled ? "Enabled" : "Disabled"}</span>
				</div>
				<Button
					disabled={
						disabled ||
						busy ||
						!changed ||
						!validDrain ||
						!draft.name.trim() ||
						!Number.isInteger(draft.priority) ||
						draft.priority < 0 ||
						draft.priority > 65_535
					}
					onClick={() => submit(() => onSave(draft))}
					size="sm"
					variant="outline"
				>
					Save account
				</Button>
				<Button
					aria-label={tl("Remove {label} {name}", {
						label,
						name: account.name,
					})}
					disabled={disabled || busy || !credentialEditable}
					onClick={() => submit(onRemove)}
					size="sm"
					variant="ghost"
				>
					Remove
				</Button>
			</div>
			{onReplace && credentialEditable ? (
				<>
					<div className="flex items-center gap-2">
						<Input
							aria-label={tl("{label} {name} replacement credential", {
								label,
								name: account.name,
							})}
							autoComplete="off"
							disabled={disabled || busy}
							onChange={(event) => setReplacement(event.target.value)}
							placeholder="Replacement credential"
							type="password"
							value={replacement}
						/>
						<Button
							disabled={
								disabled || busy || !replacement.trim() || !limitConfirmed
							}
							onClick={() =>
								submit(async () => {
									await onReplace(replacement.trim());
									setReplacement("");
									setLimitConfirmed(false);
								})
							}
							size="sm"
							variant="secondary"
						>
							Replace credential
						</Button>
					</div>
					{replacement.trim() ? (
						<SpendLimitConfirm
							checked={limitConfirmed}
							disabled={disabled || busy}
							id={`limit-${slug}-${account.id}`}
							onCheckedChange={setLimitConfirmed}
							providerId={slug}
							providerLabel={label}
						/>
					) : null}
				</>
			) : null}
			<p className="text-muted-foreground text-xs">
				Key hidden · Lower priority numbers are tried first.
				{quotaRouting
					? " Blank inherits the provider drain point; 0 disables proactive drain. Fully exhausted accounts remain unavailable."
					: null}
				{account.source === "environment"
					? " Credential supplied by the environment."
					: null}
				{account.source === "fleet"
					? " Credential supplied by the fleet."
					: null}
			</p>
			{error ? (
				<p className="text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
