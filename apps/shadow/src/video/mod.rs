use anyhow::Result;
use std::path::{Path, PathBuf};

use crate::capture::screen::Frame;

/// H.265 fragmented MP4 video encoder.
/// Requires ffmpeg-next feature and FFmpeg system libraries.
pub struct VideoEncoder {
    output_dir: PathBuf,
    display_id: u32,
    target_fps: f64,
    bitrate_kbps: u32,

    // Current segment state
    current_segment_path: Option<PathBuf>,
    segment_start_ts: Option<u64>,
    segment_frame_count: u32,
    frames_since_key: u32,

    #[cfg(feature = "video")]
    encoder_ctx: Option<ffmpeg_next::codec::encoder::video::Video>,
    #[cfg(feature = "video")]
    output_ctx: Option<ffmpeg_next::format::context::Output>,
}

impl VideoEncoder {
    /// Create a new encoder for a display.
    pub fn new(output_dir: &Path, display_id: u32) -> Result<Self> {
        #[cfg(feature = "video")]
        ffmpeg_next::init()?;

        std::fs::create_dir_all(output_dir)?;

        Ok(Self {
            output_dir: output_dir.to_path_buf(),
            display_id,
            target_fps: 0.5,
            bitrate_kbps: 300,
            current_segment_path: None,
            segment_start_ts: None,
            segment_frame_count: 0,
            frames_since_key: 0,
            #[cfg(feature = "video")]
            encoder_ctx: None,
            #[cfg(feature = "video")]
            output_ctx: None,
        })
    }

    /// Ingest a frame. Starts a new segment if needed.
    pub fn encode_frame(&mut self, frame: &Frame) -> Result<()> {
        // Start new segment if needed (hourly rotation)
        let should_rotate = match self.segment_start_ts {
            None => true,
            Some(start) => frame.timestamp - start >= 3600 * 1_000_000, // 1 hour
        };

        if should_rotate {
            self.rotate_segment(frame.timestamp, frame.width, frame.height)?;
        }

        self.segment_frame_count += 1;
        self.frames_since_key += 1;

        #[cfg(feature = "video")]
        {
            self.encode_frame_ffmpeg(frame)?;
        }

        #[cfg(not(feature = "video"))]
        {
            // Without FFmpeg, just log
            tracing::trace!(
                "Video frame {}: display={}, ts={}",
                self.segment_frame_count,
                frame.display_id,
                frame.timestamp
            );
        }

        Ok(())
    }

    fn rotate_segment(&mut self, ts: u64, width: u32, height: u32) -> Result<()> {
        // Finalize previous segment
        if let Some(path) = self.current_segment_path.take() {
            #[cfg(feature = "video")]
            self.finalize_segment()?;
            tracing::info!("Video segment closed: {:?}", path);
            shadow_core::finalize_video_segment(path.to_string_lossy().to_string(), ts)?;
        }

        // Start new segment
        let ts_secs = ts / 1_000_000;
        let dt =
            chrono::DateTime::from_timestamp(ts_secs as i64, 0).unwrap_or_else(chrono::Utc::now);
        let filename = format!(
            "display-{}/{}.mp4",
            self.display_id,
            dt.format("%Y-%m-%dT%H")
        );
        let path = self.output_dir.join(&filename);
        std::fs::create_dir_all(path.parent().unwrap())?;

        self.current_segment_path = Some(path.clone());
        self.segment_start_ts = Some(ts);
        self.segment_frame_count = 0;
        self.frames_since_key = 0;

        #[cfg(feature = "video")]
        self.open_segment_ffmpeg(&path, width, height)?;

        shadow_core::insert_video_segment(self.display_id, ts, path.to_string_lossy().to_string())?;

        tracing::info!("Video segment started: {:?}", path);
        Ok(())
    }

    #[cfg(feature = "video")]
    fn open_segment_ffmpeg(&mut self, path: &Path, width: u32, height: u32) -> Result<()> {
        use ffmpeg_next::codec::encoder;
        use ffmpeg_next::codec::Id;
        use ffmpeg_next::format::output;
        use ffmpeg_next::util::format::pixel::Pixel;
        use ffmpeg_next::Rational;

        let mut output_ctx = output(path)?;

        let codec = ffmpeg_next::encoder::find(Id::HEVC)
            .ok_or_else(|| anyhow::anyhow!("H.265 encoder not found"))?;

        let mut stream = output_ctx.add_stream(codec)?;
        let mut encoder = codec.video()?;

        encoder.set_width(width);
        encoder.set_height(height);
        encoder.set_format(Pixel::YUV420P);
        encoder.set_frame_rate(Some(Rational::new(1, 2))); // 0.5 fps
        encoder.set_time_base(Rational::new(1, 1_000_000)); // microseconds
        encoder.set_bit_rate(self.bitrate_kbps as usize * 1000);

        // Fragmented MP4 for streaming-friendly output
        let opts = ffmpeg_next::Dictionary::from_str("movflags=+frag_keyframe+empty_moov")?;
        let encoder = encoder.open_as_with(codec, opts)?;

        stream.set_parameters(&encoder);

        self.encoder_ctx = Some(encoder);
        self.output_ctx = Some(output_ctx);
        Ok(())
    }

    #[cfg(feature = "video")]
    fn encode_frame_ffmpeg(&mut self, frame: &Frame) -> Result<()> {
        use ffmpeg_next::frame::Video;
        use ffmpeg_next::software::scaling::{context::Context as SwsContext, flag::Flags};
        use ffmpeg_next::util::format::pixel::Pixel;

        let encoder = self
            .encoder_ctx
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Encoder not initialized"))?;

        // Create source frame (BGRA)
        let mut src_frame = Video::new(Pixel::BGRA, frame.width, frame.height);
        src_frame.data_mut(0).copy_from_slice(&frame.data);

        // Scale to YUV420P
        let mut sws = SwsContext::get(
            Pixel::BGRA,
            frame.width,
            frame.height,
            Pixel::YUV420P,
            frame.width,
            frame.height,
            Flags::BILINEAR,
        )?;
        let mut dst_frame = Video::new(Pixel::YUV420P, frame.width, frame.height);
        sws.run(&src_frame, &mut dst_frame)?;
        dst_frame.set_pts(Some(frame.timestamp as i64));

        encoder.send_frame(&dst_frame)?;
        self.flush_encoder()
    }

    #[cfg(feature = "video")]
    fn flush_encoder(&mut self) -> Result<()> {
        use ffmpeg_next::codec::packet::Packet;

        let encoder = self.encoder_ctx.as_mut().unwrap();
        let output = self.output_ctx.as_mut().unwrap();
        let mut packet = Packet::empty();

        while encoder.receive_packet(&mut packet).is_ok() {
            packet.write_interleaved(output)?;
        }
        Ok(())
    }

    #[cfg(feature = "video")]
    fn finalize_segment(&mut self) -> Result<()> {
        if let Some(encoder) = &mut self.encoder_ctx {
            encoder.send_eof()?;
        }
        self.flush_encoder()?;
        if let Some(output) = &mut self.output_ctx {
            output.write_trailer()?;
        }
        self.encoder_ctx = None;
        self.output_ctx = None;
        Ok(())
    }

    pub fn current_segment_path(&self) -> Option<&Path> {
        self.current_segment_path.as_deref()
    }

    /// Save a single frame as a JPEG keyframe and register it in the timeline.
    ///
    /// This is the pure-Rust path (the `image` crate, no ffmpeg) that makes the
    /// timeline scrubber show real screenshots out of the box — independent of
    /// the optional `video` feature. The frame is BGRA and tightly packed
    /// (`width * height * 4`, row pitch already stripped by the capturer); we
    /// swap B/R, drop alpha, downscale wide frames to keep JPEGs small, and write
    /// to `<data>/media/keyframes/display-<id>/<ts>.jpg`.
    pub fn save_keyframe(&self, frame: &Frame) -> Result<()> {
        // Keyframes live beside the video dir under media/keyframes.
        let keyframes_root = self
            .output_dir
            .parent()
            .map(|p| p.join("keyframes"))
            .unwrap_or_else(|| self.output_dir.join("keyframes"));
        let out_dir = keyframes_root.join(format!("display-{}", self.display_id));
        std::fs::create_dir_all(&out_dir)?;

        let (w, h) = (frame.width, frame.height);
        let expected = w as usize * h as usize * 4;
        if frame.data.len() < expected {
            anyhow::bail!(
                "frame buffer too small: {} < {}",
                frame.data.len(),
                expected
            );
        }

        // BGRA -> RGB (drop alpha, swap channels).
        let mut rgb = image::RgbImage::new(w, h);
        for (px, src) in rgb.pixels_mut().zip(frame.data.chunks_exact(4)) {
            *px = image::Rgb([src[2], src[1], src[0]]);
        }

        // Downscale wide frames; the timeline thumbnail renders at 640x360.
        const MAX_WIDTH: u32 = 1280;
        let img = if w > MAX_WIDTH {
            let new_h = ((h as u64 * MAX_WIDTH as u64) / w as u64).max(1) as u32;
            image::imageops::resize(
                &rgb,
                MAX_WIDTH,
                new_h,
                image::imageops::FilterType::Triangle,
            )
        } else {
            rgb
        };

        let path = out_dir.join(format!("{}.jpg", frame.timestamp));
        let mut buf = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
        encoder.encode_image(&img)?;
        std::fs::write(&path, &buf)?;

        shadow_core::insert_keyframe(
            self.display_id,
            frame.timestamp,
            path.to_string_lossy().to_string(),
            "direct".to_string(),
            Some(buf.len() as u64),
        )?;

        Ok(())
    }
}

/// Extracts keyframes from a recorded MP4 segment for retention.
pub struct FrameExtractor {
    output_dir: PathBuf,
}

impl FrameExtractor {
    pub fn new(keyframes_dir: &Path) -> Self {
        Self {
            output_dir: keyframes_dir.to_path_buf(),
        }
    }

    /// Extract keyframes from an MP4 file using ffmpeg CLI.
    pub fn extract_keyframes(&self, mp4_path: &Path) -> Result<Vec<PathBuf>> {
        let stem = mp4_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("segment");
        let out_dir = self.output_dir.join(stem);
        std::fs::create_dir_all(&out_dir)?;

        let output = std::process::Command::new("ffmpeg")
            .args([
                "-i",
                mp4_path.to_str().unwrap_or(""),
                "-vf",
                "select=eq(pict_type\\,I)",
                "-vsync",
                "vfr",
                "-q:v",
                "2",
                out_dir.join("keyframe-%04d.jpg").to_str().unwrap_or(""),
                "-y",
            ])
            .output()
            .map_err(|e| anyhow::anyhow!("ffmpeg not found: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("ffmpeg keyframe extraction failed: {}", stderr);
        }

        let paths: Vec<PathBuf> = std::fs::read_dir(&out_dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "jpg").unwrap_or(false))
            .collect();

        Ok(paths)
    }
}
