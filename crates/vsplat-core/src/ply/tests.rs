#[cfg(test)]
mod tests {
    use crate::ply::header::parse_header;
    use crate::ply::parser::PlyParser;
    use crate::ply::splat_data::SplatData;

    // ─── Helper: Build a minimal PLY binary for testing ────────────

    /// Create a PLY file (header + binary) with given properties and vertex data.
    fn make_ply_bytes(
        vertex_count: usize,
        properties: &[(&str, &str)], // (name, type) pairs
        vertex_data: &[u8],
    ) -> Vec<u8> {
        let mut header = String::new();
        header.push_str("ply\n");
        header.push_str("format binary_little_endian 1.0\n");
        header.push_str(&format!("element vertex {vertex_count}\n"));
        for (name, ty) in properties {
            header.push_str(&format!("property {ty} {name}\n"));
        }
        header.push_str("end_header\n");

        let mut bytes = header.into_bytes();
        bytes.extend_from_slice(vertex_data);
        bytes
    }

    /// Standard 3DGS property set (minimal: pos + rot + scale + opacity + DC color)
    fn standard_properties() -> Vec<(&'static str, &'static str)> {
        vec![
            ("x", "float"), ("y", "float"), ("z", "float"),
            ("nx", "float"), ("ny", "float"), ("nz", "float"),
            ("f_dc_0", "float"), ("f_dc_1", "float"), ("f_dc_2", "float"),
            ("opacity", "float"),
            ("scale_0", "float"), ("scale_1", "float"), ("scale_2", "float"),
            ("rot_0", "float"), ("rot_1", "float"), ("rot_2", "float"), ("rot_3", "float"),
        ]
    }

    /// Build binary vertex data for `count` splats with standard properties.
    /// Each splat: 17 floats × 4 bytes = 68 bytes.
    fn make_vertex_data(count: usize) -> Vec<u8> {
        let mut data = Vec::with_capacity(count * 17 * 4);
        for i in 0..count {
            let val = i as f32;
            // x, y, z
            data.extend_from_slice(&val.to_le_bytes());
            data.extend_from_slice(&(val + 0.1).to_le_bytes());
            data.extend_from_slice(&(val + 0.2).to_le_bytes());
            // nx, ny, nz (normals — we skip these in SoA but they occupy space)
            data.extend_from_slice(&0.0f32.to_le_bytes());
            data.extend_from_slice(&1.0f32.to_le_bytes());
            data.extend_from_slice(&0.0f32.to_le_bytes());
            // f_dc_0, f_dc_1, f_dc_2 (DC color = SH degree 0)
            data.extend_from_slice(&0.5f32.to_le_bytes());
            data.extend_from_slice(&0.6f32.to_le_bytes());
            data.extend_from_slice(&0.7f32.to_le_bytes());
            // opacity
            data.extend_from_slice(&0.9f32.to_le_bytes());
            // scale_0, scale_1, scale_2
            data.extend_from_slice(&1.0f32.to_le_bytes());
            data.extend_from_slice(&1.0f32.to_le_bytes());
            data.extend_from_slice(&1.0f32.to_le_bytes());
            // rot_0, rot_1, rot_2, rot_3 (quaternion)
            data.extend_from_slice(&1.0f32.to_le_bytes());
            data.extend_from_slice(&0.0f32.to_le_bytes());
            data.extend_from_slice(&0.0f32.to_le_bytes());
            data.extend_from_slice(&0.0f32.to_le_bytes());
        }
        data
    }

    // ─── Test 1: parse_ply_header_basic ────────────────────────────

    #[test]
    fn parse_ply_header_basic() {
        let props = standard_properties();
        let vertex_data = make_vertex_data(100);
        let ply_bytes = make_ply_bytes(100, &props, &vertex_data);

        let header = parse_header(&ply_bytes).expect("Should parse basic header");

        assert_eq!(header.vertex_count, 100);
        assert_eq!(header.properties.len(), 17); // 17 standard properties
        assert_eq!(header.stride, 17 * 4); // 17 floats × 4 bytes = 68
        assert!(header.data_offset > 0);
        // Verify property names match
        assert_eq!(header.properties[0].name, "x");
        assert_eq!(header.properties[9].name, "opacity");
        assert_eq!(header.properties[16].name, "rot_3");
    }

    // ─── Test 2: parse_ply_header_with_sh ──────────────────────────

    #[test]
    fn parse_ply_header_with_sh() {
        // Full SH degree 3: 48 SH coefficients (f_dc_0..2 + f_rest_0..44)
        let mut props: Vec<(&str, &str)> = vec![
            ("x", "float"), ("y", "float"), ("z", "float"),
            ("nx", "float"), ("ny", "float"), ("nz", "float"),
            ("f_dc_0", "float"), ("f_dc_1", "float"), ("f_dc_2", "float"),
        ];
        // f_rest_0 through f_rest_44 (45 extra SH coefficients)
        let rest_names: Vec<String> = (0..45).map(|i| format!("f_rest_{i}")).collect();
        let rest_refs: Vec<(&str, &str)> = rest_names.iter()
            .map(|s| (s.as_str(), "float"))
            .collect();
        props.extend_from_slice(&rest_refs);
        props.extend_from_slice(&[
            ("opacity", "float"),
            ("scale_0", "float"), ("scale_1", "float"), ("scale_2", "float"),
            ("rot_0", "float"), ("rot_1", "float"), ("rot_2", "float"), ("rot_3", "float"),
        ]);

        let header_str = {
            let mut h = String::new();
            h.push_str("ply\nformat binary_little_endian 1.0\nelement vertex 10\n");
            for (name, ty) in &props {
                h.push_str(&format!("property {ty} {name}\n"));
            }
            h.push_str("end_header\n");
            h
        };

        let header = parse_header(header_str.as_bytes()).expect("Should parse SH header");

        assert_eq!(header.vertex_count, 10);
        // 3 pos + 3 normals + 3 DC + 45 rest + 1 opacity + 3 scale + 4 rot = 62
        assert_eq!(header.properties.len(), 62);
        assert_eq!(header.stride, 62 * 4); // 248 bytes per vertex

        // Verify SH properties exist
        assert!(header.property_offset("f_dc_0").is_some());
        assert!(header.property_offset("f_rest_0").is_some());
        assert!(header.property_offset("f_rest_44").is_some());
    }

    // ─── Test 3: parse_ply_header_invalid ──────────────────────────

    #[test]
    fn parse_ply_header_invalid() {
        // Not a PLY file
        let result = parse_header(b"NOT A PLY FILE");
        assert!(result.is_err());

        // Missing end_header
        let result = parse_header(b"ply\nformat binary_little_endian 1.0\n");
        assert!(result.is_err());

        // Missing vertex element
        let result = parse_header(b"ply\nformat binary_little_endian 1.0\nend_header\n");
        assert!(result.is_err());

        // ASCII format (we only support binary_little_endian)
        let result = parse_header(b"ply\nformat ascii 1.0\nelement vertex 10\nproperty float x\nend_header\n");
        assert!(result.is_err());
    }

    // ─── Test 4: stream_binary_single_chunk ────────────────────────

    #[test]
    fn stream_binary_single_chunk() {
        let props = standard_properties();
        let vertex_data = make_vertex_data(10);
        let ply_bytes = make_ply_bytes(10, &props, &vertex_data);

        let header = parse_header(&ply_bytes).unwrap();
        let binary_section = &ply_bytes[header.data_offset..];
        let parser = PlyParser::new(header);

        let splats = parser.parse_all(binary_section).expect("Should parse small PLY");

        assert_eq!(splats.count, 10);
        assert_eq!(splats.positions.len(), 30); // 10 × 3
        assert_eq!(splats.rotations.len(), 40); // 10 × 4
        assert_eq!(splats.scales.len(), 30);     // 10 × 3
        assert_eq!(splats.opacities.len(), 10);

        // Verify first splat's position (x=0.0, y=0.1, z=0.2)
        assert!((splats.positions[0] - 0.0).abs() < 1e-6);
        assert!((splats.positions[1] - 0.1).abs() < 1e-6);
        assert!((splats.positions[2] - 0.2).abs() < 1e-6);

        // Verify first splat's opacity: raw 0.9 → sigmoid(0.9) ≈ 0.7109
        let expected_opacity = 1.0 / (1.0 + (-0.9f32).exp());
        assert!((splats.opacities[0] - expected_opacity).abs() < 1e-4);
    }

    // ─── Test 5: stream_binary_multi_chunk ─────────────────────────

    #[test]
    fn stream_binary_multi_chunk() {
        let props = standard_properties();
        let count = 500;
        let vertex_data = make_vertex_data(count);
        let ply_bytes = make_ply_bytes(count, &props, &vertex_data);

        let header = parse_header(&ply_bytes).unwrap();
        let binary_section = &ply_bytes[header.data_offset..];
        let binary_vec = binary_section.to_vec();
        let total_size = binary_vec.len();
        let chunk_size = 1024; // Force multiple chunks (stride=68, 1024/68 ≈ 15 splats/chunk)

        let parser = PlyParser::new(header);

        let splats = parser.parse_chunked(
            total_size,
            chunk_size,
            |offset, len| {
                let end = (offset + len).min(total_size);
                binary_vec[offset..end].to_vec()
            },
            |_| {}, // no-op progress
        ).expect("Should parse multi-chunk PLY");

        assert_eq!(splats.count, count);
        assert_eq!(splats.positions.len(), count * 3);

        // Verify last splat's x position
        let last_x = splats.positions[(count - 1) * 3];
        assert!((last_x - (count - 1) as f32).abs() < 1e-6);
    }

    // ─── Test 6: verify_soa_layout ─────────────────────────────────

    #[test]
    fn verify_soa_layout() {
        let props = standard_properties();
        let vertex_data = make_vertex_data(3);
        let ply_bytes = make_ply_bytes(3, &props, &vertex_data);

        let header = parse_header(&ply_bytes).unwrap();
        let binary_section = &ply_bytes[header.data_offset..];
        let parser = PlyParser::new(header);
        let splats = parser.parse_all(binary_section).unwrap();

        // SoA: positions are contiguous [x0,y0,z0, x1,y1,z1, x2,y2,z2]
        // NOT interleaved with other properties
        assert_eq!(splats.positions.len(), 9); // 3 splats × 3

        // Verify SoA order: splat 0, then splat 1, then splat 2
        assert!((splats.positions[0] - 0.0).abs() < 1e-6); // x0
        assert!((splats.positions[3] - 1.0).abs() < 1e-6); // x1
        assert!((splats.positions[6] - 2.0).abs() < 1e-6); // x2

        // Rotations are contiguous too
        assert_eq!(splats.rotations.len(), 12); // 3 × 4

        // Scales contiguous
        assert_eq!(splats.scales.len(), 9); // 3 × 3
    }

    // ─── Test 7: verify_preallocation_path ─────────────────────────────

    #[test]
    fn verify_preallocation_path() {
        // This test verifies that SplatData pre-allocates correct capacity
        // and that parsing fills it without extra allocations.

        let props = standard_properties();
        let count = 100;
        let vertex_data = make_vertex_data(count);
        let ply_bytes = make_ply_bytes(count, &props, &vertex_data);

        let header = parse_header(&ply_bytes).unwrap();

        // Verify SplatData::with_capacity pre-allocates correctly
        let pre_alloc = SplatData::with_capacity(count, 3); // DC-only = 3 SH dims
        assert!(pre_alloc.positions.capacity() >= count * 3);
        assert!(pre_alloc.rotations.capacity() >= count * 4);
        assert!(pre_alloc.scales.capacity() >= count * 3);
        assert!(pre_alloc.opacities.capacity() >= count);
        assert!(pre_alloc.sh_coefficients.capacity() >= count * 3);

        // Parse and verify final lengths match pre-allocated capacity
        let binary_section = &ply_bytes[header.data_offset..];
        let parser = PlyParser::new(header);
        let splats = parser.parse_all(binary_section).unwrap();

        assert_eq!(splats.positions.len(), count * 3);
        assert_eq!(splats.opacities.len(), count);
    }

    // ─── Test 8: progress_callback_fires ───────────────────────────

    #[test]
    fn progress_callback_fires() {
        let props = standard_properties();
        let count = 200;
        let vertex_data = make_vertex_data(count);
        let ply_bytes = make_ply_bytes(count, &props, &vertex_data);

        let header = parse_header(&ply_bytes).unwrap();
        let binary_section = &ply_bytes[header.data_offset..];
        let binary_vec = binary_section.to_vec();
        let total_size = binary_vec.len();
        let chunk_size = 1024; // Small chunks to trigger multiple callbacks

        let parser = PlyParser::new(header);

        let mut progress_values: Vec<f32> = Vec::new();

        let _splats = parser.parse_chunked(
            total_size,
            chunk_size,
            |offset, len| {
                let end = (offset + len).min(total_size);
                binary_vec[offset..end].to_vec()
            },
            |p| progress_values.push(p),
        ).expect("Should parse with progress");

        // Progress should have been called multiple times
        assert!(progress_values.len() > 1, "Expected multiple progress callbacks");

        // Progress should be monotonically increasing
        for window in progress_values.windows(2) {
            assert!(window[1] >= window[0], "Progress should be monotonically increasing");
        }

        // Last progress should be 1.0 (complete)
        let last = *progress_values.last().unwrap();
        assert!((last - 1.0).abs() < 1e-6, "Final progress should be 1.0, got {last}");
    }

    // ═══ Ward 016: Import Truncation Tests ═══════════════════════════

    // ─── A1a: parse_all rejects truncated binary ─────────────────────

    #[test]
    fn truncated_binary_parse_all_returns_error() {
        let props = standard_properties();
        let count = 1000;
        let vertex_data = make_vertex_data(count);
        let ply_bytes = make_ply_bytes(count, &props, &vertex_data);

        let header = parse_header(&ply_bytes).unwrap();
        let full_binary = &ply_bytes[header.data_offset..];

        // Truncate at 50% of binary
        let truncated = &full_binary[..full_binary.len() / 2];

        let parser = PlyParser::new(header);
        let result = parser.parse_all(truncated);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("mismatch"), "Error should mention size mismatch: {err}");
    }

    // ─── A1b: parse_chunked rejects truncated stream ─────────────────

    #[test]
    fn truncated_binary_parse_chunked_returns_error() {
        let props = standard_properties();
        let count = 1000;
        let vertex_data = make_vertex_data(count);
        let ply_bytes = make_ply_bytes(count, &props, &vertex_data);

        let header = parse_header(&ply_bytes).unwrap();
        let full_binary = &ply_bytes[header.data_offset..];

        // Truncate at 60% — not aligned to stride, creates junk remainder
        let truncated_size = full_binary.len() * 60 / 100;
        let truncated: Vec<u8> = full_binary[..truncated_size].to_vec();

        let parser = PlyParser::new(header);
        let chunk_size = 4096;

        let result = parser.parse_chunked(
            truncated_size,
            chunk_size,
            |offset, len| {
                let end = (offset + len).min(truncated.len());
                truncated[offset..end].to_vec()
            },
            |_| {},
        );

        assert!(result.is_err());
        let err = result.unwrap_err();
        // Should mention either junk bytes or vertex count mismatch
        assert!(
            err.contains("junk") || err.contains("mismatch"),
            "Error should indicate truncation: {err}"
        );
    }

    // ─── A2: parse_all capacity matches length (no over-alloc) ───────

    #[test]
    fn parse_all_no_overallocation() {
        let props = standard_properties();
        let count = 10_000;
        let vertex_data = make_vertex_data(count);
        let ply_bytes = make_ply_bytes(count, &props, &vertex_data);

        let header = parse_header(&ply_bytes).unwrap();
        let binary = &ply_bytes[header.data_offset..];
        let parser = PlyParser::new(header);
        let splats = parser.parse_all(binary).unwrap();

        // Capacity should be exactly what was pre-allocated (count × components)
        // Ratio capacity/length should be < 1.1 (no 2× over-allocation)
        let pos_ratio = splats.positions.capacity() as f64 / splats.positions.len() as f64;
        let rot_ratio = splats.rotations.capacity() as f64 / splats.rotations.len() as f64;
        let sc_ratio = splats.scales.capacity() as f64 / splats.scales.len() as f64;
        let op_ratio = splats.opacities.capacity() as f64 / splats.opacities.len() as f64;

        assert!(pos_ratio < 1.1, "positions over-allocated: ratio {pos_ratio}");
        assert!(rot_ratio < 1.1, "rotations over-allocated: ratio {rot_ratio}");
        assert!(sc_ratio < 1.1, "scales over-allocated: ratio {sc_ratio}");
        assert!(op_ratio < 1.1, "opacities over-allocated: ratio {op_ratio}");
    }
}
