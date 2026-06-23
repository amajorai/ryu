use anyhow::Result;
use async_trait::async_trait;
use image::DynamicImage;

/// Platform-independent OCR trait.
#[async_trait]
pub trait OcrEngine: Send + Sync {
    async fn recognize(&self, image: &DynamicImage) -> Result<String>;
}

/// Windows OCR using Windows.Media.Ocr API.
#[cfg(target_os = "windows")]
pub struct WindowsOcr;

#[cfg(target_os = "windows")]
impl WindowsOcr {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
#[async_trait]
impl OcrEngine for WindowsOcr {
    async fn recognize(&self, image: &DynamicImage) -> Result<String> {
        use windows::Globalization::Language;
        use windows::Graphics::Imaging::{BitmapDecoder, SoftwareBitmap};
        use windows::Media::Ocr::OcrEngine as WinOcrEngine;
        use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

        // Encode image to PNG bytes
        let mut png_bytes: Vec<u8> = vec![];
        image.write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )?;

        // Write to IRandomAccessStream
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(&png_bytes)?;
        writer.StoreAsync()?.get()?;
        writer.FlushAsync()?.get()?;
        stream.Seek(0)?;

        // Decode to SoftwareBitmap
        let decoder =
            BitmapDecoder::CreateWithIdAsync(BitmapDecoder::PngDecoderId()?, &stream)?.get()?;
        let software_bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;

        // Create OCR engine (user language)
        let language = Language::CreateLanguage(windows::core::h!("en-US"))?;
        let ocr_engine = WinOcrEngine::TryCreateFromLanguage(&language)?;

        let result = ocr_engine.RecognizeAsync(&software_bitmap)?.get()?;
        Ok(result.Text()?.to_string())
    }
}

/// macOS OCR using Vision framework.
#[cfg(target_os = "macos")]
pub struct MacOsOcr;

#[cfg(target_os = "macos")]
impl MacOsOcr {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

#[cfg(target_os = "macos")]
#[async_trait]
impl OcrEngine for MacOsOcr {
    async fn recognize(&self, image: &DynamicImage) -> Result<String> {
        // Write frame to a temp PNG, invoke the `tesseract` CLI, read result.
        // Requires: brew install tesseract
        let tmp_dir = std::env::temp_dir();
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let in_path = tmp_dir.join(format!("shadow_ocr_{}.png", id));
        let out_base = tmp_dir.join(format!("shadow_ocr_{}", id));
        let out_path = out_base.with_extension("txt");

        let mut buf = Vec::new();
        image.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)?;
        std::fs::write(&in_path, &buf)?;

        let output = tokio::process::Command::new("tesseract")
            .arg(&in_path)
            .arg(&out_base)
            .arg("--psm")
            .arg("3") // fully automatic page segmentation
            .output()
            .await;

        let _ = std::fs::remove_file(&in_path);

        match output {
            Ok(_) => {
                let text = if out_path.exists() {
                    let t = std::fs::read_to_string(&out_path).unwrap_or_default();
                    let _ = std::fs::remove_file(&out_path);
                    t.trim().to_string()
                } else {
                    String::new()
                };
                Ok(text)
            }
            Err(e) => {
                tracing::debug!(
                    "tesseract not available: {} — install with `brew install tesseract`",
                    e
                );
                Ok(String::new())
            }
        }
    }
}

/// Linux OCR using Tesseract.
#[cfg(target_os = "linux")]
pub struct LinuxOcr {
    #[cfg(feature = "tesseract")]
    api: std::sync::Mutex<tesseract::Tesseract>,
}

#[cfg(target_os = "linux")]
impl LinuxOcr {
    pub fn new() -> Result<Self> {
        #[cfg(feature = "tesseract")]
        {
            let api = tesseract::Tesseract::new(None, Some("eng"))?;
            Ok(Self {
                api: std::sync::Mutex::new(api),
            })
        }
        #[cfg(not(feature = "tesseract"))]
        Ok(Self {})
    }
}

#[cfg(target_os = "linux")]
#[async_trait]
impl OcrEngine for LinuxOcr {
    async fn recognize(&self, image: &DynamicImage) -> Result<String> {
        #[cfg(feature = "tesseract")]
        {
            let mut png_bytes: Vec<u8> = vec![];
            image.write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            )?;

            let mut api = self
                .api
                .lock()
                .map_err(|_| anyhow::anyhow!("OCR lock poisoned"))?;
            let text = api
                .set_image_from_mem(&png_bytes)?
                .recognize()?
                .get_text()?;
            return Ok(text);
        }
        #[cfg(not(feature = "tesseract"))]
        Ok(String::new())
    }
}

/// Platform OCR instance.
#[cfg(target_os = "windows")]
pub type PlatformOcr = WindowsOcr;
#[cfg(target_os = "macos")]
pub type PlatformOcr = MacOsOcr;
#[cfg(target_os = "linux")]
pub type PlatformOcr = LinuxOcr;

/// OCR worker that processes frames from the capture engine.
pub struct OcrWorker {
    engine: Box<dyn OcrEngine>,
    /// pHash threshold for change detection (skip identical frames).
    change_threshold: f64,
    last_hash: std::sync::Mutex<Option<u64>>,
}

impl OcrWorker {
    pub fn new() -> Result<Self> {
        let engine: Box<dyn OcrEngine> = Box::new(PlatformOcr::new()?);
        Ok(Self {
            engine,
            change_threshold: 10.0,
            last_hash: std::sync::Mutex::new(None),
        })
    }

    /// Process a raw BGRA frame. Returns OCR text if the frame changed sufficiently.
    pub async fn process_frame(
        &self,
        bgra_data: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Option<String>> {
        // Convert BGRA → RGBA for image crate
        let mut rgba = vec![0u8; bgra_data.len()];
        for i in (0..bgra_data.len()).step_by(4) {
            rgba[i] = bgra_data[i + 2]; // R
            rgba[i + 1] = bgra_data[i + 1]; // G
            rgba[i + 2] = bgra_data[i]; // B
            rgba[i + 3] = bgra_data[i + 3]; // A
        }

        let img = image::RgbaImage::from_raw(width, height, rgba)
            .ok_or_else(|| anyhow::anyhow!("Failed to create image"))?;
        let dynamic = DynamicImage::ImageRgba8(img);

        // Compute perceptual hash
        let current_hash = phash(&dynamic);
        let changed = {
            let mut last = self.last_hash.lock().unwrap();
            let changed = last
                .map(|h| hamming(h, current_hash) as f64 > self.change_threshold)
                .unwrap_or(true);
            *last = Some(current_hash);
            changed
        };

        if !changed {
            return Ok(None);
        }

        let text = self.engine.recognize(&dynamic).await?;
        Ok(Some(text))
    }
}

/// Simple 8x8 perceptual hash.
fn phash(img: &DynamicImage) -> u64 {
    let small = img
        .resize_exact(8, 8, image::imageops::FilterType::Nearest)
        .to_luma8();
    let avg: u32 = small.pixels().map(|p| p.0[0] as u32).sum::<u32>() / 64;
    let avg = avg as u8;
    let mut hash: u64 = 0;
    for (i, pixel) in small.pixels().enumerate() {
        if pixel.0[0] >= avg {
            hash |= 1 << i;
        }
    }
    hash
}

/// Hamming distance between two 64-bit hashes.
fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

impl Default for OcrWorker {
    fn default() -> Self {
        Self::new().expect("Failed to create OcrWorker")
    }
}
