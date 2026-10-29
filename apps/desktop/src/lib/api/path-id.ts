// apps/desktop/src/lib/api/path-id.ts
//
// Companion frames hand the host record IDs (monitor, quest, meeting, workflow,
// approval, notification, Space, mail, skill) that host-direct clients place in
// Core URL paths and fetch with the node bearer. Keep each ID inside one path
// segment so a `../`, `?` or `#` in it cannot steer the request onto another Core
// route. The implementation lives in core-client so its quest verbs share it.

export { encodePathId } from "@ryuhq/core-client/path-id.ts";
