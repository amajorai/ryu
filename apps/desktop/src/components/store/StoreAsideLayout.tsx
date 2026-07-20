import type { ReactNode } from "react";
import StoreListHeader from "@/src/components/store/StoreListHeader.tsx";

/**
 * Fixed left aside + full-height right pane for Store sections that are not
 * master-detail catalogs (Tools, Fine-tune, Installed, Account). Mirrors the
 * list-column chrome placement of {@link ResizableMasterDetail} without a
 * draggable divider.
 */
export default function StoreAsideLayout({
	list,
	children,
	search,
}: {
	list?: ReactNode;
	children: ReactNode;
	search?: {
		value: string;
		onChange: (value: string) => void;
		placeholder?: string;
	};
}) {
	return (
		<div className="flex h-full min-h-0 overflow-hidden">
			<aside className="flex w-[min(320px,32%)] shrink-0 flex-col border-border/60 border-r">
				{search ? <StoreListHeader search={search} /> : null}
				{list ? (
					<div className="min-h-0 flex-1 overflow-hidden">{list}</div>
				) : null}
			</aside>
			<div className="min-h-0 flex-1 overflow-hidden">
				<div className="h-full p-2 pl-0">
					<div className="scroll-fade-effect-y flex size-full flex-col overflow-auto rounded-3xl border border-border/60 bg-sidebar shadow-sm dark:bg-sidebar/50">
						{children}
					</div>
				</div>
			</div>
		</div>
	);
}
