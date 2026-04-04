/// Ward 015: FFI boundary for Wasm Worker runtime.
///
/// Tests (below) call FFI logic directly as Rust functions via `init_and_load` helper.
/// The actual `#[wasm_bindgen]` annotated export functions (init, load_ply,
/// get_positions_ptr/len, etc.) are deployment scope — they will wrap the same
/// logic tested here. The annotations do not change Rust-side signatures.

#[cfg(test)]
mod tests {
    use crate::ply::{parse_header, PlyParser};
    use crate::ecs::world::World;

    // ─── Test Helpers ────────────────────────────────────────────

    /// Build a minimal valid binary PLY with `count` vertices.
    /// Properties: x(f32), y(f32), z(f32), opacity(f32),
    ///             rot_0..3(f32), scale_0..2(f32), f_dc_0..2(f32)
    fn make_test_ply(count: usize) -> Vec<u8> {
        let header = format!(
            "ply\n\
             format binary_little_endian 1.0\n\
             element vertex {count}\n\
             property float x\n\
             property float y\n\
             property float z\n\
             property float opacity\n\
             property float rot_0\n\
             property float rot_1\n\
             property float rot_2\n\
             property float rot_3\n\
             property float scale_0\n\
             property float scale_1\n\
             property float scale_2\n\
             property float f_dc_0\n\
             property float f_dc_1\n\
             property float f_dc_2\n\
             end_header\n"
        );

        let stride = 14 * 4; // 14 float properties × 4 bytes
        let header_len = header.len();
        let mut bytes = header.into_bytes();
        for i in 0..count {
            let v = i as f32;
            // x, y, z
            bytes.extend_from_slice(&v.to_le_bytes());
            bytes.extend_from_slice(&(v + 0.1).to_le_bytes());
            bytes.extend_from_slice(&(v + 0.2).to_le_bytes());
            // opacity
            bytes.extend_from_slice(&0.9f32.to_le_bytes());
            // rot_0..3 (identity quaternion)
            bytes.extend_from_slice(&1.0f32.to_le_bytes());
            bytes.extend_from_slice(&0.0f32.to_le_bytes());
            bytes.extend_from_slice(&0.0f32.to_le_bytes());
            bytes.extend_from_slice(&0.0f32.to_le_bytes());
            // scale_0..2
            bytes.extend_from_slice(&1.0f32.to_le_bytes());
            bytes.extend_from_slice(&1.0f32.to_le_bytes());
            bytes.extend_from_slice(&1.0f32.to_le_bytes());
            // f_dc_0..2
            bytes.extend_from_slice(&0.5f32.to_le_bytes());
            bytes.extend_from_slice(&0.5f32.to_le_bytes());
            bytes.extend_from_slice(&0.5f32.to_le_bytes());
        }

        assert_eq!(bytes.len(), header_len + count * stride);
        bytes
    }

    /// Simulate FFI init + load_ply as pure Rust (no wasm-bindgen needed).
    /// Returns (World, loaded_count).
    fn init_and_load(ply_bytes: &[u8]) -> Result<(World, usize), String> {
        let mut world = World::new();
        let header = parse_header(ply_bytes)?;
        let binary = &ply_bytes[header.data_offset..];
        let parser = PlyParser::new(header);
        let splats = parser.parse_all(binary)?;
        let count = splats.count;
        world.batch_spawn_splats(&splats);
        Ok((world, count))
    }

    // ─── A1: ffi_init_creates_world ──────────────────────────────

    #[test]
    fn ffi_init_creates_world() {
        let world = World::new();

        // Fresh world has zero splats
        assert_eq!(world.opacities.len(), 0);
        assert_eq!(world.sh_coefficients.len(), 0);
        assert_eq!(world.flat_positions.len(), 0);
        assert_eq!(world.flat_rotations.len(), 0);
        assert_eq!(world.flat_scales.len(), 0);
        assert_eq!(world.sh_dim, 0);
    }

    // ─── A2: ffi_load_ply_populates_world ────────────────────────

    #[test]
    fn ffi_load_ply_populates_world() {
        let ply = make_test_ply(100);
        let (world, count) = init_and_load(&ply).unwrap();

        assert_eq!(count, 100);

        // Flat buffer lengths match expected layout
        assert_eq!(world.flat_positions.len(), 100 * 3);
        assert_eq!(world.flat_rotations.len(), 100 * 4);
        assert_eq!(world.flat_scales.len(), 100 * 3);
        assert_eq!(world.opacities.len(), 100);
        assert_eq!(world.sh_coefficients.len(), 100 * world.sh_dim);

        // Spot-check first splat position
        assert!((world.flat_positions[0] - 0.0).abs() < 1e-6);
        assert!((world.flat_positions[1] - 0.1).abs() < 1e-6);
        assert!((world.flat_positions[2] - 0.2).abs() < 1e-6);
    }

    // ─── A3: ffi_load_ply_invalid_returns_error ──────────────────

    #[test]
    fn ffi_load_ply_invalid_returns_error() {
        let garbage = b"this is not a ply file at all";

        let result = init_and_load(garbage);
        assert!(result.is_err());

        // World remains usable after error — can still load a valid file
        let ply = make_test_ply(10);
        let (world, count) = init_and_load(&ply).unwrap();
        assert_eq!(count, 10);
        assert_eq!(world.flat_positions.len(), 30);
    }

    // ─── A4: ffi_memory_pointers_valid ───────────────────────────

    #[test]
    fn ffi_memory_pointers_valid() {
        let ply = make_test_ply(50);
        let (world, _) = init_and_load(&ply).unwrap();

        // Pointers are non-null and point to valid data
        let pos_ptr = world.flat_positions.as_ptr();
        let pos_len = world.flat_positions.len();
        assert!(!pos_ptr.is_null());
        assert_eq!(pos_len, 150); // 50 * 3

        // Values at pointer match expected data
        unsafe {
            assert!((*pos_ptr - 0.0).abs() < 1e-6);           // first x
            assert!((*pos_ptr.add(1) - 0.1).abs() < 1e-6);   // first y
            assert!((*pos_ptr.add(2) - 0.2).abs() < 1e-6);   // first z
        }

        // SH pointer
        let sh_ptr = world.sh_coefficients.as_ptr();
        assert!(!sh_ptr.is_null());
        assert_eq!(world.sh_coefficients.len(), 50 * world.sh_dim);

        // Opacity pointer
        let op_ptr = world.opacities.as_ptr();
        assert!(!op_ptr.is_null());
        unsafe {
            assert!((*op_ptr - 0.9).abs() < 1e-6);
        }
    }
}
