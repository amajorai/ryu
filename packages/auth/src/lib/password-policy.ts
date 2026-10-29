// The password contract lives in `@ryuhq/protocol` so the open-source CLI can
// share it without depending on this package. Everything that imports
// `@ryu/auth/lib/password-policy` keeps working through this re-export.
export * from "@ryuhq/protocol/password-policy";
