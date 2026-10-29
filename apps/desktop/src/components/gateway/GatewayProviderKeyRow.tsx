import {
	Delete01Icon,
	EyeIcon,
	Key01Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useRef, useState } from "react";
import { SpendLimitConfirm } from "@/src/components/settings/shared/provider-key-safety.tsx";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import { ApiError } from "@/src/lib/api/client.ts";
import type {
	ByokProvider,
	GatewayAccountStrategy,
	GatewayProviderAccount,
} from "@/src/lib/api/gateway.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";

export function gatewayAccountErrorMessage(
	cause: unknown,
	fallback: string
): string {
	if (cause instanceof ApiError) {
		return cause.serverMessage ?? cause.message;
	}
	return cause instanceof Error ? cause.message : fallback;
}

function ManagedKeyNote({ note }: { note: string }) {
	return <p className="text-muted-foreground text-xs">{note}</p>;
}

function AccountEditor({
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
		<div className="space-y-2 border-border/60 border-t pt-3">
			<div className="flex flex-wrap items-end gap-3">
				<label className="min-w-40 flex-1 space-y-1 text-xs">
					<span>Account name</span>
					<Input
						aria-label={`${label} ${account.name} name`}
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
						aria-label={`${label} ${account.name} priority`}
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
							aria-label={`${label} ${account.name} drain override`}
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
						aria-label={`Enable ${label} ${account.name}`}
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
				>
					Save account
				</Button>
				<Button
					aria-label={`Remove ${label} ${account.name}`}
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
							aria-label={`${label} ${account.name} replacement credential`}
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

export function ProviderRow({
	slug,
	label,
	brand,
	credentialLabel = "API key",
	placeholder,
	isSet,
	accountCount,
	accounts,
	accountStrategy,
	quotaRouting = true,
	drainThreshold,
	onConfigure,
	onStrategyChange,
	onDrainThresholdChange,
	onSave,
	onAdd,
	onRemove,
	onReplace,
	onClear,
	readOnly = false,
	readOnlyNote = "Provided by Ryu Cloud. Keys held server-side.",
	canConfigure = true,
}: {
	slug: ByokProvider;
	label: string;
	brand?: string;
	credentialLabel?: string;
	placeholder: string;
	isSet: boolean;
	accountCount: number;
	accounts?: GatewayProviderAccount[];
	accountStrategy?: GatewayAccountStrategy;
	quotaRouting?: boolean;
	drainThreshold?: number;
	onConfigure?: (
		slug: ByokProvider,
		account: GatewayProviderAccount
	) => Promise<void>;
	onStrategyChange?: (
		slug: ByokProvider,
		strategy: GatewayAccountStrategy
	) => Promise<void>;
	onDrainThresholdChange?: (
		slug: ByokProvider,
		percent: number
	) => Promise<void>;
	onSave: (slug: ByokProvider, key: string) => Promise<void>;
	onAdd: (slug: ByokProvider, key: string) => Promise<void>;
	onRemove: (slug: ByokProvider, index: number) => Promise<void>;
	onReplace?: (
		slug: ByokProvider,
		account: GatewayProviderAccount,
		key: string
	) => Promise<void>;
	onClear: (slug: ByokProvider) => Promise<void>;
	/** Managed (Ryu Cloud) node: render key state read-only, no input, no writers. */
	readOnly?: boolean;
	readOnlyNote?: string;
	/** When false the caller lacks `gateway.configure`; writers disabled. */
	canConfigure?: boolean;
}) {
	const [input, setInput] = useState("");
	const [limitConfirmed, setLimitConfirmed] = useState(false);
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [clearing, setClearing] = useState(false);
	const [removingIndex, setRemovingIndex] = useState<number | null>(null);
	const [rowError, setRowError] = useState<string | null>(null);
	const [strategySaving, setStrategySaving] = useState(false);
	const [thresholdDraft, setThresholdDraft] = useState(
		String(drainThreshold ?? 80)
	);
	const [thresholdSaving, setThresholdSaving] = useState(false);
	useEffect(
		() => setThresholdDraft(String(drainThreshold ?? 80)),
		[drainThreshold]
	);
	const hasExternalCredentials =
		accounts?.some(
			(account) =>
				account.source === "environment" || account.source === "fleet"
		) ?? false;
	const hasFleetCredentials =
		accounts?.some((account) => account.source === "fleet") ?? false;

	const handleSave = async () => {
		if (canConfigure === false || hasFleetCredentials) {
			return;
		}
		const trimmed = input.trim();
		if (!(trimmed && limitConfirmed)) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			await onSave(slug, trimmed);
			setInput("");
			setLimitConfirmed(false);
		} catch (e) {
			setRowError(gatewayAccountErrorMessage(e, "Failed to save key"));
		} finally {
			setSaving(false);
		}
	};

	const handleClear = async () => {
		if (!canConfigure) {
			return;
		}
		setClearing(true);
		setRowError(null);
		try {
			await onClear(slug);
		} catch (e) {
			setRowError(gatewayAccountErrorMessage(e, "Failed to clear key"));
		} finally {
			setClearing(false);
		}
	};

	const handleAdd = async () => {
		if (canConfigure === false || !input.trim() || !limitConfirmed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			await onAdd(slug, input.trim());
			setInput("");
			setLimitConfirmed(false);
		} catch (error) {
			setRowError(gatewayAccountErrorMessage(error, "Failed to add account"));
		} finally {
			setSaving(false);
		}
	};

	const handleRemove = async (index: number) => {
		if (!canConfigure) {
			return;
		}
		setRemovingIndex(index);
		setRowError(null);
		try {
			await onRemove(slug, index);
		} catch (error) {
			setRowError(
				gatewayAccountErrorMessage(error, "Failed to remove account")
			);
		} finally {
			setRemovingIndex(null);
		}
	};
	const handleStrategyChange = async (strategy: GatewayAccountStrategy) => {
		if (!(onStrategyChange && canConfigure) || strategySaving) {
			return;
		}
		setStrategySaving(true);
		setRowError(null);
		try {
			await onStrategyChange(slug, strategy);
		} catch (error) {
			setRowError(
				gatewayAccountErrorMessage(error, "Failed to update account routing")
			);
		} finally {
			setStrategySaving(false);
		}
	};
	const handleThresholdChange = async () => {
		const percent = Number(thresholdDraft);
		if (
			!(onDrainThresholdChange && canConfigure) ||
			thresholdSaving ||
			!Number.isInteger(percent) ||
			percent < 1 ||
			percent > 100
		) {
			setRowError("Drain threshold must be a whole percentage from 1 to 100");
			return;
		}
		setThresholdSaving(true);
		setRowError(null);
		try {
			await onDrainThresholdChange(slug, percent);
		} catch (error) {
			setRowError(
				gatewayAccountErrorMessage(error, "Failed to update drain threshold")
			);
		} finally {
			setThresholdSaving(false);
		}
	};

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-2">
					{readOnly ? (
						<Badge variant="secondary">Managed</Badge>
					) : isSet ? (
						<Badge variant="default">Key set</Badge>
					) : (
						<Badge variant="secondary">No key</Badge>
					)}
					{!readOnly && isSet && !hasExternalCredentials && (
						<Button
							disabled={!canConfigure}
							loading={clearing}
							onClick={() => handleClear()}
							size="sm"
							variant="ghost"
						>
							{!clearing && (
								<HugeiconsIcon className="size-3" icon={Delete01Icon} />
							)}
							Clear
						</Button>
					)}
				</div>
			}
			title={
				<span className="flex items-center gap-2">
					{svglForProvider(brand ?? slug) ? (
						<ProviderBrandLogo providerKey={brand ?? slug} size={16} />
					) : (
						<HugeiconsIcon
							className="size-4 text-muted-foreground"
							icon={Key01Icon}
						/>
					)}
					{label}
				</span>
			}
		>
			{readOnly ? (
				<ManagedKeyNote note={readOnlyNote} />
			) : (
				<div className="flex w-full flex-wrap items-center gap-2 sm:flex-nowrap">
					<div className="relative min-w-0 basis-full sm:flex-1 sm:basis-auto">
						<Input
							aria-label={`${label} ${credentialLabel}`}
							disabled={hasFleetCredentials}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handleSave();
								}
							}}
							placeholder={
								isSet ? "•••••••• (leave blank to keep current)" : placeholder
							}
							trailingAdornment="compact"
							type={showKey ? "text" : "password"}
							value={input}
						/>
						<button
							aria-label={showKey ? "Hide key" : "Show key"}
							className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							onClick={() => setShowKey((v) => !v)}
							type="button"
						>
							{showKey ? (
								<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
							) : (
								<HugeiconsIcon className="size-4" icon={EyeIcon} />
							)}
						</button>
					</div>
					<Button
						disabled={
							!(input.trim() && limitConfirmed) ||
							canConfigure === false ||
							hasFleetCredentials
						}
						loading={saving}
						onClick={() => handleSave()}
						size="sm"
					>
						{hasExternalCredentials
							? "Save local credential"
							: isSet
								? "Replace first key"
								: "Save"}
					</Button>
					{isSet && accountCount > 0 && !hasExternalCredentials ? (
						<Button
							disabled={!(input.trim() && limitConfirmed && canConfigure)}
							loading={saving}
							onClick={() => handleAdd()}
							size="sm"
							variant="secondary"
						>
							Add account
						</Button>
					) : null}
				</div>
			)}

			{!readOnly && input.trim() ? (
				<SpendLimitConfirm
					checked={limitConfirmed}
					disabled={canConfigure === false || hasFleetCredentials}
					id={`limit-${slug}`}
					onCheckedChange={setLimitConfirmed}
					providerId={slug}
					providerLabel={label}
				/>
			) : null}

			{!readOnly && accounts && onConfigure ? (
				<div className="flex flex-col gap-2">
					{accounts.map((account, index) => (
						<AccountEditor
							account={account}
							disabled={!canConfigure}
							key={account.id}
							label={label}
							onRemove={() => handleRemove(index)}
							onReplace={
								onReplace ? (key) => onReplace(slug, account, key) : undefined
							}
							onSave={(updated) => onConfigure(slug, updated)}
							quotaRouting={quotaRouting}
							slug={slug}
						/>
					))}
				</div>
			) : !readOnly && accountCount > 0 ? (
				<div className="flex flex-col gap-1 text-xs">
					{Array.from({ length: accountCount }, (_, index) => (
						<div
							className="flex items-center justify-between border-border/60 border-t py-1"
							key={`${slug}-${index}`}
						>
							<span>Account {index + 1} · key hidden</span>
							<Button
								aria-label={`Remove ${label} account ${index + 1}`}
								disabled={!canConfigure}
								loading={removingIndex === index}
								onClick={() => handleRemove(index)}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</div>
					))}
				</div>
			) : null}
			{!readOnly &&
			onStrategyChange &&
			(accountCount > 1 ||
				(accountStrategy && accountStrategy !== "round_robin")) ? (
				<div className="space-y-1.5 border-border/60 border-t pt-3">
					<label className="text-xs" htmlFor={`${slug}-account-strategy`}>
						Account routing
					</label>
					<Select<GatewayAccountStrategy>
						disabled={!canConfigure || strategySaving}
						items={
							quotaRouting
								? [
										{ value: "round_robin", label: "Round robin" },
										{ value: "quota_first", label: "Quota first" },
										{ value: "fill_first", label: "Fill first" },
										{ value: "reset_first", label: "Reset first" },
									]
								: [
										{ value: "round_robin", label: "Round robin" },
										{ value: "fill_first", label: "Fill first" },
									]
						}
						onValueChange={(value) => value && handleStrategyChange(value)}
						value={accountStrategy ?? "round_robin"}
					>
						<SelectTrigger id={`${slug}-account-strategy`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent
							align="start"
							alignItemWithTrigger={false}
							className="min-w-48"
						>
							<SelectItem value="round_robin">Round robin</SelectItem>
							{quotaRouting ? (
								<SelectItem value="quota_first">Quota first</SelectItem>
							) : null}
							<SelectItem value="fill_first">Fill first</SelectItem>
							{quotaRouting ? (
								<SelectItem value="reset_first">Reset first</SelectItem>
							) : null}
						</SelectContent>
					</Select>
					<p className="text-muted-foreground text-xs">
						{accountStrategy === "quota_first"
							? "New chats prefer the key with the lowest observed rate-limit usage. Missing or stale per-key limits fall back to round robin."
							: accountStrategy === "fill_first"
								? quotaRouting
									? "New chats stay on one key until its observed rate-limit usage reaches the drain point or it cools down."
									: "New chats stay on one eligible key until rate-limit or account-credit rejection."
								: accountStrategy === "reset_first"
									? "New chats prefer a key with a reported upcoming rate-limit reset and available capacity. Missing or stale limits fall back to round robin."
									: "New chats rotate between eligible keys in the highest priority tier."}
						{
							" Existing chats with a session ID keep their healthy key for prompt caching."
						}
					</p>
					{accountStrategy === "fill_first" && onDrainThresholdChange ? (
						<div className="flex items-end gap-2">
							<div className="space-y-1">
								<label className="text-xs" htmlFor={`${slug}-drain-threshold`}>
									Drain at used quota (%)
								</label>
								<Input
									disabled={!canConfigure || thresholdSaving}
									id={`${slug}-drain-threshold`}
									max={100}
									min={1}
									onChange={(event) => setThresholdDraft(event.target.value)}
									type="number"
									value={thresholdDraft}
								/>
							</div>
							<Button
								disabled={!canConfigure || thresholdSaving}
								loading={thresholdSaving}
								onClick={handleThresholdChange}
								size="sm"
								variant="outline"
							>
								Save
							</Button>
						</div>
					) : null}
				</div>
			) : null}

			{rowError ? (
				<p className="text-status-destructive text-xs">{rowError}</p>
			) : null}
		</SettingsItem>
	);
}
