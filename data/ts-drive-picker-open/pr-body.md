Google Flights and similar forms require opening pickers before selecting their values. This change gives `operate_drive` those actions and bounds automatic picker attempts so the model can recover when a control cannot be clicked.

1. Offer click-to-open actions for fillable pickers while retaining typing.
2. Wait for picker options and calendar cells after opening, and for refreshed suggestions after typing into the focused overlay input.
3. Exclude ordinary offscreen buttons from the bounded snapshot to reduce calendar floods.
4. Map Departure to the date fact rather than the origin fact.
5. Retain the explicitly authorized fact-backed combobox dispatcher: open a control whose displayed value contradicts a supplied fact, then choose the matching option. Attempt it once per observed state and yield to the model after a stale, occluded, or offscreen click, even when the recovery snapshot changes. A rejected option click does not mark its field filled.

The author reported that rules text alone did not open the ticket-type menu in the live Flights comparison. The branch history records the rules experiment in `f552fcdc`, its reversal in `d9de6757`, and the retained dispatcher in `07dae239`. This is the rationale for the fifth change; the live comparison was not rerun during this review phase, and its referenced scout report is absent from this worktree.

Regression coverage executes the browser loop with an offscreen Country combobox, a covered Country combobox, and a combobox whose click changes nothing. The recovery cases require the model to scroll or dismiss the obstruction before automatic selection can finish. Model answers are deterministic fixtures; these tests establish dispatch and recovery behavior, not live model accuracy.
