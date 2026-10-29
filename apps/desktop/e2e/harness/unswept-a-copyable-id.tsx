// The REAL shared CopyableId (Gateway workspace org id, Account user id) in
// real Chromium with the app's real stylesheet, so the CSS blur that hides the
// value until the row is hovered or focused, and native keyboard activation of
// the copy button, are the shipping behavior and not a happy-dom stand-in.
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { createRoot } from "react-dom/client";
import { CopyableId } from "../../src/components/settings/shared/CopyableId.tsx";
import "../../src/index.css";

const root = document.getElementById("root");
if (!root) {
	throw new Error("Harness root missing");
}
createRoot(root).render(
	<main className="flex max-w-xl flex-col gap-6 p-8">
		<button type="button">Before the ids</button>
		<section aria-label="Organization row" data-row="org">
			<CopyableId label="organization ID" value="org_01J9Z4WORKSPACEID" />
		</section>
		<section aria-label="User row" data-row="user">
			<CopyableId label="user ID" value="user_01J9Z4ACCOUNTID" />
		</section>
		<Toaster />
	</main>
);
