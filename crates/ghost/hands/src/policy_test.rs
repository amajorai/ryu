//! Policy tests: pure, run on every OS by passing an explicit `TargetOs`.

use super::*;

const ALL_OS: [TargetOs; 3] = [TargetOs::Mac, TargetOs::Windows, TargetOs::Linux];

fn combo(keys: &[&str], os: TargetOs) -> KeyCombo {
    let (key, mods) = keys.split_last().expect("non-empty");
    KeyCombo::parse_for(key, mods, os).expect("parses")
}

fn blocked(keys: &[&str], os: TargetOs) -> bool {
    blocked_reason_for(&combo(keys, os), os).is_some()
}

#[test]
fn every_table_entry_is_blocked() {
    for os in ALL_OS {
        for e in table(os) {
            let mut keys: Vec<&str> = e.modifiers.iter().map(|m| m.canonical()).collect();
            keys.push(e.key);
            assert!(blocked(&keys, os), "{keys:?} on {os:?}");
        }
    }
}

#[test]
fn spec_tables_are_blocked_through_aliases() {
    let mac: &[&[&str]] = &[
        &["cmd", "q"],
        &["command", "shift", "q"],
        &["cmd", "option", "escape"],
        &["control", "cmd", "q"],
        &["cmd", "shift", "backspace"],
        &["cmd", "shift", "delete"],
    ];
    for keys in mac {
        assert!(blocked(keys, TargetOs::Mac), "{keys:?}");
    }
    let win: &[&[&str]] = &[
        &["alt", "f4"],
        &["win", "l"],
        &["windows", "d"],
        &["alt", "tab"],
        &["win", "r"],
        &["win", "x"],
        &["win", "e"],
        &["ctrl", "shift", "esc"],
        &["ctrl", "alt", "del"],
    ];
    for keys in win {
        assert!(blocked(keys, TargetOs::Windows), "{keys:?}");
    }
    let linux: &[&[&str]] = &[
        &["alt", "f4"],
        &["alt", "tab"],
        &["alt", "f2"],
        &["super", "l"],
        &["super", "d"],
        &["super", "tab"],
        &["ctrl", "alt", "t"],
        &["ctrl", "alt", "delete"],
        &["ctrl", "alt", "backspace"],
        &["ctrl", "alt", "l"],
        &["super"],
    ];
    for keys in linux {
        assert!(blocked(keys, TargetOs::Linux), "{keys:?}");
    }
    for n in 1..=12 {
        let f = format!("f{n}");
        assert!(
            blocked(&["ctrl", "alt", &f], TargetOs::Linux),
            "ctrl+alt+{f}"
        );
    }
}

#[test]
fn supersets_are_blocked() {
    assert!(blocked(&["cmd", "opt", "shift", "esc"], TargetOs::Mac));
    assert!(blocked(
        &["ctrl", "alt", "shift", "delete"],
        TargetOs::Windows
    ));
    assert!(blocked(
        &["ctrl", "alt", "shift", "delete"],
        TargetOs::Linux
    ));
    assert!(blocked(&["ctrl", "alt", "f4"], TargetOs::Windows));
}

#[test]
fn aliases_fold() {
    let os = TargetOs::Mac;
    let c = combo(&["command", "option", "escape"], os);
    assert_eq!(c.display(), "meta+alt+esc");
    assert_eq!(combo(&["win", "x"], os).display(), "meta+x");
    assert_eq!(combo(&["super", "x"], os).display(), "meta+x");
    assert_eq!(combo(&["control", "return"], os).key, "enter");
    assert_eq!(combo(&["backspace"], os).key, "delete");
    assert_eq!(combo(&["forwarddelete"], os).key, "delete");
    assert_eq!(combo(&["DEL"], os).key, "delete");
    assert_eq!(combo(&["Shift", "A"], os).display(), "shift+a");
}

#[test]
fn modifier_name_as_key_is_canonical() {
    for os in ALL_OS {
        let c = KeyCombo::parse_for("super", &["shift"], os).unwrap();
        assert_eq!(c.key, "meta");
        assert_eq!(c.modifiers, BTreeSet::from([Modifier::Shift]));
        assert_eq!(c.dispatch_key, Modifier::Meta.dispatch_name(os));
    }
    let c = KeyCombo::parse_for("super", &["shift"], TargetOs::Linux).unwrap();
    assert!(blocked_reason_for(&c, TargetOs::Linux).is_some());
    assert!(blocked_reason_for(&c, TargetOs::Mac).is_none());
    assert_eq!(
        KeyCombo::parse_for("Option", &[], TargetOs::Mac)
            .unwrap()
            .key,
        "alt"
    );
}

#[test]
fn must_stay_allowed() {
    for os in ALL_OS {
        for keys in [
            &["cmd", "v"][..],
            &["ctrl", "v"],
            &["enter"],
            &["return"],
            &["ctrl", "a"],
            &["cmd", "a"],
            &["cmd", "w"],
            &["ctrl", "w"],
            &["ctrl", "c"],
        ] {
            assert!(!blocked(keys, os), "{keys:?} on {os:?}");
        }
    }
    assert!(!blocked(&["cmd", "l"], TargetOs::Mac));
    assert!(!blocked(&["ctrl", "alt", "f13"], TargetOs::Linux));
}

#[test]
fn unknown_modifier_and_key_are_errors() {
    assert_eq!(
        KeyCombo::parse("a", &["hyper"]),
        Err(KeyError::UnknownModifier("hyper".into()))
    );
    assert_eq!(
        KeyCombo::parse("definitely-not-a-key", &[]),
        Err(KeyError::UnknownKey("definitely-not-a-key".into()))
    );
    assert!(matches!(
        KeyCombo::parse("f25", &[]),
        Err(KeyError::UnknownKey(_))
    ));
    assert!(matches!(
        KeyCombo::parse("f0", &[]),
        Err(KeyError::UnknownKey(_))
    ));
    assert!(matches!(
        KeyCombo::parse("\u{7}", &[]),
        Err(KeyError::UnknownKey(_))
    ));
    assert_eq!(KeyCombo::parse("", &[]), Err(KeyError::EmptyKey));
    assert_eq!(KeyCombo::parse("  ", &[]), Err(KeyError::EmptyKey));
    assert_eq!(KeyCombo::from_keys(&[]), Err(KeyError::EmptyKey));
    assert_eq!(KeyCombo::parse(" ", &[]).unwrap().key, "space");
    assert_eq!(KeyCombo::parse("f24", &[]).unwrap().key, "f24");
    assert_eq!(KeyCombo::parse("-", &[]).unwrap().key, "-");
}

#[test]
fn from_keys_ctrl_alt_f3_is_blocked_on_linux() {
    let c = KeyCombo::from_keys(&["ctrl", "alt", "f3"]).unwrap();
    assert_eq!(c.display(), "ctrl+alt+f3");
    assert!(blocked_reason_for(&c, TargetOs::Linux).is_some());
    assert!(blocked_reason_for(&c, TargetOs::Mac).is_none());
}

#[test]
fn check_hotkey_empty_is_none_and_force_bypasses() {
    assert_eq!(check_hotkey(&[], KeyOptions::default()), Ok(None));
    assert_eq!(check_hotkey(&[], KeyOptions { force: true }), Ok(None));
    // alt+f4 is blocked on Windows and Linux; Mac uses meta+q.
    let keys: &[&str] = match TargetOs::current() {
        TargetOs::Mac => &["cmd", "q"],
        _ => &["alt", "f4"],
    };
    let err = check_hotkey(keys, KeyOptions::default()).unwrap_err();
    assert_eq!(err.code(), "POLICY_DENIED");
    assert!(check_hotkey(keys, KeyOptions { force: true })
        .unwrap()
        .is_some());
    let (key, mods) = keys.split_last().unwrap();
    assert!(check_key(key, mods, KeyOptions::default()).is_err());
    assert!(check_key(key, mods, KeyOptions { force: true }).is_ok());
    // Force never bypasses validation.
    assert!(check_key("nope-key", &[], KeyOptions { force: true }).is_err());
}

#[test]
fn blocked_error_text_has_exactly_one_code_prefix() {
    let err = KeyError::Blocked {
        combo: "meta+q".into(),
        reason: "quits the frontmost app",
    };
    let text = err.to_string();
    assert!(text.starts_with("POLICY_DENIED: "), "{text}");
    assert_eq!(text.matches("POLICY_DENIED").count(), 1, "{text}");
    assert!(!err.message().contains("POLICY_DENIED"));
    assert!(err
        .message()
        .starts_with("key combo 'meta+q' is blocked (quits the frontmost app)"));
    assert!(err.message().contains("force=true"));
    assert_eq!(KeyError::UnknownKey("x".into()).code(), "INVALID_ARGS");
    assert_eq!(KeyError::EmptyKey.code(), "INVALID_ARGS");
    assert!(KeyError::UnknownKey("zz".into())
        .to_string()
        .starts_with("INVALID_ARGS: Unknown key"));
}

#[test]
fn dispatch_keys_fold_to_canonical_and_keep_distinct_names() {
    for os in ALL_OS {
        assert_eq!(
            KeyCombo::parse_for("backspace", &[], os)
                .unwrap()
                .dispatch_key,
            "backspace"
        );
        assert_eq!(
            KeyCombo::parse_for("escape", &[], os).unwrap().dispatch_key,
            "escape"
        );
        assert_eq!(
            KeyCombo::parse_for("enter", &[], os).unwrap().dispatch_key,
            "return"
        );
        let c = KeyCombo::parse_for("dispatch-check", &[], os);
        assert!(c.is_err());
    }
    let fwd = |os| {
        KeyCombo::parse_for("forwarddelete", &[], os)
            .unwrap()
            .dispatch_key
    };
    assert_eq!(fwd(TargetOs::Mac), "forwarddelete");
    assert_eq!(fwd(TargetOs::Windows), "forwarddelete");
    assert_eq!(fwd(TargetOs::Linux), "delete");
}

#[test]
fn modifier_dispatch_names_are_accepted_aliases() {
    for os in ALL_OS {
        for m in [
            Modifier::Meta,
            Modifier::Ctrl,
            Modifier::Alt,
            Modifier::Shift,
        ] {
            let name = m.dispatch_name(os);
            assert_ne!(name, "opt");
            assert_eq!(Modifier::from_alias(name), Some(m));
        }
    }
    assert_eq!(Modifier::Meta.dispatch_name(TargetOs::Mac), "cmd");
}

#[test]
fn current_os_matches_cfg() {
    let expected = if cfg!(target_os = "macos") {
        TargetOs::Mac
    } else if cfg!(target_os = "windows") {
        TargetOs::Windows
    } else {
        TargetOs::Linux
    };
    assert_eq!(TargetOs::current(), expected);
}
