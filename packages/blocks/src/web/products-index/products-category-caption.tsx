"use client";

// The screen-reader caption of one products-index table ("Build products").
//
// The table renders on the server in English, and the client DOM localizer
// cannot rescue a one-literal-word template such as "{category} products" (it
// deliberately refuses short templates whose capture is a prose word), so the
// caption translates on the client: the category label first, then the
// whole sentence around it.

import { useLiteralMessages, useLocalizedString } from "@ryu/i18n/react";

export function ProductsCategoryCaption({ category }: { category: string }) {
	const tl = useLiteralMessages();
	const localizedCategory = useLocalizedString(category) ?? category;
	return <>{tl("{category} products", { category: localizedCategory })}</>;
}
