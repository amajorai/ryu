import {
	EyeIcon,
	Key01Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import { OverflowMenu } from "@/src/components/gateway/quiet.tsx";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import type { ByokProvider } from "@/src/lib/api/gateway.ts";

export function ManagedKeyNote() {
	return (
		<p className="text-muted-foreground text-xs">
			Provided by Ryu Cloud. Keys held server-side.
		</p>
	);
}

export function ProviderRow({
	slug,
	label,
	placeholder,
	isSet,
	onSave,
	onClear,
	readOnly = false,
	canConfigure = true,
}: {
	slug: ByokProvider;
	label: string;
	placeholder: string;
	isSet: boolean;
	onSave: (slug: ByokProvider, key: string) => Promise<void>;
	onClear: (slug: ByokProvider) => Promise<void>;
	/** Managed (Ryu Cloud) node: render key state read-only, no input, no writers. */
	readOnly?: boolean;
	/** When false the caller lacks `gateway.configure`; writers are unavailable. */
	canConfigure?: boolean;
}) {
	const tl = useLiteralMessages();
	const [input, setInput] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [clearing, setClearing] = useState(false);
	const [rowError, setRowError] = useState<string | null>(null);

	const handleSave = async () => {
		if (readOnly || canConfigure === false) {
			return;
		}
		const trimmed = input.trim();
		if (!trimmed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			await onSave(slug, trimmed);
			setInput("");
		} catch (error) {
			setRowError(
				error instanceof Error ? error.message : "Failed to save key"
			);
		} finally {
			setSaving(false);
		}
	};

	const handleClear = async () => {
		if (readOnly || canConfigure === false) {
			return;
		}
		setClearing(true);
		setRowError(null);
		try {
			await onClear(slug);
		} catch (error) {
			setRowError(
				error instanceof Error ? error.message : "Failed to clear key"
			);
		} finally {
			setClearing(false);
		}
	};

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-2">
					<span className="text-muted-foreground text-sm">
						{readOnly ? "Ryu Cloud" : isSet ? "Key set" : "No key"}
					</span>
					{!readOnly && canConfigure && isSet && (
						<OverflowMenu
							items={[
								{
									id: "clear",
									label: "Clear",
									destructive: true,
									disabled: clearing,
									onSelect: () => void handleClear(),
								},
							]}
							label={tl("{providerLabel} key actions", {
								providerLabel: label,
							})}
						/>
					)}
				</div>
			}
			title={
				<span className="flex items-center gap-2">
					<HugeiconsIcon
						className="size-4 text-muted-foreground"
						icon={Key01Icon}
					/>
					{label}
				</span>
			}
		>
			{readOnly ? (
				<ManagedKeyNote />
			) : (
				<div className="flex w-full items-center gap-2">
					<div className="relative flex-1">
						<Input
							aria-label={tl("{label} API key", { label })}
							disabled={canConfigure === false}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									void handleSave();
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
							disabled={canConfigure === false}
							onClick={() => setShowKey((visible) => !visible)}
							type="button"
						>
							<HugeiconsIcon
								className="size-4"
								icon={showKey ? ViewOffSlashIcon : EyeIcon}
							/>
						</button>
					</div>
					<Button
						disabled={!input.trim() || canConfigure === false}
						loading={saving}
						onClick={() => void handleSave()}
						size="sm"
						variant="outline"
					>
						Save
					</Button>
				</div>
			)}

			{rowError ? (
				<p className="text-status-destructive text-xs">{rowError}</p>
			) : null}
		</SettingsItem>
	);
}
