// flow-engine.ts — shared typed boundary for provisioning flow stages.
//
// A stage reducer does not touch the browser. It receives immutable observed
// facts and returns the next executor action plus the loop-carried state for
// the next observation. Concrete stages keep their own action/outcome unions;
// this module owns the common transition shape.

export interface FlowStageStep<State, Action> {
  action: Action;
  nextState: State;
}

export function keepStage<State, Action>(state: State, action: Action): FlowStageStep<State, Action> {
  return { action, nextState: state };
}

export function patchStage<State extends object, Action>(
  state: State,
  action: Action,
  patch: Partial<State>,
): FlowStageStep<State, Action> {
  return { action, nextState: { ...state, ...patch } };
}
