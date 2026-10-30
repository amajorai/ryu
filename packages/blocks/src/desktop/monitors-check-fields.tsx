"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import type {
	ProviderUsageSnapshot,
	UsageProviderOption,
} from "@ryuhq/core-client/monitors";
import {
	comparatorSelection,
	type FormState,
	patch,
} from "./monitors-form-state.ts";
import {
	accountOptionLabel,
	type UsageAccountOption,
	type UsageSelectionChange,
	unavailableUsageMessage,
} from "./monitors-usage-accounts.ts";

function UsageAccountSelect({
	accountId,
	accounts,
	onChange,
}: {
	accountId: string;
	accounts: readonly UsageAccountOption[];
	onChange: (accountId: string) => void;
}) {
	const tl = useLiteralMessages();
	const pinnedMissing =
		accountId !== "" &&
		!accounts.some((account) => account.accountId === accountId);
	return (
		<div className="space-y-1.5">
			<Label htmlFor="m-usage-account">Account</Label>
			<NativeSelect
				className="w-full"
				id="m-usage-account"
				onChange={(event) => onChange(event.target.value)}
				value={accountId}
			>
				<NativeSelectOption value="">Follow active account</NativeSelectOption>
				{accounts.map((account) => (
					<NativeSelectOption key={account.accountId} value={account.accountId}>
						{accountOptionLabel(account, tl)}
					</NativeSelectOption>
				))}
				{pinnedMissing ? (
					<NativeSelectOption disabled value={accountId}>
						Removed account
					</NativeSelectOption>
				) : null}
			</NativeSelect>
			<p className="text-muted-foreground text-sm">
				{pinnedMissing
					? "This account is no longer saved. Choose another account to keep watching."
					: "Following the active account records a fresh baseline after you switch accounts, without alerting."}
			</p>
		</div>
	);
}

export function CheckTypeFields({
	form,
	setForm,
	providerOptions = [],
	accountOptions = [],
	usageSnapshot,
	usageLoading = false,
	providerCatalogLoading = false,
	usageError,
	onUsageProviderChange,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
	providerOptions?: UsageProviderOption[];
	/** Saved accounts of the selected provider; empty hides the account picker. */
	accountOptions?: readonly UsageAccountOption[];
	usageSnapshot?: ProviderUsageSnapshot;
	usageLoading?: boolean;
	providerCatalogLoading?: boolean;
	usageError?: string | null;
	onUsageProviderChange?: UsageSelectionChange;
}) {
	const tl = useLiteralMessages();
	if (form.checkType === "provider_usage_reset") {
		const usageTargets = [
			...(usageSnapshot?.windows ?? []).map((window) => ({
				detail: `${window.usedPercent.toFixed(1)}% used${window.resetsAt ? ` · resets ${window.resetsAt}` : ""}`,
				label: `${window.label}${window.model ? ` · ${window.model}` : ""}`,
				targetId: window.targetId,
			})),
			...(usageSnapshot?.meters ?? []).flatMap((meter) =>
				meter.values.map((value) => ({
					detail: `${value.number.toFixed(2)} ${value.unit ?? value.kind}${value.resetsAt ? ` · resets ${value.resetsAt}` : meter.resetsAt ? ` · resets ${meter.resetsAt}` : ""}`,
					label: meter.label,
					targetId: value.targetId,
				}))
			),
		];
		return (
			<div className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="m-usage-provider">Provider</Label>
					<NativeSelect
						className="w-full"
						id="m-usage-provider"
						onChange={(event) => {
							const providerId = event.target.value;
							setForm((previous) => ({
								...previous,
								accountId: "",
								providerId,
								targetIds: [],
							}));
							onUsageProviderChange?.(providerId || null);
						}}
						value={form.providerId}
					>
						<NativeSelectOption value="">Choose a provider</NativeSelectOption>
						{providerOptions.map((provider) => (
							<NativeSelectOption
								key={provider.providerId}
								value={provider.providerId}
							>
								{provider.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				{form.providerId && accountOptions.length > 0 ? (
					<UsageAccountSelect
						accountId={form.accountId}
						accounts={accountOptions}
						onChange={(accountId) => {
							patch(setForm, "accountId")(accountId);
							onUsageProviderChange?.(form.providerId, accountId || undefined);
						}}
					/>
				) : null}
				{providerCatalogLoading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Loading supported providers…
					</div>
				) : null}
				{!providerCatalogLoading &&
				providerOptions.length === 0 &&
				!usageError ? (
					<p className="text-muted-foreground text-sm" role="status">
						No supported provider usage readers are available on this node.
					</p>
				) : null}
				{usageError ? (
					<p className="text-sm text-status-destructive" role="alert">
						{usageError}
					</p>
				) : null}
				{usageLoading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Reading current provider usage…
					</div>
				) : null}
				{usageSnapshot?.available === false ? (
					<p className="text-sm text-status-warning" role="status">
						{unavailableUsageMessage(usageSnapshot.reason, tl)}
					</p>
				) : null}
				{usageSnapshot?.available && usageTargets.length > 0 ? (
					<fieldset className="space-y-2">
						<legend className="font-medium text-sm">
							Windows and balances to watch
						</legend>
						{usageTargets.map((target) => (
							<label
								className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
								key={target.targetId}
							>
								<Checkbox
									checked={form.targetIds.includes(target.targetId)}
									onCheckedChange={(checked) =>
										setForm((previous) => ({
											...previous,
											targetIds: checked
												? previous.targetIds.includes(target.targetId)
													? previous.targetIds
													: [...previous.targetIds, target.targetId]
												: previous.targetIds.filter(
														(id) => id !== target.targetId
													),
										}))
									}
								/>
								<span className="min-w-0">
									<span className="block font-medium">{target.label}</span>
									<span className="block text-muted-foreground">
										{target.detail}
									</span>
								</span>
							</label>
						))}
					</fieldset>
				) : null}
				{usageSnapshot?.available && usageTargets.length === 0 ? (
					<p className="text-muted-foreground text-sm" role="status">
						This provider currently reports no usage windows or balances to
						watch.
					</p>
				) : null}
				{!(form.providerId || usageLoading || providerCatalogLoading) &&
				providerOptions.length > 0 ? (
					<p className="text-muted-foreground text-sm">
						Choose a provider to load its live windows and balances.
					</p>
				) : null}
				<div className="max-w-xs space-y-1.5">
					<Label htmlFor="m-reset-drop">Minimum usage drop to notify</Label>
					<div className="flex items-center gap-2">
						<Input
							id="m-reset-drop"
							max="100"
							min="0.1"
							onChange={(event) =>
								patch(setForm, "minimumDropPercent")(event.target.value)
							}
							step="0.1"
							type="number"
							value={form.minimumDropPercent}
						/>
						<span className="text-muted-foreground text-sm">
							percentage points
						</span>
					</div>
				</div>
				<p className="text-muted-foreground text-sm">
					The first check saves a baseline quietly. A window alerts when usage
					drops to near zero, falls by this many percentage points, or crosses a
					reported reset boundary. Credit balances alert when they increase.
				</p>
			</div>
		);
	}

	if (form.checkType === "uptime") {
		return (
			<div className="space-y-1.5">
				<Label htmlFor="m-status">Expected status codes (optional)</Label>
				<Input
					id="m-status"
					onChange={(e) => patch(setForm, "expectStatus")(e.target.value)}
					placeholder="200, 301 (blank = any 2xx/3xx is up)"
					value={form.expectStatus}
				/>
			</div>
		);
	}
	if (form.checkType === "keyword" || form.checkType === "stock") {
		const isStock = form.checkType === "stock";
		return (
			<div className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="m-pattern">
						{isStock ? "In-stock phrase" : "Keyword / pattern"}
					</Label>
					<Input
						id="m-pattern"
						onChange={(e) => patch(setForm, "pattern")(e.target.value)}
						placeholder={isStock ? "Add to cart" : "on sale"}
						value={form.pattern}
					/>
				</div>
				<label className="flex items-center gap-2 text-sm">
					<Switch
						checked={form.isRegex}
						onCheckedChange={(v) => patch(setForm, "isRegex")(Boolean(v))}
					/>
					Treat as regular expression
				</label>
				{isStock ? null : (
					<label className="flex items-center gap-2 text-sm">
						<Switch
							checked={form.caseSensitive}
							onCheckedChange={(v) =>
								patch(setForm, "caseSensitive")(Boolean(v))
							}
						/>
						Case sensitive
					</label>
				)}
				<label className="flex items-center gap-2 text-sm">
					<Switch
						checked={form.alertWhenPresent}
						onCheckedChange={(v) =>
							patch(setForm, "alertWhenPresent")(Boolean(v))
						}
					/>
					{isStock
						? "Alert when it comes in stock (off = when out of stock)"
						: "Alert when it appears (off = when it disappears)"}
				</label>
			</div>
		);
	}
	if (form.checkType === "content_diff") {
		return (
			<div className="space-y-1.5">
				<Label htmlFor="m-region">Region regex (optional)</Label>
				<Input
					id="m-region"
					onChange={(e) => patch(setForm, "regionRegex")(e.target.value)}
					placeholder="Capture group 1 scopes the watched region"
					value={form.regionRegex}
				/>
			</div>
		);
	}
	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				<Label htmlFor="m-extract">Value regex (capture group 1)</Label>
				<Input
					id="m-extract"
					onChange={(e) => patch(setForm, "extractRegex")(e.target.value)}
					placeholder="\$([0-9.,]+)"
					value={form.extractRegex}
				/>
			</div>
			<div className="flex gap-3">
				<div className="flex-1 space-y-1.5">
					<Label htmlFor="m-cmp">Alert when</Label>
					<NativeSelect
						className="w-full"
						id="m-cmp"
						onChange={(e) =>
							patch(
								setForm,
								"comparator"
							)(comparatorSelection.parse(e.target.value))
						}
						value={form.comparator}
					>
						<NativeSelectOption value="changed">
							Value changes
						</NativeSelectOption>
						<NativeSelectOption value="less_than">
							Below threshold
						</NativeSelectOption>
						<NativeSelectOption value="greater_than">
							Above threshold
						</NativeSelectOption>
						<NativeSelectOption value="drops_by_pct">
							Drops by %
						</NativeSelectOption>
						<NativeSelectOption value="rises_by_pct">
							Rises by %
						</NativeSelectOption>
					</NativeSelect>
				</div>
				{form.comparator === "changed" ? null : (
					<div className="w-32 space-y-1.5">
						<Label htmlFor="m-threshold">Threshold</Label>
						<Input
							id="m-threshold"
							inputMode="decimal"
							onChange={(e) => patch(setForm, "threshold")(e.target.value)}
							value={form.threshold}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
