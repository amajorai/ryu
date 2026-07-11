// Mount helper for a Ryu widget (spec §1.3, D2). A widget's `index.tsx` calls
// `mountWidget(<Component />)`; this installs the bridge + openai shim, then renders
// the component tree inside `WidgetRoot`, which wires the two host-facing behaviours
// every widget wants for free:
//   - reactive theme: mirrors `window.ryu.theme` onto `data-theme` on the root so
//     `tokens.css` resolves light/dark without the widget doing anything.
//   - intrinsic height: a ResizeObserver reports the content height back to the host
//     (`ui.notifyHeight`) so the iframe sizes to fit (capped host-side by maxHeight).

import { type ReactNode, StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { installRyuBridge } from "./bridge";
import { installOpenAiShim } from "./compat/openai-shim";
import { useRyuGlobal } from "./useRyuGlobal";

/** The container id the built HTML template provides. */
const WIDGET_ROOT_ID = "ryu-root";

/** Props for {@link WidgetRoot}. */
export interface WidgetRootProps {
	children: ReactNode;
	/** Report intrinsic content height to the host on resize. Default `true`. */
	autoHeight?: boolean;
}

/**
 * The wiring shell every mounted widget is wrapped in. Bridges `window.ryu` to the
 * React tree: applies the host theme to `data-theme` and reports intrinsic height.
 */
export function WidgetRoot({ children, autoHeight = true }: WidgetRootProps) {
	const theme = useRyuGlobal("theme");
	const contentRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const root = document.documentElement;
		root.dataset.theme = theme === "light" ? "light" : "dark";
	}, [theme]);

	useEffect(() => {
		const el = contentRef.current;
		if (!(autoHeight && el) || typeof ResizeObserver === "undefined") {
			return;
		}
		const report = () => {
			window.ryu?.notifyIntrinsicHeight(Math.ceil(el.scrollHeight));
		};
		const observer = new ResizeObserver(report);
		observer.observe(el);
		report();
		return () => observer.disconnect();
	}, [autoHeight]);

	return (
		<div className="ryu-widget-root" ref={contentRef}>
			{children}
		</div>
	);
}

/** Options for {@link mountWidget}. */
export interface MountWidgetOptions {
	/** Override the container element id (defaults to `ryu-root`). */
	rootId?: string;
	/** Wrap in `<StrictMode>`. Default `true`. */
	strict?: boolean;
	/** Report intrinsic height to the host. Default `true`. */
	autoHeight?: boolean;
}

/**
 * Boot a widget: install the bridge + compat shim, then render `children` into the
 * document's widget-root container.
 *
 * @example
 *   // src/apps/checklist/index.tsx
 *   import { mountWidget } from "../../shared/host";
 *   import { Checklist } from "./Checklist";
 *   mountWidget(<Checklist />);
 */
export function mountWidget(
	children: ReactNode,
	options: MountWidgetOptions = {},
): void {
	const { rootId = WIDGET_ROOT_ID, strict = true, autoHeight = true } = options;

	// Install the bridge (idempotent) and alias window.openai before first render so
	// components reading globals at module top-level or first paint see them.
	installRyuBridge();
	installOpenAiShim();

	let container = document.getElementById(rootId);
	if (!container) {
		container = document.createElement("div");
		container.id = rootId;
		document.body.appendChild(container);
	}

	const tree = <WidgetRoot autoHeight={autoHeight}>{children}</WidgetRoot>;
	createRoot(container).render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}
