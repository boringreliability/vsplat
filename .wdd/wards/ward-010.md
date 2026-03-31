---
ward: 10
revision: null
name: "Command System & Editor Actions"
epic: "interaction-mlp"
status: "planned"
dependencies: [9]
layer: "rust"
estimated_tests: 8
created: "2026-03-31"
completed: null
---
# Ward 010: Command System & Editor Actions

## Scope
Gør "Delete" og "Undo" instant. CommandHistory pattern fra vcore med tag-baseret soft delete der tillader gratis undo uden data-tab.

## Inputs
- Ward 9: Selection system (Visibility.selected entities)

## Outputs
- Command trait og CommandHistory stack
- DeleteCommand (soft delete via Deleted tag)
- Undo/Redo system
- GPU buffer integration (skip deleted splats)
- Keyboard shortcuts (Delete, Ctrl+Z, Ctrl+Shift+Z)

## Specification
1. **Command Pattern (Rust):**
   - `Command` trait med `execute()`, `undo()`, `redo()`
   - `CommandHistory` med undo stack og redo stack
   - Max history depth (configurable, default 100)

2. **Delete Command:**
   - `execute()`: Tilføj `Deleted` tag-komponent til alle selected entities
   - `undo()`: Fjern `Deleted` tag fra entities
   - Data forbliver i arrays — ingen Swap-and-Pop ved delete
   - GPU buffer opdateres til at skippe deleted entities

3. **GPU Integration:**
   - Visibility mask buffer uploades til GPU
   - Render shader checker mask: `if (deleted) discard;`
   - Depth sort ignorerer deleted splats

4. **Keyboard Shortcuts:**
   - Delete/Backspace: Kør DeleteCommand på selected entities
   - Ctrl+Z: Undo
   - Ctrl+Shift+Z: Redo
   - Escape: Deselect all

## Tests

| # | Test Name | Verifies |
|---|-----------|----------|
| 1 | command_execute_undo | Command kan eksekveres og undoes |
| 2 | command_redo | Redo efter undo genindfører ændring |
| 3 | delete_adds_tag | Delete tilføjer Deleted tag, fjerner ikke data |
| 4 | undo_delete_removes_tag | Undo fjerner Deleted tag |
| 5 | deleted_splats_not_rendered | GPU springer deleted splats over |
| 6 | deleted_splats_not_sorted | Depth sort ignorerer deleted |
| 7 | command_history_limit | History respekterer max depth |
| 8 | redo_cleared_on_new_command | Ny command clearer redo stack |

## Must NOT
- Kør Swap-and-Pop fjernelse ved midlertidige deletes
- Fjern data fra ECS arrays ved delete (kun tag)
- Rigtig sletning sker først ved eksport

## Must DO
- Implementer CommandHistory (fra vcore)
- Ved 'Delete' tilføj Deleted tag-komponent
- Buffere opdateres så de ignoreres af GPU'en
- Undo fjerner blot tagget

## Verification
- Alle 8 tests er grønne
- Delete + Undo er instant (< 1ms for 100K splats)
- Deleted splats er usynlige i renderingen
- Undo genopretter dem visuelt
