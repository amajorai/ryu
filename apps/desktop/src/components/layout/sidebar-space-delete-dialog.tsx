import { useLiteralMessages } from "@ryu/i18n/react";
import { DestructiveConfirmDialog } from "@/src/components/ui/DestructiveConfirmDialog.tsx";

/** The single shared confirmation the Spaces sidebar section shows before deleting a Space. */
export function SpaceDeleteDialog({
	busy,
	onClose,
	onConfirm,
	space,
}: {
	busy: boolean;
	onClose: () => void;
	onConfirm: () => boolean | Promise<boolean>;
	space: { name: string } | null;
}) {
	const tl = useLiteralMessages();
	return (
		<DestructiveConfirmDialog
			busy={busy}
			description={
				space
					? tl(
							'"{name}" and all its documents will be permanently deleted. This can\'t be undone.',
							{ name: space.name }
						)
					: ""
			}
			label={tl("Delete {name}", {
				name: space?.name ?? tl("this Space"),
			})}
			onConfirm={onConfirm}
			onOpenChange={(open) => {
				if (!(open || busy)) {
					onClose();
				}
			}}
			open={space !== null}
			title="Delete this Space?"
		/>
	);
}
