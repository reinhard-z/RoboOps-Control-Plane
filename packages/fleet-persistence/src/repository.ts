import {
  type DomainState,
  createInitialDomainState
} from "@roboops/fleet-domain";

/**
 * Complete state replacement plus caller-owned metadata from an update callback.
 */
export interface DomainStateMutation<TResult> {
  readonly state: DomainState;
  readonly result: TResult;
}

/**
 * Transforms the latest aggregate into the complete next state plus caller metadata.
 * Durable repositories may retry this callback, so keep it deterministic and side-effect free.
 */
export type DomainStateMutator<TResult> = (
  state: DomainState
) => DomainStateMutation<TResult>;

/** Persistence boundary for the current whole-state domain aggregate. */
export interface DomainStateRepository {
  /** Returns the latest complete domain state snapshot. */
  read(): Promise<DomainState>;

  /** Replaces the current snapshot with a complete domain state. */
  write(state: DomainState): Promise<void>;

  /** Clears the current snapshot and installs the supplied complete state. */
  reset(state: DomainState): Promise<void>;

  /** Applies a retry-safe state callback, stores its state, and returns its result. */
  update<TResult>(mutator: DomainStateMutator<TResult>): Promise<TResult>;
}

/** In-memory repository used by local demos and as the contract baseline for durable stores. */
export class InMemoryDomainStateRepository implements DomainStateRepository {
  private state: DomainState;

  constructor(initialState: DomainState = createInitialDomainState()) {
    this.state = initialState;
  }

  async read(): Promise<DomainState> {
    return this.state;
  }

  async write(state: DomainState): Promise<void> {
    this.state = state;
  }

  async reset(state: DomainState): Promise<void> {
    this.state = state;
  }

  async update<TResult>(mutator: DomainStateMutator<TResult>): Promise<TResult> {
    const mutation = mutator(this.state);
    this.state = mutation.state;
    return mutation.result;
  }
}
