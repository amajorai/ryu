//! Bounded listing of the legacy Git history (read while importing it).

use super::*;

fn head_id(git: &GitHistory<'_>) -> String {
    git.run_git_text(&["rev-parse", "HEAD"])
        .expect("rev-parse HEAD")
        .trim()
        .to_owned()
}

#[test]
fn checkpoint_returns_head_and_bounded_lists_stay_exact() {
    let root = tempfile::tempdir().expect("temp source history");
    let history_root = root.path().join("source-history");
    let git = GitHistory::new(&history_root);

    let mut checkpoints = Vec::new();
    for index in 0..150 {
        let path = format!("agents/{index}/agent.json");
        let version = git
            .checkpoint(&path, &format!("{{\"index\":{index}}}\n"), None)
            .expect("agent checkpoint");
        assert_eq!(version.id, head_id(&git));
        assert_eq!(version.label.as_deref(), Some("Checkpoint"));
        checkpoints.push((path, version));
    }
    for (path, version) in &checkpoints {
        let listed = git.list_unlocked(path, 1).expect("list latest");
        assert_eq!(listed, vec![version.clone()]);
    }

    let path = "agents/7/agent.json";
    let mut expected = vec![checkpoints[7].1.clone()];
    for revision in 0..4 {
        expected.push(
            git.checkpoint(path, &format!("revision {revision}\n"), None)
                .expect("revision checkpoint"),
        );
    }
    let named = git
        .checkpoint(path, "revision 3\n", Some("Named"))
        .expect("named empty checkpoint");
    assert_eq!(named.id, head_id(&git));
    expected.push(named.clone());
    expected.reverse();

    let unchanged = git
        .checkpoint(path, "revision 3\n", None)
        .expect("unchanged checkpoint");
    assert_eq!(unchanged, named);
    assert_eq!(git.list_unlocked(path, 1).unwrap(), vec![named.clone()]);
    let listed = git.list_unlocked(path, 3).expect("bounded list");
    assert_eq!(listed.len(), 3);
    assert!(listed
        .windows(2)
        .all(|pair| pair[0].created_at >= pair[1].created_at));
    assert_eq!(listed[0], named);
    // Commits made within one second tie on `created_at`; the set of ids
    // is the stable contract across the bounded and unbounded queries.
    let all = git
        .list_unlocked(path, DEFAULT_HISTORY_LIMIT)
        .expect("full list");
    assert_eq!(all.len(), expected.len());
    let ids = |versions: &[SourceHistoryVersion]| {
        versions
            .iter()
            .map(|version| version.id.clone())
            .collect::<HashSet<_>>()
    };
    assert_eq!(ids(&all), ids(&expected));
    assert!(ids(&listed).is_subset(&ids(&all)));
}

#[test]
fn bounded_lists_handle_regex_metacharacters_and_trailer_prefixes() {
    let root = tempfile::tempdir().expect("temp source history");
    let history_root = root.path().join("source-history");
    let git = GitHistory::new(&history_root);

    // `|` is not a legal file name character on Windows, so only Unix
    // exercises alternation; both keep `.`, `+`, groups, anchors and braces.
    #[cfg(unix)]
    let (literal, regex_lookalike) = (
        "agents/a.b+(x)^$|{1}/agent.json",
        "agents/aXb+(x)^$|{1}/agent.json",
    );
    #[cfg(not(unix))]
    let (literal, regex_lookalike) = (
        "agents/a.b+(x)^${1}/agent.json",
        "agents/aXb+(x)^${1}/agent.json",
    );
    let first = git
        .checkpoint(literal, "one\n", Some("First"))
        .expect("metacharacter checkpoint");
    let other = git
        .checkpoint(regex_lookalike, "other\n", Some("Other"))
        .expect("lookalike checkpoint");
    assert_eq!(git.list_unlocked(literal, 5).unwrap(), vec![first.clone()]);
    assert_eq!(git.list_unlocked(regex_lookalike, 5).unwrap(), vec![other]);

    // An empty named checkpoint is only reachable through its trailer. A
    // later checkpoint whose path extends this one matches the fixed-string
    // grep too, and must not crowd it out of a bounded window.
    let named = git
        .checkpoint(literal, "one\n", Some("Named"))
        .expect("named empty checkpoint");
    let extended = format!("{literal}.bak");
    for index in 0..3 {
        git.checkpoint(&extended, &format!("{index}\n"), None)
            .expect("extended checkpoint");
    }
    assert_eq!(git.list_unlocked(literal, 1).unwrap(), vec![named.clone()]);
    let both = git.list_unlocked(literal, 2).unwrap();
    assert_eq!(both.len(), 2);
    assert_eq!(ids_of(&both), ids_of(&[first, named]));
    assert_eq!(
        git.list_unlocked(&extended, DEFAULT_HISTORY_LIMIT)
            .unwrap()
            .len(),
        3
    );
}

fn ids_of(versions: &[SourceHistoryVersion]) -> HashSet<String> {
    versions.iter().map(|version| version.id.clone()).collect()
}
