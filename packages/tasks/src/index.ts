import type { TaskState } from '@gerald/contracts';
import { generateId } from '@gerald/security';

export interface TaskRecord {
  id: string;
  userId: string;
  parentTaskId?: string;
  title: string;
  goal?: string;
  required: boolean;
  state: TaskState;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  triggerEventId: string;
  fromState?: TaskState;
  toState: TaskState;
  data: Record<string, unknown>;
  createdAt: Date;
}

export class TaskService {
  private readonly taskRecords: TaskRecord[] = [];
  private readonly taskEvents: TaskEvent[] = [];

  create(
    userId: string,
    title: string,
    options: { goal?: string; required?: boolean; parentTaskId?: string } = {},
  ): TaskRecord {
    if (options.parentTaskId && this.depth(options.parentTaskId) >= 3)
      throw new Error('Task nesting is limited to three levels');
    const task: TaskRecord = {
      id: generateId(),
      userId,
      title,
      state: 'ACTIVE',
      required: options.required ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(options.goal ? { goal: options.goal } : {}),
      ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
    };
    this.taskRecords.push(task);
    return task;
  }

  transition(
    taskId: string,
    toState: TaskState,
    triggerEventId: string,
    data: Record<string, unknown> = {},
  ): TaskRecord {
    if (!triggerEventId) throw new Error('Every task transition requires a user trigger event');
    const task = this.taskRecords.find((item) => item.id === taskId);
    if (!task) throw new Error('Task not found');
    if (task.state === toState) return task;
    if (task.state === 'COMPLETED' || task.state === 'CANCELLED')
      throw new Error('Terminal task cannot transition');
    const fromState = task.state;
    task.state = toState;
    task.updatedAt = new Date();
    this.taskEvents.push({
      id: generateId(),
      taskId,
      triggerEventId,
      fromState,
      toState,
      data,
      createdAt: new Date(),
    });
    return task;
  }

  completeParent(taskId: string, triggerEventId: string, goalCheck: () => boolean): TaskRecord {
    const parent = this.get(taskId);
    const children = this.taskRecords.filter((task) => task.parentTaskId === taskId);
    if (children.some((child) => child.required && child.state !== 'COMPLETED'))
      throw new Error('Required subtasks are incomplete');
    if (!goalCheck()) throw new Error('Explicit goal-achievement check failed');
    return this.transition(parent.id, 'COMPLETED', triggerEventId, { goalCheck: 'passed' });
  }

  get(taskId: string): TaskRecord {
    const task = this.taskRecords.find((item) => item.id === taskId);
    if (!task) throw new Error('Task not found');
    return task;
  }

  tree(userId: string): readonly TaskRecord[] {
    return this.taskRecords.filter((task) => task.userId === userId && task.state !== 'CANCELLED');
  }

  events(taskId?: string): readonly TaskEvent[] {
    return taskId ? this.taskEvents.filter((event) => event.taskId === taskId) : this.taskEvents;
  }

  private depth(taskId: string): number {
    let depth = 1;
    let current = this.taskRecords.find((task) => task.id === taskId);
    while (current?.parentTaskId) {
      depth += 1;
      current = this.taskRecords.find((task) => task.id === current?.parentTaskId);
    }
    return depth;
  }
}
