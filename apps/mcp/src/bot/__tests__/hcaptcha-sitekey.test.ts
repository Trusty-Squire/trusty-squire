import { describe, expect, it } from "vitest";
import {
  extractHcaptchaResponseKeyFromToken,
  extractHcaptchaSitekeyFromHtml,
} from "../browser.js";

describe("extractHcaptchaSitekeyFromHtml", () => {
  it("extracts standard sitekey config", () => {
    const html = `
      <script src="https://js.hcaptcha.com/1/api.js"></script>
      <script>window.captcha = { sitekey: "bc609205-5555-4444-9999-123456789abc" }</script>
    `;
    expect(extractHcaptchaSitekeyFromHtml(html)).toBe(
      "bc609205-5555-4444-9999-123456789abc",
    );
  });

  it("extracts Stripe-style underscore hCaptcha config keys", () => {
    const html = `
      <script id="hcaptcha-api-script-id" src="https://js.hcaptcha.com/1/api.js?render=explicit"></script>
      <script type="application/json" id="preloaded_json">
        {"express_hcaptcha_site_key":"cae1577d-ed44-49fd-a58a-d58fb709c8e2"}
      </script>
    `;
    expect(extractHcaptchaSitekeyFromHtml(html)).toBe(
      "cae1577d-ed44-49fd-a58a-d58fb709c8e2",
    );
  });

  it("extracts HTML-escaped Stripe register hcaptcha_key", () => {
    const html = `
      <script id="hcaptcha-api-script-id" src="https://js.hcaptcha.com/1/api.js?render=explicit&amp;onload=hcaptchaOnLoad"></script>
      <script type="application/json" id="register_app">
        {&quot;hcaptcha_key&quot;:&quot;89378a0b-0942-4717-89fc-52e01acddedd&quot;,&quot;show_hcaptcha&quot;:true}
      </script>
    `;
    expect(extractHcaptchaSitekeyFromHtml(html)).toBe(
      "89378a0b-0942-4717-89fc-52e01acddedd",
    );
  });

  it("extracts sitekey from hCaptcha iframe hash params", () => {
    const html = `
      <iframe src="https://newassets.hcaptcha.com/captcha/v1/hash/static/hcaptcha.html#frame=challenge&amp;host=dashboard.stripe.com&amp;sitekey=89378a0b-0942-4717-89fc-52e01acddedd&amp;size=invisible"></iframe>
    `;
    expect(extractHcaptchaSitekeyFromHtml(html)).toBe(
      "89378a0b-0942-4717-89fc-52e01acddedd",
    );
  });

  it("extracts named hcaptcha login site keys", () => {
    const html = `
      <script src="https://js.hcaptcha.com/1/api.js"></script>
      <script type="application/json" id="login_preloaded_json">
        {"hcaptcha_login_main_site_key":"ba52081d-da1f-466c-afa2-75aabdc729a7"}
      </script>
    `;
    expect(extractHcaptchaSitekeyFromHtml(html)).toBe(
      "ba52081d-da1f-466c-afa2-75aabdc729a7",
    );
  });

  it("does not return unrelated UUIDs without an hCaptcha marker", () => {
    const html = `
      <script>window.config = { site_key: "cae1577d-ed44-49fd-a58a-d58fb709c8e2" }</script>
    `;
    expect(extractHcaptchaSitekeyFromHtml(html)).toBeNull();
  });
});

describe("extractHcaptchaResponseKeyFromToken", () => {
  it("extracts the response key from hCaptcha token payloads", () => {
    const payload = Buffer.from(
      JSON.stringify({ pd: 0, exp: 1782226729, kr: "4744c370", shard_id: 833440897 }),
    ).toString("base64url");
    expect(extractHcaptchaResponseKeyFromToken(`P1_header.${payload}.signature`)).toBe(
      "4744c370",
    );
  });

  it("returns null when the token is not a decodable hCaptcha token", () => {
    expect(extractHcaptchaResponseKeyFromToken("not-a-token")).toBeNull();
  });
});
