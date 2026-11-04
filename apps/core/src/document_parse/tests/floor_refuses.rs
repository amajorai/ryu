use super::*;

/// The mounted route is registered, by literal path AND by handler.
///
/// Both halves matter and neither implies the other: the path string alone
/// could be a doc comment, and the handler alone could be a re-export. This
/// pair is what failed before — the handler existed, carried its `utoipa`
/// annotation and was `pub`, and simply appeared in no route table, so the
/// desktop's only reader of it 404'd and rendered an empty panel.
#[test]
fn parse_capability_is_registered_in_the_route_table() {
    assert!(
        is_registered("/api/documents/parse/capability"),
        "the capability route's path must appear in the route table"
    );
    assert!(
        SERVER_MOD_SRC.contains("get(crate::document_parse::parse_capability)"),
        "the capability path must be wired to THIS handler"
    );
}

/// The submit and poll routes are registered and wired to these handlers, and
/// neither still carries the `#[allow(dead_code)]` gate it had while unmounted
/// (a live route documented as dead code misleads the next reader).
#[test]
fn the_submit_and_poll_handlers_are_mounted_and_ungated() {
    // The module is split across `document_parse/*.rs`; read all of it.
    let this_file = concat!(
        include_str!("../blob_submit.rs"),
        include_str!("../decode_parse.rs"),
        include_str!("../mime_floor.rs"),
        include_str!("../mod.rs"),
        include_str!("../parse_failure.rs"),
        include_str!("../provider_resolution.rs"),
        include_str!("../routes.rs"),
    );
    for (handler, path) in [
        ("parse_document", "/api/documents/parse"),
        ("parse_job", "/api/documents/parse/jobs/:job_id"),
    ] {
        let signature = format!("pub async fn {handler}(");
        let declaration = this_file
            .find(&signature)
            .unwrap_or_else(|| panic!("{handler} is declared in this module"));
        let preamble = &this_file[declaration.saturating_sub(200)..declaration];
        assert!(
            !preamble.contains("#[allow(dead_code)]"),
            "{handler} is mounted, so it must not be gated as dead code"
        );
        assert!(
            is_registered(path),
            "{handler} must be registered at {path}"
        );
        assert!(
            SERVER_MOD_SRC.contains(&format!("crate::document_parse::{handler}")),
            "{path} must be wired to {handler}"
        );
    }
    assert!(
        SERVER_MOD_SRC.contains(
            "uploads::DOCUMENT_PARSE_BODY_LIMIT.apply(post(crate::document_parse::parse_document))"
        ),
        "the submit route must carry its explicit body limit"
    );
}

/// The number the desktop's parsing panel prints is the node's real ceiling.
///
/// `max_input_bytes` in the capability response is [`MAX_PARSE_BYTES`], and a
/// document only reaches a parser by being uploaded first, so the two must not
/// drift: a panel that printed a parse ceiling above the upload ceiling would
/// promise a file size the node refuses at the door.
#[test]
fn the_reported_parse_ceiling_is_the_upload_ceiling() {
    assert_eq!(MAX_PARSE_BYTES, crate::server::uploads::MAX_UPLOAD_BYTES);
}

#[test]
fn extension_of_takes_the_last_dot_lowercased() {
    assert_eq!(extension_of("Report.PDF"), ".pdf");
    assert_eq!(extension_of("/tmp/a.b/notes.md"), ".md");
    assert_eq!(extension_of("archive.tar.gz"), ".gz");
    assert_eq!(extension_of("noext"), "");
    assert_eq!(extension_of("trailing."), "");
}

#[test]
fn floor_claims_text_families_and_refuses_real_documents() {
    assert!(is_builtin_readable("notes.md"));
    assert!(is_builtin_readable("data.CSV"));
    // The floor must never claim a format it would mangle.
    assert!(!is_builtin_readable("report.pdf"));
    assert!(!is_builtin_readable("deck.pptx"));
    assert!(!is_builtin_readable("scan.png"));
}

#[test]
fn builtin_markdown_refuses_non_utf8_rather_than_producing_mojibake() {
    assert!(builtin_markdown("a.txt", b"hello").is_some());
    assert!(builtin_markdown("a.txt", &[0xff, 0xfe, 0x00, 0x41]).is_none());
}

#[test]
fn html_is_tag_stripped_and_script_bodies_are_dropped() {
    let html = "<html><head><style>p{color:red}</style></head><body>\
             <h1>Title</h1><p>Body &amp; more</p><script>alert('x')</script></body></html>";
    let (md, _) = builtin_markdown("page.html", html.as_bytes()).expect("utf-8");
    assert!(md.contains("Title"), "{md}");
    assert!(md.contains("Body & more"), "{md}");
    assert!(!md.contains("color:red"), "style body survived: {md}");
    assert!(!md.contains("alert"), "script body survived: {md}");
    assert!(!md.contains('<'), "markup survived: {md}");
}

#[test]
fn amp_entity_is_decoded_last_so_double_encoding_survives() {
    assert_eq!(strip_html("<p>&amp;lt;</p>"), "&lt;");
}

#[test]
fn typed_floor_reports_a_lossy_decode_instead_of_hiding_it() {
    // A line of prose with one byte from some other encoding in it — a latin-1
    // accent, a truncated write. That is still a text file, so it decodes with the
    // compromise recorded rather than being refused.
    //
    // The fixture used to be `b"hi\xff"`, which no longer qualifies: one bad byte
    // in three is 33% of the decoded characters, over `MAX_REPLACEMENT_RATIO`, and
    // a file that is a third replacement characters is not a file whose text we
    // recovered. The invariant this test is named for — a compromise is REPORTED,
    // never silent — is unchanged and is what the assertions below still check.
    let mut bytes = b"the colony subsists on native grasses".to_vec();
    bytes.push(0xff);
    bytes.extend_from_slice(b" and succulents.");
    let outcome = builtin_parse("a.txt", &bytes).expect("lossy floor answers");
    assert!(outcome.markdown.starts_with("the colony"));
    assert!(outcome.markdown.ends_with("succulents."));
    assert_eq!(outcome.warnings.len(), 1, "{:?}", outcome.warnings);
    assert!(outcome.warnings[0].contains("not valid UTF-8"));
    assert_eq!(outcome.backend_id, BUILTIN_BACKEND_ID);
}

#[test]
fn the_floor_refuses_bytes_that_are_not_text_rather_than_decoding_them_lossily() {
    // The defect: `is_builtin_readable` is keyed on the NAME, and the name is
    // client-supplied, so binary bytes under a floor extension reached the lossy
    // decoder and their mojibake was stored as the document's contents.
    //
    // Two signals, one case each. A NUL byte (every real container has one in its
    // header) and an undecodable-character share over the threshold (for the
    // formats that do not, like a bare `%PDF` header).
    for (name, bytes) in [
        ("payload.txt", b"PK\x03\x04\x14\x00\x00\x00".to_vec()),
        ("logo.txt", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec()),
        ("report.txt", b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec()),
    ] {
        let err =
            builtin_parse(name, &bytes).expect_err("binary bytes must not decode into a document");
        assert_eq!(err.reason, ParseFailureReason::NotText, "{name}");
        assert_eq!(err.reason.code(), "not_text");
        assert!(
            err.message.contains("not text"),
            "the user has to be told what actually happened: {}",
            err.message
        );
    }
}

#[test]
fn a_bomless_utf16_file_is_refused_rather_than_read_as_nul_separated_ascii() {
    // UTF-16LE ASCII is `A\0B\0…`, which IS valid UTF-8 — so the strict arm used to
    // accept it, with no warning at all, and store a string full of NULs. The NUL
    // probe runs before the UTF-8 arm precisely for this.
    let mut bytes = Vec::new();
    for unit in "hello there".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let err = builtin_parse("a.txt", &bytes).expect_err("NUL-riddled bytes are not text");
    assert_eq!(err.reason, ParseFailureReason::NotText);
    // And the BOM'd form of the same content still decodes, because the UTF-16 arm
    // is deliberately ahead of the probe. Refusing that would be a regression.
    let mut bommed = vec![0xFF, 0xFE];
    bommed.extend_from_slice(&bytes);
    assert_eq!(
        builtin_parse("a.txt", &bommed)
            .expect("BOM'd UTF-16 still reads")
            .markdown,
        "hello there"
    );
}

#[test]
fn typed_floor_decodes_bom_utf16_without_replacement_characters() {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "héllo".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let outcome = builtin_parse("a.txt", &bytes).expect("utf-16 floor answers");
    assert_eq!(outcome.markdown, "héllo");
    assert!(!outcome.markdown.contains('\u{FFFD}'));
}

#[test]
fn typed_floor_refuses_a_binary_format_instead_of_returning_empty() {
    let err = builtin_parse("report.pdf", b"%PDF-1.7").expect_err("no floor for pdf");
    assert_eq!(err.reason, ParseFailureReason::Unsupported);
}

#[test]
fn typed_floor_reports_source_sha_of_the_input_bytes() {
    let outcome = builtin_parse("a.md", b"hello").expect("floor");
    // sha256("hello")
    assert_eq!(
        outcome.source_sha256,
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
}

// ── The mime floor fallback ───────────────────────────────────────────────

#[test]
fn a_title_with_no_extension_reaches_the_floor_through_its_mime() {
    // The defect: `POST /api/spaces/:id/files` and `artifact.create` pass a
    // TITLE, so a plain-text note called `notes` answered `false` to the
    // extension-keyed floor and was sent to a provider that would refuse it —
    // `skipped/no_provider`, "install a document parser", for a file Core reads
    // itself in microseconds.
    assert!(!is_builtin_readable("notes"));
    assert_eq!(
        mime_floor_name("notes", "text/plain").as_deref(),
        Some("notes.txt")
    );
    assert!(is_builtin_readable(
        &mime_floor_name("notes", "text/plain").unwrap()
    ));
    // A charset parameter and odd casing are the same media type.
    assert_eq!(
        mime_floor_name("Q3 summary", "Text/Plain; charset=utf-8").as_deref(),
        Some("Q3 summary.txt")
    );
    assert_eq!(
        mime_floor_name("data", "text/csv").as_deref(),
        Some("data.csv")
    );
    assert_eq!(
        mime_floor_name("page", "text/html").as_deref(),
        Some("page.html")
    );
}

#[test]
fn the_mime_fallback_never_redirects_a_binary_into_the_text_reader() {
    // ── Arm one: inputs that DECLARE themselves binary are not given a floor name.
    //
    // A mime is client-supplied; when it disagrees with an extension the floor
    // already refused, honouring it would hand a zip container to the decoder.
    assert_eq!(mime_floor_name("deck.pptx", "text/plain"), None);
    assert_eq!(mime_floor_name("report.pdf", "text/markdown"), None);
    // Nothing binary-ish maps at all, extension or not.
    assert_eq!(mime_floor_name("scan", "application/pdf"), None);
    assert_eq!(mime_floor_name("blob", "application/octet-stream"), None);
    assert_eq!(mime_floor_name("archive", "application/zip"), None);
    // `application/octet-stream` is what `POST /api/spaces/:id/files` DEFAULTS to
    // when a client sends no mime, so a hit on it would widen the floor to every
    // untyped upload — the single worst case.
    assert_eq!(mime_floor_name("notes", ""), None);
    // An extension that is already on the floor needs no fallback and gets none:
    // arm one has already claimed it.
    assert_eq!(mime_floor_name("notes.md", "text/markdown"), None);

    // ── Arm two: binary BYTES that the fallback DOES accept a name for.
    //
    // This half is why the test was rewritten. Its name claims the fallback never
    // redirects a binary into the text reader, and every assertion above is about
    // a binary-*declaring* input — the case the name check catches. It never fed
    // binary bytes down the path the fallback ACCEPTS, which is the only path that
    // could break the invariant, and that path was broken the whole time: title and
    // mime are independent client input, so `notes` + `text/plain` holding a zip got
    // the floor name `notes.txt`, decoded lossily, and stored a page of replacement
    // characters as the document's contents.
    //
    // The floor name is still handed out here — a title with no extension
    // contradicts nothing, so there is nothing for `mime_floor_name` to refuse on.
    // The refusal is the decoder's, one layer down, and that is what this asserts.
    for (mime, bytes) in [
        ("text/plain", b"PK\x03\x04\x14\x00\x00\x00".to_vec()),
        ("text/csv", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec()),
        ("text/markdown", b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec()),
    ] {
        let floor_name =
            mime_floor_name("notes", mime).expect("an extensionless title still gets a name");
        assert!(is_builtin_readable(&floor_name));
        let err = builtin_parse(&floor_name, &bytes)
            .expect_err("binary bytes must not become a document's text");
        assert_eq!(err.reason, ParseFailureReason::NotText, "{mime}");
    }

    // The control: the same accepted path with bytes that ARE text still reads,
    // which is the whole point of the fallback and must not be collateral damage.
    let floor_name = mime_floor_name("notes", "text/plain").unwrap();
    assert_eq!(
        builtin_parse(&floor_name, b"quokkas are small macropods")
            .expect("real text still reaches the floor")
            .markdown,
        "quokkas are small macropods"
    );
}

#[test]
fn every_mime_fallback_lands_on_an_extension_the_floor_already_reads() {
    // The invariant that makes this table safe to extend: it may only re-route a
    // document to a reader Core would have used anyway, never introduce a family.
    for (mime, ext) in MIME_FLOOR_EXTENSIONS {
        assert!(
            BUILTIN_EXTENSIONS.contains(ext),
            "{mime} maps to {ext}, which is not on the floor"
        );
        assert!(
            is_builtin_readable(&format!("x{ext}")),
            "{ext} does not survive the floor's own check"
        );
    }
}

#[test]
fn crash_leftovers_go_at_startup_and_abandoned_jobs_release_their_input() {
    let dir = crate::paths::tmp_dir_for(PARSE_TMP_OWNER);
    std::fs::create_dir_all(&dir).unwrap();
    // A fresh plaintext copy a killed Core left behind.
    let leftover = dir.join(format!("{}.pdf", uuid::Uuid::new_v4().simple()));
    std::fs::write(&leftover, b"plaintext left by a crash").unwrap();
    // A copy a running job still needs.
    let live_path = dir.join(format!("{}.pdf", uuid::Uuid::new_v4().simple()));
    let live = DecryptedBlobInput::claim(live_path.clone());
    std::fs::write(&live_path, b"in use").unwrap();

    sweep_on_start();
    assert!(!leftover.exists(), "a leftover of any age is removed");
    assert!(live_path.exists(), "a live job's input is kept");

    // The poller gives up: the input goes now, not hours later.
    let job_id = format!("job-{}", uuid::Uuid::new_v4().simple());
    pending_parse_inputs()
        .lock()
        .unwrap()
        .insert(job_id.clone(), live);
    release_input(&job_id);
    assert!(!live_path.exists(), "an abandoned job's input is deleted");
    assert!(!live_parse_inputs().lock().unwrap().contains(&live_path));
}
