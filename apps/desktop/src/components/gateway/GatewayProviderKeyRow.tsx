import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { OverflowMenu } from "@/src/components/gateway/quiet.tsx";
import { SpendLimitConfirm } from "@/src/components/settings/shared/provider-key-safety.tsx";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import type {
	ByokProvider,
	GatewayAccountStrategy,
	GatewayProviderAccount,
} from "@/src/lib/api/gateway.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";
import {
	ProviderAccountList,
	ProviderAccountStrategy,
} from "./provider-key-row/provider-accounts.tsx";
import { ProviderKeyInput } from "./provider-key-row/provider-key-input.tsx";
import { gatewayAccountErrorMessage } from "./provider-key-row/shared.tsx";

export { gatewayAccountErrorMessage } from "./provider-key-row/shared.tsx";

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
	const tl = useLiteralMessages();
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
					<span className="text-muted-foreground text-sm">
						{readOnly ? "Managed" : isSet ? "Key set" : "No key"}
					</span>
					{!readOnly && isSet && !hasExternalCredentials && (
						<OverflowMenu
							items={[
								{
									id: "clear",
									label: "Clear",
									destructive: true,
									disabled: !canConfigure || clearing,
									onSelect: () => void handleClear(),
								},
							]}
							label={tl("{label} key actions", { label })}
						/>
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
			<ProviderKeyInput
				accountCount={accountCount}
				canConfigure={canConfigure}
				credentialLabel={credentialLabel}
				handleAdd={handleAdd}
				handleSave={handleSave}
				hasExternalCredentials={hasExternalCredentials}
				hasFleetCredentials={hasFleetCredentials}
				input={input}
				isSet={isSet}
				label={label}
				limitConfirmed={limitConfirmed}
				placeholder={placeholder}
				readOnly={readOnly}
				readOnlyNote={readOnlyNote}
				saving={saving}
				setInput={setInput}
				setShowKey={setShowKey}
				showKey={showKey}
			/>

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

			<ProviderAccountList
				accountCount={accountCount}
				accounts={accounts}
				canConfigure={canConfigure}
				handleRemove={handleRemove}
				label={label}
				onConfigure={onConfigure}
				onReplace={onReplace}
				quotaRouting={quotaRouting}
				readOnly={readOnly}
				removingIndex={removingIndex}
				slug={slug}
			/>
			<ProviderAccountStrategy
				accountCount={accountCount}
				accountStrategy={accountStrategy}
				canConfigure={canConfigure}
				handleStrategyChange={handleStrategyChange}
				handleThresholdChange={handleThresholdChange}
				onDrainThresholdChange={onDrainThresholdChange}
				onStrategyChange={onStrategyChange}
				quotaRouting={quotaRouting}
				readOnly={readOnly}
				setThresholdDraft={setThresholdDraft}
				slug={slug}
				strategySaving={strategySaving}
				thresholdDraft={thresholdDraft}
				thresholdSaving={thresholdSaving}
			/>

			{rowError ? (
				<p className="text-status-destructive text-xs">{rowError}</p>
			) : null}
		</SettingsItem>
	);
}
