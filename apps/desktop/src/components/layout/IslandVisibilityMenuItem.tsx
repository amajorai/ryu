// User Nav control for the desktop-owned Island companion.
//
// NavUser renders this only when the `ISLAND_ENABLED` release gate
// (`@/src/lib/island-availability.ts`) is on, so enabling Island is one flag
// flip, not a new visibility implementation.

import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import { Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import {
	getIslandVisibility,
	setIslandVisibility,
} from "@/src/lib/api/island.ts";

export function IslandVisibilityMenuItem() {
	const [visible, setVisible] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let active = true;
		getIslandVisibility()
			.then((value) => {
				if (active) {
					setVisible(value);
				}
			})
			.catch(() => {
				if (active) {
					setVisible(null);
				}
			});
		return () => {
			active = false;
		};
	}, []);

	if (visible === null) {
		return null;
	}

	const toggle = async () => {
		setBusy(true);
		try {
			const next = await setIslandVisibility(!visible);
			if (next !== null) {
				setVisible(next);
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<DropdownMenuItem
			disabled={busy}
			onClick={() => toggle().catch(() => undefined)}
		>
			<Laptop className="mr-2 size-4" />
			{visible ? "Hide Island" : "Show Island"}
		</DropdownMenuItem>
	);
}
