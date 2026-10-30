// apps/desktop/src/components/shell/NodeSelector-lazy-share-node-dialog.tsx
//
// The "Share this computer" dialog, fetched the first time it opens.
//
// The node selector mounts it with the sidebar header; its QR code renderer is
// only needed once a user shares a node. After the first open it stays mounted,
// so its state and close animation behave as before.

import { type ComponentProps, lazy, Suspense, useState } from "react";
import type { ShareNodeDialog as ShareNodeDialogComponent } from "./NodeSelector-share-node-dialog.tsx";

const ShareNodeDialogImpl = lazy(() =>
	import("./NodeSelector-share-node-dialog.tsx").then((module) => ({
		default: module.ShareNodeDialog,
	}))
);

export function ShareNodeDialog(
	props: ComponentProps<typeof ShareNodeDialogComponent>
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
			<ShareNodeDialogImpl {...props} />
		</Suspense>
	);
}
