"use client";

import { Button } from "@ryu/ui/components/button";

/** The editor's footer: form error, save/create buttons, and the lock note. */
export function AgentFormActions({
	formError,
	isLocked,
	isNew,
	onCancel,
	onCreateAndChat,
	onSave,
	saveDisabled,
	saving,
}: {
	formError?: string | null;
	isLocked: boolean;
	isNew: boolean;
	onCancel?: () => void;
	onCreateAndChat?: () => void;
	onSave?: () => void;
	saveDisabled?: boolean;
	saving?: boolean;
}) {
	return (
		<>
			{formError ? (
				<p className="text-sm text-status-destructive">{formError}</p>
			) : null}

			<div className="flex gap-2">
				{isNew ? (
					<>
						<Button
							disabled={saveDisabled}
							loading={saving}
							onClick={onCreateAndChat}
						>
							Create &amp; chat
						</Button>
						<Button disabled={saveDisabled} onClick={onSave} variant="ghost">
							Create agent
						</Button>
					</>
				) : (
					<Button disabled={saveDisabled} loading={saving} onClick={onSave}>
						Save changes
					</Button>
				)}
				<Button onClick={onCancel} variant="ghost">
					Cancel
				</Button>
			</div>

			{isLocked ? (
				<p className="text-muted-foreground text-xs">
					This agent is locked. Unlock it to make changes.
				</p>
			) : null}
		</>
	);
}
