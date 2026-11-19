// packages/client/src/box-desktop.ts
//
// The Box desktop and browser verbs of the standalone Box service
// (`apps/box`): canonical `computer.*` desktop actions, the `browser.*` verbs
// served by the Box's own Chromium, and the credential-fill flow
// (prepare, commit, status, cancel). It talks to the service directly with a
// tenant API key, like `BoxAPI` in `./box.ts`, and is a separate class so
// `BoxAPI` (and the `ryu.box` services namespace built from it) keeps its
// surface. A Box must have been created with `desktop: true`.

import { z } from "zod";
import type { BoxClientOptions } from "./box.ts";
import { assertSafeRequestPath, encodePathId } from "./path-id.ts";
import { wireJsonRecordSchema, wireJsonSchema } from "./wire-json.ts";

/** The canonical `computer.*` actions a Box desktop performs. */
export type BoxDesktopAction =
	| { action: "screenshot"; maxWidth?: number }
	| {
			action: "click";
			button?: "left" | "right" | "middle";
			count?: 1 | 2 | 3;
			x: number;
			y: number;
	  }
	| { action: "type"; text: string }
	| { action: "key"; keys: string[] }
	| {
			action: "scroll";
			amount?: number;
			direction: "up" | "down" | "left" | "right";
			x?: number;
			y?: number;
	  }
	| { action: "focus_app"; app: string };

/** `{action: "screenshot"}`: a base64 image; `width`/`height` are the image's size. */
export interface BoxDesktopScreenshot {
	action: "screenshot";
	encoding: "base64";
	height: number;
	image: string;
	mime: "image/png" | "image/jpeg";
	ok: true;
	screenHeight: number;
	screenWidth: number;
	type: "desktop.action";
	width: number;
}

/** The result of a desktop action other than a screenshot. */
export interface BoxDesktopActionDone {
	action: Exclude<BoxDesktopAction["action"], "screenshot">;
	ok: true;
	type: "desktop.action";
}

export type BoxDesktopActionResult =
	| BoxDesktopScreenshot
	| BoxDesktopActionDone;

/** The browser verbs the Box service serves (`POST /v1/boxes/:id/browser/:verb`). */
export const BOX_BROWSER_VERBS = [
	"tabs",
	"navigate",
	"navigate_tab",
	"close_tab",
	"snapshot",
	"screenshot",
	"click",
	"type",
	"scroll",
	"hover",
	"click_at",
	"key",
	"drag",
	"context",
	"annotate",
	"clear_annotations",
] as const;

export type BoxBrowserVerb = (typeof BOX_BROWSER_VERBS)[number];

/** A browser verb's arguments: the `ryu-browser` body for that verb. */
export type BoxBrowserArgs = z.infer<typeof wireJsonRecordSchema>;

/** A browser verb's result, as the Box browser returns it. */
export type BoxBrowserResult = z.infer<typeof wireJsonRecordSchema>;

/** The field a credential fill types into. */
export type BoxBrowserFillField = "username" | "email" | "password" | "totp";

/** `POST /v1/boxes/:id/browser-fills`: checks and remembers a fill target. */
export interface BoxBrowserFillTarget {
	/** Hosts the filled value may be sent to (exact DNS names). */
	bindHosts: string[];
	field: BoxBrowserFillField;
	/** Hosts the page with the field may be on (exact DNS names). */
	pageHosts: string[];
	/** An element reference from a browser snapshot, such as `@e3`. */
	ref: string;
	/** Known login URLs on a bound host, checked before any value is read. */
	submitUrls?: string[];
	tabId?: string;
}

/**
 * The value to fill. `placeholder` types a placeholder the Box's egress
 * proxy swaps for `value` only on requests to the bound hosts; `text` types
 * `value` as is (one line, for a non-secret field).
 */
export type BoxBrowserFillCommit =
	| {
			mode: "placeholder";
			submit?: boolean;
			submitUrls?: string[];
			ttlSeconds?: number;
			unbound: boolean;
			value: string;
	  }
	| { mode: "text"; submit?: boolean; value: string };

const preparedSchema = z.looseObject({
	fillId: z.string(),
	ok: z.literal(true),
	pageUrl: z.string(),
	tab: wireJsonSchema.optional(),
	type: z.literal("browser.fill.prepared"),
});

const committedSchema = z.looseObject({
	fillId: z.string(),
	ok: z.literal(true),
	type: z.literal("browser.fill.committed"),
});

const statusSchema = z.looseObject({
	fillId: z.string(),
	ok: z.literal(true),
	state: z.string(),
	type: z.literal("browser.fill"),
});

const actionSchema = z.looseObject({
	action: z.string(),
	ok: z.literal(true),
	type: z.literal("desktop.action"),
});

export type BoxBrowserFillPrepared = z.infer<typeof preparedSchema>;
export type BoxBrowserFillCommitted = z.infer<typeof committedSchema>;
export type BoxBrowserFillStatus = z.infer<typeof statusSchema>;

const TRAILING_SLASHES = /\/+$/u;

function pathId(value: string): string {
	return encodePathId("Box", value);
}

export function isBoxBrowserVerb(value: string): value is BoxBrowserVerb {
	return BOX_BROWSER_VERBS.some((verb) => verb === value);
}

export class BoxDesktopAPI {
	private readonly options: BoxClientOptions;

	constructor(options: BoxClientOptions) {
		this.options = options;
	}

	/** Performs one desktop action (screenshot, click, type, key, scroll, focus an app). */
	async action(
		boxId: string,
		action: BoxDesktopAction
	): Promise<BoxDesktopActionResult> {
		const result = actionSchema.parse(
			await this.json("POST", `${this.box(boxId)}/desktop/actions`, action)
		);
		// The service validates the shape per action; the union is its contract.
		return result as BoxDesktopActionResult;
	}

	/** Captures the desktop, scaled down to `maxWidth` when given. */
	async screenshot(
		boxId: string,
		maxWidth?: number
	): Promise<BoxDesktopScreenshot> {
		const result = await this.action(
			boxId,
			maxWidth === undefined
				? { action: "screenshot" }
				: { action: "screenshot", maxWidth }
		);
		if (result.action !== "screenshot") {
			throw new Error(
				"Ryu Box: the screenshot action returned another result."
			);
		}
		return result;
	}

	/** Runs one `browser.*` verb in the Box's browser. */
	async browser(
		boxId: string,
		verb: BoxBrowserVerb,
		args: BoxBrowserArgs = {}
	): Promise<BoxBrowserResult> {
		if (!isBoxBrowserVerb(verb)) {
			throw new Error(`Ryu Box: unknown browser verb '${String(verb)}'.`);
		}
		return wireJsonRecordSchema.parse(
			await this.json("POST", `${this.box(boxId)}/browser/${verb}`, args)
		);
	}

	/** Checks a credential-fill target and returns its `fillId`. */
	async prepareFill(
		boxId: string,
		target: BoxBrowserFillTarget
	): Promise<BoxBrowserFillPrepared> {
		return preparedSchema.parse(
			await this.json("POST", `${this.box(boxId)}/browser-fills`, target)
		);
	}

	/** Fills a prepared target once. The value is sent in the body only. */
	async commitFill(
		boxId: string,
		fillId: string,
		commit: BoxBrowserFillCommit
	): Promise<BoxBrowserFillCommitted> {
		return committedSchema.parse(
			await this.json("POST", this.fill(boxId, fillId), commit)
		);
	}

	/** A fill's state (pending, committed, consumed, expired, ...). */
	async fillStatus(
		boxId: string,
		fillId: string
	): Promise<BoxBrowserFillStatus> {
		return statusSchema.parse(await this.json("GET", this.fill(boxId, fillId)));
	}

	/** Cancels a fill and its placeholder. */
	async cancelFill(boxId: string, fillId: string): Promise<void> {
		await this.json("DELETE", this.fill(boxId, fillId));
	}

	private box(boxId: string): string {
		return `/v1/boxes/${pathId(boxId)}`;
	}

	private fill(boxId: string, fillId: string): string {
		return `${this.box(boxId)}/browser-fills/${pathId(fillId)}`;
	}

	private async json(
		method: string,
		path: string,
		body?:
			| BoxDesktopAction
			| BoxBrowserArgs
			| BoxBrowserFillTarget
			| BoxBrowserFillCommit
	): Promise<z.infer<typeof wireJsonSchema> | undefined> {
		assertSafeRequestPath("Box", path);
		const base = this.options.baseUrl.replace(TRAILING_SLASHES, "");
		const fetchImpl = this.options.fetch ?? globalThis.fetch;
		const response = await fetchImpl(`${base}${path}`, {
			body: body === undefined ? null : JSON.stringify(body),
			headers: {
				Authorization: `Bearer ${this.options.apiKey}`,
				"Content-Type": "application/json",
			},
			method,
			signal: null,
		});
		const text = await response.text().catch(() => response.statusText);
		if (!response.ok) {
			// A fill commit body holds the value; only the service's reply is quoted.
			throw new Error(
				`Ryu Box: ${method} ${path} failed (${response.status}): ${text}`
			);
		}
		return text ? wireJsonSchema.parse(JSON.parse(text)) : undefined;
	}
}

export function createBoxDesktopClient(
	options: BoxClientOptions
): BoxDesktopAPI {
	return new BoxDesktopAPI(options);
}
