// Status and action rows for ModelLaunchConfigSection: the refresh-failure
// banner shown above loaded fields and the save row at the bottom.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";

/** A failed background refresh of an already-loaded launch config. */
export function LaunchRefreshError({
	error,
	isFetching,
	onRetry,
	ownerLabel,
}: {
	error: string;
	isFetching: boolean;
	onRetry: () => void;
	ownerLabel: string;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
			<p className="text-status-destructive text-xs" role="alert">
				{tl("Could not refresh {ownerLabel} launch config: {error}", {
					error,
					ownerLabel,
				})}
			</p>
			<Button
				disabled={isFetching}
				loading={isFetching}
				onClick={onRetry}
				size="sm"
				variant="outline"
			>
				{tl("Retry {ownerLabel} config", { ownerLabel })}
			</Button>
		</div>
	);
}

/** The save button plus its saved / failed status. */
export function LaunchSaveActions({
	disabled,
	onSave,
	ownerLabel,
	saved,
	saveError,
	saving,
}: {
	disabled: boolean;
	onSave: () => void;
	ownerLabel: string;
	saved: boolean;
	saveError: string | null;
	saving: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex items-center gap-2">
			<Button
				disabled={disabled}
				loading={saving}
				onClick={onSave}
				variant="outline"
			>
				{tl("Save {ownerLabel} launch settings", { ownerLabel })}
			</Button>
			{saved ? (
				<span className="text-muted-foreground text-xs">Saved</span>
			) : null}
			{saveError ? (
				<span className="text-status-destructive text-xs" role="alert">
					{tl("Could not save: {saveError}", { saveError })}
				</span>
			) : null}
		</div>
	);
}
