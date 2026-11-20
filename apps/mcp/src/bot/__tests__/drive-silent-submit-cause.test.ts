import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { submitFormInvalidFields } from "../drive-act.js";

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
});

// The shape of Zro's create-key dialog (1.1.47-rc.1 drive-trace L7): Alias
// filled, Spend limit optional, an Expiration date select. When the browser
// blocks the submit on a required field, only a transient bubble says so.
const form = (expirationRequired: boolean): string => `
  <!doctype html><html><body>
    <form onsubmit="event.preventDefault()">
      <label for="alias">Alias</label><input id="alias" value="grunt">
      <label for="limit">Spend limit</label><input id="limit" type="number" min="0.01">
      <label for="exp">Expiration date</label>
      <select id="exp" ${expirationRequired ? "required" : ""}>
        <option value="">Choose</option><option value="30">30 days</option>
      </select>
      <button id="create" type="submit">Create</button>
    </form>
  </body></html>`;

async function open(html: string): Promise<Page> {
  const page = await browser!.newPage();
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
  return page;
}

it("names a required field that blocked the submit", async () => {
  const page = await open(form(true));
  try {
    const invalid = await submitFormInvalidFields(page, "#create");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatch(/^Expiration date: \S/);
  } finally {
    await page.close();
  }
});

it("names nothing when the form is valid", async () => {
  const page = await open(form(false));
  try {
    expect(await submitFormInvalidFields(page, "#create")).toEqual([]);
  } finally {
    await page.close();
  }
});
