// "New Space", fetched the first time the dialog opens.
//
// The sidebar and the create menu mount this dialog with the shell; its body
// (retrieval-mode picker and the Spaces block) is only needed once a user
// creates a Space. After the first open it stays mounted, so its state and
// close animation behave as before.

import { type ComponentProps, lazy, Suspense, useState } from "react";
import type { CreateSpaceDialog as CreateSpaceDialogComponent } from "./CreateSpaceDialog.tsx";

const CreateSpaceDialogImpl = lazy(() =>
	import("./CreateSpaceDialog.tsx").then((module) => ({
		default: module.CreateSpaceDialog,
	}))
);

export function CreateSpaceDialog(
	props: ComponentProps<typeof CreateSpaceDialogComponent>
) {
	const [opened, setOpened] = useState(props.open);
	if (props.open && !opened) {
		setOpened(true);
	}
	if (!opened) {
		return null;
	}
	return (
		<Suspense fallback={null}>
			<CreateSpaceDialogImpl {...props} />
		</Suspense>
	);
}
