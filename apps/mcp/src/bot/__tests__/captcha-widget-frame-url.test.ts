// The frame-URL classifier that lets the drive find a checkbox challenge the
// row map deliberately omits — including one mounted in a CLOSED shadow root,
// where no selector can reach the frame. The rule is about the widget family a
// frame hosts, never about a site: a checkbox frame is pressable, a challenge
// frame (the image grid) is not.

import { describe, expect, it } from "vitest";
import { captchaWidgetKindForFrameUrl } from "../captcha.js";

describe("captchaWidgetKindForFrameUrl", () => {
  it("classifies a normal-size anchor frame as the reCAPTCHA checkbox", () => {
    expect(
      captchaWidgetKindForFrameUrl(
        "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Ltestsitekey0000000000000000&hl=en&size=normal",
      ),
    ).toBe("recaptcha");
  });

  it("refuses a score-mode anchor and the image-grid challenge frame", () => {
    expect(
      captchaWidgetKindForFrameUrl(
        "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Ltestsitekey0000000000000000&size=invisible",
      ),
    ).toBeNull();
    expect(
      captchaWidgetKindForFrameUrl(
        "https://www.google.com/recaptcha/api2/bframe?ar=1&k=6Ltestsitekey0000000000000000&hl=en",
      ),
    ).toBeNull();
  });

  it("classifies a checkbox frame and refuses a challenge frame for the other widget families", () => {
    expect(
      captchaWidgetKindForFrameUrl(
        "https://newassets.hcaptcha.com/captcha/v1/abc/frame?frame=checkbox",
      ),
    ).toBe("hcaptcha");
    expect(
      captchaWidgetKindForFrameUrl(
        "https://newassets.hcaptcha.com/captcha/v1/abc/frame?frame=challenge",
      ),
    ).toBeNull();
    expect(
      captchaWidgetKindForFrameUrl(
        "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/xyz/light/normal?lang=en",
      ),
    ).toBe("turnstile");
    expect(
      captchaWidgetKindForFrameUrl(
        "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/other/frame",
      ),
    ).toBeNull();
  });

  it("returns null for anything that is not a captcha widget frame", () => {
    expect(captchaWidgetKindForFrameUrl("https://example.test/embed")).toBeNull();
    expect(captchaWidgetKindForFrameUrl("about:blank")).toBeNull();
    expect(captchaWidgetKindForFrameUrl("not a url")).toBeNull();
  });
});
