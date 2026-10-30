// The shared "New agent" dialog, fetched the first time it opens.
//
// CreateAgentDialog is mounted once by the shell and reads its open state from
// `useCreateAgentDialog`. Its body carries the agent setup composer and avatar
// picker, so the shell mounts this stand-in instead: it renders nothing until
// the store first opens the dialog, then keeps the real dialog mounted so its
// state and close animation behave as before.

import { lazy, Suspense, useState } from "react";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";

const CreateAgentDialogImpl = lazy(() =>
	import("./CreateAgentDialog.tsx").then((module) => ({
		default: module.CreateAgentDialog,
	}))
);

export function CreateAgentDialog() {
	const open = useCreateAgentDialog((state) => state.open);
	const [opened, setOpened] = useState(open);
	if (open && !opened) {
		setOpened(true);
	}
	if (!opened) {
		return null;
	}
	return (
		<Suspense fallback={null}>
			<CreateAgentDialogImpl />
		</Suspense>
	);
}
