// Ambient declarations so this app's tsc can type-check the Lanyard source it
// imports from @ryu/ui. Bun symlinks workspace packages as source, so those
// .tsx files enter this program — but their colocated .d.ts siblings do not, so
// the asset imports and the meshline JSX intrinsics are unknown here without
// this file.
//
// Kept a SCRIPT file (no top-level import/export) so the wildcard `declare
// module` decls register globally. The meshline JSX intrinsics live in the
// sibling lanyard-jsx.d.ts (a module, since it augments `react`).
declare module "*.glb" {
	const src: string;
	export default src;
}

declare module "*.png" {
	const src: string;
	export default src;
}
