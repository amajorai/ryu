// Revoke with one inline confirmation: the first press asks, "Revoke now"
// revokes. Both confirm buttons name what they act on, and the row cannot be
// revoked twice while a request is in flight.

import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";

export function VaultRevokeButton({
	labels,
	onRevoke,
}: {
	/** Accessible names naming what is revoked, already translated. */
	labels: { ask: string; keep: string; now: string };
	onRevoke: () => Promise<void>;
}) {
	const [confirming, setConfirming] = useState(false);
	const [revoking, setRevoking] = useState(false);
	if (!confirming) {
		return (
			<Button
				aria-label={labels.ask}
				onClick={() => setConfirming(true)}
				size="sm"
				variant="ghost"
			>
				Revoke
			</Button>
		);
	}
	return (
		<>
			<Button
				aria-label={labels.now}
				disabled={revoking}
				onClick={async () => {
					setRevoking(true);
					try {
						await onRevoke();
					} finally {
						setRevoking(false);
						setConfirming(false);
					}
				}}
				size="sm"
				variant="destructive"
			>
				Revoke now
			</Button>
			<Button
				aria-label={labels.keep}
				disabled={revoking}
				onClick={() => setConfirming(false)}
				size="sm"
				variant="ghost"
			>
				Keep
			</Button>
		</>
	);
}
