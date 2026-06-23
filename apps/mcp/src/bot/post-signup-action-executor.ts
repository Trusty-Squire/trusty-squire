import type { PostVerifyStep } from "./agent.js";
import { CredentialExtractionFlow } from "./credential-extraction-flow.js";

export type PostSignupExecutableAction = Exclude<
  PostVerifyStep,
  { kind: "done" } | { kind: "extract" } | { kind: "login" }
>;

export interface TosScrollResult {
  reason: "ok" | "no_container" | "already_at_bottom";
  container: string | null;
}

export interface PostSignupActionBrowserPort {
  click(selector: string): Promise<void>;
  clickSubmit?(selector: string): Promise<void>;
  type(selector: string, value: string): Promise<void>;
  selectOption(selector: string, optionText?: string): Promise<void>;
  check(selector: string): Promise<void>;
  scrollToEndOfTOS(selector?: string): Promise<TosScrollResult>;
  wait(seconds: number): Promise<void>;
  goto(url: string): Promise<void>;
  waitForInteractiveDom(minElements: number, timeoutMs: number): Promise<void>;
  captureTransientAlert(timeoutSeconds: number): Promise<string>;
}

export interface PostSignupActionExtractionPort {
  extractCredentials(): Promise<Record<string, string>>;
  extractFromDomProximity(): Promise<Record<string, string>>;
}

export interface PostSignupActionExecutorInput {
  step: PostSignupExecutableAction;
  credentials: Record<string, string>;
  snapshotPostClickAlert(): Promise<void>;
  submitClick?: boolean;
}

export interface PostSignupActionExecutorResult {
  steps: string[];
  hint: string | undefined;
}

export interface PostSignupActionExecutorOptions {
  clickPollMaxWaitMs?: number;
  clickPollIntervalSeconds?: number;
  clickPollMaxPolls?: number;
}

export class PostSignupActionExecutor {
  constructor(
    private readonly browser: PostSignupActionBrowserPort,
    private readonly extractionPort: PostSignupActionExtractionPort,
    private readonly credentialExtractionFlow = new CredentialExtractionFlow(),
    private readonly opts: PostSignupActionExecutorOptions = {},
  ) {}

  async execute(
    input: PostSignupActionExecutorInput,
  ): Promise<PostSignupActionExecutorResult> {
    const steps: string[] = [];
    let hint: string | undefined;
    const { step, credentials } = input;

    switch (step.kind) {
      case "click": {
        if (input.submitClick === true && this.browser.clickSubmit !== undefined) {
          await this.browser.clickSubmit(step.selector);
        } else {
          await this.browser.click(step.selector);
        }
        const clickPoll =
          await this.credentialExtractionFlow.pollAfterCredentialProducingClick({
            credentials,
            ...(this.opts.clickPollMaxWaitMs !== undefined
              ? { maxWaitMs: this.opts.clickPollMaxWaitMs }
              : {}),
            ...(this.opts.clickPollIntervalSeconds !== undefined
              ? { pollIntervalSeconds: this.opts.clickPollIntervalSeconds }
              : {}),
            ...(this.opts.clickPollMaxPolls !== undefined
              ? { maxPolls: this.opts.clickPollMaxPolls }
              : {}),
            port: {
              wait: (seconds) => this.browser.wait(seconds),
              captureTransientAlert: (timeoutSeconds) =>
                this.browser.captureTransientAlert(timeoutSeconds),
              extractCredentials: () => this.extractionPort.extractCredentials(),
              extractFromDomProximity: () =>
                this.extractionPort.extractFromDomProximity(),
            },
          });
        if (!clickPoll.foundApiKey && clickPoll.alertSeen.length > 0) {
          steps.push(
            `Post-verify: the page showed a notification after the click: "${clickPoll.alertSeen}"`,
          );
          await input.snapshotPostClickAlert();
          hint =
            `After your last click the page showed this notification: "${clickPoll.alertSeen}". ` +
            `It likely explains why the page did not advance — address it (fix the named ` +
            `field, wait, or choose a different action) rather than repeating the same click.`;
        }
        return { steps, hint };
      }
      case "fill":
        if (/#react-select-\d+-input\b/.test(step.selector)) {
          await this.browser.selectOption(step.selector, step.value);
          await this.browser.wait(1);
        } else {
          await this.browser.type(step.selector, step.value);
        }
        return { steps, hint };
      case "select":
        await this.browser.selectOption(step.selector, step.option_text);
        await this.browser.wait(1);
        return { steps, hint };
      case "check":
        await this.browser.check(step.selector);
        await this.browser.wait(1);
        return { steps, hint };
      case "scroll": {
        const result = await this.browser.scrollToEndOfTOS(step.selector);
        if (result.reason === "no_container") {
          steps.push(
            "Post-verify: scroll requested but no scrollable container found — re-planning.",
          );
          hint =
            "Your last 'scroll' found NO scrollable container on the page. " +
            "Do NOT return scroll again — try clicking a different element, " +
            "or return done if the gated button still won't enable.";
        } else if (result.reason === "already_at_bottom") {
          steps.push(
            `Post-verify: scroll requested but ${result.container} is already at the bottom — re-planning.`,
          );
          hint =
            "Your last 'scroll' was a no-op — the scrollable container is ALREADY at the " +
            "bottom. Whatever is keeping the Accept button disabled is NOT scroll position. " +
            "Re-read the page: look for an unticked agreement checkbox, an unfilled required " +
            "input (name/email), a sub-tab on the modal that hasn't been visited, or a 'I agree' " +
            "radio button. Do NOT return scroll again.";
        } else {
          steps.push(
            `Post-verify: scrolled ToS container (${result.container}) to bottom.`,
          );
        }
        await this.browser.wait(1);
        return { steps, hint };
      }
      case "navigate":
        await this.browser.goto(step.url);
        await this.browser.waitForInteractiveDom(5, 20_000);
        return { steps, hint };
      case "wait":
        await this.browser.wait(Math.min(step.seconds, 15));
        return { steps, hint };
    }
  }
}
