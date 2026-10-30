import { COMPUTE_SHARE_FLAG } from "@ryu/auth/lib/feature-flags";
import { useReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import { useMemo, useState } from "react";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import type { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { loadHiddenChrome, persistHiddenChrome } from "@/src/lib/features.ts";
import type { ChromeDnd, ChromeMenu } from "./sidebar-chrome-buttons.tsx";
import {
	type ChromeKey,
	COMPUTE_SHARE_CHROME,
	type DynamicChromeKey,
	isDynamicChromeKey,
	loadChromeOrder,
	saveChromeOrder,
} from "./sidebar-panel-state.tsx";

type ContributedButtons = ReturnType<
	typeof usePluginContributions
>["sidebar_buttons"];

/** The sidebar's header-button ("chrome") layout: persisted order, hidden
 *  set, plugin-contributed buttons, and every reorder/move/hide writer. */
export function useSidebarChromeLayout({
	botProduct,
	contributedButtons,
	coreAppIds,
}: {
	botProduct: boolean;
	contributedButtons: ContributedButtons;
	coreAppIds: Set<string>;
}) {
	const [hiddenChrome, setHiddenChrome] = useState<Set<string>>(() =>
		loadHiddenChrome()
	);
	const [chromeOrder, setChromeOrder] = useState<ChromeKey[]>(loadChromeOrder);
	// Plugin-registered header buttons (`sidebar_buttons`), appended to the persisted
	// chrome order the same way dynamic sections are. Core-tier App buttons are
	// deliberately excluded; their single entry belongs in the Apps shelf.
	const dynamicChromeKeys = useMemo<ChromeKey[]>(
		() =>
			[...contributedButtons]
				.filter((button) => !coreAppIds.has(button.plugin))
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				)
				.map((b): DynamicChromeKey => `plugin:${b.plugin}:${b.id}`),
		[contributedButtons, coreAppIds]
	);
	// Compute and Share are held behind a rollout flag. Dropping them here hides
	// both the buttons and their Customize rows while keeping the persisted order,
	// so they return in place when the flag turns on.
	const computeShareEnabled = useFeatureFlag(COMPUTE_SHARE_FLAG);
	const effectiveChromeOrder = useMemo<ChromeKey[]>(() => {
		// Drop stale app-button keys from older releases as well as currently absent
		// plugin buttons. The app shelf below is the only host-level app entry point.
		const current = chromeOrder.filter(
			(key) =>
				(computeShareEnabled || !COMPUTE_SHARE_CHROME.has(key)) &&
				(!isDynamicChromeKey(key) || dynamicChromeKeys.includes(key))
		);
		const missing = dynamicChromeKeys.filter((k) => !current.includes(k));
		return missing.length > 0 ? [...current, ...missing] : current;
	}, [chromeOrder, computeShareEnabled, dynamicChromeKeys]);
	const [chromeDraggingKey, setChromeDraggingKey] = useState<ChromeKey | null>(
		null
	);
	const [chromeDragOverKey, setChromeDragOverKey] = useState<ChromeKey | null>(
		null
	);
	const chromeShift = useReorderShift({
		activeId: chromeDraggingKey,
		axis: "y",
		overId: chromeDragOverKey,
	});
	const renderChromeOrder: ChromeKey[] = botProduct
		? ["new-chat"]
		: effectiveChromeOrder.filter((key) => !hiddenChrome.has(key));

	const setChromeHidden = (key: ChromeKey, hidden: boolean) => {
		const next = loadHiddenChrome();
		if (hidden) {
			next.add(key);
		} else {
			next.delete(key);
		}
		setHiddenChrome(next);
		persistHiddenChrome(next);
	};

	const setChromeItemsHidden = (keys: ChromeKey[], hidden: boolean) => {
		const next = loadHiddenChrome();
		for (const key of keys) {
			if (hidden) {
				next.add(key);
			} else {
				next.delete(key);
			}
		}
		setHiddenChrome(next);
		persistHiddenChrome(next);
	};

	// The single writer for header-button order: drag, the per-button move menu,
	// and the customize dialog all funnel through here, mirroring reorderSections.
	const reorderChrome = (next: ChromeKey[]) => {
		setChromeOrder(next);
		saveChromeOrder(next);
	};

	const handleDropChrome = (target: ChromeKey) => {
		if (chromeDraggingKey && chromeDraggingKey !== target) {
			const draggingDown =
				chromeOrder.indexOf(chromeDraggingKey) < chromeOrder.indexOf(target);
			const next = chromeOrder.filter((k) => k !== chromeDraggingKey);
			const targetIdx = next.indexOf(target);
			next.splice(
				draggingDown ? targetIdx + 1 : targetIdx,
				0,
				chromeDraggingKey
			);
			reorderChrome(next);
		}
		setChromeDraggingKey(null);
		setChromeDragOverKey(null);
	};

	// Move/hide operate relative to the *visible* buttons, so a move never swaps a
	// button with a hidden one (matching the section move behaviour).
	const visibleChromeOrder = chromeOrder.filter(
		(k) =>
			!hiddenChrome.has(k) &&
			(computeShareEnabled || !COMPUTE_SHARE_CHROME.has(k))
	);

	const canMoveChrome = (key: ChromeKey, dir: "up" | "down") => {
		const idx = visibleChromeOrder.indexOf(key);
		if (idx === -1) {
			return false;
		}
		return dir === "up" ? idx > 0 : idx < visibleChromeOrder.length - 1;
	};

	const handleMoveChrome = (key: ChromeKey, dir: "up" | "down") => {
		const idx = visibleChromeOrder.indexOf(key);
		const neighbor =
			dir === "up" ? visibleChromeOrder[idx - 1] : visibleChromeOrder[idx + 1];
		if (!neighbor) {
			return;
		}
		const next = chromeOrder.filter((k) => k !== key);
		const neighborIdx = next.indexOf(neighbor);
		next.splice(dir === "up" ? neighborIdx : neighborIdx + 1, 0, key);
		reorderChrome(next);
	};

	const chromeMenu: ChromeMenu = {
		canMove: canMoveChrome,
		onMove: handleMoveChrome,
		onHide: (key) => setChromeHidden(key, true),
	};

	const chromeDnd: ChromeDnd = {
		draggingKey: chromeDraggingKey,
		dragOverKey: chromeDragOverKey,
		order: chromeOrder,
		onDragStart: setChromeDraggingKey,
		onDragEnd: () => {
			setChromeDraggingKey(null);
			setChromeDragOverKey(null);
		},
		onDragOver: (key) =>
			setChromeDragOverKey((prev) => (prev === key ? prev : key)),
		// Drop on the resolved target, not the (shifted) button under the pointer.
		onDrop: (key) => handleDropChrome(chromeDragOverKey ?? key),
		shift: chromeShift,
	};

	return {
		chromeDnd,
		chromeMenu,
		effectiveChromeOrder,
		hiddenChrome,
		renderChromeOrder,
		reorderChrome,
		setChromeHidden,
		setChromeItemsHidden,
		setHiddenChrome,
	};
}
