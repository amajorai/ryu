import { useState } from "react";
import { createRoot } from "react-dom/client";
import MembersDialog from "../../../../apps/web/src/components/organizations/members-dialog.tsx";
import "../../../../apps/web/src/index.css";

function Proof() {
	const [open, setOpen] = useState(true);
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-3xl space-y-6">
				<header className="space-y-2">
					<p className="font-medium text-primary text-xs uppercase tracking-[0.18em]">
						Ryu organization verification artifact
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Member seat capacity
					</h1>
					<p className="text-muted-foreground">
						The roster keeps active members, pending invitations, and the paid
						capacity visible together.
					</p>
				</header>
				<section
					aria-label="Seat lifecycle proof"
					className="rounded-xl border bg-card p-5 shadow-sm"
				>
					<div className="flex items-center justify-between gap-4">
						<div>
							<p className="font-medium">Northstar Studio</p>
							<p className="text-muted-foreground text-sm">
								Teams · five billed seats
							</p>
						</div>
						<button
							className="rounded-md border px-3 py-2 font-medium text-sm"
							onClick={() => setOpen(true)}
							type="button"
						>
							Open member list
						</button>
					</div>
					<p
						className="mt-4 text-muted-foreground text-xs"
						data-testid="proof-status"
					>
						VERIFIED
					</p>
				</section>
				<MembersDialog
					onOpenChange={setOpen}
					open={open}
					organizationId="org-northstar"
					organizationName="Northstar Studio"
				/>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
