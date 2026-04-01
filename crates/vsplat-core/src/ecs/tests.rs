/// Ward 4 tests: 3D ECS Core
/// Tests entity lifecycle, component storage, swap-and-pop, batch spawn, and queries.

#[cfg(test)]
pub mod tests {
    use crate::ecs::component_store::ComponentStore;
    use crate::ecs::entity::{Entity, EntityManager};
    use crate::ecs::components::{Transform, Visibility, VisibilityFlags};
    use crate::ecs::world::World;
    use crate::ply::SplatData;

    // ─── Test 1: entity_spawn_despawn ─────────────────────────────────

    #[test]
    fn entity_spawn_despawn() {
        let mut em = EntityManager::new();

        // Spawn 3 entities
        let e0 = em.spawn();
        let e1 = em.spawn();
        let e2 = em.spawn();

        assert_eq!(e0.index, 0);
        assert_eq!(e1.index, 1);
        assert_eq!(e2.index, 2);
        assert_eq!(e0.generation, 0);

        // All alive
        assert!(em.is_alive(e0));
        assert!(em.is_alive(e1));
        assert!(em.is_alive(e2));

        // Despawn e1
        em.despawn(e1);
        assert!(!em.is_alive(e1));

        // e0 and e2 still alive
        assert!(em.is_alive(e0));
        assert!(em.is_alive(e2));

        // Respawn reuses slot 1 with bumped generation
        let e3 = em.spawn();
        assert_eq!(e3.index, 1);
        assert_eq!(e3.generation, 1);

        // Old e1 reference is stale
        assert!(!em.is_alive(e1));
        assert!(em.is_alive(e3));
    }

    // ─── Test 2: component_store_insert_get ───────────────────────────

    #[test]
    fn component_store_insert_get() {
        let mut store = ComponentStore::<f64>::new();

        let e0 = Entity { index: 0, generation: 0 };
        let e1 = Entity { index: 1, generation: 0 };
        let e2 = Entity { index: 5, generation: 0 };

        store.insert(e0, 1.0);
        store.insert(e1, 2.0);
        store.insert(e2, 3.0);

        assert_eq!(store.get(e0), Some(&1.0));
        assert_eq!(store.get(e1), Some(&2.0));
        assert_eq!(store.get(e2), Some(&3.0));
        assert_eq!(store.len(), 3);

        // Non-existent entity returns None
        let missing = Entity { index: 99, generation: 0 };
        assert_eq!(store.get(missing), None);
    }

    // ─── Test 3: component_store_swap_and_pop ─────────────────────────

    #[test]
    fn component_store_swap_and_pop() {
        let mut store = ComponentStore::<&str>::new();

        let e0 = Entity { index: 0, generation: 0 };
        let e1 = Entity { index: 1, generation: 0 };
        let e2 = Entity { index: 2, generation: 0 };

        store.insert(e0, "alpha");
        store.insert(e1, "beta");
        store.insert(e2, "gamma");

        // Dense array before removal: ["alpha", "beta", "gamma"]
        assert_eq!(store.len(), 3);

        // Remove e1 (middle element) — swap with last
        store.remove(e1);
        assert_eq!(store.len(), 2);

        // e1 is gone
        assert_eq!(store.get(e1), None);

        // e0 and e2 still accessible with correct values
        assert_eq!(store.get(e0), Some(&"alpha"));
        assert_eq!(store.get(e2), Some(&"gamma"));

        // Dense array is still tightly packed (no holes)
        let dense = store.dense_data();
        assert_eq!(dense.len(), 2);
    }

    // ─── Test 4: batch_spawn_from_ply ─────────────────────────────────

    #[test]
    fn batch_spawn_from_ply() {
        let count = 1000;
        let sh_dim = 3;

        // Create fake SplatData
        let mut splat_data = SplatData::with_capacity(count, sh_dim);
        for i in 0..count {
            let v = i as f32;
            splat_data.positions.extend_from_slice(&[v, v + 0.1, v + 0.2]);
            splat_data.rotations.extend_from_slice(&[1.0, 0.0, 0.0, 0.0]);
            splat_data.scales.extend_from_slice(&[1.0, 1.0, 1.0]);
            splat_data.opacities.push(0.95);
            splat_data.sh_coefficients.extend_from_slice(&[0.5, 0.5, 0.5]);
        }

        let mut world = World::new();
        let entities = world.batch_spawn_splats(&splat_data);

        assert_eq!(entities.len(), count);

        // Verify first entity's transform
        let t0 = world.transforms.get(entities[0]).unwrap();
        assert!((t0.position[0] - 0.0).abs() < 1e-6);
        assert!((t0.position[1] - 0.1).abs() < 1e-6);
        assert!((t0.position[2] - 0.2).abs() < 1e-6);

        // Verify last entity's transform
        let last = entities[count - 1];
        let tl = world.transforms.get(last).unwrap();
        assert!((tl.position[0] - (count - 1) as f32).abs() < 1e-6);

        // Verify material
        let m0 = world.materials.get(entities[0]).unwrap();
        assert!((m0.opacity - 0.95).abs() < 1e-6);
        assert_eq!(m0.sh_coefficients.len(), 3);
    }

    // ─── Test 5: transform_component_layout ───────────────────────────

    #[test]
    fn transform_component_layout() {
        let mut store = ComponentStore::<Transform>::new();

        let entities: Vec<Entity> = (0..100)
            .map(|i| Entity { index: i as u32, generation: 0 })
            .collect();

        for (i, &e) in entities.iter().enumerate() {
            store.insert(e, Transform {
                position: [i as f32, 0.0, 0.0],
                rotation: [1.0, 0.0, 0.0, 0.0],
                scale: [1.0, 1.0, 1.0],
            });
        }

        // Dense data is contiguous — iterate to verify SoA-like access pattern
        let dense = store.dense_data();
        assert_eq!(dense.len(), 100);

        // Positions are in insertion order (since no removals)
        assert!((dense[0].position[0] - 0.0).abs() < 1e-6);
        assert!((dense[50].position[0] - 50.0).abs() < 1e-6);
        assert!((dense[99].position[0] - 99.0).abs() < 1e-6);
    }

    // ─── Test 6: visibility_bitflags ──────────────────────────────────

    #[test]
    fn visibility_bitflags() {
        let mut vis = Visibility::default();

        // Default: visible, not selected, not deleted
        assert!(vis.is_visible());
        assert!(!vis.is_selected());
        assert!(!vis.is_deleted());

        // Select
        vis.set(VisibilityFlags::SELECTED);
        assert!(vis.is_visible());
        assert!(vis.is_selected());

        // Soft delete — clears visible, sets deleted
        vis.soft_delete();
        assert!(!vis.is_visible());
        assert!(vis.is_deleted());
        assert!(!vis.is_selected()); // selection cleared on delete

        // Restore
        vis.restore();
        assert!(vis.is_visible());
        assert!(!vis.is_deleted());
    }

    // ─── Test 7: query_single_component ───────────────────────────────

    #[test]
    fn query_single_component() {
        let mut world = World::new();

        let e0 = world.entities.spawn();
        let _e1 = world.entities.spawn();
        let e2 = world.entities.spawn();

        world.transforms.insert(e0, Transform {
            position: [1.0, 0.0, 0.0],
            rotation: [1.0, 0.0, 0.0, 0.0],
            scale: [1.0, 1.0, 1.0],
        });
        world.transforms.insert(e2, Transform {
            position: [3.0, 0.0, 0.0],
            rotation: [1.0, 0.0, 0.0, 0.0],
            scale: [1.0, 1.0, 1.0],
        });
        // e1 has no transform

        // Query all entities with Transform
        let results: Vec<(Entity, &Transform)> = world.transforms.iter().collect();
        assert_eq!(results.len(), 2);

        // Both e0 and e2 should be present
        let indices: Vec<u32> = results.iter().map(|(e, _)| e.index).collect();
        assert!(indices.contains(&0));
        assert!(indices.contains(&2));
    }

    // ─── Test 8: query_with_without_filter ────────────────────────────

    #[test]
    fn query_with_without_filter() {
        let mut world = World::new();

        let e0 = world.entities.spawn();
        let e1 = world.entities.spawn();
        let e2 = world.entities.spawn();

        // All get transforms
        for &e in &[e0, e1, e2] {
            world.transforms.insert(e, Transform {
                position: [0.0, 0.0, 0.0],
                rotation: [1.0, 0.0, 0.0, 0.0],
                scale: [1.0, 1.0, 1.0],
            });
        }

        // Only e0 and e2 get visibility
        let vis0 = Visibility::default();
        let mut vis2 = Visibility::default();
        vis2.set(VisibilityFlags::SELECTED);

        world.visibility.insert(e0, vis0);
        world.visibility.insert(e2, vis2);

        // Query: entities WITH Transform AND WITH Visibility
        let with_both: Vec<Entity> = world.transforms.iter()
            .filter(|(e, _)| world.visibility.get(*e).is_some())
            .map(|(e, _)| e)
            .collect();
        assert_eq!(with_both.len(), 2);

        // Query: entities WITH Transform AND WITHOUT Visibility
        let without_vis: Vec<Entity> = world.transforms.iter()
            .filter(|(e, _)| world.visibility.get(*e).is_none())
            .map(|(e, _)| e)
            .collect();
        assert_eq!(without_vis.len(), 1);
        assert_eq!(without_vis[0].index, 1);
    }
}
