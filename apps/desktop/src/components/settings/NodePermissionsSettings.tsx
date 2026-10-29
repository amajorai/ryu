import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import { ResourcePermissions } from "./ResourcePermissions.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * Node-wide view of every resource whose permissions have been customised.
 *
 * Most resources have no exceptions — everyone follows their role — so listing
 * "every space" here would bury the handful that were deliberately changed. The
 * node therefore reports only resources that CARRY an exception, and anything
 * else is reached by naming it directly below.
 */

interface ResourceRef {
	id: string;
	kind: string;
}

/**
 * Fallback kinds, used only when the node does not report its own.
 *
 * The node is the authority (`GET /api/acl/principals` -> `kinds`): a list
 * maintained here drifted the moment Core grew a kind, leaving agents and
 * workflows uneditable with nothing to warn about it.
 */
const FALLBACK_KINDS = ["space"] as const;

/** What each kind is called in the rest of the app. */
const KIND_LABEL = new Map<string, string>([
	["agent", "Agent"],
	["conversation", "Conversation"],
	["node", "Node"],
	["space", "Space"],
	["workflow", "Workflow"],
]);

function kindLabel(kind: string): string {
	return KIND_LABEL.get(kind) ?? kind;
}

const resourceRefResponseCodec: z.ZodType<ResourceRef> = z
	.object({ id: z.string(), kind: z.string() })
	.passthrough();
export function NodePermissionsSettings() {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};

	const [resources, setResources] = useState<ResourceRef[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selected, setSelected] = useState<ResourceRef | null>(null);
	const [kinds, setKinds] = useState<string[]>([...FALLBACK_KINDS]);
	const [kind, setKind] = useState<string>(FALLBACK_KINDS[0]);
	const [id, setId] = useState("");

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const [data, principals] = await Promise.all([
				request<{ resources: ResourceRef[] }>(
					target,
					"/api/acl/resources",
					{},
					z
						.object({ resources: z.array(resourceRefResponseCodec) })
						.passthrough()
				),
				request<{ kinds?: string[] }>(
					target,
					"/api/acl/principals",
					{},
					z.object({ kinds: z.array(z.string()).optional() }).passthrough()
				).catch(() => null),
			]);
			setResources(data.resources ?? []);
			setLoadError(null);
			// The resource list remains usable even if an older node cannot serve its
			// authoritative kinds/directory; use the narrow Space fallback until it
			// answers and let each resource editor offer its manual-ID escape hatch.
			if (principals?.kinds?.length) {
				setKinds(principals.kinds);
				setKind((current) =>
					principals.kinds?.includes(current)
						? current
						: (principals.kinds?.[0] ?? current)
				);
			}
		} catch (error) {
			setLoadError(
				error instanceof Error
					? error.message
					: "Could not list customised resources"
			);
		} finally {
			setLoading(false);
		}
		// `target` is rebuilt each render; depend on its fields.
	}, [node.url, node.token, node.userJwt]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (selected) {
		return (
			<div className="flex flex-col gap-4">
				<Button
					appearance="settings-back"
					className="-ml-2 w-fit"
					onClick={() => {
						setSelected(null);
						void refresh();
					}}
					size="sm"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
					All resources
				</Button>
				<ResourcePermissions
					resourceId={selected.id}
					resourceKind={selected.kind}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="By default everyone's access follows their role. Here you can make exceptions for a Space, Agent, Workflow, Conversation, or Node: give one team access, or take it away from someone who would otherwise have it."
				title="With custom permissions"
			>
				{loading && resources.length === 0 ? (
					<SettingsCard className="text-center text-muted-foreground text-sm">
						<p role="status">Checking customised resources…</p>
					</SettingsCard>
				) : null}
				{loadError ? (
					<div role="alert">
						<SettingsItem
							actions={
								<Button
									disabled={loading}
									onClick={() => void refresh()}
									size="sm"
									variant="outline"
								>
									{loading ? "Retrying…" : "Retry"}
								</Button>
							}
							title={
								<span className="text-status-destructive">
									{tl("Could not list customised resources: {loadError}", {
										loadError,
									})}
								</span>
							}
						/>
					</div>
				) : null}
				{!(loading || loadError) && resources.length === 0 ? (
					<SettingsCard className="text-center text-muted-foreground text-sm">
						Nothing customised yet. Everyone follows their role everywhere.
					</SettingsCard>
				) : null}
				{resources.length > 0 ? (
					<SettingsGroup>
						{resources.map((resource) => (
							<SettingsItem
								actions={
									<span className="flex items-center gap-2">
										<span className="text-muted-foreground text-sm">
											{kindLabel(resource.kind)}
										</span>
										<Button
											onClick={() => setSelected(resource)}
											size="sm"
											variant="ghost"
										>
											Edit
										</Button>
									</span>
								}
								key={`${resource.kind}:${resource.id}`}
								title={
									<span className="block truncate" title={resource.id}>
										{resource.id}
									</span>
								}
							/>
						))}
					</SettingsGroup>
				) : null}
			</SettingsSection>

			<SettingsSection title="Set permissions on something else">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={kinds.map((k) => ({
									value: k,
									label: kindLabel(k),
								}))}
								onValueChange={(value) =>
									setKind(isNativeText(value) ? value : kinds[0])
								}
								value={kind}
							>
								<SelectTrigger
									appearance="gateway-action"
									className="w-40"
									id="acl-kind"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{kinds.map((k) => (
										<SelectItem key={k} value={k}>
											{kindLabel(k)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title={
							<Label className="font-normal" htmlFor="acl-kind">
								Type
							</Label>
						}
					/>
					<SettingsItem
						actions={
							<Button
								disabled={!id.trim()}
								onClick={() => setSelected({ kind, id: id.trim() })}
								size="sm"
							>
								Open
							</Button>
						}
						title={
							<Label className="font-normal" htmlFor="acl-id">
								Identifier
							</Label>
						}
					>
						<Input
							id="acl-id"
							onChange={(e) => setId(e.target.value)}
							placeholder={tl("{kind} identifier", { kind: kindLabel(kind) })}
							value={id}
						/>
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
