/*
 * ryu_sdk.h — C-ABI for the ryu-sdk Rust core.
 *
 * Hand-authored (regenerate with `cbindgen --config cbindgen.toml --output
 * include/ryu_sdk.h`). Consumed by the Go (cgo) binding and any C-FFI client.
 *
 * Memory rules:
 *   - Every `char*` RETURNED by this library is heap-owned; free it with
 *     ryu_string_free().
 *   - Value functions return NULL on error; call ryu_last_error() for the
 *     message (also heap-owned, free with ryu_string_free()).
 *   - int functions return 0 on success, -1 on error (message via
 *     ryu_last_error()).
 */
#ifndef RYU_SDK_H
#define RYU_SDK_H

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque model-client handle. */
typedef struct RyuModelClientHandle RyuModelClientHandle;

/* ── Error + memory ─────────────────────────────────────────────────────── */

/* Last error for the calling thread, or NULL. Caller frees. */
char *ryu_last_error(void);

/* Free a char* returned by this library. NULL is a no-op. */
void ryu_string_free(char *ptr);

/* ── Manifest + schema ──────────────────────────────────────────────────── */

/* 0 if the plugin id is valid, -1 otherwise. */
int ryu_validate_plugin_id(const char *id);

/* Normalized manifest JSON on success (caller frees), NULL on error. */
char *ryu_parse_and_validate_manifest(const char *json);

/* The plugin.json JSON Schema (caller frees). */
char *ryu_plugin_manifest_json_schema(void);

/* ── Gateway ────────────────────────────────────────────────────────────── */

/* Resolved gateway base URL (caller frees). */
char *ryu_resolve_gateway_url(void);

/* 0 if the egress URL is allowed, -1 if it is a blocked direct provider. */
int ryu_assert_allowed_egress(const char *url);

/* ── Model client ───────────────────────────────────────────────────────── */

/* Construct a client. base_url/token may be NULL for env/defaults. Returns a
 * handle (free with ryu_model_client_free) or NULL on error. */
RyuModelClientHandle *ryu_model_client_new(const char *model,
                                           const char *base_url,
                                           const char *token);

/* Free a model-client handle. NULL is a no-op. */
void ryu_model_client_free(RyuModelClientHandle *handle);

/* Blocking chat. messages_json is a JSON array of {"role","content"}. Returns
 * a JSON object {"content","finish_reason","usage"} (caller frees) or NULL. */
char *ryu_model_client_chat(const RyuModelClientHandle *handle,
                            const char *messages_json);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* RYU_SDK_H */
