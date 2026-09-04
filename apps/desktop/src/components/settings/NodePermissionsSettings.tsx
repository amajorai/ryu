import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo";
import { useCallback, useEffect, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import { ResourcePermissions } from "./ResourcePermissions.tsx";

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
const KIND_LABEL: Record<string, string> = {
	agent: "Agent",
	conversation: "Conversation",
	node: "Node",
	space: "Space",
	workflow: "Workflow",
};

function kindLabel(kind: string): string {
	return KIND_LABEL[kind] ?? kind;
}

export function NodePermissionsSettings() {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};

	const [resources, setResources] = useState<ResourceRef[]>([]);
	const [selected, setSelected] = useState<ResourceRef | null>(null);
	const [kinds, setKinds] = useState<string[]>([...FALLBACK_KINDS]);
	const [kind, setKind] = useState<string>(FALLBACK_KINDS[0]);
	const [id, setId] = useState("");

	const refresh = useCallback(async () => {
		try {
			const [data, principals] = await Promise.all([
				request<{ resources: ResourceRef[] }>(target, "/api/acl/resources"),
				request<{ kinds?: string[] }>(target, "/api/acl/principals"),
			]);
			setResources(data.resources ?? []);
			// The node is the authority on which kinds it enforces; only fall back
			// when it reports none (an older node that predates the field).
			if (principals.kinds?.length) {
				setKinds(principals.kinds);
				setKind((current) =>
					principals.kinds?.includes(current)
						? current
						: (principals.kinds?.[0] ?? current)
				);
			}
		} catch (error) {
			toast.error("Could not list customised resources", {
				id: "acl-resource-list",
				description: error instanceof Error ? error.message : String(error),
			});
		}
		// `target` is rebuilt each render; depend on its fields.
	}, [node.url, node.token, node.userJwt]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (selected) {
		return (
			<div className="flex flex-col gap-4">
				<div>
					<Button
						onClick={() => {
							setSelected(null);
							void refresh();
						}}
						size="sm"
						variant="ghost"
					>
						← All resources
					</Button>
				</div>
				<ResourcePermissions
					resourceId={selected.id}
					resourceKind={selected.kind}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="font-medium text-sm">Permissions</h3>
				<p className="text-muted-foreground text-xs">
					By default everyone's access follows their role. Here you can make
					exceptions for a Space, Agent, Workflow, Conversation, or Node: give
					one team access, or take it away from someone who would otherwise have
					it.
				</p>
			</div>

			<section className="flex flex-col gap-2">
				<h4 className="font-medium text-xs">With custom permissions</h4>
				{resources.length === 0 ? (
					<p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground text-xs">
						Nothing customised yet. Everyone follows their role everywhere.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{resources.map((resource) => (
							<li
								className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
								key={`${resource.kind}:${resource.id}`}
							>
								<div className="min-w-0">
									<p className="truncate text-sm">{resource.id}</p>
									<p className="text-muted-foreground text-xs">
										{kindLabel(resource.kind)}
									</p>
								</div>
								<Button
									onClick={() => setSelected(resource)}
									size="sm"
									variant="ghost"
								>
									Edit
								</Button>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="flex flex-col gap-2">
				<h4 className="font-medium text-xs">
					Set permissions on something else
				</h4>
				<div className="flex flex-wrap items-end gap-2">
					<div className="flex flex-col gap-1">
						<Label className="text-xs" htmlFor="acl-kind">
							Type
						</Label>
						<Select
							items={kinds.map((k) => ({
								value: k,
								label: kindLabel(k),
							}))}
							onValueChange={(value) =>
								setKind(typeof value === "string" ? value : kinds[0])
							}
							value={kind}
						>
							<SelectTrigger className="h-8 w-40 text-xs" id="acl-kind">
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
					</div>
					<div className="flex flex-1 flex-col gap-1">
						<Label className="text-xs" htmlFor="acl-id">
							Identifier
						</Label>
						<Input
							className="h-8 text-xs"
							id="acl-id"
							onChange={(e) => setId(e.target.value)}
							placeholder={`${kindLabel(kind)} identifier`}
							value={id}
						/>
					</div>
					<Button
						disabled={!id.trim()}
						onClick={() => setSelected({ kind, id: id.trim() })}
						size="sm"
					>
						Open
					</Button>
				</div>
			</section>
		</div>
	);
}
