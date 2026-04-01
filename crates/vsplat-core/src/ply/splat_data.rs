/// SoA (Struct of Arrays) layout for parsed splat data.
/// Each array holds one component for all splats, optimised for GPU upload.

/// Parsed splat scene data in SoA layout.
#[derive(Debug, Clone)]
pub struct SplatData {
    /// Number of splats
    pub count: usize,
    /// Positions: [x0, y0, z0, x1, y1, z1, ...] — length = count * 3
    pub positions: Vec<f32>,
    /// Rotations (quaternion): [w0, x0, y0, z0, w1, ...] — length = count * 4
    pub rotations: Vec<f32>,
    /// Scales: [sx0, sy0, sz0, sx1, ...] — length = count * 3
    pub scales: Vec<f32>,
    /// Opacity: [o0, o1, o2, ...] — length = count
    pub opacities: Vec<f32>,
    /// SH coefficients (DC + rest): flattened, length = count * sh_dim
    pub sh_coefficients: Vec<f32>,
    /// Dimension of SH per splat (e.g., 3 for DC-only, 48 for degree 3)
    pub sh_dim: usize,
}

impl SplatData {
    /// Pre-allocate all arrays for `count` splats with given SH dimension.
    pub fn with_capacity(count: usize, sh_dim: usize) -> Self {
        Self {
            count,
            positions: Vec::with_capacity(count * 3),
            rotations: Vec::with_capacity(count * 4),
            scales: Vec::with_capacity(count * 3),
            opacities: Vec::with_capacity(count),
            sh_coefficients: Vec::with_capacity(count * sh_dim),
            sh_dim,
        }
    }
}
