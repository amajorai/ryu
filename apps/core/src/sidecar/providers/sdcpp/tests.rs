use super::model::{
    default_image_path, installed_default_image, launch_refusal, loaded_bytes, model_flag,
    sdxl_companions, video_inputs_for,
};
use super::*;

/// Image and video generation call `start()` on every request. With our own
/// child already serving, that repeat start must not brand it an adopted
/// external server, or the next stop() (a diffusion-model switch, uninstall)
/// would leave the old child running.
#[cfg(unix)]
#[tokio::test]
async fn repeat_start_with_our_child_running_keeps_ownership() {
    let manager = StableDiffusionManager::new();
    manager
        .process
        .start_path_with_args("sleep", &["30".to_owned()])
        .await
        .expect("spawn stand-in child");

    manager.start().await.expect("repeat start is a no-op");
    assert!(!manager.adopted_external.load(Ordering::Relaxed));

    manager.stop().await.expect("stop our child");
    assert!(!manager.process.is_running());
}

/// The media engine's port is pinned (release 8101, dev 9101) and no longer
/// shares the classify tier's 8083.
#[test]
fn sd_port_base_is_pinned_and_distinct_from_classify() {
    assert_eq!(SD_PORT_BASE, 8101);
    assert_eq!(crate::profile::port_for(SD_PORT_BASE, "dev"), 9101);
    assert_ne!(
        SD_PORT_BASE,
        super::super::llamacpp::classify::CLASSIFY_PORT_BASE
    );
}

#[test]
fn qwen_image_defaults_load_text_vision_and_vae_companions() {
    let args = companion_args(ModelKind::DefaultImage);
    let flags: Vec<&str> = args.iter().map(|(flag, _)| flag.as_str()).collect();
    assert_eq!(flags, ["--llm", "--llm_vision", "--vae"]);
    assert!(args[0].1.ends_with("Qwen3VL-8B-Instruct-Q4_K_M.gguf"));
    assert!(args[1].1.ends_with("mmproj-Qwen3VL-8B-Instruct-F16.gguf"));
    assert!(args[2].1.ends_with("qwen_image_2.1_vae_bf16.safetensors"));
}

/// The Lite checkpoint embeds both encoders, so it launches with `-m` alone;
/// an older SDXL install that left its CLIP files keeps passing them.
#[test]
fn sdxl_clip_companions_are_passed_only_when_present() {
    let dir = tempfile::tempdir().unwrap();
    let clip_l = dir.path().join("sdxl_clip_l.safetensors");
    let clip_g = dir.path().join("sdxl_clip_g.safetensors");

    assert!(sdxl_companions(clip_l.clone(), clip_g.clone()).is_empty());

    std::fs::write(&clip_g, b"g").unwrap();
    let args = sdxl_companions(clip_l.clone(), clip_g.clone());
    let flags: Vec<&str> = args.iter().map(|(flag, _)| flag.as_str()).collect();
    assert_eq!(flags, ["--clip_g"]);

    std::fs::write(&clip_l, b"l").unwrap();
    let args = sdxl_companions(clip_l.clone(), clip_g.clone());
    let flags: Vec<&str> = args.iter().map(|(flag, _)| flag.as_str()).collect();
    assert_eq!(flags, ["--clip_l", "--clip_g"]);
    assert_eq!(args[0].1, clip_l);
    assert_eq!(args[1].1, clip_g);
}

#[test]
fn installed_standard_wins_unless_ram_rules_it_out() {
    use ModelKind::{DefaultImage, LiteImage};
    assert_eq!(
        installed_default_image(true, true, Some(true)),
        Some(DefaultImage)
    );
    // An unknown RAM reading never discards an existing install.
    assert_eq!(
        installed_default_image(true, false, None),
        Some(DefaultImage)
    );
    // Known too small: fall to the Lite checkpoint when it is there…
    assert_eq!(
        installed_default_image(true, true, Some(false)),
        Some(LiteImage)
    );
    // …and to nothing (the tier decides what to install) when it is not.
    assert_eq!(installed_default_image(true, false, Some(false)), None);
    assert_eq!(
        installed_default_image(false, true, Some(true)),
        Some(LiteImage)
    );
    assert_eq!(installed_default_image(false, false, Some(true)), None);
    assert_eq!(default_image_path(LiteImage), downloader::lite_model_path());
    assert_eq!(
        default_image_path(DefaultImage),
        downloader::default_model_path()
    );
}

#[test]
fn only_a_none_tier_turns_into_the_cloud_refusal() {
    let none = downloader::ImageTierChoice {
        tier: downloader::ImageTier::None,
        downgrade_reason: Some("only 2.0 GB of memory".into()),
    };
    let message = unavailable_message(&none).expect("none tier refuses");
    assert!(message.contains("only 2.0 GB of memory"), "{message}");
    assert!(message.contains("cloud image provider"), "{message}");
    let lite = downloader::ImageTierChoice {
        tier: downloader::ImageTier::Lite,
        downgrade_reason: Some("x".into()),
    };
    assert_eq!(unavailable_message(&lite), None);
}

#[test]
fn loaded_bytes_sums_the_model_and_present_companions() {
    let dir = tempfile::tempdir().unwrap();
    let model = dir.path().join("m.gguf");
    let vae = dir.path().join("vae.safetensors");
    std::fs::write(&model, [0u8; 10]).unwrap();
    std::fs::write(&vae, [0u8; 5]).unwrap();
    let companions = vec![
        ("--vae".to_string(), vae),
        ("--llm".to_string(), dir.path().join("absent.gguf")),
    ];
    assert_eq!(loaded_bytes(&model, &companions), 15);
}

#[test]
fn frame_model_launch_bytes_count_the_whole_a14b_pair() {
    use frame_models::WanFrameModel;
    let dir = tempfile::tempdir().unwrap();
    let low = dir.path().join("Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf");
    let high = dir.path().join("Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf");
    std::fs::write(&low, [0u8; 7]).unwrap();
    std::fs::write(&high, [0u8; 11]).unwrap();
    let kind = ModelKind::FrameVideo(WanFrameModel::Wan22I2vA14b);
    // The pair counts in full (plus any companion a dev machine has on disk);
    // measuring only the model would report 7.
    assert!(launch_loaded_bytes(kind, &low, &companion_args(kind)) >= 18);
    // A single-transformer model keeps the plain sum.
    assert_eq!(
        launch_loaded_bytes(ModelKind::Other, &low, &companion_args(ModelKind::Other)),
        7
    );
}

#[test]
fn split_qwen_image_and_wan_models_load_as_standalone_diffusion_models() {
    assert_eq!(model_flag(ModelKind::DefaultImage), "--diffusion-model");
    assert_eq!(model_flag(ModelKind::KnownImage), "--diffusion-model");
    assert_eq!(model_flag(ModelKind::KnownVideo), "--diffusion-model");
    assert_eq!(
        model_flag(ModelKind::FrameVideo(frame_models::WanFrameModel::Wan21I2v)),
        "--diffusion-model"
    );
    assert_eq!(model_flag(ModelKind::LiteImage), "-m");
    assert_eq!(model_flag(ModelKind::Sdxl), "-m");
    assert_eq!(model_flag(ModelKind::EnvOverride), "-m");
    assert_eq!(model_flag(ModelKind::Other), "-m");
}

async fn models_fixture(model_id: &'static str) -> u16 {
    use axum::{routing::get, Json, Router};
    let app = Router::new().route(
        "/v1/models",
        get(move || async move {
            Json(serde_json::json!({ "data": [{ "id": model_id, "object": "model" }] }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

/// A long-lived stand-in for the spawned child, so readiness sees it alive.
/// Windows has no `sleep` binary; `ping -n 31` to loopback waits ~30 s.
async fn sleeping_child() -> ProcessHandle {
    let (program, args): (&str, Vec<String>) = if cfg!(windows) {
        (
            "ping",
            ["-n", "31", "127.0.0.1"].map(str::to_owned).to_vec(),
        )
    } else {
        ("sleep", vec!["30".to_owned()])
    };
    let process = ProcessHandle::new();
    process
        .start_path_with_args(program, &args)
        .await
        .expect("spawn sleeping child");
    process
}

#[tokio::test]
async fn sd_server_readiness_requires_its_models_identity() {
    let client = reqwest::Client::new();
    let stderr = super::super::readiness::StderrTail::default();
    let timeout = std::time::Duration::from_secs(5);

    let process = sleeping_child().await;
    let port = models_fixture(SD_SERVER_MODEL_ID).await;
    wait_for_sd_server(&client, port, &process, &stderr, timeout)
        .await
        .expect("sd-server listing sd-cpp-local is ready");

    // A llama.cpp server (e.g. the classify tier) answering on the port is
    // not sd-server, even though a TCP connect would have succeeded.
    let port = models_fixture("gemma-3-270m-it-qat-Q4_0").await;
    let error = wait_for_sd_server(&client, port, &process, &stderr, timeout)
        .await
        .expect_err("a foreign listener must not count as ready");
    assert!(
        error.to_string().contains("served model mismatch"),
        "{error:#}"
    );
    let _ = process.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn sd_server_exit_fails_fast_with_its_stderr_tail() {
    let client = reqwest::Client::new();
    let stderr = super::super::readiness::StderrTail::default();
    let process = ProcessHandle::new();
    process
        .start_path_with_args_capturing_stderr(
            "sh",
            &[
                "-c".to_owned(),
                "echo 'error: failed to load diffusion model' >&2; exit 1".to_owned(),
            ],
            "sdcpp-test",
            stderr.clone(),
        )
        .await
        .expect("spawn sh");
    // Port 9 (discard) is never an sd-server; the child exit must win long
    // before the 60 s timeout.
    let started = std::time::Instant::now();
    let error = wait_for_sd_server(
        &client,
        9,
        &process,
        &stderr,
        std::time::Duration::from_secs(60),
    )
    .await
    .expect_err("exited child is not ready");
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    let message = format!("{error:#}");
    assert!(
        message.contains("exited before becoming ready"),
        "{message}"
    );
    assert!(
        message.contains("failed to load diffusion model"),
        "{message}"
    );
}

#[test]
fn image_and_video_weights_live_in_their_own_modality_dirs() {
    assert!(downloader::default_model_path()
        .parent()
        .unwrap()
        .ends_with("models/image/sdcpp"));
    // The Qwen3-VL text encoder belongs with the image weights, not with
    // the chat models the catalog scans.
    assert!(downloader::image_llm_path()
        .parent()
        .unwrap()
        .ends_with("models/image/sdcpp"));
    assert!(downloader::video_t5xxl_path()
        .parent()
        .unwrap()
        .ends_with("models/video/sdcpp"));
    // Wan frame-model companions sit with the other Wan weights.
    for companion in [
        downloader::video_clip_vision_path(),
        downloader::video_wan22_vae_path(),
    ] {
        assert!(companion.parent().unwrap().ends_with("models/video/sdcpp"));
    }
    assert!(downloader::server_binary_path()
        .parent()
        .unwrap()
        .ends_with("engines/image/sdcpp"));
}

#[test]
fn only_recognized_frame_models_report_local_frame_support() {
    use frame_models::WanFrameModel;
    use ryu_image::video::LocalVideoInputs;
    let dir = std::env::temp_dir().join(format!("ryu-sd-frames-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let flf2v = dir.join("wan2.1-flf2v-14b-720p-Q4_K_M.gguf");
    std::fs::write(&flf2v, b"weights").unwrap();

    // A recognized frame model reports its frames.
    assert_eq!(
        video_inputs_for(ModelKind::FrameVideo(WanFrameModel::Wan21Flf2v), &flf2v),
        LocalVideoInputs {
            first_frame: true,
            last_frame: true
        }
    );
    // The same file loaded without companions (`RYU_SD_MODEL`, or an
    // unrecognized preference) cannot use frames.
    for kind in [ModelKind::Other, ModelKind::EnvOverride] {
        assert_eq!(video_inputs_for(kind, &flf2v), LocalVideoInputs::default());
    }
    // The default text-to-video and image models are text-only.
    assert_eq!(
        video_inputs_for(ModelKind::KnownVideo, &downloader::video_model_path()),
        LocalVideoInputs::default()
    );
    assert_eq!(
        video_inputs_for(ModelKind::DefaultImage, &downloader::default_model_path()),
        LocalVideoInputs::default()
    );
    // Half of an A14B pair cannot launch, so it claims nothing.
    let low = dir.join("Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf");
    std::fs::write(&low, b"weights").unwrap();
    assert_eq!(
        video_inputs_for(ModelKind::FrameVideo(WanFrameModel::Wan22I2vA14b), &low),
        LocalVideoInputs::default()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn frame_models_launch_with_diffusion_model_instead_of_m() {
    use frame_models::WanFrameModel;
    let model = std::path::Path::new("/models/wan2.1-i2v-14b-480p-Q4_K_M.gguf");
    let args = model_args(ModelKind::FrameVideo(WanFrameModel::Wan21I2v), model).unwrap();
    assert_eq!(args[..2], ["--diffusion-model", &*model.to_string_lossy()]);
    assert!(args.iter().any(|arg| arg == "--clip_vision"));
    assert!(!args.iter().any(|arg| arg == "-m"));

    let image = model_args(ModelKind::DefaultImage, &downloader::default_model_path()).unwrap();
    assert_eq!(image[0], "--diffusion-model");
    assert!(image.iter().any(|arg| arg == "--llm"));
}

#[test]
fn an_incomplete_a14b_pair_is_refused_as_the_active_model() {
    // Only the low-noise half is installed, so the launch plan fails and
    // the switch must refuse it before the sidecar downloads anything.
    let dir = std::env::temp_dir().join(format!("ryu-sd-activate-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let stem = "Wan2.2-I2V-A14B-LowNoise-Q4_K_M";
    let low = dir.join(format!("{stem}.gguf"));
    std::fs::write(&low, b"weights").unwrap();
    let reason = launch_refusal(stem, &low).expect("incomplete pair refused");
    assert!(
        reason.contains("Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf"),
        "{reason}"
    );
    std::fs::write(dir.join("Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf"), b"w").unwrap();
    assert_eq!(launch_refusal(stem, &low), None);
    // Non-frame models are never refused here.
    for other in [
        downloader::IMAGE_DEFAULT_STEM,
        downloader::VIDEO_DEFAULT_STEM,
    ] {
        assert_eq!(
            launch_refusal(other, &dir.join(format!("{other}.gguf"))),
            None
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn video_model_still_receives_its_separate_vae() {
    let args = companion_args(ModelKind::KnownVideo);
    assert!(args.iter().any(|(flag, _)| flag == "--t5xxl"));
    assert!(args.iter().any(|(flag, _)| flag == "--vae"));
}
