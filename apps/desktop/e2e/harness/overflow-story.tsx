// Standalone browser story for the REAL SectionOverflowPopover (the "search
// overflow in a popover" sidebar mode). Mounts the actual exported component
// with mock items so its search + infinite-scroll windowing can be driven in a
// real browser without Core, Tauri, or seed data. Not part of the plugin-runtime
// cert; served by the same harness Vite config via its own html entry.

import { createRoot } from "react-dom/client";
import { SectionOverflowPopover } from "../../src/components/layout/AppSidebar.tsx";
import "../../src/index.css";

interface MockItem {
	id: string;
	name: string;
}

const TOTAL = 55;
const PAGE_ONE = 10;

const items: MockItem[] = Array.from({ length: TOTAL }, (_, i) => ({
	id: String(i),
	name: `Item ${String(i).padStart(2, "0")}`,
}));

function Story() {
	return (
		<div style={{ padding: 40 }}>
			<div style={{ width: 240 }}>
				<SectionOverflowPopover<MockItem>
					overflow={{
						getSearchText: (it) => it.name,
						items,
						label: "items",
						renderList: (list) =>
							list.map((it) => (
								<div
									className="px-2 py-1 text-sm"
									data-testid="row"
									key={it.id}
								>
									{it.name}
								</div>
							)),
					}}
					remaining={TOTAL - PAGE_ONE}
				/>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
