import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
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
import { OverwriteCard } from "./ResourcePermissions-cards.tsx";
import {
	overwriteResponseCodec,
	principalDirectoryResponseCodec,
	vocabularyResponseCodec,
} from "./ResourcePermissions-codecs.ts";
import {
	buildGroups,
	choicesFor,
	TARGET_LABEL,
} from "./ResourcePermissions-model.ts";
import type {
	Overwrite,
	PrincipalDirectory,
	TargetType,
	Vocabulary,
} from "./ResourcePermissions-types.ts";

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
export function ResourcePermissions({
	resourceKind,
	resourceId,
	resourceName,
}: {
	resourceId: string;
	resourceKind: string;
	resourceName?: string;
}) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
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
		return <SkeletonRows label="Loading permissions…" rows={2} />;
	}
	if (loadError) {
		return (
			<div
				className="flex min-h-12 items-center justify-between gap-6 py-3"
				role="alert"
			>
				<p className="min-w-0 break-words text-sm">
					{tl("Could not load permissions: {loadError}", { loadError })}
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
				<h3 className="font-semibold text-sm">
					{resourceName
						? tl("Permissions — {resourceName}", { resourceName })
						: "Permissions"}
				</h3>
				<p className="text-detail text-muted-foreground">
					{tlRich(
						"Exceptions for this {resourceKind}. Anything left on <em>Inherit</em> follows the person's normal role. A <em>Deny</em> here removes access even from someone whose role would normally allow it.",
						{ resourceKind },
						{ em: (chunks) => <em>{chunks}</em> }
					)}
				</p>
			</div>

			{rows.length === 0 ? (
				<p className="py-3 text-muted-foreground text-sm">
					No exceptions. Everyone follows their usual role.
				</p>
			) : (
				<ul className="flex flex-col">
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
						{tl("Add {target}", { target: TARGET_LABEL[t].toLowerCase() })}
					</Button>
				))}
				<div className="flex-1" />
				<Button
					disabled={!dirty || saving || unfinished}
					onClick={() => void save()}
					size="sm"
					variant="mono"
				>
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>

			{vocabulary && vocabulary.collisions.length > 0 ? (
				<p className="text-detail text-muted-foreground">
					{tl(
						"Note: some app rules for {collisions} were ignored. An app can't change a built-in permission, a level another app owns, or a level two installed apps both declare.",
						{ collisions: vocabulary.collisions.join(", ") }
					)}
				</p>
			) : null}
		</div>
	);
}
