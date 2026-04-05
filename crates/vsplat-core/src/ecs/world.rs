/// ECS World: ties together EntityManager, ComponentStores, and flat SoA buffers.
/// Provides batch_spawn_splats for bulk loading parsed PLY data.
///
/// Material data (opacity, SH coefficients) is stored in flat contiguous buffers
/// indexed by entity slot index, NOT in per-entity ComponentStores. This eliminates
/// per-entity Vec<f32> heap allocations and enables direct GPU upload.
///
/// Ward 15 adds flat_positions, flat_rotations, flat_scales as GPU-ready parallel
/// copies of the Transform ComponentStore data. These are populated via
/// extend_from_slice during batch spawn and exposed to JS via FFI pointers.
///
/// Index stability contract: The 1:1 mapping between entity slot index and buffer
/// position is valid because deletion is soft-delete only (visibility flags).
/// Any future compaction must update this contract explicitly.

use super::entity::{Entity, EntityManager};
use super::component_store::ComponentStore;
use super::components::{Transform, Visibility};
use crate::ply::SplatData;

/// The ECS world holding all entities and their data.
pub struct World {
    pub entities: EntityManager,
    pub transforms: ComponentStore<Transform>,
    pub visibility: ComponentStore<Visibility>,

    /// Flat opacity buffer: opacities[entity_index]. One f32 per entity.
    pub opacities: Vec<f32>,
    /// Flat SH coefficient buffer: sh_coefficients[entity_index * sh_dim + coeff_index].
    pub sh_coefficients: Vec<f32>,
    /// SH dimension (uniform per scene): 3, 12, 27, or 48 for degrees 0-3.
    pub sh_dim: usize,

    // Ward 15: GPU-ready flat buffers (parallel to ComponentStore<Transform>).
    // Populated by extend_from_slice during batch spawn. Exposed via FFI pointers.
    /// Flat positions: [x0,y0,z0, x1,y1,z1, ...]. Length = entity_count * 3.
    pub flat_positions: Vec<f32>,
    /// Flat rotations: [w0,x0,y0,z0, w1,x1,y1,z1, ...]. Length = entity_count * 4.
    pub flat_rotations: Vec<f32>,
    /// Flat scales: [sx0,sy0,sz0, sx1,sy1,sz1, ...]. Length = entity_count * 3.
    pub flat_scales: Vec<f32>,
    /// Sorted indices for rendering. Populated by sort_by_depth().
    pub sorted_indices: Vec<u32>,
    /// Scratch buffers for O(n) counting sort
    pub depth_buffer: Vec<u32>,
    pub count_buffer: Vec<u32>,
}

impl World {
    pub fn new() -> Self {
        Self {
            entities: EntityManager::new(),
            transforms: ComponentStore::new(),
            visibility: ComponentStore::new(),
            opacities: Vec::new(),
            sh_coefficients: Vec::new(),
            sh_dim: 0,
            flat_positions: Vec::new(),
            flat_rotations: Vec::new(),
            flat_scales: Vec::new(),
            sorted_indices: Vec::new(),
            depth_buffer: Vec::new(),
            count_buffer: Vec::new(),
        }
    }

    /// Batch-spawn entities from parsed PLY data.
    ///
    /// Uses bulk extend_from_slice for all flat buffers — zero per-entity allocation.
    /// Panics if sh_dim mismatches an already-initialized world.
    pub fn batch_spawn_splats(&mut self, data: &SplatData) -> Vec<Entity> {
        let count = data.count;

        // Validate/initialize sh_dim
        if self.sh_dim == 0 {
            self.sh_dim = data.sh_dim;
        } else if self.sh_dim != data.sh_dim {
            panic!(
                "sh_dim mismatch: world has sh_dim={}, but batch has sh_dim={}",
                self.sh_dim, data.sh_dim,
            );
        }

        // Reserve capacity once
        self.transforms.reserve(count);
        self.visibility.reserve(count);
        self.opacities.reserve(count);
        self.sh_coefficients.reserve(count * self.sh_dim);
        self.flat_positions.reserve(count * 3);
        self.flat_rotations.reserve(count * 4);
        self.flat_scales.reserve(count * 3);

        let entities = self.entities.batch_spawn(count);

        // Transforms + visibility: per-entity insert (ComponentStore requires it)
        for (i, &entity) in entities.iter().enumerate() {
            let p = i * 3;
            let r = i * 4;
            let s = i * 3;

            self.transforms.insert(entity, Transform {
                position: [
                    data.positions[p],
                    data.positions[p + 1],
                    data.positions[p + 2],
                ],
                rotation: [
                    data.rotations[r],
                    data.rotations[r + 1],
                    data.rotations[r + 2],
                    data.rotations[r + 3],
                ],
                scale: [
                    data.scales[s],
                    data.scales[s + 1],
                    data.scales[s + 2],
                ],
            });

            self.visibility.insert(entity, Visibility::default());
        }

        // Flat buffers: bulk copy for most, convert for scales
        // Opacity is already sigmoid'd by the parser (Ward 18).
        self.opacities.extend_from_slice(&data.opacities);
        self.sh_coefficients.extend_from_slice(&data.sh_coefficients);
        self.flat_positions.extend_from_slice(&data.positions);
        self.flat_rotations.extend_from_slice(&data.rotations);

        // GPU-ready scales: exp() converts from log-space to linear.
        // ECS Transform retains raw log-space scales for roundtrip export.
        for i in 0..count {
            let s = i * 3;
            self.flat_scales.push(data.scales[s].exp());
            self.flat_scales.push(data.scales[s + 1].exp());
            self.flat_scales.push(data.scales[s + 2].exp());
        }

        entities
    }

    /// Total number of splats in the world.
    pub fn splat_count(&self) -> usize {
        self.opacities.len()
    }

    /// O(n) counting sort by dot-product depth, nearest first (front-to-back).
    /// Uses adaptive key width (10-20 bits) based on splat count.
    /// Y is negated to match 3DGS→WebGPU convention.
    /// Returns total count (behind-camera culling handled in vertex shader).
    pub fn sort_by_depth(
        &mut self,
        cam_x: f32, cam_y: f32, cam_z: f32,
        dir_x: f32, dir_y: f32, dir_z: f32,
    ) -> usize {
        let count = self.splat_count();
        if count == 0 { return 0; }
        let pos = &self.flat_positions;

        // Resize scratch buffers
        if self.depth_buffer.len() != count {
            self.depth_buffer.resize(count, 0);
        }
        if self.sorted_indices.len() != count {
            self.sorted_indices.resize(count, 0);
        }

        // Pass 1: compute dot-product depths, find min/max
        let mut min_depth = f32::MAX;
        let mut max_depth = f32::MIN;
        for i in 0..count {
            let idx = i * 3;
            let x = pos[idx];
            let y = -pos[idx + 1]; // Y-flip
            let z = pos[idx + 2];
            let d = x * dir_x + y * dir_y + z * dir_z;
            if d < min_depth { min_depth = d; }
            if d > max_depth { max_depth = d; }
        }

        // Adaptive key width: ceil(log2(count)) clamped to [10, 20]
        let key_bits = ((count as f32).log2().ceil() as u32).clamp(10, 20);
        let bucket_count = (1u32 << key_bits) + 1;

        // Resize count buffer
        if self.count_buffer.len() < bucket_count as usize {
            self.count_buffer.resize(bucket_count as usize, 0);
        }
        self.count_buffer[..bucket_count as usize].fill(0);

        let range = max_depth - min_depth;
        let inv_range = if range > 1e-6 {
            (bucket_count - 1) as f32 / range
        } else {
            0.0
        };

        // Pass 2: quantize depths to keys, count per bucket
        for i in 0..count {
            let idx = i * 3;
            let d = pos[idx] * dir_x + (-pos[idx + 1]) * dir_y + pos[idx + 2] * dir_z;
            let key = ((d - min_depth) * inv_range) as u32;
            self.depth_buffer[i] = key;
            self.count_buffer[key as usize] += 1;
        }

        // Pass 3: exclusive prefix sum
        let mut sum = 0u32;
        for i in 0..bucket_count as usize {
            let c = self.count_buffer[i];
            self.count_buffer[i] = sum;
            sum += c;
        }

        // Pass 4: scatter into sorted_indices (front-to-back: nearest first)
        for i in 0..count {
            let key = self.depth_buffer[i] as usize;
            let dest = self.count_buffer[key] as usize;
            self.sorted_indices[dest] = i as u32;
            self.count_buffer[key] += 1;
        }

        count
    }
}
