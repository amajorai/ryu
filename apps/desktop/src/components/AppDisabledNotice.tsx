// apps/desktop/src/components/AppDisabledNotice.tsx
//
// The one surface for Core's `503 app_disabled` contract: a feature route
// (Meetings, Spaces, …) refused because the App that owns it is disabled. Core
// returns the App's manifest id, so instead of a dead error string we offer a
// one-click Enable using the same lifecycle toggle the store uses. Shared by
// every gated page (MeetingsPage, SpacesPage) so the recovery UX is identical.

import { PackageIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { toast } from "@ryu/ui/components/sileo";
import { useState } from "react";
import { useApps } from "@/src/hooks/useApps.ts";

export function AppDisabledNotice({
	app,
	message,
	onEnabled,
}: {
	/** The owning App's manifest id to enable (from the 503 body). */
	app: string;
	/** Core's human message ("Enable the Meetings app"). */
	message: string;
	/** Called after a successful enable so the page can refetch its gated data
	 *  (some hooks auto-recover on the global refresh; others need an explicit
	 *  invalidate). */
	onEnabled?: () => void;
}) {
	const { toggle } = useApps();
	const [busy, setBusy] = useState(false);

	const enable = async () => {
		setBusy(true);
		try {
			// `toggle` handles its own refusal reporting; enabling auto-enables any
			// dependencies (e.g. Meetings pulls in Spaces) in order.
			await toggle(app, true);
			onEnabled?.();
		} catch (e) {
			toast.error("Couldn't enable this app", {
				description: e instanceof Error ? e.message : "Please try again.",
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex h-full items-center justify-center p-6">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={PackageIcon} />
					</EmptyMedia>
					<EmptyTitle>{message}</EmptyTitle>
					<EmptyDescription>
						This feature is part of an app that is currently turned off. Enable
						it to continue — your existing data is untouched.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						disabled={busy}
						onClick={() => {
							enable().catch(() => {
								// Errors surfaced via toast in `enable`.
							});
						}}
					>
						{busy ? "Enabling…" : "Enable"}
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	);
}
