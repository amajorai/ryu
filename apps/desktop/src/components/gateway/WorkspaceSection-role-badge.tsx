import { Button } from "@ryu/ui/components/button.tsx";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import type { OrgRole } from "@/src/lib/api/org.ts";

export function RoleBadge({ role }: { role: OrgRole }) {
	return (
		<span className="text-muted-foreground text-sm capitalize">
			{role ?? "member"}
		</span>
	);
}

/**
 * A failed read as one row: a plain sentence and its Retry button, inside the
 * section's card. The raw failure message stays on the `title` attribute.
 */
export function LoadErrorRow({
	detail,
	message,
	onRetry,
	retryLabel,
}: {
	detail?: string;
	message: string;
	onRetry: () => void;
	retryLabel: string;
}) {
	return (
		<SettingsItem
			actions={
				<Button onClick={onRetry} size="sm" variant="outline">
					{retryLabel}
				</Button>
			}
			title={
				<span role="alert" title={detail}>
					{message}
				</span>
			}
		/>
	);
}
