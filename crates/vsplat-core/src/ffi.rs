/// Ward 015: FFI boundary for Wasm Worker runtime.
///
/// Actual FFI function bodies. On wasm32 targets, `#[wasm_bindgen]` is applied
/// to export them to JavaScript. On native targets (cargo test), the attribute
/// is stripped — functions are plain Rust, testable without a Wasm runtime.
///
/// Uses `thread_local!` with `RefCell<Option<World>>` for safe single-threaded
/// access. Sound because the Worker is single-threaded (Web platform guarantee).

use std::cell::RefCell;
use crate::ply::{parse_header, PlyParser};
use crate::ecs::world::World;

// ─── Global State ────────────────────────────────────────────────

thread_local! {
    static WORLD: RefCell<Option<World>> = RefCell::new(None);
}

fn with_world<T>(default: T, f: impl FnOnce(&World) -> T) -> T {
    WORLD.with(|cell| {
        cell.borrow().as_ref().map_or(default, f)
    })
}

fn with_world_mut<T>(f: impl FnOnce(&mut World) -> T) -> Result<T, String> {
    WORLD.with(|cell| {
        let mut borrow = cell.borrow_mut();
        match borrow.as_mut() {
            Some(world) => Ok(f(world)),
            None => Err("Not initialized: call init() first".to_string()),
        }
    })
}

// ─── FFI Functions ───────────────────────────────────────────────

/// Initialize an empty World. Must be called before load_ply.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn init() {
    WORLD.with(|cell| {
        *cell.borrow_mut() = Some(World::new());
    });
}

/// Parse a PLY file and populate the World.
/// Returns the number of splats loaded in THIS call.
/// Returns Err on invalid PLY data; World remains usable after error.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn load_ply(data: &[u8]) -> Result<usize, String> {
    // Verify world is initialized before doing any work
    WORLD.with(|cell| {
        if cell.borrow().is_none() {
            return Err("Not initialized: call init() first".to_string());
        }
        Ok(())
    })?;

    let header = parse_header(data)?;
    let binary = &data[header.data_offset..];
    let parser = PlyParser::new(header);
    let splats = parser.parse_all(binary)?;
    let count = splats.count;
    with_world_mut(|world| {
        world.batch_spawn_splats(&splats);
    })?;
    Ok(count)
}

/// Total number of splats in the World.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_splat_count() -> usize {
    with_world(0, |w| w.splat_count())
}

/// SH dimension for the loaded scene.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_sh_dim() -> usize {
    with_world(0, |w| w.sh_dim)
}

// ─── Pointer/Length Getters ──────────────────────────────────────
// On wasm32, pointers are 32-bit and returned as u32.
// On native 64-bit (cargo test), pointers are 64-bit — we use usize.
// The wasm_bindgen exports use u32; tests use the native pointer width.

/// Get raw pointer to positions buffer. Returns byte offset (usize).
/// On wasm32 this fits in u32. JS divides by 4 for Float32Array index.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_positions_ptr() -> usize {
    with_world(0, |w| w.flat_positions.as_ptr() as usize)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_positions_len() -> usize {
    with_world(0, |w| w.flat_positions.len())
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_rotations_ptr() -> usize {
    with_world(0, |w| w.flat_rotations.as_ptr() as usize)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_rotations_len() -> usize {
    with_world(0, |w| w.flat_rotations.len())
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_scales_ptr() -> usize {
    with_world(0, |w| w.flat_scales.as_ptr() as usize)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_scales_len() -> usize {
    with_world(0, |w| w.flat_scales.len())
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_opacities_ptr() -> usize {
    with_world(0, |w| w.opacities.as_ptr() as usize)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_opacities_len() -> usize {
    with_world(0, |w| w.opacities.len())
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_sh_ptr() -> usize {
    with_world(0, |w| w.sh_coefficients.as_ptr() as usize)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_sh_len() -> usize {
    with_world(0, |w| w.sh_coefficients.len())
}

// ─── Sort ────────────────────────────────────────────────────────

/// O(n) counting sort by depth, nearest first (front-to-back).
/// Camera direction is the view-space -Z axis (normalized).
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn sort_by_depth(
    cam_x: f32, cam_y: f32, cam_z: f32,
    dir_x: f32, dir_y: f32, dir_z: f32,
) -> usize {
    with_world_mut(|world| {
        world.sort_by_depth(cam_x, cam_y, cam_z, dir_x, dir_y, dir_z)
    }).unwrap_or(0)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_sorted_indices_ptr() -> usize {
    with_world(0, |w| w.sorted_indices.as_ptr() as usize)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn get_sorted_indices_len() -> usize {
    with_world(0, |w| w.sorted_indices.len())
}

// ─── Tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
        let stride = 14 * 4;
        let header_len = header.len();
        let mut bytes = header.into_bytes();
        for i in 0..count {
            let v = i as f32;
            bytes.extend_from_slice(&v.to_le_bytes());
            bytes.extend_from_slice(&(v + 0.1).to_le_bytes());
            bytes.extend_from_slice(&(v + 0.2).to_le_bytes());
            bytes.extend_from_slice(&0.9f32.to_le_bytes());
            bytes.extend_from_slice(&1.0f32.to_le_bytes());
            bytes.extend_from_slice(&0.0f32.to_le_bytes());
            bytes.extend_from_slice(&0.0f32.to_le_bytes());
            bytes.extend_from_slice(&0.0f32.to_le_bytes());
            bytes.extend_from_slice(&1.0f32.to_le_bytes());
            bytes.extend_from_slice(&1.0f32.to_le_bytes());
            bytes.extend_from_slice(&1.0f32.to_le_bytes());
            bytes.extend_from_slice(&0.5f32.to_le_bytes());
            bytes.extend_from_slice(&0.5f32.to_le_bytes());
            bytes.extend_from_slice(&0.5f32.to_le_bytes());
        }
        assert_eq!(bytes.len(), header_len + count * stride);
        bytes
    }

    #[test]
    fn ffi_init_creates_world() {
        init();
        assert_eq!(get_splat_count(), 0);
        assert_eq!(get_positions_len(), 0);
        assert_eq!(get_rotations_len(), 0);
        assert_eq!(get_scales_len(), 0);
        assert_eq!(get_opacities_len(), 0);
        assert_eq!(get_sh_len(), 0);
        assert_eq!(get_sh_dim(), 0);
    }

    #[test]
    fn ffi_load_ply_populates_world() {
        init();
        let ply = make_test_ply(100);
        let count = load_ply(&ply).unwrap();
        assert_eq!(count, 100);
        assert_eq!(get_splat_count(), 100);
        assert_eq!(get_positions_len(), 300);
        assert_eq!(get_rotations_len(), 400);
        assert_eq!(get_scales_len(), 300);
        assert_eq!(get_opacities_len(), 100);
        assert_eq!(get_sh_len(), 100 * get_sh_dim());

        let ptr = get_positions_ptr() as *const f32;
        assert!(!ptr.is_null());
        unsafe {
            assert!((*ptr - 0.0).abs() < 1e-6);
            assert!((*ptr.add(1) - 0.1).abs() < 1e-6);
            assert!((*ptr.add(2) - 0.2).abs() < 1e-6);
        }
    }

    #[test]
    fn ffi_load_ply_invalid_returns_error() {
        init();
        let result = load_ply(b"this is not a ply file");
        assert!(result.is_err());
        assert_eq!(get_splat_count(), 0);

        let ply = make_test_ply(10);
        let count = load_ply(&ply).unwrap();
        assert_eq!(count, 10);
        assert_eq!(get_splat_count(), 10);
        assert_eq!(get_positions_len(), 30);
    }

    #[test]
    fn ffi_load_ply_without_init_returns_not_initialized() {
        // Reset world to None (thread_local may have state from other tests)
        WORLD.with(|cell| { *cell.borrow_mut() = None; });

        let ply = make_test_ply(10);
        let result = load_ply(&ply);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not initialized"));
    }

    #[test]
    fn ffi_memory_pointers_valid() {
        init();
        let ply = make_test_ply(50);
        load_ply(&ply).unwrap();

        let pos_ptr = get_positions_ptr() as *const f32;
        assert!(!pos_ptr.is_null());
        assert_eq!(get_positions_len(), 150);

        let rot_ptr = get_rotations_ptr() as *const f32;
        assert!(!rot_ptr.is_null());
        assert_eq!(get_rotations_len(), 200);

        let sc_ptr = get_scales_ptr() as *const f32;
        assert!(!sc_ptr.is_null());
        assert_eq!(get_scales_len(), 150);

        let op_ptr = get_opacities_ptr() as *const f32;
        assert!(!op_ptr.is_null());
        assert_eq!(get_opacities_len(), 50);

        let sh_ptr = get_sh_ptr() as *const f32;
        assert!(!sh_ptr.is_null());
        assert_eq!(get_sh_len(), 50 * get_sh_dim());

        unsafe {
            assert!((*pos_ptr - 0.0).abs() < 1e-6);
            assert!((*pos_ptr.add(1) - 0.1).abs() < 1e-6);
            // Raw opacity 0.9 → sigmoid(0.9) ≈ 0.7109
            let expected_opacity = 1.0 / (1.0 + (-0.9f32).exp());
            assert!((*op_ptr - expected_opacity).abs() < 1e-4);
            assert!((*rot_ptr - 1.0).abs() < 1e-6);
        }
    }
}
