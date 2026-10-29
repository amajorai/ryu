// Ambient types for the noVNC RFB client (`@novnc/novnc` ships core/rfb.js as ESM
// with no bundled declarations). Only the surface the shared VNC viewer uses is
// declared; keep this minimal so an upstream typings release can replace it whole.

declare module "@novnc/novnc" {
	/** Event detail noVNC attaches to `disconnect`, `securityfailure` and friends. */
	export interface RfbEventDetail {
		clean?: boolean;
		message?: string;
		reason?: string;
		status?: number;
	}

	/** noVNC RFB client: connects a WebSocket (RFB-over-WS) to a VNC server and
	 *  renders into its own screen `<div>` and `<canvas>`, which it appends inside
	 *  `target` (a container element, never a canvas), forwarding mouse/keyboard
	 *  events back. */
	export default class RFB {
		constructor(
			target: HTMLElement,
			url: string,
			options?: {
				credentials?: Record<string, string>;
				shared?: boolean;
				/** WebSocket subprotocols offered on the upgrade. */
				wsProtocols?: string[];
			}
		);

		/** Scale the remote framebuffer to the canvas size. */
		scaleViewport: boolean;
		/** Resize the remote session to the canvas size. */
		resizeSession: boolean;
		/** Ignore local keyboard and mouse input. */
		viewOnly: boolean;

		addEventListener(
			type: string,
			listener: (event: CustomEvent<RfbEventDetail>) => void
		): void;
		removeEventListener(
			type: string,
			listener: (event: CustomEvent<RfbEventDetail>) => void
		): void;

		disconnect(): void;
	}
}
