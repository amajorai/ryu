// packages/marketplace/src/states.tsx
//
// Shared "can't show the money layer" empty states for the marketplace surfaces
// (Licenses / Sell): the signed-out and no-organization placeholders. Shared by
// desktop + web so both render the identical degrade-cleanly copy.

import { Building01Icon, Store01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";

export function SignedOutState({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={Store01Icon} />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function NoOrgState({
	title,
	message,
}: {
	title: string;
	message: string;
}) {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={Building01Icon} />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{message}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
