// Reader for Core's plugin CONTRIBUTIONS feed, projected to the one family the
// terminal renders: declarative `views`.
//
//   - data: GET /api/plugins/contributions -> json.views (each entry tagged with its
//     owning `plugin` id by Core). The TUI set `X-Ryu-Surface: cli` at entry
//     (src/index.tsx), so Core has ALREADY filtered the feed to plugins that target
//     this surface — nothing here re-filters and nothing here knows an app id.
//
// The wire shape is snake_case-free (the Rust `ViewContribution` declares no
// renames), so the projection is mostly a type-narrowing pass: drop entries without
// a string `id`/`view`, keep `spec` opaque, remember the owning plugin. A malformed
// entry is skipped rather than thrown on — one bad manifest must not blank the feed.
//
// ── HOW A CONTRIBUTED VIEW REACHES A SCREEN ─────────────────────────────────
// Two routes, both data-driven:
//   1. Every contributed view is navigable at `/plugin-view/<plugin>/<viewId>`
//      ({@link pluginViewPath}) — the generic surface, mirroring the desktop's
//      `PluginViewPage` route mint. Nothing needs to know the app exists.
//   2. A view whose id is the reserved token `surface:<id>` CLAIMS the built-in
//      surface with that id ({@link viewClaimingSurface}): the shell renders the
//      contributed view at `/calendar` instead of its own hand-written screen. The
//      view id is the claim token — the "stable id, route/anchor key" the Rust
//      contract documents — so an app takes over a screen by declaring it, never by
//      the shell naming the app. Until an app claims it, the built-in keeps
//      rendering.
//
//      The `surface:` prefix is load-bearing, not decoration. A view id is only
//      unique PER PLUGIN, and the built-in surface ids are common words (tasks,
//      calendar, monitors…), so matching a bare id would let any third-party app
//      that happens to name a view `"tasks"` silently hijack the built-in Tasks
//      screen. The namespaced token has to be typed on purpose.

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "@ryuhq/core-client/client";
import { z } from "zod";
import type { RawViewSpec } from "./views.ts";
import {
	isKnownViewKind,
	rawViewSpecSchema,
	validateView,
	viewSpecSchema,
} from "./views.ts";

/** One plugin-contributed declarative view, tagged with its owning plugin id.
 *  Mirrors Core's `ViewContribution` plus the `plugin` field the contributions
 *  endpoint injects. `spec` is opaque to Core; the renderer interprets it. */
export interface ContributedView {
	id: string;
	/** Owning plugin id (e.g. `com.acme.tracker`). Empty when Core did not tag it. */
	plugin: string;
	spec?: RawViewSpec;
	title?: string;
	/** The vocabulary member this view renders as. Kept as a plain string: Core
	 *  passes unknown kinds through, and the renderer degrades readably. */
	view: string;
}

/** A slash command advertised by an enabled plugin or imported user prompt. */
export interface ContributedSlashCommand {
	args: SlashCommandArgument[];
	body?: string;
	description: string;
	hint?: string;
	name: string;
	plugin: string;
}

export interface SlashCommandOption {
	description?: string;
	label: string;
	value: string;
}

export interface SlashCommandCustomOption {
	description?: string;
	label: string;
}

export interface SlashCommandArgument {
	custom?: SlashCommandCustomOption;
	description?: string;
	name: string;
	options: SlashCommandOption[];
}

export interface AgentSlashCommand {
	description: string;
	hint?: string;
	name: string;
}

export interface ContributedContent {
	commands: ContributedSlashCommand[];
	views: ContributedView[];
}

const nonEmptyTextSchema = z.string().trim().min(1);
const viewWireSchema = z.object({
	id: z.string().min(1),
	plugin: z.string().catch(""),
	spec: z.json().optional().catch(undefined),
	title: z.string().optional().catch(undefined),
	view: z.string().optional().catch(undefined),
});
const commandWireSchema = z.object({
	command: z.string(),
	args: z.unknown().optional(),
	parameters: z.unknown().optional(),
	body: z.string().optional().catch(undefined),
	description: z.string().catch(""),
	hint: z.string().optional().catch(undefined),
	plugin: z.string().catch(""),
});
const contributionsSchema = z.object({
	views: z
		.array(viewWireSchema.nullable().catch(null))
		.optional()
		.catch(undefined),
	slash_commands: z
		.array(commandWireSchema.nullable().catch(null))
		.optional()
		.catch(undefined),
});
const commandArgumentSchema = z.object({
	name: z.unknown().optional(),
	label: z.unknown().optional(),
	id: z.unknown().optional(),
	options: z.unknown().optional(),
	choices: z.unknown().optional(),
	values: z.unknown().optional(),
	custom: z.unknown().optional(),
	allow_custom: z.unknown().optional(),
	allowCustom: z.unknown().optional(),
	description: z.unknown().optional(),
});
const commandArgumentsSchema = z.array(
	commandArgumentSchema.nullable().catch(null)
);
const commandOptionSchema = z.object({
	value: z.unknown().optional(),
	id: z.unknown().optional(),
	name: z.unknown().optional(),
	label: z.unknown().optional(),
	description: z.unknown().optional(),
});
const commandOptionsSchema = z.array(z.unknown());
const customOptionSchema = z.object({
	label: z.unknown().optional(),
	description: z.unknown().optional(),
});
const customFlagSchema = z.union([z.literal(true), z.literal("true")]);
const acpCommandsSchema = z.object({
	commands: z.array(
		z
			.object({
				name: z.unknown().optional(),
				description: z.unknown().optional(),
				hint: z.unknown().optional(),
			})
			.nullable()
			.catch(null)
	),
});

function nonEmptyString(
	value: Parameters<typeof nonEmptyTextSchema.safeParse>[0]
): string | null {
	const parsed = nonEmptyTextSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** Keep the route envelope for a known malformed spec; its renderer degrades readably. */
function toContributedView(
	wire: z.infer<typeof viewWireSchema>
): ContributedView | null {
	const parsedSpec = rawViewSpecSchema.safeParse(wire.spec);
	const spec =
		parsedSpec.success && isKnownViewKind(parsedSpec.data.view)
			? parsedSpec.data
			: undefined;
	const kind = wire.view ?? spec?.view;
	if (!kind) {
		return null;
	}
	return {
		id: wire.id,
		plugin: wire.plugin,
		title: wire.title,
		view: kind,
		spec,
	};
}

function toContributedSlashCommand(
	wire: z.infer<typeof commandWireSchema>
): ContributedSlashCommand | null {
	const name = wire.command.trim().replace(/^\//, "");
	if (!/^[\w-]+$/.test(name)) {
		return null;
	}
	const body = wire.body?.trim() ? wire.body : undefined;
	const plugin = wire.plugin.trim();
	if (!(plugin || body)) {
		return null;
	}
	const command: ContributedSlashCommand = {
		args: readCommandArguments(wire.args ?? wire.parameters),
		description: wire.description.trim(),
		name,
		plugin,
	};
	if (body) {
		command.body = body;
	}
	const hint = wire.hint?.trim();
	if (hint) {
		command.hint = hint;
	}
	return command;
}

/** ACP updates replace the complete advertised command set; malformed events do not clear it. */
export function acpSlashCommandsFromData(
	value: Parameters<typeof acpCommandsSchema.safeParse>[0]
): AgentSlashCommand[] | null {
	const parsed = acpCommandsSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data.commands.flatMap((entry) => {
		if (entry === null) {
			return [];
		}
		const name = nonEmptyString(entry.name)?.replace(/^\/+/, "");
		if (!(name && /^[\w-]+$/.test(name))) {
			return [];
		}
		const command: AgentSlashCommand = {
			description: nonEmptyString(entry.description) ?? "",
			name,
		};
		const hint = nonEmptyString(entry.hint);
		if (hint) {
			command.hint = hint;
		}
		return [command];
	});
}

function readCommandOption(
	value: Parameters<typeof commandOptionSchema.safeParse>[0]
): SlashCommandOption | null {
	const text = nonEmptyString(value);
	if (text) {
		return { label: text, value: text };
	}
	const parsed = commandOptionSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const raw = parsed.data;
	const optionValue = nonEmptyString(raw.value ?? raw.id ?? raw.name);
	if (!optionValue) {
		return null;
	}
	const option: SlashCommandOption = {
		label: nonEmptyString(raw.label ?? raw.name ?? raw.value) ?? optionValue,
		value: optionValue,
	};
	const description = nonEmptyString(raw.description);
	if (description) {
		option.description = description;
	}
	return option;
}

function readCustomOption(
	value: Parameters<typeof customOptionSchema.safeParse>[0]
): SlashCommandCustomOption | undefined {
	if (customFlagSchema.safeParse(value).success) {
		return {
			description: "Type a value that is not in the registered options.",
			label: "Use a custom value",
		};
	}
	const parsed = customOptionSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	return {
		description:
			nonEmptyString(parsed.data.description) ??
			"Type a value that is not in the registered options.",
		label: nonEmptyString(parsed.data.label) ?? "Use a custom value",
	};
}

function readCommandArguments(
	value: Parameters<typeof commandArgumentsSchema.safeParse>[0]
): SlashCommandArgument[] {
	const parsed = commandArgumentsSchema.safeParse(value);
	if (!parsed.success) {
		return [];
	}
	return parsed.data.flatMap((argument, index) => {
		if (argument === null) {
			return [];
		}
		const rawOptions = commandOptionsSchema.safeParse(
			argument.options ?? argument.choices ?? argument.values
		);
		const result: SlashCommandArgument = {
			name:
				nonEmptyString(argument.name ?? argument.label ?? argument.id) ??
				`Argument ${index + 1}`,
			options: rawOptions.success
				? rawOptions.data.flatMap((value) => {
						const option = readCommandOption(value);
						return option ? [option] : [];
					})
				: [],
		};
		const custom = readCustomOption(
			argument.custom ?? argument.allow_custom ?? argument.allowCustom
		);
		if (custom) {
			result.custom = custom;
		}
		const description = nonEmptyString(argument.description);
		if (description) {
			result.description = description;
		}
		return [result];
	});
}

/** Parse raw Core response rows individually so one malformed plugin does not blank the feed. */
export function contributedViewsFromResponse(
	payload: Parameters<typeof contributionsSchema.safeParse>[0]
): ContributedView[] {
	const parsed = contributionsSchema.safeParse(payload);
	if (!parsed.success) {
		return [];
	}
	return (parsed.data.views ?? []).flatMap((entry) => {
		if (entry === null) {
			return [];
		}
		const view = toContributedView(entry);
		return view ? [view] : [];
	});
}

export function contributedSlashCommandsFromResponse(
	payload: Parameters<typeof contributionsSchema.safeParse>[0]
): ContributedSlashCommand[] {
	const parsed = contributionsSchema.safeParse(payload);
	if (!parsed.success) {
		return [];
	}
	return (parsed.data.slash_commands ?? []).flatMap((entry) => {
		if (entry === null) {
			return [];
		}
		const command = toContributedSlashCommand(entry);
		return command ? [command] : [];
	});
}

export function contributedContentFromResponse(
	payload: Parameters<typeof contributionsSchema.safeParse>[0]
): ContributedContent {
	return {
		commands: contributedSlashCommandsFromResponse(payload),
		views: contributedViewsFromResponse(payload),
	};
}

/** GET /api/plugins/contributions -> the enabled plugins' declarative views.
 *  Core-client has no typed reader for this endpoint, so it is fetched with the
 *  shared HTTP primitives (parity with the `/api/catalog` read in src/tabs/apps.tsx).
 *  Throws on a non-2xx so the caller can decide whether to surface it — the
 *  contributions context treats any failure as "no contributions". */
export async function fetchContributedViews(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<ContributedView[]> {
	return (await fetchContributedContent(target, signal)).views;
}

/** Fetch the enabled, CLI-targeted plugin contributions from Core once. */
export async function fetchContributedContent(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<ContributedContent> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/plugins/contributions"),
		{
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/plugins/contributions failed: ${resp.status}`);
	}
	return contributedContentFromResponse(await resp.json());
}

/** The route a contributed view is navigable at. Both segments are encoded so an
 *  exotic id round-trips (mirrors the desktop `pluginViewPath`). */
export function pluginViewPath(pluginId: string, viewId: string): string {
	return `/plugin-view/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`;
}

/** The `{plugin, view}` ids encoded in a `/plugin-view/...` path, or null when the
 *  path is not one (or is missing a segment). */
export function parsePluginViewPath(
	path: string
): { plugin: string; view: string } | null {
	const segments = path.split("/").filter((segment) => segment.length > 0);
	if (segments[0] !== "plugin-view" || segments.length < 3) {
		return null;
	}
	return {
		plugin: decodeURIComponent(segments[1] ?? ""),
		view: decodeURIComponent(segments[2] ?? ""),
	};
}

/** The reserved view id an app declares to take over the built-in surface
 *  `surfaceId` — e.g. `surfaceClaimToken("calendar") === "surface:calendar"`. */
export function surfaceClaimToken(surfaceId: string): string {
	return `surface:${surfaceId}`;
}

/** The contributed view that CLAIMS a built-in surface, or undefined when none
 *  does — the seam that lets an app retire a hand-written screen. A view with
 *  `id: "surface:calendar"` takes over the surface registered as `calendar` (see
 *  the header for why the token is namespaced). Feed order breaks a tie between two
 *  claimants, which is the plugin load order Core serves.
 *
 *  A claim only counts when the spec actually DRAWS: it must be present (a
 *  title-only manifest entry must not blank a working screen) and structurally
 *  valid (`validateView` — a `list-detail` with no `items` renders the renderer's
 *  "unsupported view" line, and swapping a screen full of real data for that line
 *  is a worse outcome than simply not handing the screen over). Losing the claim
 *  leaves the built-in surface rendering exactly as it did before the app existed. */
export function viewClaimingSurface(
	views: readonly ContributedView[],
	surfaceId: string
): ContributedView | undefined {
	const token = surfaceClaimToken(surfaceId);
	return views.find(
		(view) =>
			view.id === token &&
			validateView(view.spec).ok &&
			viewSpecSchema.safeParse(view.spec).success
	);
}
