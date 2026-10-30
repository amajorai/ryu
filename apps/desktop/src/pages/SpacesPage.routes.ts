/** URL segment for a document editor route, by kind: page → doc, database → db,
 * whiteboard → wb (matches the route patterns in `Layout.tsx`). */
export function docSegment(kind: "page" | "database" | "whiteboard"): string {
	if (kind === "database") {
		return "db";
	}
	if (kind === "whiteboard") {
		return "wb";
	}
	return "doc";
}
