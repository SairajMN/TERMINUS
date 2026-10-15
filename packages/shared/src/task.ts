export type TaskState =
  | "queued"
  | "investigating"
  | "planning"
  | "awaiting_approval"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "failed_check"
  | "diagnosing"
  | "completed"
  | "cancelled";

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["investigating", "cancelled"],
  investigating: ["planning", "completed", "cancelled"],
  planning: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["implementing", "planning", "cancelled"],
  implementing: ["verifying", "failed_check", "cancelled"],
  verifying: ["reviewing", "completed", "failed_check", "cancelled"],
  reviewing: ["completed", "diagnosing", "cancelled"],
  failed_check: ["diagnosing", "completed", "cancelled"],
  diagnosing: ["implementing", "cancelled"],
  completed: [],
  cancelled: [],
};

export const canTransition = (from: TaskState, to: TaskState): boolean =>
  TRANSITIONS[from].includes(to);

export class TaskMachine {
  state: TaskState = "queued";

  to(next: TaskState): TaskState {
    if (!canTransition(this.state, next)) {
      throw new Error(`invalid task transition: ${this.state} -> ${next}`);
    }
    this.state = next;
    return next;
  }

  get finished(): boolean {
    return this.state === "completed" || this.state === "cancelled";
  }
}
