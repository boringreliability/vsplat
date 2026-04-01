/**
 * Command pattern and history stack for undo/redo.
 *
 * Two stacks: undoStack (executed commands) and redoStack (undone commands).
 * - execute(): runs command, pushes to undo, clears redo
 * - undo(): pops from undo, calls undo(), pushes to redo
 * - redo(): pops from redo, calls execute(), pushes to undo
 *
 * Max depth enforced on undoStack — oldest commands are dropped (shift from front).
 */

export interface Command {
  execute(): void;
  undo(): void;
}

const DEFAULT_MAX_DEPTH = 100;

export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxDepth: number;

  constructor(maxDepth: number = DEFAULT_MAX_DEPTH) {
    if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
      throw new Error(`maxDepth must be a positive integer, got ${maxDepth}`);
    }
    this.maxDepth = maxDepth;
  }

  /** Execute a command, push to undo stack, clear redo stack. */
  execute(cmd: Command): void {
    cmd.execute();
    this.undoStack.push(cmd);

    // Enforce max depth — drop oldest
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }

    // New command invalidates the redo timeline
    this.redoStack.length = 0;
  }

  /** Undo the most recent command. No-op if undo stack is empty. */
  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
  }

  /** Redo the most recently undone command. No-op if redo stack is empty. */
  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.execute();
    this.undoStack.push(cmd);

    // Enforce max depth — drop oldest (same as execute())
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
