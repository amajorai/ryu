// apps/desktop/src/components/settings/NetworkSettings-read-error.tsx
//
// Read-failure row shared by the network settings cards (split out of
// NetworkSettings.tsx).

import { Button } from "@ryu/ui/components/button.tsx";
import { SettingsItem } from "./shared/settings-items.tsx";

export function NetworkReadError({
	title,
	error,
	onRetry,
}: {
	title: string;
	error: string | null;
	onRetry: () => void;
}) {
	if (!error) {
		return null;
	}
	// A plain sentence with Retry beside it; the raw failure stays one click away
	// under "Details" rather than being the headline.
	return (
		<div role="alert">
			<SettingsItem
				actions={
					<Button onClick={onRetry} size="sm" variant="outline">
						Retry
					</Button>
				}
				title={title}
			>
				<details className="text-muted-foreground text-xs">
					<summary className="cursor-pointer select-none">Details</summary>
					<span className="mt-1 block break-all">{error}</span>
				</details>
			</SettingsItem>
		</div>
	);
}
