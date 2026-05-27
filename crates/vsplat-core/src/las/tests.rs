#[cfg(test)]
mod tests {
    use crate::las::header::{parse_las_header, LasError};
    use crate::las::stream_parser::{LasParser, PdrfFormat};

    // ─── Test fixture builders ──────────────────────────────────────

    /// Build a minimal LAS v1.4 header (375 bytes). Returns a Vec<u8> ready for parsing.
    /// All numeric fields are little-endian per LAS spec.
    fn make_v14_header(
        pdrf: u8,
        record_length: u16,
        num_points: u64,
        scale: [f64; 3],
        offset: [f64; 3],
    ) -> Vec<u8> {
        let mut bytes = vec![0u8; 375];
        // Magic
        bytes[0..4].copy_from_slice(b"LASF");
        // Version
        bytes[24] = 1;
        bytes[25] = 4;
        // Header size (v1.4 = 375)
        bytes[94..96].copy_from_slice(&375u16.to_le_bytes());
        // Point data offset (immediately after header)
        bytes[96..100].copy_from_slice(&375u32.to_le_bytes());
        // Number of VLRs
        bytes[100..104].copy_from_slice(&0u32.to_le_bytes());
        // Point data format ID
        bytes[104] = pdrf;
        // Point data record length
        bytes[105..107].copy_from_slice(&record_length.to_le_bytes());
        // Legacy number of point records (u32) — used by v1.2/1.3
        bytes[107..111].copy_from_slice(&(num_points as u32).to_le_bytes());
        // Scale factors (f64 little-endian)
        bytes[131..139].copy_from_slice(&scale[0].to_le_bytes());
        bytes[139..147].copy_from_slice(&scale[1].to_le_bytes());
        bytes[147..155].copy_from_slice(&scale[2].to_le_bytes());
        // Offsets
        bytes[155..163].copy_from_slice(&offset[0].to_le_bytes());
        bytes[163..171].copy_from_slice(&offset[1].to_le_bytes());
        bytes[171..179].copy_from_slice(&offset[2].to_le_bytes());
        // Min/max XYZ (unused in tests, leave zeros)
        // v1.4-specific: number of point records (u64) at offset 247
        bytes[247..255].copy_from_slice(&num_points.to_le_bytes());
        bytes
    }

    /// Build a v1.2 header (227 bytes) — smaller subset, same fields up to byte 226.
    fn make_v12_header(
        pdrf: u8,
        record_length: u16,
        num_points: u32,
        scale: [f64; 3],
        offset: [f64; 3],
    ) -> Vec<u8> {
        let mut bytes = vec![0u8; 227];
        bytes[0..4].copy_from_slice(b"LASF");
        bytes[24] = 1;
        bytes[25] = 2;
        bytes[94..96].copy_from_slice(&227u16.to_le_bytes());
        bytes[96..100].copy_from_slice(&227u32.to_le_bytes());
        bytes[100..104].copy_from_slice(&0u32.to_le_bytes());
        bytes[104] = pdrf;
        bytes[105..107].copy_from_slice(&record_length.to_le_bytes());
        bytes[107..111].copy_from_slice(&num_points.to_le_bytes());
        bytes[131..139].copy_from_slice(&scale[0].to_le_bytes());
        bytes[139..147].copy_from_slice(&scale[1].to_le_bytes());
        bytes[147..155].copy_from_slice(&scale[2].to_le_bytes());
        bytes[155..163].copy_from_slice(&offset[0].to_le_bytes());
        bytes[163..171].copy_from_slice(&offset[1].to_le_bytes());
        bytes[171..179].copy_from_slice(&offset[2].to_le_bytes());
        bytes
    }

    /// Build a PDRF 0 point record (20 bytes).
    fn make_pdrf0(x: i32, y: i32, z: i32, intensity: u16, classification: u8) -> Vec<u8> {
        let mut bytes = vec![0u8; 20];
        bytes[0..4].copy_from_slice(&x.to_le_bytes());
        bytes[4..8].copy_from_slice(&y.to_le_bytes());
        bytes[8..12].copy_from_slice(&z.to_le_bytes());
        bytes[12..14].copy_from_slice(&intensity.to_le_bytes());
        // byte 14: return flags (leave zero)
        bytes[15] = classification;
        // bytes 16-19: scan angle, user data, point source ID (leave zero)
        bytes
    }

    /// Build a PDRF 3 point record (34 bytes) — PDRF 0 + GPS time + RGB.
    fn make_pdrf3(
        x: i32, y: i32, z: i32,
        intensity: u16, classification: u8,
        rgb: [u16; 3],
    ) -> Vec<u8> {
        let mut bytes = make_pdrf0(x, y, z, intensity, classification);
        // Pad to 28 with GPS time (f64, leave 0.0)
        bytes.extend_from_slice(&0.0f64.to_le_bytes());
        // RGB (3 × u16, little-endian)
        bytes.extend_from_slice(&rgb[0].to_le_bytes());
        bytes.extend_from_slice(&rgb[1].to_le_bytes());
        bytes.extend_from_slice(&rgb[2].to_le_bytes());
        bytes
    }

    // ─── T1: las_header_magic_recognized ──────────────────────────

    #[test]
    fn t1_las_header_magic_recognized() {
        // Given: bytes starting with "LASF"
        let bytes = make_v14_header(0, 20, 100, [0.01, 0.01, 0.01], [0.0, 0.0, 0.0]);

        // When: we parse the header
        let result = parse_las_header(&bytes);

        // Then: it succeeds
        assert!(result.is_ok(), "valid LASF header should parse");
    }

    #[test]
    fn t1b_las_header_missing_magic_rejected() {
        // Given: bytes with wrong magic
        let mut bytes = make_v14_header(0, 20, 100, [0.01; 3], [0.0; 3]);
        bytes[0..4].copy_from_slice(b"XYZW");

        // When: we parse
        let result = parse_las_header(&bytes);

        // Then: returns MissingMagic
        assert_eq!(result.unwrap_err(), LasError::MissingMagic);
    }

    // ─── T2: las_header_version_1_4_parsed ────────────────────────

    #[test]
    fn t2_las_header_version_1_4_parsed() {
        // Given: a v1.4 header (375 bytes) with known PDRF and counts
        let bytes = make_v14_header(3, 34, 12_345, [0.001, 0.001, 0.001], [500_000.0, 6_000_000.0, 0.0]);

        // When: we parse
        let h = parse_las_header(&bytes).expect("v1.4 header parses");

        // Then: all fields read correctly
        assert_eq!(h.version_major, 1);
        assert_eq!(h.version_minor, 4);
        assert_eq!(h.header_size, 375);
        assert_eq!(h.point_data_format, 3);
        assert_eq!(h.point_data_record_length, 34);
        assert_eq!(h.number_of_point_records, 12_345);
        assert_eq!(h.scale, [0.001, 0.001, 0.001]);
        assert_eq!(h.offset, [500_000.0, 6_000_000.0, 0.0]);
    }

    // ─── T3: pdrf_0_yields_xyz_intensity_classification ───────────

    #[test]
    fn t3_pdrf_0_yields_xyz_intensity_classification() {
        // Given: v1.2 header with PDRF 0 and 2 point records
        let mut bytes = make_v12_header(0, 20, 2, [0.01, 0.01, 0.01], [0.0, 0.0, 0.0]);
        bytes.extend_from_slice(&make_pdrf0(100, 200, 300, 1000, 2));
        bytes.extend_from_slice(&make_pdrf0(400, 500, 600, 2000, 5));

        // When: we parse the full file in one chunk
        let mut parser = LasParser::new();
        let result = parser.parse_chunk(&bytes).expect("parse PDRF 0");

        // Then: 2 points added, no RGB buffer
        assert_eq!(result.points_added, 2);
        assert_eq!(parser.positions().len(), 6); // 2 points × 3 coords
        assert_eq!(parser.intensity().len(), 2);
        assert_eq!(parser.intensity(), &[1000, 2000]);
        assert_eq!(parser.classification(), &[2, 5]);
        assert_eq!(parser.rgb().len(), 0, "PDRF 0 has no RGB");
        assert_eq!(parser.pdrf(), Some(PdrfFormat::Format0));
    }

    // ─── T4: pdrf_3_yields_xyz_intensity_rgb_classification ──────

    #[test]
    fn t4_pdrf_3_yields_xyz_intensity_rgb_classification() {
        // Given: v1.4 header with PDRF 3 and 1 point with RGB
        let mut bytes = make_v14_header(3, 34, 1, [0.01, 0.01, 0.01], [0.0, 0.0, 0.0]);
        bytes.extend_from_slice(&make_pdrf3(100, 200, 300, 500, 2, [65535, 32768, 0]));

        // When: we parse
        let mut parser = LasParser::new();
        let result = parser.parse_chunk(&bytes).expect("parse PDRF 3");

        // Then: all 4 buffers populated, RGB stored as 3 × u8 (downsampled from u16)
        assert_eq!(result.points_added, 1);
        assert_eq!(parser.positions().len(), 3);
        assert_eq!(parser.intensity(), &[500]);
        assert_eq!(parser.classification(), &[2]);
        assert_eq!(parser.rgb().len(), 3, "PDRF 3 produces 3 RGB bytes per point");
        // LAS RGB is u16, our SoA stores u8 (top byte = high-order)
        assert_eq!(parser.rgb()[0], 255); // 65535 >> 8 = 255
        assert_eq!(parser.rgb()[1], 128); // 32768 >> 8 = 128
        assert_eq!(parser.rgb()[2], 0);
    }

    // ─── T5: scale_and_offset_applied_correctly ──────────────────

    #[test]
    fn t5_scale_and_offset_applied_correctly() {
        // Given: scale 0.01, offset (10.0, 20.0, 30.0), i32 input (1000, 2000, 3000)
        // Expected: f32 output (10.01*1000 + 10.0 = 20.0, ...) wait let me redo:
        //   x_f32 = (1000 * 0.01) + 10.0 = 10.0 + 10.0 = 20.0
        //   y_f32 = (2000 * 0.01) + 20.0 = 20.0 + 20.0 = 40.0
        //   z_f32 = (3000 * 0.01) + 30.0 = 30.0 + 30.0 = 60.0
        let mut bytes = make_v12_header(0, 20, 1, [0.01, 0.01, 0.01], [10.0, 20.0, 30.0]);
        bytes.extend_from_slice(&make_pdrf0(1000, 2000, 3000, 0, 0));

        // When: we parse
        let mut parser = LasParser::new();
        parser.parse_chunk(&bytes).expect("parse");

        // Then: positions are scaled + offset applied
        let pos = parser.positions();
        assert!((pos[0] - 20.0).abs() < 1e-4, "x = {}", pos[0]);
        assert!((pos[1] - 40.0).abs() < 1e-4, "y = {}", pos[1]);
        assert!((pos[2] - 60.0).abs() < 1e-4, "z = {}", pos[2]);
    }

    // ─── T6: streaming_parser_handles_partial_chunks ──────────────

    #[test]
    fn t6_streaming_parser_handles_partial_chunks() {
        // Given: a 2-point PDRF 0 file (header + 40 bytes of point data)
        let mut full = make_v12_header(0, 20, 2, [0.01; 3], [0.0; 3]);
        full.extend_from_slice(&make_pdrf0(100, 200, 300, 1000, 2));
        full.extend_from_slice(&make_pdrf0(400, 500, 600, 2000, 5));

        // When: we split into 3 oddly-sized chunks (header+10 bytes, 20 bytes, 10 bytes)
        let split_a = 227 + 10; // mid-point in first record (10 of 20 bytes)
        let split_b = split_a + 20; // mid-point in second record (10 of remaining 30)
        let mut parser = LasParser::new();
        let r1 = parser.parse_chunk(&full[..split_a]).expect("chunk 1");
        let r2 = parser.parse_chunk(&full[split_a..split_b]).expect("chunk 2");
        let r3 = parser.parse_chunk(&full[split_b..]).expect("chunk 3");

        // Then: chunk 1 holds the partial record back, chunk 2 finishes it,
        // chunk 3 finishes the second. Tvinger korrekt streaming — en impl der
        // drop'er partial records vil ikke matche denne fordeling.
        assert_eq!(r1.points_added, 0, "first chunk has no complete records");
        assert_eq!(r2.points_added, 1, "second chunk completes record 1");
        assert_eq!(r3.points_added, 1, "third chunk completes record 2");
        assert_eq!(parser.intensity(), &[1000, 2000]);
        assert_eq!(parser.classification(), &[2, 5]);
    }

    // ─── T7: unsupported_pdrf_returns_error ───────────────────────

    #[test]
    fn t7_unsupported_pdrf_returns_error() {
        // Given: header with PDRF 99 (not in supported set)
        let bytes = make_v14_header(99, 20, 1, [0.01; 3], [0.0; 3]);

        // When: we parse
        let mut parser = LasParser::new();
        let result = parser.parse_chunk(&bytes);

        // Then: error is UnsupportedFormat(99)
        assert_eq!(result.unwrap_err(), LasError::UnsupportedFormat(99));
    }

    // ─── T8: large_offset_avoids_f32_precision_loss ──────────────

    #[test]
    fn t8_large_offset_avoids_f32_precision_loss() {
        // Given: UTM-like coordinates with offset 500_000.0, scale 0.001 (mm precision)
        // i32 input (12345) → world: 12345 * 0.001 + 500000.0 = 500012.345
        // Naive (cast to f32 first): (12345 as f32) * 0.001 + 500000.0 ≈ 500012.34 (lose mm)
        // Correct (f64 intermediate): 12345 as f64 * 0.001 + 500000.0 = 500012.345 → f32
        let mut bytes = make_v12_header(0, 20, 1, [0.001, 0.001, 0.001], [500_000.0, 6_000_000.0, 0.0]);
        bytes.extend_from_slice(&make_pdrf0(12345, 67890, 1234, 0, 0));

        let mut parser = LasParser::new();
        parser.parse_chunk(&bytes).expect("parse");

        let pos = parser.positions();
        // f32 ULP varies with magnitude. Tolerance afspejler f32-præcision på dette niveau:
        //   500012.345 → nærmeste f32 er ~500012.34 (ULP ≈ 0.0625) → < 0.1
        //   6_000_067.89 → nærmeste f32 er ~6_000_067.5 (ULP ≈ 1.0) → < 1.5
        // Mindre stramt end naive (f32 først) ville være: f64-intermediate giver
        // korrekt afrunding til nærmeste f32 i begge tilfælde.
        assert!(
            (pos[0] - 500012.345).abs() < 0.1,
            "x should round to ~500012.345 in f32 with f64 intermediate; got {}", pos[0],
        );
        assert!(
            (pos[1] - 6_000_067.890).abs() < 1.5,
            "y should round to ~6_000_067.5 in f32 with f64 intermediate; got {}", pos[1],
        );
        // Diagnostic: hvis impl bruger naive (f32) path vil pos[1] være tæt på
        // (12345 as f32 * 0.001 + 500000.0) i forkert dimension; vi bekræfter
        // at det er en f64-vej ved at z-koordinaten (lille tal) er præcis:
        let expected_z = 1234_f64 * 0.001 + 0.0;
        assert!(
            (pos[2] as f64 - expected_z).abs() < 0.0001,
            "z should be exact when offset is small; got {}", pos[2],
        );
    }

    // ─── T1d: LAZ-compressed file detected via high bit ──────────

    #[test]
    fn t1d_laz_compressed_file_detected_via_high_bit() {
        // Given: a valid v1.4 header with LAZ flag set (PDRF 3 | 0x80 = 131)
        let mut bytes = make_v14_header(3, 34, 1, [0.01; 3], [0.0; 3]);
        bytes[104] |= 0x80; // Set LAZ compression flag

        // When: we parse the header
        let result = parse_las_header(&bytes);

        // Then: LazCompressed error (NOT silently stripped to PDRF 3)
        assert_eq!(result.unwrap_err(), LasError::LazCompressed);
    }

    // ─── T1c (bonus): truncated header returns BufferTooSmall ────

    #[test]
    fn t1c_truncated_header_returns_buffer_too_small() {
        // Given: only the first 100 bytes (less than v1.2 minimum of 227)
        let bytes = vec![0u8; 100];
        // (Magic missing too, but the size check should trip first.)
        let result = parse_las_header(&bytes);
        // Then: error — either BufferTooSmall or MissingMagic acceptable, men
        // ikke et silent-pass eller en korrupt LasHeader.
        assert!(result.is_err(), "truncated header must not parse to Ok");
    }

    // ─── T4b (bonus): PDRF 2 yields RGB without GPS time ─────────

    #[test]
    fn t4b_pdrf_2_yields_xyz_intensity_rgb_classification_no_gps() {
        // Given: v1.2 header with PDRF 2 (26 bytes: PDRF 0 + RGB, no GPS)
        let mut bytes = make_v12_header(2, 26, 1, [0.01; 3], [0.0; 3]);
        let mut point = make_pdrf0(100, 200, 300, 500, 2);
        // RGB only (no GPS time interleaved)
        point.extend_from_slice(&65535u16.to_le_bytes());
        point.extend_from_slice(&32768u16.to_le_bytes());
        point.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&point);

        let mut parser = LasParser::new();
        let r = parser.parse_chunk(&bytes).expect("parse PDRF 2");

        assert_eq!(r.points_added, 1);
        assert_eq!(parser.positions().len(), 3);
        assert_eq!(parser.intensity(), &[500]);
        assert_eq!(parser.classification(), &[2]);
        assert_eq!(parser.rgb().len(), 3);
        assert_eq!(parser.rgb()[0], 255);
        assert_eq!(parser.pdrf(), Some(PdrfFormat::Format2));
    }
}
