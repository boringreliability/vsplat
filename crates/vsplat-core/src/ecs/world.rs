/// ECS World: ties together EntityManager and ComponentStores.
/// Provides batch_spawn_splats for bulk loading parsed PLY data.

use super::entity::{Entity, EntityManager};
use super::component_store::ComponentStore;
use super::components::{Transform, SplatMaterial, Visibility};
use crate::ply::SplatData;

/// The ECS world holding all entities and their component stores.
pub struct World {
    pub entities: EntityManager,
    pub transforms: ComponentStore<Transform>,
    pub materials: ComponentStore<SplatMaterial>,
    pub visibility: ComponentStore<Visibility>,
}

impl World {
    pub fn new() -> Self {
        Self {
            entities: EntityManager::new(),
            transforms: ComponentStore::new(),
            materials: ComponentStore::new(),
            visibility: ComponentStore::new(),
        }
    }

    /// Batch-spawn entities from parsed PLY data.
    /// Pre-allocates all component stores, then inserts in one pass.
    pub fn batch_spawn_splats(&mut self, data: &SplatData) -> Vec<Entity> {
        let count = data.count;

        // Reserve capacity once
        self.transforms.reserve(count);
        self.materials.reserve(count);
        self.visibility.reserve(count);

        let entities = self.entities.batch_spawn(count);

        for (i, &entity) in entities.iter().enumerate() {
            // Transform: extract position, rotation, scale from SoA arrays
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

            // Material: opacity + SH slice
            let sh_start = i * data.sh_dim;
            let sh_end = sh_start + data.sh_dim;
            self.materials.insert(entity, SplatMaterial {
                opacity: data.opacities[i],
                sh_coefficients: data.sh_coefficients[sh_start..sh_end].to_vec(),
            });

            // Visibility: default (visible)
            self.visibility.insert(entity, Visibility::default());
        }

        entities
    }
}
