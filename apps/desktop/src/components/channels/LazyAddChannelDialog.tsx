// The sidebar's "Add channel" dialog, fetched the first time it opens.
//
// The Channels section mounts the dialog with the sidebar, but its body (every
// channel type's setup form and the managed-bot flow) is only needed once a
// user starts adding a channel. After the first open it stays mounted, so its
// state and close animation behave as before.

import { type ComponentProps, lazy, Suspense, useState } from "react";
import type { AddChannelDialog as AddChannelDialogComponent } from "./AddChannelDialog.tsx";

const AddChannelDialogImpl = lazy(() =>
	import("./AddChannelDialog.tsx").then((module) => ({
		default: module.AddChannelDialog,
	}))
);

export function AddChannelDialog(
	props: ComponentProps<typeof AddChannelDialogComponent>
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
			<AddChannelDialogImpl {...props} />
		</Suspense>
	);
}
