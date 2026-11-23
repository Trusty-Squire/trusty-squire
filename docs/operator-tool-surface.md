# Flat operator tool surface

Trusty Squire’s operator surface is a set of flat, single-purpose MCP tools.
Discover the installed server’s exact input and output schemas with `tools/list`;
that registered schema is authoritative for a particular server version.

The operator surface is listed below. Recipe and vault/account tools are
separate surfaces.

Startup navigation waits for `DOMContentLoaded`, including deferred scripts,
but skips the humanized post-load dwell before observing the page. It does not
wait for all images or subframes to finish loading; later asynchronous UI may
still require another observation or an explicit wait.

| Purpose | Tool |
| --- | --- |
| Goal-shaped drive | `operate_drive` |
| Start and finish | `operate_start`, `operate_finish` |
| Read the page | `operate_observe`, `operate_screenshot`, `operate_network` |
| Native browser dialogs | `operate_dialog` |
| Human live handoff | `operate_share` |
| Drive ordinary UI | `operate_navigate`, `operate_click`, `operate_type`, `operate_select`, `operate_upload`, `operate_press`, `operate_scroll`, `operate_wait` |
| Browser downloads | `operate_download` |
| Email verification read | `operate_read_inbox` |
| Login | `operate_login` |
| Vault-aware browser work | `operate_login({action:"load_saved"})`, `operate_extract` |
| Payments and vault lists | `inject_card`, `list_credentials`, `list_payment_cards`, `edit_payment_card` |

`operate_share({session_id})` gives a trusted server-side proxy an interactive
view of that session's tab. Lifetime, human control, navigation notifications,
and Beeline proxy mapping are specified in [Operate live share](operate-live-share.md).

Native alert, confirm, prompt and beforeunload dialogs stay open for an explicit
answer. Observations report `semantic.blockers` entries with `kind:"native_dialog"`,
`id`, `type`, `text`, `default_value`, `options` and `expires_at`. While one is open,
observations read that browser evidence without evaluating the blocked document.
Use `operate_dialog({session_id,dialog_id,action:"accept"|"dismiss",text?})`;
`text` is only valid when accepting a prompt. An expired or already answered id
is refused. Unanswered dialogs are dismissed after two minutes, and subsequent
observations include `native_dialog_notices`. Outside `operate_drive`, no dialog
is automatically accepted. `operate_drive` acknowledges alerts and decides native
confirmations against the user's goal. It hands prompt text and uncertain
credential confirmations back to the host under the
[credential guard policy](#credential-capture-and-retrieval). Destructive
consequences still require authorization; ordinary confirmations have no confidence
threshold. Each dialog answer consumes a drive step, including an automatic alert acknowledgement. The
human live viewer displays the same question with OK, Cancel and a prompt input.

`operate_upload` takes `session_id`, exactly one of a current `target` ref or
`@label` for an upload button/file input or `screenshot:{screenshot_id,x,y}`
from `operate_screenshot.click_binding`, and an absolute local `path`.
Screenshot upload uses the same original-image coordinates, freshness, frame,
and single-dispatch guards as `operate_click`. Observe after an uncertain
upload before choosing another action. The file must exist
on the machine running the browser; the operator sets it through the browser
file chooser without using an OS dialog. A control that calls
`window.showOpenFilePicker` instead of opening a file input (Dreamina's
first-frame card) is routed through that same chooser while the upload is
armed; if the page called the picker and still no chooser opened, the upload
failure cause is `file_picker_unrouted`.

Every `operate_*` step result except start, finish, and `operate_download`
carries `downloads` when a browser download started or changed state since the
last report. Each record has `download_id`, `state` (`in_progress`, `complete`,
or `failed`), `filename`, `mime_type`, `path` (absolute, on the broker host),
`size_bytes`, and `sha256`; the last three are set once the download is
complete. A download that starts during a step gets up to three seconds to
finish before the step returns. Finished files live in a private per-session
folder under `~/.trusty-squire/downloads` (override with
`TRUSTY_SQUIRE_DOWNLOADS_DIR`), capped at 2 GiB per session
(`TRUSTY_SQUIRE_DOWNLOAD_SESSION_CAP_BYTES`); the folder is deleted when the
session ends. Records belong to their session: another session or connection
cannot list or fetch them.

`operate_download({session_id, download_id, dest_dir?, delivery?, timeout_ms?})`
waits for the download to complete, then copies it into `dest_dir` on the
broker host. Without `dest_dir`, with `delivery:"handle"`, or when the copy
fails, it returns a single-use `handle` that expires after five minutes. Run
`npx -y @trusty-squire/mcp download <handle> <dest_dir>` on the agent's machine;
it reads the file over the shared MCP socket (`TRUSTY_SQUIRE_MCP_SOCKET`
overrides the path, for example a forwarded socket) and checks the sha256.
`operate_observe` on `chrome://downloads` returns guidance to use
`operate_download`; Chrome's internal page is not read. A drive whose goal asks
for one download completes after the first download it starts finishes.

For a signup, checkout, or other goal-shaped website task, call `operate_drive`
with the goal and a `facts` bag (email, name, address, `card_ref`, …). When
`facts.email` is absent, the session account email supplies the default; explicit
caller or retained email facts take precedence. No email is invented when the
session has none. Pass
`session_id` of an open session, or `url` to open the page and drive in one
call; provide exactly one. Model-directed steps ask Jev for one operation (CLICK, TYPE_TEXT, SELECT,
SCROLL, WAIT, DONE, BLOCKED) plus a matching per-operation target; unused
target heads cannot act. Identifying values come only from the facts bag. A
search or query field may receive a phrase Jev assigns from the goal's own
words or the facts; identity and payment fields still require a fact.

On a new-account form, omit the password fact to let the drive invent a random
password. Password fields and confirmation controls are recognized from English
field names or labels, and a `type=password` input whose name, label, or
placeholder names no other field (dots, or words in another language) is a
password field; a masked input whose words name another field, such as a
verification code, keeps that field. Initial invention requires explicit
Create account, Sign up, or Register evidence, or a form that asks for an
email/username plus at least one more text field (name, username, referral)
beside the password; English sign-in, reset, and current/old/existing-password
cues exclude the form. Populated password controls are preserved. Account
identifiers and confirmation controls are scoped to the password's form and
frame. The account identifier comes from the form's exact email/username value;
while that field is still empty, from the supplied fact for it; or, on a
password-only step, supplied facts or the session's signup identifier/account
email. With an
authenticated vault client, the drive saves a new `username_password` credential for the
password control's frame site before typing from a sealed session slot. It does
not overwrite an existing saved login or require `store`, which controls key
capture separately. Saving the login does not establish that account creation
succeeded. If generation or storage fails,
the password stays unfilled and the ordinary handoff applies.

Generation defaults to 24 characters, adjusted for the primary and currently
visible confirmation controls' minimum/maximum lengths, compilable patterns,
and password-local help text, with a 128-character ceiling. Empty confirmation
fields reuse the saved password for the same host and login, including fields
revealed later, only when it meets their requirements. The generated value is
not returned in drive results, history, or traces.

For a key-provisioning goal, also pass `store` as described under
[credential capture and retrieval](#credential-capture-and-retrieval).
On a drive carrying `card_ref`, the released card supplies its own facts —
`exp_month`, `exp_year`, `exp_year_short`, `card_expiry`, `card_expiry_long`,
and `card_name` — and the drive types expiry and cardholder name from them
after release. A later release rebuilds all of them, and they are never offered
as goal phrases, so a card value cannot be typed into a search box. Card
controls take those card values and nothing else: the shipping name never
lands in the cardholder field. A combined expiry control takes the year length
the control itself states (placeholder, pattern, inputmode, or label), never
its declared width — seven characters fits both `MM/YYYY` and `MM / YY`. With
nothing stated the drive writes the two-digit year, reads the value back, and
rewrites that control once with the four-digit year when the write was
rejected or truncated. A separate year control uses its own maxlength: two
digits take `exp_year_short`, anything else takes the four-digit `exp_year`.

The approval a fresh card release mints carries the total the checkout page
itself presents: the drive reads the page's last summary total — a line the
total label opens, carrying a currency symbol or code — and signs the human's
approval for that amount. The same words inside a sentence are prose ("you
saved a total of $12.00 today"), and so are a tax-exclusive figure or a counted
quantity; none of them answer for the amount. `amount_cents` is in the
currency's smallest unit: USD $12.34 → 1234; JPY ¥65,800 → 65800 (do not
multiply by 100); KRW works like JPY. That fact can only
confirm it — the page amount still stands when the two disagree, and the
disagreement is appended to the approval's item so the human reads it beside
the amount. A `currency` fact names the currency only for a symbol several
currencies share (`$`, `£`, `¥`); a currency code the page prints, or a symbol
unique to one currency, wins over the fact and keeps its own minor-unit scale.
A total the page does not present readably never refuses or blocks the
purchase: the approval is still minted and marked `total not readable`, which
the approval page, the Telegram prompt, and the 3-D Secure nudge show in place
of a zero amount. A summary total that names a currency the drive cannot
resolve, or whose displayed fraction disagrees with that currency's minor
units, reads as unreadable in exactly that way rather than being rescaled or
answered by a running figure higher up the summary. A total that names no
currency at all ("Total 3 items") is passed over like the prose above. A
resumed release replays its own approval's terms, so it does not re-read the
page.

The loop reads verification mail when a verification field is listed, and also
when a click leaves the page waiting with no fill or live choice left and its
wording or URL says mail is expected (check-your-email text, an Open Gmail
control, a verify path). It polls that read for up to 45 seconds. If that poll
window expires without mail, it hands back `needs_value` for `verification_code`,
or `stuck` when a link rather than a code was expected. If the per-call time
budget cuts the poll window short, it returns `budget` without recording a
no-mail outcome. Resume the same session without an `answer` to poll again,
even if the verification page is unchanged. It does not gate on confidence.
The drive loop takes its own in-page snapshot and dispatches click, type,
select, and scroll on a control
that snapshot recorded through the same shared act executor the single-step
tools use, asking it for no observation and keeping the drive's own settling,
pacing, occlusion guard, and cross-origin coordinate fallback; any other action
falls back to the ordinary tool act, which does return one. Login, inbox, and
card still use those primitives. The two-head Jev request, structured state,
choice validation, WAIT, SELECT option targets, snapshot evaluate, and drive
rules prose are adapted from browser-use/jev-ultrafast (MIT).
The model's INBOX rule prefers listed controls that send, request, or enter a
verification code or link before reading mail.
After the inbox poll window expires with no matching mail, that miss remains
in the outcome trail and suppresses the emailed-code question while it is the latest outcome
on that page. A later action or a different page makes the question eligible
again. A populated masked (`type=password`) field is marked `filled` in the
decider's element list and is not offered for another inbox code. This uses
the field's live populated state; clearing it makes it eligible again.

WAIT and BLOCKED are offered only while no listed work remains: an enabled
fill, select, choice, or non-OAuth submit that is actually offered keeps both
out of the answer set. A chosen WAIT remains available even when the page is
unchanged. When the snapshot is empty the loop takes up
to three automatic waits itself and then asks the ordinary question, which on
zero rows offers exactly WAIT, DONE, and BLOCKED — an empty processor screen is
not a no-op loop, so a payment keeps settling for as long as the budgets allow.
When instead the whole form surface is disabled or a submit is in flight with
no fills left, the loop takes up to three automatic settle waits on that page
and then offers only DONE and BLOCKED.

An action that produced no observable change is not offered again while the
page's URL, form surface, and filled fields stay the same; WAIT is excluded from
that budget, and a stale click ref is withheld until the observation
fingerprint changes. After five such dead actions on one page, or when they
leave no actionable operation, the drive ends with `no_progress` and a `reason`
naming them.

Negative model feedback alone permits an ordinary control to be retried; a
key-create control retains that retry guard because the first press may have
created a key. `NONE_OF_THESE` replans once on a fresh observation; another
replan on the same page state returns `no_progress`.

A drive snapshot ref names the control that snapshot recorded — its selector,
frame, role, label, and a link's destination — not a position within it. Every
act re-resolves that identity against the live page: when the ref's registered
node is gone, its selector no longer names that node alone, or the node reads
back as a different control, the act returns stale rather than acting on
whatever now sits in that place.

Before each act the loop checks the live page against the snapshot the decision
came from — the document, plus the identity, role, and enabled/checked state of
the controls that snapshot rowed, not their typed values, so a countdown or an
input mask reformatting a field does not trigger it. Unchanged, the act runs;
changed, the loop re-snapshots and decides again instead of executing a decision
the page has outgrown, and the re-decide is excluded from the no-progress
accounting: it can never end the drive, because an action that was never
dispatched is not a no-progress step. A page that never settles spends its
steps re-deciding and finishes on the step or call budget.

It returns a handoff (never a bare page): status, the current compact
observation with the same stable refs, trajectory, and done/remaining.
On `complete`, `message` states that the goal is finished and `stored` reports
whether this call captured and stored a key through `store`. When `stored` is
true, `stored_credential` carries the non-secret vault `reference`, `service`,
and optional `label`, and the message names that destination. When false,
`stored_credential` is absent; this does not report whether an invented signup
login was saved. These completion fields are absent on other statuses.
A complete result leaves the session open for further tasks; no additional
key capture is needed when `stored` is true.
`needs_value` names the selected field's label when its value is unavailable.
Empty required fields do not block a selected OAuth dispatch, even when the
OAuth control shares a form with empty username/password fields. Ordinary
submit clicks still check for outstanding empty required fields in their own
form before dispatch. A refused submit stays offered with `waits_for` naming
the empty field it needs; that field is offered for typing, or through SELECT
for a native select. Filling or removing the field releases the wait. Native
`a=submit` evidence with a form owner identifies submits regardless of label
language, alongside the existing label-based recognition. A vote that the page
is not asking for an emailed code does not override the selected operation.
`stuck` means no listed element
advances the goal. Resume the same session with `answer` (a
readable action slug from the handoff options, `done`, or `stuck`) and/or
added `facts`. Use the single-step primitives only for a handoff you are
answering or a task that is not a goal.

Repeated handoff questions retain their options. OAuth resume choices include
providers without a live browser session; choosing one still follows the OAuth
executor's identity and pending-attempt rules. After two OAuth returns to the
login page, drive returns `no_progress` with the current options.

Post-submit page notices and invalid fields remain evidence for the next
decision rather than immediately ending the drive. A typed value that still
differs after one retype also leaves the drive running. If a call budget ends
with a remembered submit response, the handoff is `budget` and carries that
response as its reason.

Wallet sign-in dismissal applies only on checkout URLs, even when `card_ref`
is supplied. An email-code page elsewhere remains ordinary verification work.

When `operate_drive` opens a `url`, its first page read is the drive snapshot;
startup skips the general observation and automatic consent-banner dismissal
and settling retry. Consent overlays remain ordinary controls for the drive
loop to handle. The live Google-session admission gate still applies.
Standalone `operate_start` retains its general initial observation in the
requested format and best-effort consent-banner dismissal before that read.

Before each drive read, readiness uses the same bounded network-idle and
DOM-quiet settling as an observation. The wait caps are owned by
`PAGE_READY_CAPS` in `apps/mcp/src/bot/page-ready.ts`. If the page remains
unready, the loop tops up that wait to `DRIVE_WAIT_MS`, capped by the remaining
call time, before reading again. Each retry consumes a step without asking the
model to act on the unready page; persistent navigation ends on the step or
call budget.

After a guarded drive action, settling waits for two animation frames or
50 ms. If the document's time origin changed, the loop then polls for a
nonempty, changed fingerprint of body text and input/select/textarea types
and values before taking the next snapshot. URL or title changes alone do
not end that wait. This replaces the network-idle wait with a 300 ms timer
that also ends polling when animation frames are suspended. It detects
content movement, not complete page readiness; later asynchronous content
may still require another observation or WAIT. A guarded action whose target
sits outside the viewport scrolls it into view instantly before the occlusion
measurement, so an offscreen control does not burn the attempt.

A snapshot with no controls — a same-document checkout stage swap, or a page
still hydrating — is re-observed after up to three automatic waits per blank
window before any question is asked. For that case alone the progress
fingerprint and the planner's page text fold in the body text, because prose
is the only evidence such a page offers.

Drive offers `Open <label>` click choices for recognized picker fields alongside
typing where supported. Supply `origin`, `destination`, and `date` facts for
travel forms: Departure matches the date, not the origin. Picker typing preserves
the input focused by the opening click. Opening waits up to 400 ms for visible
options or calendar cells; typing waits up to 2 seconds for changed suggestion
labels. These bounded waits do not guarantee that an asynchronous picker is ready.

A custom combobox with a missing or different displayed value can be opened
automatically when a supplied fact matches its field, including `ticket_type`,
`cabin`, and `passengers`. Within a call, automatic opening is attempted once per
observation fingerprint. A stale, occluded, or offscreen click yields the next
decision to Jev even if the recovery observation changes. A matching page-wide
option also yields to Jev: the dispatcher cannot establish custom option
ownership and does not select it or mark the field filled. A native select whose
field matches a supplied fact is filled by the drive itself before Jev is asked,
once per target per observation fingerprint. Ordinary typeable fields go through
the step vote, which can choose TYPE_TEXT with a supplied fact. A
checkout page's offscreen fillables stay eligible, because the act path
scrolls a target into view before it measures; a control already displaying
that fact is not offered again. Recovery and
option-ownership regressions live in
[`operate-drive-fixture.test.ts`](../apps/mcp/src/bot/__tests__/operate-drive-fixture.test.ts).

Calls default to 60 steps and 45 seconds; `max_steps` and `max_seconds` set
the per-call allowances within the registered schema's limits. A drive-dispatched
OAuth step shares the call's remaining `max_seconds` across preflight checks,
the human-handoff window, fallback dispatch, and post-action reads. OAuth phase
changes do not extend that limit; call-budget exhaustion returns a `budget` handoff.
If an OAuth deadline expires before dispatch is attempted, the control remains
eligible for retry on the next call; after dispatch may have occurred, the drive
preserves that uncertainty rather than treating the control as unclicked.
If the OAuth executor reports a pending attempt, including an already-owned
attempt that prevents a second authorization click, drive returns
`status: "awaiting_human"` with `oauth.state: "awaiting_human"`, the observed
`reason`, any challenge and notification details, and
`oauth.next_action: "operate_observe"`. Observe the owned session before choosing
another action; do not resume drive merely to repeat the authorization click.
This handoff does not record a failure or dead action. An action deadline that
expires before authorization dispatch remains `budget`, as does call-budget
exhaustion even when dispatch may have occurred. These distinctions are covered by
[`drive-oauth-pending-human.test.ts`](../apps/mcp/src/bot/__tests__/drive-oauth-pending-human.test.ts).
If the OAuth executor throws an error other than recoverable budget exhaustion
or a pending-attempt handoff,
the error still propagates, but the drive first records the selected control as
failed and dead. Later calls on the same session withhold that control on that
page even if other page controls change. Recoverable OAuth budget exceptions
record neither failure nor a dead action. These cases are covered by
[`drive-oauth-trace.test.ts`](../apps/mcp/src/bot/__tests__/drive-oauth-trace.test.ts).
A `budget` handoff preserves partial progress for another call on the same
session. `jev_unavailable`, `no_progress`, and `evaluate_timeout` also return
handoffs; the last indicates that an in-page evaluation exceeded its deadline.
`pending_approval` supplies the card approval URL. `card_incomplete` means the
card was released but not every requested field was filled; resume the same
session to retry against the existing `approval_id`. The handoff's `payment`
contains the per-field results. Always call `operate_finish`
when the task is finished. Drive-initiated opens follow the
[broker refused-start receipt contract](browser-broker.md).
`low_confidence` hands the step back to the frontier operator agent, which can
inspect a screenshot and act deliberately.

browser-use/jev-ultrafast (MIT) adoptions live in `operate-drive.ts`. Mapping:

| # | Adoption | Where |
| --- | --- | --- |
| 1 | Two heads: `operation` plus `<operation>_target`; unused heads cannot act | `buildDriveQuestions`, `decideAfterJev` |
| 2 | Structured `state` `{page, elements, recent_actions}` and `instructions` `{goal, rules}` | `DriveJevState`, `buildJevState`, `pageTextFromObservation` |
| 3 | Per-element `operations` plus checked/disabled/required/acted/invalid, live `value`, and the control's own declared `maxlength`, placeholder, pattern, and inputmode from the drive snapshot | `elementState`, `operationsForRow`, `drive-snapshot.ts` |
| 4 | `validate_choice`: offered id, exact keys, finite [0,1], sum ±0.02, argmax. Malformed answers are `invalid_answer` (reason + confidence), not `low_confidence`; one same-observation retry | `validateChoiceReason`, `admitsChoice` |
| 5 | SELECT option is a target (`slug:option`) | `selectTargets`, `selectTargetKey`, `lastSelectOptions` |
| 6 | WAIT when the needed control is absent/disabled or results are loading | `DRIVE_RULES`, `{kind:"wait"}`, `DRIVE_WAIT_MS` |
| 7 | Rules prose adapted from their MIT `NEXT_ACTION` / `TARGET` | `DRIVE_RULES` |
| 8 | After answer-shape validation, concrete operation, target, and value choices below `DRIVE_CONFIDENCE_THRESHOLD` (0.6) normally require both confidence and selected probability of at least 0.30, and selected probability at least twice the runner-up; an option whose label is identical to the selected one is not a runner-up. CLICK targets with the same resolved HTTP(S) destination also do not compete; full URLs are compared, excluding fragment-only links and links to the current origin/path/query. Otherwise choices return `low_confidence`, except for the CLICK fallbacks described below. DONE, BLOCKED, NONE_OF_THESE, GO_BACK, WAIT, INBOX, and value `none` retain the 0.6 bar; the direct `email_code_field` shortcut also retains it. Purchase approval remains a separate check | `DRIVE_CONFIDENCE_THRESHOLD`, `admitsChoice`, `decideAfterJev` |
| 9 | Three consecutive non-wait actions with no fingerprint change | `DRIVE_STALE_LIMIT`, `staleNonWait` |
| 10 | Decision bound to the observation fingerprint, consumed once | `boundFingerprint`, `consumedActionKey` |
| 11 | Candidate and question budgets; only offered choices can be selected | `driveTargetSets`, `buildDriveQuestions` |
| 12 | Snapshot, decision, guarded act through the shared executor, then bounded settling; automatic combobox opening follows the policy above | `drive-snapshot.ts`, `act/act.ts`, `act/identity.ts`, `drive-act.ts`, `operate-drive.ts` |

If operation admission returns `low_confidence` with CLICK or SCROLL selected,
the drive can derive CLICK from a valid CLICK target with confidence at least
0.6 when the combined CLICK and SCROLL probability is at least 0.6. The click
executor scrolls an offscreen target into view. When the chosen CLICK target is
offscreen, the SCROLL share also counts for it: it is spread over the
offscreen targets in proportion to their own click votes, visible targets keep
only their CLICK share, and the merged target confidence must reach 0.6.
Fixed operation choices and invalid answers do not take this fallback.

Click controls that share a frame, role, and label (one "Edit" per key) carry
row context in the `ctx=` fact; their options and element descriptions name
that row. The snapshot reads up to 200 characters of visible row text from
the largest ancestor holding no twin. Context uses up to 60 characters of
words the other rows do not share; if those do not distinguish every twin,
it falls back to the ordered row text. Only nonempty, unique contexts are
included. Twins whose captured row text reads the same stay identical.
Checked/unchecked state (`s=c`/`s=u`) covers checkboxes, radios, switches
(`aria-checked`), and toggle buttons (`aria-pressed`); ARIA `mixed` is reported
as checked.

For an admitted CLICK operation, a valid target vote that would otherwise return
`low_confidence` is admitted when its chosen candidate is the only CLICK candidate
whose readable label contains the session's known account email (case-insensitive),
and a CLICK candidate has the exact readable label `Use another account`
(case-insensitive). This exception admits the voted tile without redirecting to
another candidate. Invalid answers retain their rejection and retry behavior;
ordinary admitted votes remain unchanged. Regression coverage lives in
[`drive-identity-account-choice.test.ts`](../apps/mcp/src/bot/__tests__/drive-identity-account-choice.test.ts).

The drive considers up to 250 candidates and caps each decision batch at 128
total choice criteria, including operation and goal-value choices. Truncation
is disclosed in the question instructions; retained dropdown choices with
omitted siblings carry `options_elided` in planner state. The allocator reserves
a usable goal-value choice alongside `none` when available. Omitted choices
cannot be selected in that batch.

Covered controls remain eligible for the drive's action menu alongside dialog
and overlay dismiss controls; the action-time occlusion guard still applies.
Repeated occlusion refusals replan within the call budgets instead of ending
after a fixed refusal count. Checked checkboxes remain click candidates so the
drive can untick them.
The drive snapshot retains offscreen form controls and controls in header,
navigation, and footer regions. It retains offscreen buttons only on a checkout
URL, where they become click candidates too — no label test, so a localized
submit such as "Payer maintenant" is kept. Elsewhere ordinary offscreen buttons
are excluded, which limits calendar-button floods and keeps an offscreen "Buy
now" on a product page unclickable. Jev's visible element state includes each
ref once even when it supports both typing and clicking; the operation-specific
choices remain separate.

On a checkout URL after a card release, with every requested fill done and no
pay click dispatched since that release, a snapshot carrying no button at all
is re-observed for up to three automatic waits. If no button has mounted by
then and the page still offers some other visible clickable control, the drive
returns `stuck` with `the control for this operation is not present (CLICK
pay/place-order)` and names the controls it did see, rather than clicking a
substitute such as a back link. A retry of an incomplete card release, and a
page already past the payment form — a processing path or a completed checkout
— do not stop this way. Reachability and refusal regressions live in
[`checkout-pay-submit-fixture.test.ts`](../apps/mcp/src/bot/__tests__/checkout-pay-submit-fixture.test.ts).

`operate_read_inbox` lists up to ten recent messages from the session's
signed-in Gmail in a utility tab, leaving the page waiting for a code open.
Each entry includes sender, subject, received time, bounded body text, codes,
and full links. The agent chooses the relevant message; the reader does not
match senders or service hosts. An optional `query` is passed to Gmail search
unchanged, with All Mail included because search indexing can lag. To put a
code in a protected session slot, pass `into_slot` and the selected message's
`pick` index. The inbox consent and live Google session gates still apply.

Use an action `ref` from the current observation. `operate_start` and
`operate_observe` default to `format: "compact"`, a paged control map;
`format: "full"` is the explicit DOM view. After `inject_card` releases a card,
both modes replace that card's complete PAN and security code while leaving all
other content verbatim — including a CVV the agent typed itself via the masked
per-digit tokens (`{{pan}}`, `{{cvv}}`, `{{pan:N}}`, `{{cvv:N}}`) into any
textbox ref. `operate_screenshot` composites covers over only the
injected controls and identified ordinary displayed copies that contain those
two values. Payment approval and vault write-only boundaries remain separate.

## Pickers and popup return

For a readonly field backed by a picker, click its Select button, then click
the choice in the resulting observation or a fresh screenshot. Do not type
into the readonly field. An inline dialog stays on the current page; an owned
popup opened by an ordinary action becomes the active page. Unrelated pages
and pages without a proven opener are not adopted.

When the active picker closes after a selection, post-click observations and
subsequent screenshots return to its nearest still-live, session-owned opener
in the creation-time ancestry. This return does not choose a sibling or foreign
page. Re-observe before using refs from the restored form and check the selected
value. The dispatched click and field verification remain bound to the original
picker document; returning does not dispatch another action on the form.

This ordinary-popup return excludes tracked OAuth provider/product pages. Card
release and later checkout actions use the same generic page lifecycle.
The local regression fixture is
[`picker-window.test.ts`](../apps/mcp/src/bot/__tests__/picker-window.test.ts).

## Clicking a screenshot-visible control

Prefer an observed `ref` or unique `@label`. A closed-shadow control may be
visible in a screenshot without a usable DOM ref. In that case,
`operate_screenshot` can return an additive `click_binding`:

```json
{
  "click_binding": {
    "screenshot_id": "12345678-1234-4234-8234-123456789abc",
    "width": 1600,
    "height": 1200,
    "coordinate_space": "image_pixels"
  }
}
```

Pass coordinates in that original image's pixels, measured from its top-left:

```json
{
  "session_id": "session-id",
  "screenshot": {
    "screenshot_id": "12345678-1234-4234-8234-123456789abc",
    "x": 348,
    "y": 488
  }
}
```

This is an `operate_click` input. Supply exactly one of `ref` or `screenshot`.
If your image viewer resizes the image, scale the displayed coordinates back to
`click_binding.width` and `height`. The server handles device scale, frame crops,
full-page origins, and current scroll, rounding to the nearest CSS pixel for
both hit testing and dispatch. Points outside the current viewport cannot
be clicked from a full-page or frame image; scroll and take a new screenshot.

The binding belongs to the captured page, expires after 60 seconds, is replaced
by the next screenshot, and permits one attempt. Navigation, viewport/scroll or
frame-geometry changes invalidate it. The hit node must retain its physical
identity, attributes and bounds, including its control's text and associated
label text, across capture and dispatch preparation. Overlapping surfaces must
retain their geometry, relative paint order and hit-affecting styles: removing, hiding or
moving an overlay cannot authorize a newly exposed control from the old image.
Unrelated text changes do not invalidate an otherwise unchanged target. This is
a geometry/identity binding, not proof that every pixel or page animation stayed
unchanged. If capture cannot establish a binding, the image is still returned
without `click_binding`; observations and other actions remain usable.

Results include `screenshot_click.dispatch` (`dispatched`, `not_dispatched`, or
`unknown`), `outcome: "unknown"`, and a retry policy. `dispatched` means the
native pointer call completed, not that the provider accepted the action or
cleared a challenge. A lost pointer acknowledgement reports unknown dispatch; a
failed observation after an acknowledged click retains `dispatch: "dispatched"`.
Both leave the outcome unknown; observe before deciding a new action. The same image token
cannot replay an uncertain click. `stale_screenshot` requires a new screenshot;
`invalid_screenshot_point` means the point was outside the image/current viewport.
For ordinary clicks, `target_unresolved` means the label was never issued in this document;
`stale_ref` remains the response for an expired physical ref or retired alias.

When combined with `capture`, the vault capture result retains the click receipt;
storage success does not establish the provider outcome. Screenshot clicks use
the same [picker and popup return rules](#pickers-and-popup-return).

Coordinate clicks use the session's existing control-plane and payment predicates and
are not promoted into replay recipes. They do not change vault storage,
credential capture, payment approval, or 3-D Secure behavior. Local regression
fixtures prove pointer mechanics; they do not guarantee Cloudflare clearance.

## Explicit action inputs

Login and approval tools expose a single object at the schema root, with visible
fields and a required `action` enum, so clients do not need to discover inputs
through a root union. `operate_login` requires `action`: `oauth`, `prepare_signup`,
`store_signup`, or `load_saved`. For OAuth, use
`{session_id, action:"oauth", provider, ref}`; omitting `action` is rejected.
Approval-based `fetch_credential`,
`edit_credential`, `delete_credential`, and `edit_payment_card` calls start with
`action:"start"` and their existing target fields. Resume with `action:"resume"`
and the returned `approval_id`; do not repeat the target or mutation fields.

## Browser egress is unrestricted

The operator does not filter browser requests by host. Payment SDKs, issuer/ACS
frames, fingerprinting, authentication providers, analytics, and arbitrary
third-party resources need no host declaration. This holds before, during, and
after payment; there is no payment-network window or scope-denial reporting.

`operate_start` rejects the removed `allowed_hosts` and `extra_allowed_hosts`
arguments. There is no host-widening tool.
Existing control-plane action restrictions, credential vault egress, card-fill
recognition and sealing, and the purchase's single human approval are unchanged.

## Finish with the flat schema

`operate_finish` uses the flat enum shape, not a nested union:

```json
{ "session_id": "session-id", "outcome": "none" }
```

```json
{
  "session_id": "session-id",
  "outcome": "result",
  "summary": "Provider setup reached its reported completion page.",
  "data": { "provider_reported": true }
}
```

`result` requires `summary` or `data`. Complete
[credential capture and storage](#credential-capture-and-retrieval) before
calling `operate_finish`. The accepted outcomes are `none` and `result`;
the removed `credentials` outcome and `store` argument are rejected.
Agent-supplied data is reported data, not proof that login, provisioning, or a
mutation completed. Preserve booleans as booleans in result data.

`operate_finish` returns a common, additive finish receipt:

```json
{
  "session_id": "session-id",
  "operation_id": "operation-id",
  "execution": "completed",
  "mutation": "not_dispatched",
  "cleanup": "closed",
  "closed": true
}
```

Its allowed values are `execution: completed | cancelled | pending | unknown`,
`mutation: not_dispatched | dispatched | unknown`, and
`cleanup: open | closing | closed | already_closed | unknown`. `closed` is true
only when closure is positively established. A bounded finish can return
`execution: "pending"`, `cleanup: "closing"`, and `closed: false` while the
lifecycle retains ownership and drains work. Repeat finish to obtain closure
proof; do not replay a mutation. That closure proof lives with the live session:
ending the broker connection ends it. Missing proof is unknown, never an
inferred `already_closed`. Clients should feature-detect the output schema in
`tools/list` when talking to older installed servers.

## Credential capture and retrieval

Before dispatching a drive click or select, the drive hands back `stuck` for
controls marked `credential=1`, except Copy/reveal buttons, links, and menu
items. The marker comes from the nearest table row or list item (including
ARIA equivalents) containing a credential-shaped token, a visible masked
display, or a visible readonly input. This structural check does not depend
on mutation verbs or their language. A DOM dialog control following a recorded
credential-row mutation click on the same page path is also refused, with the
same Copy/reveal exception. Native confirmations use that same recorded-click
provenance to offer a human handoff and require confidence of at least 0.6
for an automatic accept or dismiss; dialog wording alone does not classify
them as credential mutations. Other rows, including new-key creation controls
without that evidence, remain eligible. Regression coverage lives in
[`drive-key-complete-refusal.test.ts`](../apps/mcp/src/bot/__tests__/drive-key-complete-refusal.test.ts).

Credential capture uses the selected source rather than scanning for key-shaped
tokens. `operate_extract` without
`capture` clicks the Copy button in an open key dialog and keeps only the value
that click writes to the clipboard, as `api_key`; it never scans page text,
labels or inputs. When no Copy click yields a value it stores nothing and returns
an `error` telling the agent to read the page with `operate_observe` and point
`capture` at the key. A targeted `capture` (selector, role, or the clipboard
after an `operate_click`) stores the pointed value as is. The one exception on
every store path, the drive's included, is a value that is an http(s) URL: a Copy
beside an invite or docs link writes the link, so it is not stored.

`operate_extract(store=...)` sends the value directly to the write-only vault
and returns storage metadata, not the secret. Without `store`, it returns the
value. If extraction fails, the session stays open for another observation or
capture. Observation and screenshot reads remain verbatim; extraction does not
redact those surfaces.

`operate_drive` accepts the same `store` destination as `operate_extract`.
Supply it on each drive call that should vault a key, including resumed calls.
With a destination and an authenticated vault client, a revealed-secret row
(`@key-value` or `secret=1`) or a successfully dispatched Copy click triggers
extraction and storage before the next model decision. The Copy evidence
survives a button changing its label to “Copied!” on the same document and URL.
Extraction still uses the Copy source described above; a revealed-secret row
does not itself supply the credential value. Successful storage returns
`complete` without waiting for the model to choose DONE. Each page state gets
one automatic capture attempt per call; a failed extraction or storage attempt
returns to ordinary decision-making after a fresh snapshot.

DONE also attempts extraction and requires successful storage if a credential
is extracted. It refuses completion when a visible credential cannot be
captured or an extracted credential cannot be stored. Supply `store`, or use
`operate_extract` with an explicit capture source to resolve the handoff.

`operate_click` and `operate_extract` accept an optional `capture` field:

```json
{
  "store": { "service": "Example Service", "label": "fresh-key", "api_hosts": ["api.example.com"] },
  "source": {
    "role": "textbox",
    "name": "API key",
    "container": { "role": "dialog", "name": "New API key" }
  }
}
```

`api_hosts` names API hosts this credential may be sent to. It is unioned with
the same session-observed hosts and service defaults as before. `store_credential`
also accepts `api_hosts`; `login_hosts` remains the separate browser sign-in
allowlist. The removed aliases `observed_hosts` on `store_credential` and
`egress_hosts` in extraction and capture stores are rejected; use `api_hosts`.

Perform typing, selection, or keyboard actions first, then use
`operate_extract({capture})` for a DOM credential capture. `operate_type`,
`operate_select`, and `operate_press` reject the removed `capture` argument.

The source role is `textbox` or `code`. For a plain-text copy field without
those roles, use `source: {"selector": "<observed CSS selector>"}` instead of
`role`/`name`. Choose the selector from the actual element structure, never from
the secret value; CSS sources select visible elements only. Either source can
include an optional named `dialog` or `region` container to limit the selection.
Capture pins exactly one element and returns vault metadata, an unresolved
result, or explicit ambiguity, never the captured value or a screenshot. A `stored: true`
result includes `resolved_source`, describing the pinned element used to read the
value by tag and role/name or selector. If that descriptor is unavailable, the
receipt falls back to the requested source. Default actions and reads remain
unredacted.

Resolution includes open shadow roots and unions matching sources before
requiring exactly one. An id-less `<input>` with no type or `type="text"`
has the `textbox` role; its value does not override a requested name or role.
Password, search, and datalist-backed inputs do not substitute for textboxes.
The CSS fallback supports bare simple selectors in shadow roots and simple
descendant chains that cross a shadow boundary. With a requested container,
the chain must start at that container (for example, `[role=dialog] input`);
it cannot use an ancestor outside the container. Other selector forms retain
Playwright's matching behavior.

Zero source matches return `capture_unresolved` with `candidate_count: 0`
and `found`: up to 12 visible roles/names from the document and its open
shadow roots, never field values. This diagnostic list can include elements
outside the requested container; it is not a list of matching sources.
It is empty when no reportable elements exist or diagnostics are unavailable.
More than one source match returns `capture_ambiguous`. A single source with
no usable value, or an extraction/storage exception, also returns
`capture_unresolved`; inspect `candidate_count` and storage metadata before
choosing recovery.

For `operate_click` with capture, the source is probed before the click and
resolved again after the click settles. Capture waits a bounded render window
for a changed resolution. A new element or a changed value in the same element
can be captured; an unchanged element and value cannot. If the resolution stays
unchanged, or the pre-click probe failed, capture returns
`error: "capture_pre_action_only"`, `stored: false`, `storage: "unknown"`, and
`retry: "extract_only"`, without a value or vault write. Zero or multiple
candidates never authorize storage. See the post-action and same-element reveal
fixtures in `apps/mcp/src/bot/__tests__/credential-capture-browser.test.ts`.

On an uncertain storage result, pass the returned
`write_id` in the same `capture` object to `operate_extract` for extraction-only
recovery. Never resend the create action. Mutation verbs refuse a supplied
`capture.write_id`; the vault binds retries to the account, service, label, and
original value and refuses rotation of an existing credential slot.

Pending capture storage permits unrelated plain actions and reads, including
`operate_click`, `operate_type`, `operate_observe`, and `operate_extract` without
`capture` or `store`. A new vaulting attempt (including top-level
`operate_extract.store`) remains fenced; extraction with the original
`capture.write_id` remains available.
This exception does not relax other unresolved-mutation guards. Broker recovery
records are audit-only and preserve the capture's prior admission state, including
across delivery acknowledgement. See the recovery-transition coverage in
`apps/mcp/src/bot/__tests__/broker-operator.test.ts`.

For the Neon success dialog structure observed on 2026-09-10 (a LABEL named
`API token`, followed by a nested plain-DIV value and a Copy button), the
value-free source is:

```json
{
  "selector": "label:text-is(\"API token\") + div div:not(:has(*))",
  "container": { "role": "dialog" }
}
```

This uses Playwright's CSS text-label matcher and selects leaf DIVs in the
label's following value group. It does not match on token content or click Copy.
The native operator can use this documented source directly in atomic capture,
or in `operate_extract` with the original `capture.write_id`, unchanged store
service/label, and the same still-open session. The capture result and recovery
contract above applies. The selector is grounded in the
reported structure and synthetic regression, not a live validation of this fix.

For Firstmate's live retest: create one uniquely labelled Neon key with this
capture source; if needed retry extraction only with that write ID. Require
`stored: true` and vault metadata without plaintext, then use that returned
reference with server-side credential injection for the read-only
`GET https://console.neon.tech/api/v2/projects` and require HTTP 200. Finish the
session and require `cleanup: "closed"` and `closed: true`. Preserve existing
keys. Closed sessions from earlier diagnostics cannot be recovered by replaying
their write IDs in a new session.

The resolved-source receipt identifies a captured element; it does not discover
a selector for an uncaptured field. The Neon selector above came from bounded
inspection. For another page, inspect its rendered structure and choose a
selector that does not depend on the secret value. The read policy is owned by
[the observation model](observation-model.md), §4.5.

`fetch_credential` is the only raw-value path. Its first call returns an
approval link and no value; only a user’s passkey signature for that exact fetch
permits one resumed call to receive the value. Use the
[explicit action inputs](#explicit-action-inputs) for start and resume calls.
Omitting `field` requests every field on that credential in the same approval;
passing `field` requests only the named field. The approval page names every
field that will be released.
Do not use a payment or mutation approval as a substitute. Prefer
`use_credential` or a scoped app grant whenever server-side injection can do the
job without exposing plaintext to the agent.

## Using the rest of the surface

- `operate_login` keeps OAuth and password lifecycle actions on the real
  profile using the [explicit action inputs](#explicit-action-inputs).
  A chooser, challenge, return with uncertain authentication,
  or other human step is an honest pending result; stop automation and observe
  the owned session rather than treating a page title or same-origin URL as
  success. A browser error after dispatch follows the same contract as request
  cancellation: return attempt-owned completion evidence when available, otherwise
  `oauth: {state: "in_progress", completion: "unknown", next_action: "operate_observe"}`
  with the retained `session_id` and observe-before-action guidance. A timeout
  alone proves neither failure nor a human challenge. An attempt-owned popup
  opened before the initiating click rejects stays the observation target and
  retains OAuth ownership; closing it restores the viable product page. Concrete
  attempt-owned callback denials take precedence over interrupted-click uncertainty;
  they and proven pre-dispatch failures retain their failure semantics. See the
  routed click-then-error regression in
  `apps/mcp/src/bot/__tests__/oauth-login.test.ts`. Native OAuth
  errors retain `error.session_id`; ordinary errors direct observation, while
  unsettled cancellation keeps its existing wait/finish guidance. Never replay
  OAuth automatically after an uncertain result.
- `operate_type` accepts exactly one of literal `text` or a protected `slot`.
  For a saved login, read the selected credential's `field_names` with
  `list_credentials`, then call `operate_login` with `action:"load_saved"`, `session_id`,
  `reference` (or `service`), and those exact names as `fields`. Use each returned
  slot with `operate_type(ref, slot)` on its matching form control; vault values
  are not returned. The installed schema documents the field defaults and naming
  conventions. A missing-slot error points to this vault flow; `operate_extract`
  with `into_slot` is for capturing a page value instead.
- `operate_extract`, `use_credential`, and `grant_app_access` preserve the
  write-only vault boundary. `fetch_credential` has the separate passkey gate
  above.
- `inject_card` retains the existing single purchase approval and fills only
  caller-named `pan`/`cvv` refs. Its `amount_cents` uses the currency's smallest
  unit: USD $12.34 → 1234; JPY ¥65,800 → 65800 (do not multiply by 100);
  KRW works like JPY. Expiry, cardholder name, and billing are NOT
  inject targets and are not secret: after approval the result carries
  `exp_month`, `exp_year`, `name`, and any stored `billing` alongside `last4`;
  type those with ordinary `operate_type`/`operate_select`, or place the masked
  per-digit tokens returned in the inject_card result (`card_tokens`) into any
  ref yourself. It does not submit
  or interpret the checkout. Use
  `operate_observe`, `operate_network`, and masked screenshots as evidence, then
  drive the page with ordinary actions. A rendered 3-D Secure challenge is
  detected on observation/action results; the operator notifies the cardholder
  once and reports `three_ds` state `challenge_detected` without waiting on or
  gating the challenge. `challenge_loading` means an ACS URL appeared but no
  rendered challenge control or prompt was found, so no nudge is sent yet.
  `sdk_error_retryable` carries the exact emitted error `code`, its
  console/exception/request-body `source`, and `observed_at` timestamp. It
  describes SDK initialization before a challenge was observed, not an
  authentication verdict. The retry guidance reports whether the observed
  submit control is enabled. If it is disabled, re-arm the payment form and
  refill the card fields with the existing approval's masked tokens before
  retrying; a detected challenge always takes precedence. Explicit page text
  can yield `authentication_failed`,
  `authentication_succeeded`, or `merchant_order_confirmed`, each marked as
  page-text evidence. Generic checkout error copy alone does not prove a 3-D
  Secure outcome; keep observing the checkout before another submission.

  Card controls expose `card-empty`, `card-complete`, `card-valid`, and
  `card-validity-source` in full DOM, and the same value-free status in compact
  `card=` facts. Braintree hosted-field container classes take precedence when
  readable. `unknown` means the source cannot determine that bit. A separate
  `invalid-source` identifies authored `aria-invalid`, native input validity,
  or an AX invalid signal whose native origin is unknown; none is silently
  promoted to a provider verdict.

Legacy union verbs and aliases are not part of this contract. Use the flat names
shown above, and use the installed server’s `tools/list` schema for optional
arguments and output details.

To repeat the built-service dialog demonstration against the local GitHub-style
fixture (agent answer and actual live-view OK button):

```sh
pnpm --filter '@trusty-squire/mcp...' build
NATIVE_DIALOG_BUILT_DEMO=1 pnpm --filter @trusty-squire/mcp exec vitest run scripts/native-dialog-built-demo.test.mjs
```

The demonstration uses Vitest's isolated home and a local viewer endpoint; it
prints the question and the resulting `/submitted?` navigation for both paths.
