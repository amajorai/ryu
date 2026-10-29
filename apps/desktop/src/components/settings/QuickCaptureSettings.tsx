// Settings → Keyboard Shortcuts → Quick Capture.
//
// The double-tap-Shift keep gesture. This row is unusual among settings toggles
// because turning it ON is what triggers a macOS permission prompt, and because
// it can be "on" while still not working — so the row reports the three things
// that can independently be wrong instead of a single switch that lies:
//
//   1. Input Monitoring — gates the keyboard event tap. Without it the gesture
//      never fires at all.
//   2. Accessibility — gates reading the selected text and the source window.
//      Without it capture still works (via the clipboard fallback) and still names
//      the app (NSWorkspace is ungated); it loses the window title and page URL.
//   3. The Quests app being enabled — it ships OFF, and captures have nowhere to
//      go until the user turns it on from the Store.
//
// All three are surfaced as their own line with its own fix, because "it doesn't
// work" with no explanation is the failure mode this feature is most prone to.

import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
	openAccessibilitySettings,
	openInputMonitoringSettings,
	requestAccessibilityPermission,
	requestInputMonitoringPermission,
} from "@/src/lib/os/permissions.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

type Binding = "either" | "left" | "right";

interface QuickCaptureStatus {
	accessibility: boolean;
	binding: Binding;
	enabled: boolean;
	error: string | null;
	input_monitoring: boolean;
	listening: boolean;
	quests_enabled: boolean;
	supported: boolean;
}

const GESTURE_TITLE = "Keep The Selection With A Double-Tap Of Shift";

const BINDINGS: { id: Binding; label: string }[] = [
	{ id: "either", label: "Either Shift" },
	{ id: "left", label: "Left only" },
	{ id: "right", label: "Right only" },
];

export function QuickCaptureSettings() {
	const [status, setStatus] = useState<QuickCaptureStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setStatus(await invoke<QuickCaptureStatus>("quick_capture_status"));
		} catch {
			// The command is missing only in a non-Tauri harness; leave the section
			// hidden rather than showing a broken row.
			setStatus(null);
		}
	}, []);

	useEffect(() => {
		void refresh();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	const toggle = async (next: boolean) => {
		setBusy(true);
		try {
			const updated = await invoke<QuickCaptureStatus>(
				"quick_capture_set_enabled",
				{ enabled: next }
			);
			setStatus(updated);
			if (next && !updated.listening) {
				toast.error({
					title: "Quick Capture couldn't start",
					description:
						updated.error ?? "Grant Input Monitoring to Ryu, then try again.",
				});
			}
		} catch (e) {
			toast.error({
				title: "Quick Capture couldn't start",
				description: e instanceof Error ? e.message : String(e),
			});
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const setBinding = async (binding: Binding) => {
		try {
			setStatus(
				await invoke<QuickCaptureStatus>("quick_capture_set_binding", {
					binding,
				})
			);
		} catch {
			await refresh();
		}
	};

	if (!status) {
		return null;
	}

	if (!status.supported) {
		return (
			<SettingsSection
				caption="Quick Capture is macOS-only for now."
				title="Quick Capture"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch aria-label={GESTURE_TITLE} checked={false} disabled />
						}
						title={GESTURE_TITLE}
					/>
				</SettingsGroup>
			</SettingsSection>
		);
	}

	return (
		<SettingsSection
			caption="Select text in any app and tap Shift twice, and it lands on your Quests board with the app and page it came from. Nothing is read until you tap; Ryu never stores what you type."
			title="Quick Capture"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label={GESTURE_TITLE}
							checked={status.enabled}
							disabled={busy}
							onCheckedChange={toggle}
						/>
					}
					title={GESTURE_TITLE}
				/>

				<SettingsItem
					actions={
						<div className="flex items-center gap-1">
							{BINDINGS.map((b) => (
								<Button
									aria-pressed={status.binding === b.id}
									key={b.id}
									onClick={() => setBinding(b.id)}
									size="sm"
									variant={status.binding === b.id ? "secondary" : "ghost"}
								>
									{b.label}
								</Button>
							))}
						</div>
					}
					description="Bind to one side if you use the other Shift heavily."
					title="Which Shift"
				/>

				<PermissionRow
					description="Required. The gesture can't be detected without it."
					granted={status.input_monitoring}
					onFix={async () => {
						await requestInputMonitoringPermission();
						await openInputMonitoringSettings();
						await refresh();
					}}
					title="Input Monitoring"
				/>

				<PermissionRow
					description="Optional. Captures still work and still record which app they came from; without it they lose the window title and page URL. A freshly granted permission takes effect after Ryu restarts."
					granted={status.accessibility}
					onFix={async () => {
						await requestAccessibilityPermission();
						await openAccessibilitySettings();
						await refresh();
					}}
					title="Accessibility"
				/>

				{status.error ? (
					<SettingsItem
						description={status.error}
						title="Last Capture Failed"
					/>
				) : null}

				<SettingsItem
					actions={
						status.quests_enabled ? (
							<span className="text-muted-foreground text-xs">On</span>
						) : (
							<span className="text-status-destructive text-xs">Off</span>
						)
					}
					description={
						status.quests_enabled
							? undefined
							: "Captures have nowhere to go until Quests is enabled. Turn it on from the Store."
					}
					title="Quests App"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

// `description` is read by the enclosing SettingsGroup off this element's own
// props and rendered as the caption under the row; it must be passed at the call
// site; text computed inside this wrapper would never be shown.
function PermissionRow({
	title,
	granted,
	description,
	onFix,
}: {
	title: string;
	granted: boolean;
	description: string;
	onFix: () => Promise<void>;
}) {
	return (
		<SettingsItem
			actions={
				granted ? (
					<span className="text-muted-foreground text-xs">Granted</span>
				) : (
					<Button onClick={onFix} size="sm" variant="ghost">
						Grant
					</Button>
				)
			}
			description={description}
			title={title}
		/>
	);
}
