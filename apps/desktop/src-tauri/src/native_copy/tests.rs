use super::*;

/// The store is process-global; serialise the tests that replace it.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn guard() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn reset() {
    match STORE.write() {
        Ok(mut store) => *store = None,
        Err(poisoned) => *poisoned.into_inner() = None,
    }
}

fn payload(labels: &[(&str, &str)], categories: &[&str], digits: Option<&str>) -> NativeShellCopy {
    NativeShellCopy {
        labels: labels
            .iter()
            .map(|(id, text)| ((*id).to_owned(), (*text).to_owned()))
            .collect(),
        plural_categories: categories.iter().map(|c| (*c).to_owned()).collect(),
        digits: digits.map(str::to_owned),
        locale: None,
        language_mode: None,
    }
}

#[test]
fn reads_the_language_mode_the_webview_sends() {
    let copy: NativeShellCopy =
        serde_json::from_str(r#"{"locale":"de","languageMode":"fixed"}"#).expect("payload");
    assert_eq!(copy.language_mode.as_deref(), Some("fixed"));
    let older: NativeShellCopy = serde_json::from_str(r#"{"locale":"de"}"#).expect("payload");
    assert_eq!(older.language_mode, None);
}

#[test]
fn falls_back_to_english_before_the_webview_registers() {
    let _lock = guard();
    reset();
    assert_eq!(label(ids::TRAY_SHOW), "Show Ryu");
    let copy = quit_confirmation(1);
    assert_eq!(copy.title, "Quit Ryu?");
    assert!(
        copy.message.starts_with("1 local task is still running."),
        "{}",
        copy.message
    );
    assert!(plural(ids::QUIT_MESSAGE, 3).starts_with("3 local tasks are still running."));
    // The update dialog no longer says "tasks are" for one task.
    assert!(update_confirmation(1)
        .message
        .starts_with("1 local task is running."));
    assert!(update_confirmation(0)
        .message
        .starts_with("Installing this app update"));
}

#[test]
fn merges_localized_labels_over_the_english_fallback() {
    let _lock = guard();
    reset();
    replace_store(
        sanitize(payload(
            &[
                (ids::TRAY_SHOW, "Ryu を表示"),
                ("tray.unknown", "dropped"),
                (ids::TRAY_QUIT, "   "),
            ],
            &[],
            None,
        ))
        .expect("valid payload"),
    );
    assert_eq!(label(ids::TRAY_SHOW), "Ryu を表示");
    // Blank and unknown labels are dropped; English fills the gap.
    assert_eq!(label(ids::TRAY_QUIT), "Quit");
    assert_eq!(label("tray.unknown"), "tray.unknown");
    // A later payload replaces the previous language entirely.
    replace_store(sanitize(payload(&[], &[], None)).expect("valid payload"));
    assert_eq!(label(ids::TRAY_SHOW), "Show Ryu");
    reset();
}

#[test]
fn picks_the_plural_category_the_webview_computed() {
    let _lock = guard();
    reset();
    // Arabic-like table: 0 zero, 1 one, 2 two, 3-10 few, 11-99 many, 100-102 other.
    let mut table = vec!["zero", "one", "two"];
    table.extend(std::iter::repeat_n("few", 8));
    table.extend(std::iter::repeat_n("many", 89));
    table.extend(std::iter::repeat_n("other", 3));
    table.extend(std::iter::repeat_n("few", 8));
    table.extend(std::iter::repeat_n("many", 89));
    assert_eq!(table.len(), 200);
    replace_store(
        sanitize(payload(
            &[
                ("quit.message.two", "مهمتان"),
                ("quit.message.few", "{count} مهام"),
                ("quit.message.other", "{count} مهمة"),
            ],
            &table,
            Some("٠١٢٣٤٥٦٧٨٩"),
        ))
        .expect("valid payload"),
    );
    assert_eq!(plural(ids::QUIT_MESSAGE, 2), "مهمتان");
    assert_eq!(plural(ids::QUIT_MESSAGE, 5), "٥ مهام");
    // No `many` template: the stored `other` form is used, not English.
    assert_eq!(plural(ids::QUIT_MESSAGE, 42), "٤٢ مهمة");
    // Counts past the table follow `count % 100` within the 100-199 rows.
    assert_eq!(plural(ids::QUIT_MESSAGE, 1005), "١٠٠٥ مهام");
    reset();
}

#[test]
fn rejects_oversize_payloads_and_bad_tables() {
    let labels: Vec<(String, String)> = (0..=MAX_LABELS)
        .map(|i| (format!("x{i}"), "y".to_owned()))
        .collect();
    let copy = NativeShellCopy {
        labels: labels.into_iter().collect(),
        ..Default::default()
    };
    assert!(sanitize(copy).is_err());
    let store = sanitize(payload(&[], &["one", "bogus"], Some("0123"))).expect("bounded payload");
    assert!(store.categories.is_empty());
    assert!(store.digits.is_none());
    let long = "x".repeat(MAX_LABEL_BYTES + 1);
    let store = sanitize(payload(&[(ids::TRAY_SHOW, &long)], &[], None)).expect("bounded payload");
    assert!(store.labels.is_empty());
}

#[test]
fn normalizes_os_language_tags() {
    assert_eq!(normalize_tag("pt_BR.UTF-8@euro"), "pt-BR");
    assert_eq!(normalize_tag("zh-Hans-CN"), "zh-Hans-CN");
    assert_eq!(normalize_tag("C"), "");
    assert_eq!(normalize_tag("POSIX"), "");
    assert_eq!(normalize_tag("en US"), "");
}

#[test]
fn reads_the_posix_locale_environment_in_glibc_order() {
    assert_eq!(
        os::from_posix_env(Some("ja:en"), None, None, Some("ja_JP.UTF-8")),
        ["ja", "en", "ja_JP.UTF-8"]
    );
    assert_eq!(os::from_posix_env(Some("ja"), Some("C"), None, None), ["C"]);
    assert_eq!(
        os::from_posix_env(None, None, Some("de_DE"), Some("fr_FR")),
        ["de_DE"]
    );
}
