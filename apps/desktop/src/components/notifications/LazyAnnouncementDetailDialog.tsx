// The announcement detail dialog, fetched the first time one opens.
//
// Its artwork (admin-authored scenes, pass-card shaders) is the heaviest part
// of the sidebar's announcements section and only renders once a user opens an
// announcement. After the first open the real dialog stays mounted, so later
// opens and the close animation behave as before.

import { type ComponentProps, lazy, Suspense, useState } from "react";
import type { AnnouncementDetailDialog as AnnouncementDetailDialogComponent } from "./announcement-detail-dialog.tsx";

const AnnouncementDetailDialogImpl = lazy(() =>
	import("./announcement-detail-dialog.tsx").then((module) => ({
		default: module.AnnouncementDetailDialog,
	}))
);

export function AnnouncementDetailDialog(
	props: ComponentProps<typeof AnnouncementDetailDialogComponent>
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
			<AnnouncementDetailDialogImpl {...props} />
		</Suspense>
	);
}
