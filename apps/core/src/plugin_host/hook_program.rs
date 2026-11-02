//! The sandbox program a hook runs in: the serialized `ctx` (plus the node
//! language as `ctx.locale`), the `host` capability facade over the sandbox
//! `tools` proxy, then the plugin's hook body.

use super::HookContext;

/// Deep-freezes a middleware hook's context so it can only forward a new one.
const DEEP_FREEZE: &str = r#"const __ryu_deep_freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) __ryu_deep_freeze(child);
    Object.freeze(value);
  }
  return value;
};
"#;

/// `host.t`'s fallback when Core cannot render: the English ICU source with its
/// `{name}` placeholders filled in (`''` is an apostrophe).
const FILL_TEMPLATE: &str = r#"const __ryu_fill = (source, values) => source
  .replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? "") : match)
  .replace(/''/g, "'");
"#;

/// The `host` facade. `t` never throws: if the bridge call fails it returns the
/// filled-in English source.
const HOST_FACADE: &str = r#"const host = {
  sideModel: (a) => tools.host.sideModel(a ?? {}),
  runAgent: (a) => tools.host.runAgent(a ?? {}),
  runFanout: (a) => tools.host.runFanout(a ?? {}),
  reactions: {
    add: (a) => tools.host.addMessageReaction(a ?? {}),
  },
  notify: (a) => tools.host.notify(a ?? {}),
  t: async (source, values) => {
    const text = String(source ?? "");
    const vars = values && typeof values === "object" ? values : {};
    try {
      const rendered = await tools.host.t({ source: text, values: vars, locale: ctx.locale });
      if (typeof rendered === "string") return rendered;
    } catch (_error) {}
    return __ryu_fill(text, vars);
  },
  setConversationTitle: (a) => tools.host.setConversationTitle(a ?? {}),
  getPreference: (a) => tools.host.getPreference(a ?? {}),
  background: {
    list: (a) => tools.host.background_list(a ?? {}),
    stop: (a) => tools.host.background_stop(a ?? {}),
  },
  usage: (a) => tools.host.usageSnapshot(a ?? {}),
  subscriptions: {
    list: (a) => tools.host.subscriptions_list(a ?? {}),
    usage: (a) => tools.host.subscriptions_usage(a ?? {}),
  },
  storage: {
    get: (k, ns) => tools.host.storage_get({ key: String(k), namespace: ns }),
    set: (k, v, ns) => tools.host.storage_set({ key: String(k), value: typeof v === "string" ? v : JSON.stringify(v), namespace: ns }),
    delete: (k, ns) => tools.host.storage_delete({ key: String(k), namespace: ns }),
    keys: (ns) => tools.host.storage_keys({ namespace: ns }),
    compareAndSet: (k, expected, v, ns) => tools.host.storage_compare_and_set({ key: String(k), expected: expected == null ? null : String(expected), value: v == null ? null : (typeof v === "string" ? v : JSON.stringify(v)), namespace: ns }),
  },
  spaces: {
    ensureSpace: (a) => tools.host.spaces_ensure_space(a ?? {}),
    createDoc: (a) => tools.host.spaces_create_doc(a ?? {}),
    getDoc: (a) => tools.host.spaces_get_doc(a ?? {}),
    updateDoc: (a) => tools.host.spaces_update_doc(a ?? {}),
    listDocs: (a) => tools.host.spaces_list_docs(a ?? {}),
    deleteDoc: (a) => tools.host.spaces_delete_doc(a ?? {}),
    createDatabase: (a) => tools.host.spaces_create_database(a ?? {}),
    listDatabases: (a) => tools.host.spaces_list_databases(a ?? {}),
    getDatabase: (a) => tools.host.spaces_get_database(a ?? {}),
    updateDatabase: (a) => tools.host.spaces_update_database(a ?? {}),
    queryDatabase: (a) => tools.host.spaces_query_database(a ?? {}),
    deleteDatabase: (a) => tools.host.spaces_delete_database(a ?? {}),
  },
  crypto: {
    seal: (v) => tools.host.crypto_seal({ value: typeof v === "string" ? v : JSON.stringify(v) }),
    open: (v) => tools.host.crypto_open({ value: String(v) }),
    status: () => tools.host.crypto_status({}),
  },
  log: (...a) => console.log(...a),
};
"#;

/// Build the sandbox program: inject `ctx` + define the `host` capability facade
/// over the sandbox `tools` proxy, then the plugin's hook body (which `return`s a
/// directive). The body runs inside the substrate's async IIFE, so a bare
/// `return` reports the directive as the program's final value. `locale` is
/// the node language, exposed as `ctx.locale` and used by `host.t`.
pub(super) fn build_hook_program_in(ctx: &HookContext, entry_code: &str, locale: &str) -> String {
    build_hook_program_inner(ctx, entry_code, locale, false)
}

/// Build a middleware hook program. The user function receives a Core-mediated
/// `next` continuation; the continuation calls back into the bridge, which owns
/// the remaining hook chain and its per-plugin capability boundaries.
pub(super) fn build_middleware_hook_program_in(
    ctx: &HookContext,
    entry_code: &str,
    locale: &str,
) -> String {
    let entry = format!(
        "const __ryu_function_hook = async (ctx, host, next) => {{ {entry_code} }};\nreturn await __ryu_function_hook(ctx, host, (nextCtx) => tools.host.next({{ context: nextCtx ?? ctx }}));"
    );
    build_hook_program_inner(ctx, &entry, locale, true)
}

/// [`build_hook_program_in`] for English, for tests that do not exercise locale.
#[cfg(test)]
pub(super) fn build_hook_program(ctx: &HookContext, entry_code: &str) -> String {
    build_hook_program_in(ctx, entry_code, "en")
}

/// [`build_middleware_hook_program_in`] for English.
#[cfg(test)]
pub(super) fn build_middleware_hook_program(ctx: &HookContext, entry_code: &str) -> String {
    build_middleware_hook_program_in(ctx, entry_code, "en")
}

fn build_hook_program_inner(
    ctx: &HookContext,
    entry_code: &str,
    locale: &str,
    freeze_context: bool,
) -> String {
    let mut ctx_value = serde_json::to_value(ctx).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(object) = ctx_value.as_object_mut() {
        object.insert("locale".to_owned(), serde_json::Value::from(locale));
    }
    let ctx_json = serde_json::to_string(&ctx_value).unwrap_or_else(|_| "{}".to_string());
    let ctx_expression = if freeze_context {
        format!("__ryu_deep_freeze({ctx_json})")
    } else {
        ctx_json
    };
    format!(
        "{DEEP_FREEZE}const ctx = {ctx_expression};\n{FILL_TEMPLATE}{HOST_FACADE}{entry_code}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_exposes_the_node_locale_and_a_catalog_translate_helper() {
        let program = build_hook_program_in(&HookContext::default(), "return null;", "ja");
        assert!(program.contains(r#""locale":"ja""#));
        assert!(program.contains("t: async (source, values) =>"));
        assert!(
            program.contains("tools.host.t({ source: text, values: vars, locale: ctx.locale })")
        );
        let middleware =
            build_middleware_hook_program_in(&HookContext::default(), "return null;", "de");
        assert!(middleware.contains(r#"__ryu_deep_freeze({"#));
        assert!(middleware.contains(r#""locale":"de""#));
    }
}
