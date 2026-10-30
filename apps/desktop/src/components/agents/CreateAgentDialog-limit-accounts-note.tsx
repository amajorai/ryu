interface CreateAgentLimitAccountsNoteProps {
	onRemoveLimit: () => void;
	submitting: boolean;
}

// Shown in `CreateAgentDialog` once the launch warning's "Limit to selected
// accounts" was chosen.
export function CreateAgentLimitAccountsNote({
	onRemoveLimit,
	submitting,
}: CreateAgentLimitAccountsNoteProps) {
	return (
		<p className="px-3 text-detail text-muted-foreground" role="status">
			This agent will start limited to selected accounts. Choose them in its
			settings after it's created.{" "}
			<button
				className="underline underline-offset-2"
				disabled={submitting}
				onClick={onRemoveLimit}
				type="button"
			>
				Remove limit
			</button>
		</p>
	);
}
