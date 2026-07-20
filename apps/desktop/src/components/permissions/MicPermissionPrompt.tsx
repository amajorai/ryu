// apps/desktop/src/components/permissions/MicPermissionPrompt.tsx
//
// Reusable pre-permission UI for microphone access. Wraps the existing
// ensureMicPermission() request/grant logic and adds a custom, in-app surface
// instead of relying on the raw webview prompt:
//
//   - Windows: the in-page prompt is auto-accepted (additionalBrowserArgs in
//     tauri.conf.json), so requesting either succeeds silently or throws when
//     the OS-wide mic toggle is off. The "blocked" branch deep-links there.
//   - macOS: the request triggers the one-time TCC prompt (backed by
//     NSMicrophoneUsageDescription); a prior denial deep-links to System
//     Settings.
//
// Used by the onboarding mic step and the audio settings panel so there is one
// place that owns the request/blocked/retry flow.

import { Mic01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { useCallback, useState } from "react";
import { ensureMicPermission } from "@/src/lib/audio/devices.ts";
import {
	canOpenMicrophoneSettings,
	openMicrophoneSettings,
} from "@/src/lib/os/permissions.ts";

type MicStatus = "idle" | "requesting" | "granted" | "blocked";

interface MicPermissionPromptProps {
	className?: string;
	/** Fired after each request resolves, with whether access was granted. */
	onResolved?: (granted: boolean) => void;
	/** Label for the primary request button while idle. */
	requestLabel?: string;
}

export function MicPermissionPrompt({
	onResolved,
	requestLabel = "Enable microphone",
	className,
}: MicPermissionPromptProps) {
	const [status, setStatus] = useState<MicStatus>("idle");

	const request = useCallback(async () => {
		setStatus("requesting");
		const granted = await ensureMicPermission();
		setStatus(granted ? "granted" : "blocked");
		onResolved?.(granted);
	}, [onResolved]);

	if (status === "granted") {
		return (
			<div
				className={`flex items-center gap-2 text-sm ${className ?? ""}`}
				role="status"
			>
				<HugeiconsIcon className="text-primary" icon={Mic01Icon} size={16} />
				<span className="text-muted-foreground">Microphone enabled.</span>
			</div>
		);
	}

	if (status === "blocked") {
		return (
			<div className={`space-y-2 ${className ?? ""}`}>
				<p className="text-destructive text-sm">
					Microphone access is blocked. Turn it on in your system settings, then
					try again.
				</p>
				<div className="flex items-center gap-2">
					{canOpenMicrophoneSettings() && (
						<Button
							onClick={() => {
								openMicrophoneSettings().catch(() => undefined);
							}}
							size="sm"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon icon={Settings02Icon} size={16} />
							Open settings
						</Button>
					)}
					<Button
						onClick={() => {
							request().catch(() => undefined);
						}}
						size="sm"
						type="button"
						variant="ghost"
					>
						Try again
					</Button>
				</div>
			</div>
		);
	}

	return (
		<Button
			className={className}
			disabled={status === "requesting"}
			onClick={() => {
				request().catch(() => undefined);
			}}
			type="button"
			variant="secondary"
		>
			<HugeiconsIcon icon={Mic01Icon} size={16} />
			{status === "requesting" ? "Requesting…" : requestLabel}
		</Button>
	);
}
