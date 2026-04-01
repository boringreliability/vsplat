/// Generic ComponentStore with Swap-and-Pop deletion.
/// Dense array stays tightly packed — no holes — for cache-friendly iteration.

use super::entity::Entity;

const EMPTY: u32 = u32::MAX;

/// SoA-friendly component storage. Sparse index maps entity→dense slot.
/// Dense array holds (Entity, T) pairs for contiguous iteration.
pub struct ComponentStore<T> {
    /// Sparse array: entity.index → dense index. EMPTY if not present.
    sparse: Vec<u32>,
    /// Dense array of component data, tightly packed.
    dense: Vec<T>,
    /// Parallel to dense: which entity owns each dense slot.
    dense_entities: Vec<Entity>,
}

impl<T> ComponentStore<T> {
    pub fn new() -> Self {
        Self {
            sparse: Vec::new(),
            dense: Vec::new(),
            dense_entities: Vec::new(),
        }
    }

    /// Pre-allocate capacity for batch inserts.
    pub fn reserve(&mut self, additional: usize) {
        self.dense.reserve(additional);
        self.dense_entities.reserve(additional);
    }

    /// Insert a component for an entity. Overwrites if already present.
    pub fn insert(&mut self, entity: Entity, component: T) {
        let idx = entity.index as usize;

        // Grow sparse if needed
        if idx >= self.sparse.len() {
            self.sparse.resize(idx + 1, EMPTY);
        }

        if self.sparse[idx] != EMPTY {
            // Overwrite existing
            let dense_idx = self.sparse[idx] as usize;
            self.dense[dense_idx] = component;
            self.dense_entities[dense_idx] = entity;
        } else {
            // New entry: append to dense
            let dense_idx = self.dense.len() as u32;
            self.sparse[idx] = dense_idx;
            self.dense.push(component);
            self.dense_entities.push(entity);
        }
    }

    /// Remove a component via Swap-and-Pop. O(1).
    pub fn remove(&mut self, entity: Entity) {
        let idx = entity.index as usize;
        if idx >= self.sparse.len() || self.sparse[idx] == EMPTY {
            return;
        }

        let dense_idx = self.sparse[idx] as usize;
        let last_idx = self.dense.len() - 1;

        // Clear sparse entry for removed entity
        self.sparse[idx] = EMPTY;

        if dense_idx != last_idx {
            // Swap with last element
            self.dense.swap(dense_idx, last_idx);
            self.dense_entities.swap(dense_idx, last_idx);

            // Update sparse for the swapped entity
            let swapped = self.dense_entities[dense_idx];
            self.sparse[swapped.index as usize] = dense_idx as u32;
        }

        // Pop last
        self.dense.pop();
        self.dense_entities.pop();
    }

    /// Get a component reference by entity.
    #[inline]
    pub fn get(&self, entity: Entity) -> Option<&T> {
        let idx = entity.index as usize;
        if idx >= self.sparse.len() {
            return None;
        }
        let dense_idx = self.sparse[idx];
        if dense_idx == EMPTY {
            return None;
        }
        Some(&self.dense[dense_idx as usize])
    }

    /// Number of components stored.
    #[inline]
    pub fn len(&self) -> usize {
        self.dense.len()
    }

    /// Direct access to the dense data array (contiguous, no holes).
    pub fn dense_data(&self) -> &[T] {
        &self.dense
    }

    /// Iterate over (Entity, &T) pairs.
    pub fn iter(&self) -> impl Iterator<Item = (Entity, &T)> {
        self.dense_entities.iter().copied().zip(self.dense.iter())
    }
}
