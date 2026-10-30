import {
	EyeIcon,
	Key01Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { type ReactNode, useEffect, useState } from "react";
import { ManagedKeyNote } from "@/src/components/gateway/ProviderKeyRow.tsx";
import { OverflowMenu } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";

/**
 * Cloud media provider (Replicate / Fal) BYOK key card. Mirrors
 * {@link ComposioKeyCard}: the key is a Core preference that Core mirrors into
 * its resolver and injects into the gateway (`REPLICATE_API_KEY` / `FAL_API_KEY`)
 * on save, activating the provider's image/video generation.
 */
export function MediaKeyCard({
	target,
	label,
	caption,
	placeholder,
	getKey,
	saveKey,
	managed = false,
	canConfigure = true,
}: {
	target: ApiTarget;
	label: string;
	caption: ReactNode;
	placeholder: string;
	getKey: (t: ApiTarget) => Promise<string>;
	saveKey: (t: ApiTarget, key: string) => Promise<boolean>;
	/** Managed (Ryu Cloud) node: read-only, writers no-op, no per-node fetch. */
	managed?: boolean;
	/** When false the caller lacks `gateway.configure`; writers disabled. */
	canConfigure?: boolean;
}) {
	const tl = useLiteralMessages();
	const [input, setInput] = useState("");
	const [isSet, setIsSet] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [showKey, setShowKey] = useState(false);
	const [rowError, setRowError] = useState<string | null>(null);

	useEffect(() => {
		// A managed node holds no keys locally (WS1); skip the fetch so the card
		// doesn't report a misleading "No key" for a fleet-held key.
		if (managed) {
			return;
		}
		let active = true;
		getKey(target)
			.then((key) => {
				if (active) {
					setIsSet(Boolean(key));
					setLoaded(true);
				}
			})
			.catch(() => {
				if (active) {
					setLoaded(true);
				}
			});
		return () => {
			active = false;
		};
	}, [target, getKey, managed]);

	const handleSave = async () => {
		// Security gate (WS4): never POST a personal key to the shared fleet.
		// Also blocked when the caller lacks `gateway.configure` (RBAC).
		if (managed || canConfigure === false) {
			return;
		}
		const trimmed = input.trim();
		if (!trimmed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			const ok = await saveKey(target, trimmed);
			if (ok) {
				setIsSet(true);
				setInput("");
			} else {
				setRowError("Failed to save key");
			}
		} catch (e) {
			setRowError(e instanceof Error ? e.message : "Failed to save key");
		} finally {
			setSaving(false);
		}
	};

	const handleClear = async () => {
		if (managed) {
			return;
		}
		setSaving(true);
		setRowError(null);
		try {
			const ok = await saveKey(target, "");
			if (ok) {
				setIsSet(false);
				setInput("");
			} else {
				setRowError("Failed to clear key");
			}
		} catch (e) {
			setRowError(e instanceof Error ? e.message : "Failed to clear key");
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection caption={caption} title={label}>
			<SettingsGroup>
				<SettingsItem
					actions={
						<div className="flex items-center gap-2">
							<span className="text-muted-foreground text-sm">
								{managed ? "Ryu Cloud" : isSet ? "Key set" : "No key"}
							</span>
							{!managed && isSet && (
								<OverflowMenu
									items={[
										{
											id: "clear",
											label: "Clear",
											destructive: true,
											disabled: saving,
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
							<HugeiconsIcon
								className="size-4 text-muted-foreground"
								icon={Key01Icon}
							/>
							API key
						</span>
					}
				>
					{managed ? (
						<ManagedKeyNote />
					) : (
						<div className="flex w-full items-center gap-2">
							<div className="relative flex-1">
								<Input
									disabled={!loaded}
									onChange={(e) => setInput(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											handleSave();
										}
									}}
									placeholder={
										isSet
											? "•••••••• (leave blank to keep current)"
											: placeholder
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
								disabled={!(loaded && input.trim()) || canConfigure === false}
								loading={saving}
								onClick={() => handleSave()}
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
			</SettingsGroup>
		</SettingsSection>
	);
}
