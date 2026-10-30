import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import {
	HUB_IDLE_MS,
	type HubKeyAction,
	hubKeyAction,
	isHubTypingTarget,
} from "./hub-model.ts";
import { isInterfaceCovered } from "./interface-keys.ts";

/** Automation and reduced motion keep the cards up until someone leaves. */
function idleTimeoutEnabled(reduceMotion: boolean | null): boolean {
	if (reduceMotion) {
		return false;
	}
	return !(typeof navigator !== "undefined" && navigator.webdriver);
}

/** Document keys drive the Hub unless something covers it or the sheet keeps them. */
export function useHubKeys({
	activityRef,
	rootRef,
	runActionRef,
	sheetRef,
}: {
	activityRef: RefObject<number>;
	rootRef: RefObject<HTMLDivElement | null>;
	runActionRef: RefObject<
		(action: HubKeyAction, target: EventTarget | null) => boolean
	>;
	sheetRef: RefObject<HTMLElement | null>;
}) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			activityRef.current = Date.now();
			if (event.defaultPrevented || event.isComposing) {
				return;
			}
			const action = hubKeyAction(event);
			if (!action || isHubTypingTarget(event.target)) {
				return;
			}
			const target = event.target;
			// Inside the sheet the host's conversation keeps its keys; only
			// Escape (when the host has not used it) goes back to the cards.
			if (
				target instanceof Node &&
				sheetRef.current?.contains(target) &&
				action !== "close"
			) {
				return;
			}
			const onPage =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && rootRef.current?.contains(target) === true);
			if (!onPage) {
				return;
			}
			// Enter and Space keep activating focused buttons once awake.
			if (
				action === "wake" &&
				target instanceof Element &&
				target.closest("button, a, [role='radio']")
			) {
				return;
			}
			if (runActionRef.current(action, target)) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);
}

/** Focus moves into the thread sheet on open and back to its opener on close. */
export function useHubFocusReturn({
	isOpen,
	rootRef,
	sheetRef,
}: {
	isOpen: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
	sheetRef: RefObject<HTMLElement | null>;
}) {
	/** The last control focused outside the sheet: where focus returns. */
	const returnFocusRef = useRef<HTMLElement | null>(null);

	// Remember the last control focused outside the sheet, so closing the
	// sheet returns focus to the row (or field) that opened it.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				target !== root &&
				!sheetRef.current?.contains(target)
			) {
				returnFocusRef.current = target;
			}
		};
		root.addEventListener("focusin", onFocusIn);
		return () => root.removeEventListener("focusin", onFocusIn);
	}, []);

	// The sheet is modal: focus moves into it on open and back out on close.
	const wasOpenRef = useRef(isOpen);
	useLayoutEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = isOpen;
		if (isOpen) {
			// The dialog itself takes focus (no ring on the back control until
			// someone tabs to it); Escape and Tab work from there.
			sheetRef.current?.focus({ preventScroll: true });
			return;
		}
		if (!wasOpen) {
			return;
		}
		const previous = returnFocusRef.current;
		if (previous?.isConnected && !previous.closest("[inert]")) {
			previous.focus({ preventScroll: true });
		} else {
			rootRef.current?.focus({ preventScroll: true });
		}
	}, [isOpen]);
}

/** Dims the cards back to the ambient screen after a quiet spell. */
export function useHubIdle({
	activityRef,
	awake,
	fieldRef,
	isOpen,
	reduceMotion,
	setAwake,
}: {
	activityRef: RefObject<number>;
	awake: boolean;
	fieldRef: RefObject<HTMLTextAreaElement | null>;
	isOpen: boolean;
	reduceMotion: boolean;
	setAwake: Dispatch<SetStateAction<boolean>>;
}) {
	// Dim back to the ambient screen after a quiet spell, like the reference.
	useEffect(() => {
		if (!(awake && !isOpen && idleTimeoutEnabled(reduceMotion))) {
			return;
		}
		activityRef.current = Date.now();
		const timer = setInterval(() => {
			const field = fieldRef.current;
			const composing =
				field !== null &&
				(document.activeElement === field || field.value.trim() !== "");
			if (composing || document.visibilityState === "hidden") {
				activityRef.current = Date.now();
				return;
			}
			if (Date.now() - activityRef.current >= HUB_IDLE_MS) {
				setAwake(false);
			}
		}, 5000);
		return () => clearInterval(timer);
	}, [awake, isOpen, reduceMotion]);
}
