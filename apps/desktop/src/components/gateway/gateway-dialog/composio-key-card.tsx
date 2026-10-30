import {
	EyeIcon,
	Key01Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useState } from "react";
import { ManagedKeyNote } from "@/src/components/gateway/ProviderKeyRow.tsx";
import { CaptionInfo, OverflowMenu } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getComposioApiKey,
	setComposioApiKey,
} from "@/src/lib/api/preferences.ts";

/**
 * Composio API key, surfaced here in Gateway → Keys alongside the BYOK provider
 * keys because Composio is an execution credential the gateway uses to run tool
 * actions (the gateway reads it via the `COMPOSIO_API_KEY` env Core injects). The
 * value is stored in Core preferences (`composio-api-key`) and shared with the
 * browse path (catalog + Marketplace → Connections), so saving here is identical
 * to the old Settings → Integrations field — only the location moved.
 */
export function ComposioKeyCard({
	target,
	managed = false,
	canConfigure = true,
}: {
	target: ApiTarget;
	/** Managed (Ryu Cloud) node: read-only, writers no-op, no per-node fetch. */
	managed?: boolean;
	/** When false the caller lacks `gateway.configure`; writers disabled. */
	canConfigure?: boolean;
}) {
	const [input, setInput] = useState("");
	const [isSet, setIsSet] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [showKey, setShowKey] = useState(false);
	const [rowError, setRowError] = useState<string | null>(null);

	useEffect(() => {
		// A managed node holds no keys locally (WS1); the fetch would report a
		// misleading "No key", so skip it and let the read-only note be the state.
		if (managed) {
			return;
		}
		let active = true;
		getComposioApiKey(target)
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
	}, [target, managed]);

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
			const ok = await setComposioApiKey(target, trimmed);
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
			const ok = await setComposioApiKey(target, "");
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
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"The gateway runs the actions; browse and connect accounts in Marketplace → Connections. Stored locally and sent only to Composio."
					}
				>
					{"Connect agents to Gmail, GitHub, Slack and 800+ apps."}
				</CaptionInfo>
			}
			title="Composio"
		>
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
									label="Composio key actions"
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
										isSet ? "•••••••• (leave blank to keep current)" : "comp_…"
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
