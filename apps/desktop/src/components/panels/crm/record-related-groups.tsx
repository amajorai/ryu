import { Delete01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LiteralMessage } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import { recordTitle } from "@/src/components/panels/crm/fields.tsx";
import type {
	CrmClient,
	ObjectWithFields,
	RelatedGroup,
} from "@/src/lib/api/crm.ts";

import { RelationPicker } from "./record-detail-parts.tsx";

interface RelatedGroupsInput {
	changeLink: (
		group: RelatedGroup,
		targetId: string,
		add: boolean
	) => Promise<void>;
	client: CrmClient;
	linking: boolean;
	objectsBySlug: Map<string, ObjectWithFields>;
	onOpenRecord: (recordId: string, objectSlug?: string) => void;
	related: RelatedGroup[];
	tl: LiteralMessage;
}

/** The record page's Related section: linked records per relation, with unlink and a picker to link more. */
export function renderRelatedGroups({
	changeLink,
	client,
	linking,
	objectsBySlug,
	onOpenRecord,
	related,
	tl,
}: RelatedGroupsInput) {
	return (
		related.length > 0 && (
			<>
				<Separator className="my-4" />
				<h3 className="mb-1 font-semibold text-foreground text-sm">Related</h3>
				<div className="space-y-3">
					{related.map((group) => (
						<div key={group.field_id}>
							<div className="mb-1 flex items-center gap-1.5 text-muted-foreground text-xs">
								<HugeiconsIcon icon={UserGroupIcon} size={14} />
								{group.field_name}
								<Badge typography="normal" variant="secondary">
									{group.records.length}
								</Badge>
							</div>
							<ul className="space-y-0.5">
								{group.records.map((linked) => (
									<li className="flex items-center gap-1" key={linked.id}>
										<button
											className="min-w-0 flex-1 truncate rounded-lg px-1 py-0.5 text-left text-sm hover:bg-muted"
											onClick={() => onOpenRecord(linked.id, group.object_slug)}
											type="button"
										>
											{recordTitle(
												linked.title,
												linked.values,
												objectsBySlug
													.get(group.object_slug)
													?.fields.find(
														(f) =>
															f.id ===
															objectsBySlug.get(group.object_slug)?.object
																.title_field_id
													)
											)}
										</button>
										<Button
											aria-label={tl("Unlink {title}", {
												title: linked.title,
											})}
											disabled={linking}
											onClick={() => void changeLink(group, linked.id, false)}
											size="icon"
											variant="ghost"
										>
											<HugeiconsIcon icon={Delete01Icon} size={14} />
										</Button>
									</li>
								))}
							</ul>
							<RelationPicker
								client={client}
								disabled={linking}
								objectSlug={group.object_slug}
								onPick={(targetId) => void changeLink(group, targetId, true)}
								titleField={objectsBySlug
									.get(group.object_slug)
									?.fields.find(
										(f) =>
											f.id ===
											objectsBySlug.get(group.object_slug)?.object
												.title_field_id
									)}
							/>
						</div>
					))}
				</div>
			</>
		)
	);
}
