/// 3D components for Gaussian Splatting ECS.

/// 3D transform: position, rotation (quaternion), scale.
#[derive(Debug, Clone)]
pub struct Transform {
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
}

/// Splat material: opacity + spherical harmonics coefficients.
#[derive(Debug, Clone)]
pub struct SplatMaterial {
    pub opacity: f32,
    pub sh_coefficients: Vec<f32>,
}

/// Bitflags for visibility state.
pub struct VisibilityFlags;

impl VisibilityFlags {
    pub const VISIBLE: u8 = 0b0000_0001;
    pub const SELECTED: u8 = 0b0000_0010;
    pub const DELETED: u8 = 0b0000_0100;
}

/// Visibility component using bitflags. Supports soft-delete for free Undo.
#[derive(Debug, Clone, Copy)]
pub struct Visibility {
    flags: u8,
}

impl Default for Visibility {
    fn default() -> Self {
        Self {
            flags: VisibilityFlags::VISIBLE,
        }
    }
}

impl Visibility {
    #[inline]
    pub fn is_visible(&self) -> bool {
        self.flags & VisibilityFlags::VISIBLE != 0
    }

    #[inline]
    pub fn is_selected(&self) -> bool {
        self.flags & VisibilityFlags::SELECTED != 0
    }

    #[inline]
    pub fn is_deleted(&self) -> bool {
        self.flags & VisibilityFlags::DELETED != 0
    }

    /// Set a flag.
    #[inline]
    pub fn set(&mut self, flag: u8) {
        self.flags |= flag;
    }

    /// Clear a flag.
    #[inline]
    pub fn clear(&mut self, flag: u8) {
        self.flags &= !flag;
    }

    /// Soft-delete: mark as deleted, clear visible + selected.
    #[inline]
    pub fn soft_delete(&mut self) {
        self.flags = VisibilityFlags::DELETED;
    }

    /// Restore: clear deleted, set visible.
    #[inline]
    pub fn restore(&mut self) {
        self.flags = VisibilityFlags::VISIBLE;
    }
}
