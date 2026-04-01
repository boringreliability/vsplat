/// Entity management with generational indices.
/// Entity = u32 index + u32 generation for safe recycling of slots.

/// A handle to an entity. Only valid if generation matches the EntityManager's record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Entity {
    pub index: u32,
    pub generation: u32,
}

/// Manages entity lifecycle: spawn, despawn, slot recycling with generation bumping.
pub struct EntityManager {
    /// Generation counter per slot. Even = alive, odd = dead (after first despawn).
    generations: Vec<u32>,
    /// Free list of recyclable slot indices.
    free_list: Vec<u32>,
    /// Total number of currently alive entities.
    alive_count: u32,
}

impl EntityManager {
    pub fn new() -> Self {
        Self {
            generations: Vec::new(),
            free_list: Vec::new(),
            alive_count: 0,
        }
    }

    /// Spawn a single entity. Reuses a free slot if available, otherwise grows.
    #[inline]
    pub fn spawn(&mut self) -> Entity {
        self.alive_count += 1;
        if let Some(index) = self.free_list.pop() {
            // Reuse slot — generation was already bumped on despawn
            let generation = self.generations[index as usize];
            Entity { index, generation }
        } else {
            // New slot
            let index = self.generations.len() as u32;
            self.generations.push(0);
            Entity { index, generation: 0 }
        }
    }

    /// Spawn `count` entities in batch. Pre-allocates capacity.
    pub fn batch_spawn(&mut self, count: usize) -> Vec<Entity> {
        self.generations.reserve(count.saturating_sub(self.free_list.len()));
        let mut entities = Vec::with_capacity(count);
        for _ in 0..count {
            entities.push(self.spawn());
        }
        entities
    }

    /// Despawn an entity. Bumps generation and adds slot to free list.
    /// No-op if the entity is already dead (stale reference).
    pub fn despawn(&mut self, entity: Entity) {
        if !self.is_alive(entity) {
            return;
        }
        self.generations[entity.index as usize] += 1;
        self.free_list.push(entity.index);
        self.alive_count -= 1;
    }

    /// Check if an entity handle is still valid.
    #[inline]
    pub fn is_alive(&self, entity: Entity) -> bool {
        (entity.index as usize) < self.generations.len()
            && self.generations[entity.index as usize] == entity.generation
    }

    pub fn alive_count(&self) -> u32 {
        self.alive_count
    }
}
