/// Streaming PLY binary parser.
/// Reads binary vertex data in chunks and populates SplatData in SoA layout.
///
/// Performance: property byte-offsets are compiled once in `PlyParser::new()`.
/// `extract_vertex` uses only pre-calculated integer offsets — zero string lookups.

use super::header::PlyHeader;
use super::splat_data::SplatData;

/// Pre-calculated byte offsets for all properties we extract.
/// Computed once in `PlyParser::new()`, used for every vertex without string lookups.
struct CompiledLayout {
    /// Byte offsets for position [x, y, z] within a vertex record. None if missing.
    position: [Option<usize>; 3],
    /// Byte offsets for rotation quaternion [rot_0, rot_1, rot_2, rot_3].
    rotation: [Option<usize>; 4],
    /// Byte offsets for scale [scale_0, scale_1, scale_2].
    scale: [Option<usize>; 3],
    /// Byte offset for opacity.
    opacity: Option<usize>,
    /// Byte offsets for SH coefficients (DC + rest), in order.
    sh_offsets: Vec<usize>,
    /// Total SH dimension (len of sh_offsets).
    sh_dim: usize,
}

impl CompiledLayout {
    fn from_header(header: &PlyHeader) -> Self {
        let pos = |name: &str| header.property_offset(name);

        let position = [pos("x"), pos("y"), pos("z")];
        let rotation = [pos("rot_0"), pos("rot_1"), pos("rot_2"), pos("rot_3")];
        let scale = [pos("scale_0"), pos("scale_1"), pos("scale_2")];
        let opacity = pos("opacity");

        // Collect SH offsets: DC first, then f_rest_0..44
        let mut sh_offsets = Vec::new();
        for name in &["f_dc_0", "f_dc_1", "f_dc_2"] {
            if let Some(off) = pos(name) {
                sh_offsets.push(off);
            }
        }
        for i in 0..45 {
            if let Some(off) = pos(&format!("f_rest_{i}")) {
                sh_offsets.push(off);
            }
        }

        let sh_dim = sh_offsets.len();

        Self {
            position,
            rotation,
            scale,
            opacity,
            sh_offsets,
            sh_dim,
        }
    }
}

/// Streaming parser that processes binary PLY data in chunks.
pub struct PlyParser {
    header: PlyHeader,
    layout: CompiledLayout,
}

impl PlyParser {
    pub fn new(header: PlyHeader) -> Self {
        let layout = CompiledLayout::from_header(&header);
        Self { header, layout }
    }

    /// Read an f32 from a vertex record at a pre-calculated byte offset.
    #[inline(always)]
    fn read_f32(record: &[u8], offset: Option<usize>) -> f32 {
        match offset {
            Some(off) => {
                let bytes: [u8; 4] = record[off..off + 4].try_into().unwrap();
                f32::from_le_bytes(bytes)
            }
            None => 0.0,
        }
    }

    /// Extract one splat's components from a vertex record and push to SplatData.
    /// Uses only pre-calculated integer offsets — zero string lookups.
    #[inline]
    fn extract_vertex(&self, record: &[u8], splats: &mut SplatData) {
        let l = &self.layout;

        // Positions
        splats.positions.push(Self::read_f32(record, l.position[0]));
        splats.positions.push(Self::read_f32(record, l.position[1]));
        splats.positions.push(Self::read_f32(record, l.position[2]));

        // Rotations
        splats.rotations.push(Self::read_f32(record, l.rotation[0]));
        splats.rotations.push(Self::read_f32(record, l.rotation[1]));
        splats.rotations.push(Self::read_f32(record, l.rotation[2]));
        splats.rotations.push(Self::read_f32(record, l.rotation[3]));

        // Scales
        splats.scales.push(Self::read_f32(record, l.scale[0]));
        splats.scales.push(Self::read_f32(record, l.scale[1]));
        splats.scales.push(Self::read_f32(record, l.scale[2]));

        // Opacity: 3DGS stores as logit (log-odds). Apply sigmoid → [0,1].
        let raw_opacity = Self::read_f32(record, l.opacity);
        splats.opacities.push(1.0 / (1.0 + (-raw_opacity).exp()));

        // SH coefficients via pre-compiled offset array
        for &off in &l.sh_offsets {
            let bytes: [u8; 4] = record[off..off + 4].try_into().unwrap();
            splats.sh_coefficients.push(f32::from_le_bytes(bytes));
        }
    }

    /// Parse all binary vertex data from a byte slice (the full binary section).
    pub fn parse_all(&self, binary_data: &[u8]) -> Result<SplatData, String> {
        let stride = self.header.stride;
        let count = self.header.vertex_count;
        let expected = count * stride;

        if binary_data.len() != expected {
            return Err(format!(
                "Binary data size mismatch: expected exactly {expected} bytes ({count} vertices × {stride} stride), got {}",
                binary_data.len()
            ));
        }

        let mut splats = SplatData::with_capacity(count, self.layout.sh_dim);

        for i in 0..count {
            let start = i * stride;
            let record = &binary_data[start..start + stride];
            self.extract_vertex(record, &mut splats);
        }

        Ok(splats)
    }

    /// Parse binary data in chunks, calling progress_cb after each chunk.
    /// `read_fn` is called with (offset, length) and returns the bytes.
    /// Handles chunk boundaries that split vertex records via a remainder buffer.
    pub fn parse_chunked(
        &self,
        total_binary_size: usize,
        chunk_size: usize,
        mut read_fn: impl FnMut(usize, usize) -> Vec<u8>,
        mut progress_cb: impl FnMut(f32),
    ) -> Result<SplatData, String> {
        let stride = self.header.stride;
        let count = self.header.vertex_count;
        let mut splats = SplatData::with_capacity(count, self.layout.sh_dim);

        let mut offset = 0usize;
        let mut remainder: Vec<u8> = Vec::new();
        let mut parsed_count = 0usize;

        while offset < total_binary_size {
            let read_len = chunk_size.min(total_binary_size - offset);
            let chunk = read_fn(offset, read_len);
            offset += chunk.len();

            // Prepend remainder from previous chunk
            let working_buf = if remainder.is_empty() {
                chunk
            } else {
                let mut combined = std::mem::take(&mut remainder);
                combined.extend_from_slice(&chunk);
                combined
            };

            // Process complete vertex records
            let complete_vertices = working_buf.len() / stride;
            for i in 0..complete_vertices {
                let start = i * stride;
                let record = &working_buf[start..start + stride];
                self.extract_vertex(record, &mut splats);
                parsed_count += 1;
            }

            // Save remainder bytes for next chunk
            let consumed = complete_vertices * stride;
            if consumed < working_buf.len() {
                remainder = working_buf[consumed..].to_vec();
            }

            // Report progress
            let progress = (offset as f32 / total_binary_size as f32).min(1.0);
            progress_cb(progress);
        }

        // Process any final remainder that forms a complete vertex
        if !remainder.is_empty() && remainder.len() >= stride {
            let record = &remainder[..stride];
            self.extract_vertex(record, &mut splats);
            parsed_count += 1;
            // Check for trailing junk after the last complete vertex
            let leftover = remainder.len() - stride;
            if leftover > 0 {
                return Err(format!(
                    "Trailing {leftover} junk bytes after last complete vertex"
                ));
            }
        } else if !remainder.is_empty() {
            // Remainder exists but is smaller than one vertex — always junk
            return Err(format!(
                "Trailing {} junk bytes that do not form a complete vertex ({stride} bytes required)",
                remainder.len()
            ));
        }

        // Strict validation: parsed count must match header vertex count
        if parsed_count != count {
            return Err(format!(
                "Vertex count mismatch: header declares {count} vertices, but parsed {parsed_count}"
            ));
        }

        Ok(splats)
    }
}
