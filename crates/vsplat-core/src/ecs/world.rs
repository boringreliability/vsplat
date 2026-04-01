/// ECS World: ties together EntityManager, ComponentStores, and flat SoA buffers.
/// Provides batch_spawn_splats for bulk loading parsed PLY data.
///
/// Material data (opacity, SH coefficients) is stored in flat contiguous buffers
/// indexed by entity slot index, NOT in per-entity ComponentStores. This eliminates
/// per-entity Vec<f32> heap allocations and enables direct GPU upload.
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
    /// Contiguous, cache-friendly, GPU-uploadable.
    pub sh_coefficients: Vec<f32>,
    /// SH dimension (uniform per scene): 3, 12, 27, or 48 for degrees 0-3.
    /// Initialized from first batch. Subsequent batches must match.
    pub sh_dim: usize,
}

impl World {
    pub fn new() -> Self {
        Self {
            entities: EntityManager::new(),
            transforms: ComponentStore::new(),
            visibility: ComponentStore::new(),
            opacities: Vec::new(),
            sh_coefficients: Vec::new(),
            sh_dim: 0, // initialized from first batch
        }
    }

    /// Batch-spawn entities from parsed PLY data.
    ///
    /// Uses bulk extend_from_slice for opacity and SH data — zero per-entity allocation.
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

        // Opacity + SH: bulk copy from SplatData (zero per-entity allocation)
        self.opacities.extend_from_slice(&data.opacities);
        self.sh_coefficients.extend_from_slice(&data.sh_coefficients);

        entities
    }
}
