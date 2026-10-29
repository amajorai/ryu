//! Minimal QR Code encoder for `otpauth://` enrollment URLs.
//!
//! Byte mode, error-correction level M, versions 1–20 (up to 666 bytes),
//! following ISO/IEC 18004 with the usual four penalty rules for mask
//! selection. It exists so the TOTP engine can return a scannable code once at
//! key generation without a new dependency; it is not a general-purpose
//! encoder (no numeric/alphanumeric/kanji modes, no other ECC levels).

/// Highest supported version.
const MAX_VERSION: usize = 20;
/// Error-correction codewords per block at level M, by version.
const ECC_PER_BLOCK: [usize; MAX_VERSION + 1] = [
    0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
/// Error-correction blocks at level M, by version.
const ECC_BLOCKS: [usize; MAX_VERSION + 1] = [
    0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];
/// Format-information bits for level M.
const ECC_FORMAT_BITS: u32 = 0;

/// A square module matrix; `true` is dark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QrCode {
    pub size: usize,
    modules: Vec<bool>,
}

impl QrCode {
    /// Whether the module at column `x`, row `y` is dark.
    pub fn get(&self, x: usize, y: usize) -> bool {
        self.modules[y * self.size + x]
    }

    /// Encode `data` with an automatically chosen version and mask. Returns
    /// `None` when the data does not fit in version 20-M.
    pub fn encode(data: &[u8]) -> Option<Self> {
        Self::encode_with_mask(data, None)
    }

    /// Encode with a fixed mask (0–7) or the lowest-penalty mask.
    pub fn encode_with_mask(data: &[u8], mask: Option<u8>) -> Option<Self> {
        let version =
            (1..=MAX_VERSION).find(|&v| data_bits_needed(v, data.len()) <= data_capacity(v) * 8)?;
        let codewords = add_ecc_and_interleave(version, &build_data_codewords(version, data));
        let mut base = Builder::new(version);
        base.draw_function_patterns();
        base.draw_codewords(&codewords);
        let chosen = match mask {
            Some(mask) => mask & 7,
            None => (0..8u8)
                .min_by_key(|&candidate| {
                    let mut trial = base.clone();
                    trial.apply_mask(candidate);
                    trial.draw_format_bits(candidate);
                    trial.penalty()
                })
                .unwrap_or(0),
        };
        base.apply_mask(chosen);
        base.draw_format_bits(chosen);
        Some(Self {
            size: base.size,
            modules: base.modules,
        })
    }

    /// An SVG rendering with a 4-module quiet zone, one path of unit squares.
    pub fn to_svg(&self) -> String {
        let border = 4;
        let dimension = self.size + border * 2;
        let mut path = String::new();
        for y in 0..self.size {
            for x in 0..self.size {
                if self.get(x, y) {
                    if !path.is_empty() {
                        path.push(' ');
                    }
                    path.push_str(&format!("M{},{}h1v1h-1z", x + border, y + border));
                }
            }
        }
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {dimension} {dimension}\" \
             shape-rendering=\"crispEdges\"><rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>\
             <path d=\"{path}\" fill=\"#000\"/></svg>"
        )
    }

    /// A grayscale PNG with `scale` pixels per module and a 4-module quiet zone.
    pub fn to_png(&self, scale: usize) -> anyhow::Result<Vec<u8>> {
        let scale = scale.clamp(1, 16);
        let border = 4;
        let pixels = (self.size + border * 2) * scale;
        let mut image = vec![0xffu8; pixels * pixels];
        for y in 0..self.size {
            for x in 0..self.size {
                if !self.get(x, y) {
                    continue;
                }
                for dy in 0..scale {
                    let row = (y + border) * scale + dy;
                    let start = row * pixels + (x + border) * scale;
                    image[start..start + scale].fill(0);
                }
            }
        }
        let mut out = Vec::new();
        {
            let side = u32::try_from(pixels)?;
            let mut encoder = png::Encoder::new(&mut out, side, side);
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header()?.write_image_data(&image)?;
        }
        Ok(out)
    }
}

fn raw_data_modules(version: usize) -> usize {
    let mut result = (16 * version + 128) * version + 64;
    if version >= 2 {
        let align = version / 7 + 2;
        result -= (25 * align - 10) * align - 55;
        if version >= 7 {
            result -= 36;
        }
    }
    result
}

/// Data codewords available at level M.
fn data_capacity(version: usize) -> usize {
    raw_data_modules(version) / 8 - ECC_PER_BLOCK[version] * ECC_BLOCKS[version]
}

fn count_bits(version: usize) -> usize {
    if version <= 9 {
        8
    } else {
        16
    }
}

fn data_bits_needed(version: usize, len: usize) -> usize {
    if len >= 1 << count_bits(version) {
        return usize::MAX;
    }
    4 + count_bits(version) + len * 8
}

fn build_data_codewords(version: usize, data: &[u8]) -> Vec<u8> {
    let mut bits: Vec<bool> = Vec::new();
    let mut push = |value: usize, len: usize| {
        for i in (0..len).rev() {
            bits.push((value >> i) & 1 == 1);
        }
    };
    push(0b0100, 4);
    push(data.len(), count_bits(version));
    for byte in data {
        push(usize::from(*byte), 8);
    }
    let capacity = data_capacity(version) * 8;
    let terminator = (capacity - bits.len()).min(4);
    bits.extend(std::iter::repeat(false).take(terminator));
    while bits.len() % 8 != 0 {
        bits.push(false);
    }
    let mut out: Vec<u8> = bits
        .chunks(8)
        .map(|chunk| {
            chunk
                .iter()
                .fold(0u8, |acc, bit| (acc << 1) | u8::from(*bit))
        })
        .collect();
    for pad in [0xEC, 0x11].into_iter().cycle() {
        if out.len() >= data_capacity(version) {
            break;
        }
        out.push(pad);
    }
    out
}

fn gf_mul(x: u8, y: u8) -> u8 {
    let mut z: u16 = 0;
    for i in (0..8).rev() {
        z = (z << 1) ^ ((z >> 7) * 0x11D);
        z ^= u16::from((y >> i) & 1) * u16::from(x);
    }
    z as u8
}

fn rs_divisor(degree: usize) -> Vec<u8> {
    let mut result = vec![0u8; degree];
    result[degree - 1] = 1;
    let mut root = 1u8;
    for _ in 0..degree {
        for j in 0..degree {
            result[j] = gf_mul(result[j], root);
            if j + 1 < degree {
                result[j] ^= result[j + 1];
            }
        }
        root = gf_mul(root, 0x02);
    }
    result
}

fn rs_remainder(data: &[u8], divisor: &[u8]) -> Vec<u8> {
    let mut result = vec![0u8; divisor.len()];
    for byte in data {
        let factor = byte ^ result.remove(0);
        result.push(0);
        for (slot, coefficient) in result.iter_mut().zip(divisor) {
            *slot ^= gf_mul(*coefficient, factor);
        }
    }
    result
}

fn add_ecc_and_interleave(version: usize, data: &[u8]) -> Vec<u8> {
    let blocks = ECC_BLOCKS[version];
    let ecc_len = ECC_PER_BLOCK[version];
    let raw = raw_data_modules(version) / 8;
    let short_blocks = blocks - raw % blocks;
    let short_len = raw / blocks;
    let divisor = rs_divisor(ecc_len);
    let mut all: Vec<Vec<u8>> = Vec::with_capacity(blocks);
    let mut offset = 0;
    for index in 0..blocks {
        let len = short_len - ecc_len + usize::from(index >= short_blocks);
        let mut block = data[offset..offset + len].to_vec();
        offset += len;
        let ecc = rs_remainder(&block, &divisor);
        if index < short_blocks {
            block.push(0);
        }
        block.extend(ecc);
        all.push(block);
    }
    let mut out = Vec::with_capacity(raw);
    for i in 0..=short_len {
        for (index, block) in all.iter().enumerate() {
            if i != short_len - ecc_len || index >= short_blocks {
                out.push(block[i]);
            }
        }
    }
    out
}

fn alignment_positions(version: usize) -> Vec<usize> {
    if version == 1 {
        return Vec::new();
    }
    let count = version / 7 + 2;
    let size = version * 4 + 17;
    let step = (version * 4 + count * 2 + 1) / (count * 2 - 2) * 2;
    let mut result = vec![6];
    let mut pos = size - 7;
    let mut tail = Vec::new();
    while tail.len() + 1 < count {
        tail.push(pos);
        pos -= step;
    }
    tail.reverse();
    result.extend(tail);
    result
}

#[derive(Clone)]
struct Builder {
    version: usize,
    size: usize,
    modules: Vec<bool>,
    function: Vec<bool>,
}

impl Builder {
    fn new(version: usize) -> Self {
        let size = version * 4 + 17;
        Self {
            version,
            size,
            modules: vec![false; size * size],
            function: vec![false; size * size],
        }
    }

    fn set_function(&mut self, x: usize, y: usize, dark: bool) {
        self.modules[y * self.size + x] = dark;
        self.function[y * self.size + x] = true;
    }

    fn draw_function_patterns(&mut self) {
        for i in 0..self.size {
            self.set_function(6, i, i % 2 == 0);
            self.set_function(i, 6, i % 2 == 0);
        }
        let far = self.size - 4;
        for (cx, cy) in [(3, 3), (far, 3), (3, far)] {
            self.draw_finder(cx, cy);
        }
        let positions = alignment_positions(self.version);
        let last = positions.len().saturating_sub(1);
        for (i, &x) in positions.iter().enumerate() {
            for (j, &y) in positions.iter().enumerate() {
                let corner = (i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0);
                if !corner {
                    self.draw_alignment(x, y);
                }
            }
        }
        self.draw_format_bits(0);
        self.draw_version();
    }

    fn draw_finder(&mut self, cx: usize, cy: usize) {
        for dy in -4i32..=4 {
            for dx in -4i32..=4 {
                let x = cx as i32 + dx;
                let y = cy as i32 + dy;
                if (0..self.size as i32).contains(&x) && (0..self.size as i32).contains(&y) {
                    let distance = dx.abs().max(dy.abs());
                    self.set_function(x as usize, y as usize, distance != 2 && distance != 4);
                }
            }
        }
    }

    fn draw_alignment(&mut self, cx: usize, cy: usize) {
        for dy in -2i32..=2 {
            for dx in -2i32..=2 {
                let x = (cx as i32 + dx) as usize;
                let y = (cy as i32 + dy) as usize;
                self.set_function(x, y, dx.abs().max(dy.abs()) != 1);
            }
        }
    }

    fn draw_format_bits(&mut self, mask: u8) {
        let data = (ECC_FORMAT_BITS << 3) | u32::from(mask);
        let mut rem = data;
        for _ in 0..10 {
            rem = (rem << 1) ^ ((rem >> 9) * 0x537);
        }
        let bits = ((data << 10) | rem) ^ 0x5412;
        let bit = |i: usize| (bits >> i) & 1 == 1;
        for i in 0..=5 {
            self.set_function(8, i, bit(i));
        }
        self.set_function(8, 7, bit(6));
        self.set_function(8, 8, bit(7));
        self.set_function(7, 8, bit(8));
        for i in 9..15 {
            self.set_function(14 - i, 8, bit(i));
        }
        let size = self.size;
        for i in 0..8 {
            self.set_function(size - 1 - i, 8, bit(i));
        }
        for i in 8..15 {
            self.set_function(8, size - 15 + i, bit(i));
        }
        self.set_function(8, size - 8, true);
    }

    fn draw_version(&mut self) {
        if self.version < 7 {
            return;
        }
        let mut rem = self.version as u32;
        for _ in 0..12 {
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
        }
        let bits = ((self.version as u32) << 12) | rem;
        for i in 0..18 {
            let dark = (bits >> i) & 1 == 1;
            let a = self.size - 11 + i % 3;
            let b = i / 3;
            self.set_function(a, b, dark);
            self.set_function(b, a, dark);
        }
    }

    fn draw_codewords(&mut self, data: &[u8]) {
        let total_bits = data.len() * 8;
        let mut i = 0;
        let mut right = self.size as i32 - 1;
        while right >= 1 {
            if right == 6 {
                right = 5;
            }
            for vert in 0..self.size {
                for j in 0..2 {
                    let x = (right - j) as usize;
                    let upward = (right + 1) & 2 == 0;
                    let y = if upward { self.size - 1 - vert } else { vert };
                    if !self.function[y * self.size + x] && i < total_bits {
                        self.modules[y * self.size + x] = (data[i >> 3] >> (7 - (i & 7))) & 1 == 1;
                        i += 1;
                    }
                }
            }
            right -= 2;
        }
    }

    fn apply_mask(&mut self, mask: u8) {
        for y in 0..self.size {
            for x in 0..self.size {
                let invert = match mask {
                    0 => (x + y) % 2 == 0,
                    1 => y % 2 == 0,
                    2 => x % 3 == 0,
                    3 => (x + y) % 3 == 0,
                    4 => (x / 3 + y / 2) % 2 == 0,
                    5 => x * y % 2 + x * y % 3 == 0,
                    6 => (x * y % 2 + x * y % 3) % 2 == 0,
                    _ => ((x + y) % 2 + x * y % 3) % 2 == 0,
                };
                let index = y * self.size + x;
                if invert && !self.function[index] {
                    self.modules[index] ^= true;
                }
            }
        }
    }

    fn at(&self, x: usize, y: usize) -> bool {
        self.modules[y * self.size + x]
    }

    /// ISO/IEC 18004 §7.8.3 penalty score (lower is better).
    fn penalty(&self) -> usize {
        let size = self.size;
        let mut score = 0;
        let line = |horizontal: bool, a: usize, b: usize| {
            if horizontal {
                self.at(b, a)
            } else {
                self.at(a, b)
            }
        };
        for horizontal in [true, false] {
            for a in 0..size {
                let row: Vec<bool> = (0..size).map(|b| line(horizontal, a, b)).collect();
                let mut run = 1;
                for b in 1..=size {
                    if b < size && row[b] == row[b - 1] {
                        run += 1;
                        continue;
                    }
                    if run >= 5 {
                        score += run - 2;
                    }
                    run = 1;
                }
                score += finder_like(&row) * 40;
            }
        }
        for y in 0..size - 1 {
            for x in 0..size - 1 {
                let color = self.at(x, y);
                if color == self.at(x + 1, y)
                    && color == self.at(x, y + 1)
                    && color == self.at(x + 1, y + 1)
                {
                    score += 3;
                }
            }
        }
        let dark = self.modules.iter().filter(|m| **m).count();
        let total = size * size;
        let deviation = (dark * 20).abs_diff(total * 10);
        score += deviation.div_ceil(total).saturating_sub(1) * 10;
        score
    }
}

/// Occurrences of 1:1:3:1:1 finder-like runs with four light modules on
/// either side (the quiet zone outside the symbol counts as light).
fn finder_like(row: &[bool]) -> usize {
    const CORE: [bool; 7] = [true, false, true, true, true, false, true];
    let light = |index: isize| index < 0 || index as usize >= row.len() || !row[index as usize];
    let mut count = 0;
    for start in 0..row.len().saturating_sub(6) {
        if row[start..start + 7] != CORE {
            continue;
        }
        let before = (1..=4).all(|k| light(start as isize - k));
        let after = (0..4).all(|k| light((start + 7 + k) as isize));
        count += usize::from(before) + usize::from(after);
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(code: &QrCode) -> String {
        use sha2::Digest as _;
        let bits: String = code
            .modules
            .iter()
            .map(|dark| if *dark { '1' } else { '0' })
            .collect();
        hex::encode(sha2::Sha256::digest(bits.as_bytes()))
    }

    #[test]
    fn capacities_match_the_standard_tables() {
        // ISO/IEC 18004 Table 7, byte mode at level M.
        assert_eq!(data_capacity(1), 16);
        assert_eq!(data_capacity(7), 124);
        assert_eq!(data_capacity(10), 216);
        assert_eq!(data_capacity(20), 669);
        assert_eq!(alignment_positions(7), vec![6, 22, 38]);
        assert_eq!(alignment_positions(20), vec![6, 34, 62, 90]);
    }

    #[test]
    fn matrices_match_a_reference_encoder() {
        // Golden fingerprints from an independent encoder (python-qrcode 8.2,
        // byte mode, level M, fixed mask), covering a small symbol and a
        // multi-block symbol with version information.
        let small = QrCode::encode_with_mask(
            b"otpauth://totp/Ryu:alice?secret=JBSWY3DPEHPK3PXP&issuer=Ryu",
            Some(3),
        )
        .unwrap();
        assert_eq!(small.size, 33);
        assert_eq!(
            fingerprint(&small),
            "78b3abe82eb36a0be0fc0d72bb5534fb67929f005950e914c646389cab12990e"
        );
        let large = QrCode::encode_with_mask(&[b'E'; 400], Some(6)).unwrap();
        assert_eq!(large.size, 77);
        assert_eq!(
            fingerprint(&large),
            "91188d74eb2d6c58a66b5cd8e894800178ee0d0edf0e422cfe0f5cbc1df1e638"
        );
    }

    #[test]
    fn oversize_input_is_refused() {
        assert!(QrCode::encode(&[b'a'; 700]).is_none());
        assert_eq!(QrCode::encode(b"otpauth://totp/x").unwrap().size, 25);
    }

    #[test]
    fn renders_svg_and_png() {
        let code = QrCode::encode(b"otpauth://totp/Ryu:alice?secret=JBSWY3DPEHPK3PXP").unwrap();
        let svg = code.to_svg();
        assert!(svg.starts_with("<svg") && svg.ends_with("</svg>"));
        let png = code.to_png(4).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
