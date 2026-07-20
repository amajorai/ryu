// apps/desktop/src/components/settings/ChatRenameSettings.tsx
//
// Settings for chat auto-rename (ChatGPT/Claude-style naming of a new chat after
// its first message). A master toggle, plus which model names the chat.
//
// By default Core asks the resident LOCAL model directly so the first message
// never leaves the machine. On a cloud-only setup no local engine is resident, so
// that direct path is a no-op and chats never get named — set a model here and
// the title call routes through the Gateway with it instead. Model/effort persist
// under the `auto-title-*` keys; Core routes by the model id alone (the provider
// dropdown is a suggestion, never a lock).

import { toast } from "@ryu/ui/components/sileo";
import { Switch } from "@ryu/ui/components/switch";
import { useCallback, useEffect, useState } from "react";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	getChatRenameConfig,
	getChatRenameEnabled,
	type SideModelConfig,
	setChatRenameConfig,
	setChatRenameEnabled,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { SideModelPicker } from "./shared/SideModelPicker.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const EMPTY_MODEL: SideModelConfig = { provider: "", model: "", effort: "" };

function activeTarget(): ApiTarget {
	return toTarget(useNodeStore.getState().getActiveNode());
}

export function ChatRenameSettings() {
	const [enabled, setEnabled] = useState(true);
	const [cfg, setCfg] = useState<SideModelConfig>(EMPTY_MODEL);

	useEffect(() => {
		let cancelled = false;
		const target = activeTarget();
		Promise.all([getChatRenameEnabled(target), getChatRenameConfig(target)])
			.then(([enabledValue, modelValue]) => {
				if (cancelled) {
					return;
				}
				setEnabled(enabledValue);
				setCfg(modelValue);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	const updateEnabled = useCallback(async (next: boolean) => {
		setEnabled(next);
		try {
			await setChatRenameEnabled(activeTarget(), next);
		} catch {
			setEnabled(!next);
			toast.error("Couldn't save the auto-rename setting");
		}
	}, []);

	const updateModel = useCallback(async (next: SideModelConfig) => {
		let previous: SideModelConfig = EMPTY_MODEL;
		setCfg((prev) => {
			previous = prev;
			return next;
		});
		try {
			await setChatRenameConfig(activeTarget(), next);
		} catch {
			setCfg(previous);
			toast.error("Couldn't save the rename model", {
				description: "Check your connection and try again.",
			});
		}
	}, []);

	return (
		<SettingsSection
			caption="When a chat gets its first message, Ryu names it automatically. By default the local model on this device does it, so your message never leaves the machine. Set a model below to name chats through the Gateway instead — needed when no local engine is running (a cloud-only setup), otherwise chats keep their first-message title."
			title="Auto-rename chats"
		>
			<SettingsCard className="space-y-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="font-medium text-sm">Auto-rename new chats</p>
						<p className="text-muted-foreground text-xs">
							Generate a short title from the first message.
						</p>
					</div>
					<Switch
						aria-label="Auto-rename new chats"
						checked={enabled}
						onCheckedChange={(v) => {
							Promise.resolve(updateEnabled(Boolean(v))).catch(() => undefined);
						}}
					/>
				</div>
				{enabled && (
					<SideModelPicker
						onChange={updateModel}
						target={activeTarget()}
						value={cfg}
					/>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
