import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";

/**
 * Who can do what on ONE resource.
 *
 * The node already answers "may this role do X anywhere in the org" from the
 * caller's role. This panel edits the EXCEPTIONS to that answer — the Discord
 * model, where a channel can allow or deny a permission for a specific role,
 * team, or person regardless of what their role says globally.
 *
 * Every permission shown is one the node declared: the built-in keys plus
 * whatever the installed apps published. Nothing here is hardcoded, so an app
 * that ships a new level appears without a desktop release.
 *
 * ## Three things this panel refuses to leave invisible
 *
 * 1. WHO a rule applies to is chosen from the node's own directory, never typed.
 *    A mistyped id is not an error anywhere — it saves cleanly and matches
 *    nobody, so the rule looks set and grants nothing. The one case where a text
 *    box is still the honest answer is a node with no directory to offer (see
 *    {@link TargetPicker}).
 * 2. WHERE a permission came from. Every installed app may publish levels, so a
 *    flat list becomes unreadable at a few dozen apps; rows are grouped by their
 *    source and all but the built-ins start collapsed.
 * 3. What a permission DRAGS WITH IT. Core expands the implication graph before
 *    it walks the tiers, so allowing `edit` really does allow `view`, and denying
 *    `view` really does deny `edit`. Both are stated on the row.
 */

type TargetType = "org" | "team" | "role" | "member";

interface Overwrite {
	allow: string[];
	deny: string[];
	target_id: string;
	target_type: TargetType;
}

interface DeclaredLevel {
	description: string;
	id: string;
	implies: string[];
	label: string;
	plugin_id: string;
}

interface Vocabulary {
	collisions: string[];
	declared: DeclaredLevel[];
	kernel: string[];
}

/**
 * The node's org directory — everything a rule can be pointed at.
 *
 * A member carries no email when the org never had one for them, so the email is
 * a subtitle here and never the thing a row is identified by.
 */
interface PrincipalDirectory {
	kinds?: string[];
	members: { email: string | null; id: string; name: string }[];
	/**
	 * The org an `org`-tier overwrite must name. Null on an unbound (personal)
	 * node, where there is no org and that tier is meaningless.
	 */
	org_id?: string | null;
	roles: { id: string; label: string }[];
	teams: { id: string; name: string }[];
}

/** One selectable target, already reduced to what the picker renders. */
interface Choice {
	hint?: string;
	id: string;
	label: string;
}

/** One permission as it appears on a row, with its knock-on effects resolved. */
interface PermissionInfo {
	alsoAllows: string[];
	alsoDenies: string[];
	description: string;
	id: string;
	label: string;
}

/** Permissions from one source — an app, or the node itself. */
interface PermissionGroup {
	key: string;
	permissions: PermissionInfo[];
	title: string;
}

/** Tri-state for one permission on one target. */
type Setting = "allow" | "deny" | "inherit";

const SETTING_LABEL = {
	allow: "Allow",
	deny: "Deny",
	inherit: "Inherit",
} satisfies Record<Setting, string>;

const SETTING_ORDER = ["deny", "inherit", "allow"] as const;

function settingOf(row: Overwrite, permission: string): Setting {
	if (row.deny.includes(permission)) {
		return "deny";
	}
	if (row.allow.includes(permission)) {
		return "allow";
	}
	return "inherit";
}

/**
 * Apply a tri-state choice, keeping allow/deny mutually exclusive.
 *
 * "Inherit" removes the permission from BOTH lists rather than writing an empty
 * marker — the node treats absence as "fall through to the role", so an explicit
 * neutral entry would be a rule that looks set but does nothing.
 */
function withSetting(
	row: Overwrite,
	permission: string,
	setting: Setting
): Overwrite {
	const allow = row.allow.filter((p) => p !== permission);
	const deny = row.deny.filter((p) => p !== permission);
	if (setting === "allow") {
		allow.push(permission);
	}
	if (setting === "deny") {
		deny.push(permission);
	}
	return { ...row, allow, deny };
}

const TARGET_LABEL = {
	org: "Everyone in the org",
	team: "Team",
	role: "Role",
	member: "Person",
} satisfies Record<TargetType, string>;

const TARGET_PLACEHOLDER = {
	org: "",
	team: "Choose a team",
	role: "Choose a role",
	member: "Choose a person",
} satisfies Record<TargetType, string>;

const TARGET_FALLBACK_PLACEHOLDER = {
	org: "",
	team: "Team identifier",
	role: "Role identifier",
	member: "Person's identifier",
} satisfies Record<TargetType, string>;

/** What the node would have listed, for the message shown when it listed none. */
const TARGET_PLURAL = {
	org: "",
	team: "teams",
	role: "roles",
	member: "people",
} satisfies Record<TargetType, string>;

/**
 * A readable name for the app a permission came from.
 *
 * Derived from the id rather than looked up in the installed-apps list on
 * purpose: a heading is not worth a second data dependency that can fail, and an
 * app that publishes levels may not be one this desktop can name.
 */
function sourceTitle(pluginId: string): string {
	const last = pluginId.split(".").at(-1) ?? pluginId;
	const spaced = last.replace(/[-_]/g, " ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Everything reachable from `seed`, seed excluded.
 *
 * Breadth-first with a visited set, mirroring Core's own walk: the graph is
 * assembled from many manifests, so nothing guarantees it is acyclic even though
 * each manifest is validated on its own.
 */
function closureFrom(seed: string, edges: Map<string, string[]>): string[] {
	const seen = new Set<string>([seed]);
	const queue = [seed];
	for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
		for (const next of edges.get(id) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	seen.delete(seed);
	return [...seen];
}

/**
 * The permission list, grouped by source and with implications resolved.
 *
 * Two rules here come straight from the node and are not cosmetic:
 *
 * - An app that names a built-in key keeps its wording but loses its edges — the
 *   node drops them and reports the id in `collisions` — so the key is filed
 *   under the built-ins and its declared `implies` is ignored. Drawing those
 *   edges would promise an expansion the node does not perform. Core likewise
 *   drops (and reports) an app level's edges into a built-in key or another
 *   app's level, and strips them from that level's `implies` before serving it.
 * - An edge pointing at an id nothing declared is dropped, again matching Core:
 *   an unknown id must not be able to widen a known one.
 */
function buildGroups(vocabulary: Vocabulary | null): PermissionGroup[] {
	if (!vocabulary) {
		return [];
	}
	const builtIn = new Set(vocabulary.kernel);
	const byId = new Map<string, DeclaredLevel>();
	for (const level of vocabulary.declared) {
		byId.set(level.id, level);
	}
	const ids = new Set<string>([...builtIn, ...byId.keys()]);

	const allows = new Map<string, string[]>();
	const denies = new Map<string, string[]>();
	const addEdge = (edges: Map<string, string[]>, from: string, to: string) => {
		const existing = edges.get(from);
		if (existing) {
			existing.push(to);
			return;
		}
		edges.set(from, [to]);
	};
	for (const level of vocabulary.declared) {
		if (builtIn.has(level.id)) {
			continue;
		}
		for (const implied of level.implies) {
			if (!ids.has(implied)) {
				continue;
			}
			addEdge(allows, level.id, implied);
			addEdge(denies, implied, level.id);
		}
	}

	// A kernel key with no app-supplied label falls back to its own id: the id is
	// a poor label, but showing nothing would make a real permission unselectable.
	const labelOf = (id: string) => byId.get(id)?.label ?? id;
	const grouped = new Map<string, PermissionGroup>();
	for (const id of [...ids].sort()) {
		const level = byId.get(id);
		const key = level && !builtIn.has(id) ? level.plugin_id : "";
		const group = grouped.get(key) ?? {
			key,
			title: key ? sourceTitle(key) : "Built in",
			permissions: [],
		};
		group.permissions.push({
			id,
			label: labelOf(id),
			description: level?.description ?? "",
			alsoAllows: closureFrom(id, allows).map(labelOf).sort(),
			alsoDenies: closureFrom(id, denies).map(labelOf).sort(),
		});
		grouped.set(key, group);
	}

	// Built-ins first: they are the keys every node has, and the ones an admin
	// setting up a space is looking for.
	return [...grouped.values()].sort((a, b) => {
		if (a.key === b.key) {
			return 0;
		}
		if (a.key === "") {
			return -1;
		}
		if (b.key === "") {
			return 1;
		}
		return a.title.localeCompare(b.title);
	});
}

function choicesFor(
	directory: PrincipalDirectory | null,
	targetType: TargetType
): Choice[] {
	if (!directory) {
		return [];
	}
	if (targetType === "role") {
		return directory.roles.map((r) => ({ id: r.id, label: r.label || r.id }));
	}
	if (targetType === "team") {
		return directory.teams.map((t) => ({ id: t.id, label: t.name || t.id }));
	}
	if (targetType === "member") {
		return directory.members.map((m) => ({
			id: m.id,
			label: m.name || m.email || m.id,
			hint: m.email ?? undefined,
		}));
	}
	return [];
}

/**
 * Who a rule applies to.
 *
 * Falls back to a text box when the node offers no directory, and says which of
 * the two reasons it is: a personal node has no org to list, while a node that
 * failed the read may well list one on the next Refresh. Collapsing those into
 * one message would tell a laptop owner to go and fix an outage that is not
 * happening.
 */
function TargetPicker({
	row,
	choices,
	directoryFailed,
	onChange,
}: {
	choices: Choice[];
	directoryFailed: boolean;
	onChange: (targetId: string) => void;
	row: Overwrite;
}) {
	if (row.target_type === "org") {
		return null;
	}

	if (choices.length === 0) {
		return (
			<div className="flex flex-1 flex-col gap-1">
				<Input
					aria-label={`${TARGET_LABEL[row.target_type]} identifier`}
					onChange={(e) => onChange(e.target.value)}
					placeholder={TARGET_FALLBACK_PLACEHOLDER[row.target_type]}
					size="compact"
					value={row.target_id}
				/>
				<p className="text-muted-foreground text-xs">
					{directoryFailed
						? "This node did not send anything to choose from. It may be an older node, or unreachable. Type the identifier, or come back once it answers."
						: `This node listed no ${TARGET_PLURAL[row.target_type]}, which is normal on a personal node that belongs to no organisation. Type an identifier only if you know it: a wrong one saves cleanly and applies to nobody.`}
				</p>
			</div>
		);
	}

	// A rule can outlive the person it names. Keeping the stored value as its own
	// option means opening the panel shows who it points at instead of quietly
	// blanking the field and saving the rule away.
	const known = choices.some((c) => c.id === row.target_id);
	const options =
		known || row.target_id === ""
			? choices
			: [
					...choices,
					{
						id: row.target_id,
						label: row.target_id,
						hint: "No longer in this organisation",
					},
				];

	return (
		<Select
			items={options.map((c) => ({ value: c.id, label: c.label }))}
			onValueChange={(value) => onChange(isNativeText(value) ? value : "")}
			value={row.target_id}
		>
			<SelectTrigger appearance="gateway-action" className="flex-1">
				<SelectValue placeholder={TARGET_PLACEHOLDER[row.target_type]} />
			</SelectTrigger>
			<SelectContent
				searchable={row.target_type === "member"}
				searchPlaceholder="Search people…"
			>
				{options.map((choice) => (
					<SelectItem
						key={choice.id}
						textValue={`${choice.label} ${choice.hint ?? ""}`}
						value={choice.id}
					>
						<span className="flex flex-col">
							<span>{choice.label}</span>
							{choice.hint && choice.hint !== choice.label ? (
								<span className="text-muted-foreground text-xs">
									{choice.hint}
								</span>
							) : null}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function PermissionRow({
	permission,
	setting,
	onSet,
}: {
	onSet: (setting: Setting) => void;
	permission: PermissionInfo;
	setting: Setting;
}) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0">
				<p className="text-xs">{permission.label}</p>
				{permission.description ? (
					<p className="text-muted-foreground text-xs">
						{permission.description}
					</p>
				) : null}
				{/* Each line describes the setting it would produce, so only one of
				    them is ever the live consequence: offering "allowing this also
				    allows" under a row set to Deny describes a state just turned off. */}
				{setting !== "deny" && permission.alsoAllows.length > 0 ? (
					<p className="text-muted-foreground text-xs">
						Allowing this also allows: {permission.alsoAllows.join(", ")}
					</p>
				) : null}
				{setting === "deny" && permission.alsoDenies.length > 0 ? (
					<p className="text-muted-foreground text-xs">
						Denying this also denies: {permission.alsoDenies.join(", ")}
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 gap-1">
				{SETTING_ORDER.map((opt) => (
					<Button
						key={opt}
						onClick={() => onSet(opt)}
						size="sm"
						variant={setting === opt ? "default" : "ghost"}
					>
						{SETTING_LABEL[opt]}
					</Button>
				))}
			</div>
		</div>
	);
}

/**
 * One source's permissions, collapsed by default.
 *
 * `defaultOpen` is read once, at mount: a group that opens because it holds a
 * rule must not slam shut the moment the admin puts that rule back to Inherit,
 * and a group opened by hand must stay open.
 */
function PermissionGroupSection({
	group,
	row,
	defaultOpen,
	onSet,
}: {
	defaultOpen: boolean;
	group: PermissionGroup;
	onSet: (permission: string, setting: Setting) => void;
	row: Overwrite;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const setCount = group.permissions.filter(
		(p) => settingOf(row, p.id) !== "inherit"
	).length;

	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<CollapsibleTrigger
				appearance="permission-group"
				className="flex w-full items-center justify-between text-left"
			>
				<span
					className="min-w-0 truncate font-medium text-xs"
					title={group.title}
				>
					{group.title}
				</span>
				<span className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
					{setCount > 0
						? `${setCount} set`
						: `${group.permissions.length} available`}
					<HugeiconsIcon
						className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
						icon={ArrowDown01Icon}
					/>
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="flex flex-col" spacing="permission-list">
				{group.permissions.map((permission) => (
					<PermissionRow
						key={permission.id}
						onSet={(setting) => onSet(permission.id, setting)}
						permission={permission}
						setting={settingOf(row, permission.id)}
					/>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

function OverwriteCard({
	row,
	groups,
	choices,
	directoryFailed,
	onChange,
	onRemove,
}: {
	choices: Choice[];
	directoryFailed: boolean;
	groups: PermissionGroup[];
	onChange: (next: Overwrite) => void;
	onRemove: () => void;
	row: Overwrite;
}) {
	const needsTarget =
		row.target_type !== "org" && row.target_id.trim().length === 0;

	return (
		<li className="flex flex-col gap-3 rounded-md border p-3">
			<div className="flex items-start gap-2">
				<Label size="compact" spacing="permission-aligned">
					{TARGET_LABEL[row.target_type]}
				</Label>
				<TargetPicker
					choices={choices}
					directoryFailed={directoryFailed}
					onChange={(targetId) => onChange({ ...row, target_id: targetId })}
					row={row}
				/>
				<Button onClick={onRemove} size="sm" variant="ghost">
					Remove
				</Button>
			</div>

			{needsTarget ? (
				<p className="text-muted-foreground text-xs">
					Pick who this applies to. Until then these settings do nothing.
				</p>
			) : null}

			<div className="flex flex-col">
				{groups.map((group) => (
					<PermissionGroupSection
						defaultOpen={
							group.key === "" ||
							group.permissions.some((p) => settingOf(row, p.id) !== "inherit")
						}
						group={group}
						key={group.key}
						onSet={(permission, setting) =>
							onChange(withSetting(row, permission, setting))
						}
						row={row}
					/>
				))}
			</div>
		</li>
	);
}

const declaredLevelResponseCodec: z.ZodType<DeclaredLevel> = z
	.object({
		description: z.string(),
		id: z.string(),
		implies: z.array(z.string()),
		label: z.string(),
		plugin_id: z.string(),
	})
	.passthrough();
const vocabularyResponseCodec: z.ZodType<Vocabulary> = z
	.object({
		collisions: z.array(z.string()),
		declared: z.array(declaredLevelResponseCodec),
		kernel: z.array(z.string()),
	})
	.passthrough();
const overwriteResponseCodec: z.ZodType<Overwrite> = z
	.object({
		allow: z.array(z.string()),
		deny: z.array(z.string()),
		target_id: z.string(),
		target_type: z.union([
			z.literal("org"),
			z.literal("team"),
			z.literal("role"),
			z.literal("member"),
		]),
	})
	.passthrough();
const principalDirectoryResponseCodec: z.ZodType<PrincipalDirectory> = z
	.object({
		kinds: z.array(z.string()).optional(),
		members: z.array(
			z
				.object({
					email: z.union([z.string(), z.null()]),
					id: z.string(),
					name: z.string(),
				})
				.passthrough()
		),
		org_id: z.union([z.string(), z.null()]).optional(),
		roles: z.array(
			z.object({ id: z.string(), label: z.string() }).passthrough()
		),
		teams: z.array(
			z.object({ id: z.string(), name: z.string() }).passthrough()
		),
	})
	.passthrough();
export function ResourcePermissions({
	resourceKind,
	resourceId,
	resourceName,
}: {
	resourceId: string;
	resourceKind: string;
	resourceName?: string;
}) {
	const node = useActiveNode();
	const scope = useMemo(() => {
		const target: ApiTarget = {
			url: node.url,
			token: node.token,
			userJwt: node.userJwt ?? null,
		};
		return { target, resourceKind, resourceId };
	}, [node.url, node.token, node.userJwt, resourceKind, resourceId]);
	const ownerRef = useRef<{
		scope: typeof scope;
		draftRevision: number;
	} | null>(null);

	const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
	const [directory, setDirectory] = useState<PrincipalDirectory | null>(null);
	const [rows, setRows] = useState<Overwrite[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);

	useLayoutEffect(() => {
		// Each committed lifetime gets a distinct owner, including effect replay.
		// Returning to the same credentials must not revive a retired request.
		const owner = { scope, draftRevision: 0 };
		ownerRef.current = owner;
		setLoading(true);
		setLoadError(null);
		setSaving(false);
		setDirty(false);
		return () => {
			if (ownerRef.current === owner) {
				ownerRef.current = null;
			}
		};
	}, [scope]);

	const refresh = useCallback(async () => {
		const owner = ownerRef.current;
		if (!owner || owner.scope !== scope) {
			return;
		}
		const isCurrent = () => ownerRef.current === owner;
		const readRevision = owner.draftRevision;
		setLoading(true);
		try {
			const [vocab, current, principals] = await Promise.all([
				request<Vocabulary>(
					scope.target,
					"/api/acl/vocabulary",
					{},
					vocabularyResponseCodec
				),
				request<{ overwrites: Overwrite[] }>(
					scope.target,
					`/api/acl/resources/${encodeURIComponent(scope.resourceKind)}/${encodeURIComponent(scope.resourceId)}`,
					{},
					z
						.object({ overwrites: z.array(overwriteResponseCodec) })
						.passthrough()
				),
				// Caught here rather than by the surrounding try: the directory is an
				// improvement on a text box, not a precondition for editing, and an
				// older node that does not serve it must still get a working panel.
				request<PrincipalDirectory>(
					scope.target,
					"/api/acl/principals",
					{},
					principalDirectoryResponseCodec
				).catch(() => null),
			]);
			if (!isCurrent() || owner.draftRevision !== readRevision) {
				return;
			}
			setVocabulary(vocab);
			setRows(current.overwrites ?? []);
			setDirectory(principals);
			setLoadError(null);
			setDirty(false);
		} catch (error) {
			if (isCurrent() && owner.draftRevision === readRevision) {
				setLoadError(
					error instanceof Error ? error.message : "Could not load permissions"
				);
			}
		} finally {
			if (isCurrent()) {
				setLoading(false);
			}
		}
	}, [scope]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const groups = useMemo(() => buildGroups(vocabulary), [vocabulary]);

	const save = async () => {
		const owner = ownerRef.current;
		if (!owner || owner.scope !== scope) {
			return;
		}
		const isCurrent = () => ownerRef.current === owner;
		const savedRevision = owner.draftRevision;
		setSaving(true);
		try {
			// Drop rows that ended up setting nothing, so "inherit everything"
			// removes the target rather than persisting an empty rule.
			const overwrites = rows.filter(
				(r) => r.allow.length > 0 || r.deny.length > 0
			);
			await request(
				scope.target,
				`/api/acl/resources/${encodeURIComponent(scope.resourceKind)}/${encodeURIComponent(scope.resourceId)}`,
				{ method: "PUT", body: { overwrites } },
				gatewayJsonValueSchema
			);
			if (!isCurrent()) {
				return;
			}
			toast.success("Permissions saved", {
				id: `acl-save-${scope.resourceId}`,
			});
			// The acknowledged write saved its captured rows. Later edits stay
			// dirty instead of being replaced by a read of that older snapshot.
			if (owner.draftRevision === savedRevision) {
				await refresh();
			}
		} catch (error) {
			if (isCurrent()) {
				toast.error("Could not save permissions", {
					id: `acl-save-${scope.resourceId}`,
					description: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (isCurrent()) {
				setSaving(false);
			}
		}
	};

	const markDraftChanged = () => {
		const owner = ownerRef.current;
		if (!owner || owner.scope !== scope) {
			return false;
		}
		owner.draftRevision += 1;
		return true;
	};

	const addTarget = (targetType: TargetType) => {
		if (!markDraftChanged()) {
			return;
		}
		setRows((current) => [
			...current,
			{
				target_type: targetType,
				// An `org` row carries the node's org id. It used to be left empty,
				// which stored `Org("")` — a target that matches no principal, so
				// every org-wide rule the editor produced was silently dead.
				target_id: targetType === "org" ? (directory?.org_id ?? "") : "",
				allow: [],
				deny: [],
			},
		]);
		setDirty(true);
	};

	const updateRow = (index: number, next: Overwrite) => {
		if (!markDraftChanged()) {
			return;
		}
		setRows((current) => current.map((r, i) => (i === index ? next : r)));
		setDirty(true);
	};

	const removeRow = (index: number) => {
		if (!markDraftChanged()) {
			return;
		}
		setRows((current) => current.filter((_, i) => i !== index));
		setDirty(true);
	};

	// A rule with settings but no target saves cleanly and applies to nobody, so
	// it is held back at the button rather than written and forgotten.
	const unfinished = rows.some(
		(r) =>
			r.target_type !== "org" &&
			r.target_id.trim().length === 0 &&
			(r.allow.length > 0 || r.deny.length > 0)
	);

	if (loading) {
		return (
			<p className="text-muted-foreground text-xs">
				Loading permissions&hellip;
			</p>
		);
	}
	if (loadError) {
		return (
			<div
				className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 px-3 py-2"
				role="alert"
			>
				<p className="text-status-destructive text-xs">
					Could not load permissions: {loadError}
				</p>
				<Button onClick={() => void refresh()} size="sm" variant="outline">
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="font-medium text-sm">
					Permissions{resourceName ? ` — ${resourceName}` : ""}
				</h3>
				<p className="text-muted-foreground text-xs">
					Exceptions for this {resourceKind}. Anything left on <em>Inherit</em>{" "}
					follows the person's normal role. A <em>Deny</em> here removes access
					even from someone whose role would normally allow it.
				</p>
			</div>

			{rows.length === 0 ? (
				<p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground text-xs">
					No exceptions. Everyone follows their usual role.
				</p>
			) : (
				<ul className="flex flex-col gap-4">
					{rows.map((row, index) => (
						<OverwriteCard
							choices={choicesFor(directory, row.target_type)}
							directoryFailed={directory === null}
							groups={groups}
							// rows are positional and freely reorderable, and two of them may legitimately point at the same role or person, so the target is not a key.
							key={index}
							onChange={(next) => updateRow(index, next)}
							onRemove={() => removeRow(index)}
							row={row}
						/>
					))}
				</ul>
			)}

			<div className="flex flex-wrap items-center gap-2">
				{(["role", "team", "member", "org"] as const).map((t) => (
					<Button
						// An `org` rule needs the node's org id, which an unbound
						// personal node does not have. Offering the button there would
						// only produce a rule that matches nobody.
						disabled={t === "org" && !directory?.org_id}
						key={t}
						onClick={() => addTarget(t)}
						size="sm"
						variant="ghost"
					>
						Add {TARGET_LABEL[t].toLowerCase()}
					</Button>
				))}
				<div className="flex-1" />
				<Button
					disabled={!dirty || saving || unfinished}
					onClick={() => void save()}
					size="sm"
				>
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>

			{vocabulary && vocabulary.collisions.length > 0 ? (
				<p className="text-muted-foreground text-xs">
					Note: some app rules for {vocabulary.collisions.join(", ")} were
					ignored. An app can't change a built-in permission, a level another
					app owns, or a level two installed apps both declare.
				</p>
			) : null}
		</div>
	);
}
