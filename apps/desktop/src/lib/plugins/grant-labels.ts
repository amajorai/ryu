// Plain-language names + one-line descriptions for the permission grants an app
// (plugin) requests, shown in the enable consent dialog and the per-app
// permissions / revocation view. The desktop uses the shared registry in
// `@ryu/marketplace` (`grant-label-registry.ts`) so the Store, the install
// confirmation and Settings name every grant the same way and in the reader's
// language. Add new grant copy there, not here.

export {
	grantDescription,
	grantLabel,
} from "@ryu/marketplace/catalog/grant-labels";
