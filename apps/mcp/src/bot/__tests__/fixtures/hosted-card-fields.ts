import type { Page } from "playwright";
import type { CheckoutCard } from "../../browser.js";

// Synthetic provider pages at genuinely different origins; no provider network calls.
export async function serveHostedCardFields(
  page: Page,
  provider: "braintree" | "stripe",
  card: CheckoutCard,
  mountDelayMs = 0,
): Promise<void> {
  const origin =
    provider === "braintree" ? "https://assets.braintreegateway.com" : "https://js.stripe.com";
  const fields =
    provider === "braintree"
      ? {
          number: card.pan,
          cvv: card.cvv,
          expirationMonth: card.exp_month,
          expirationYear: card.exp_year,
          cardholderName: card.name,
        }
      : {
          cardnumber: card.pan,
          "exp-date": `${card.exp_month}/${card.exp_year.slice(-2)}`,
          cvc: card.cvv,
        };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      const field = url.pathname.slice(1);
      const expected = fields[field as keyof typeof fields];
      const helpers =
        provider === "braintree"
          ? [
              ["cardholderName", "cardholder-name", "cc-name"],
              ["number", "credit-card-number", "cc-number"],
              ["expirationMonth", "expiration-month", "cc-exp-month"],
              ["expirationYear", "expiration-year", "cc-exp-year"],
              ["cvv", "cvv", "cc-csc"],
            ]
              .filter(([role]) => role !== field)
              .map(
                ([, name, autocomplete]) => `
            <label aria-hidden="true" for="${name}-autofill-field">${name}</label>
            <input aria-hidden="true" id="${name}-autofill-field" class="autofill-field"
              type="text" name="${name}" autocomplete="${autocomplete}" tabindex="-1">`,
              )
              .join("") + '<input class="focus-intercept" type="text" tabindex="0">'
          : "";
      return route.fulfill({
        contentType: "text/html",
        body: `
        <input ${provider === "stripe" ? `name="${field}"` : 'id="opaque-input"'}>
        ${helpers}
        <style>
          .autofill-field { position: absolute; top: 0; height: 100%; width: 2px; z-index: -1; left: -2px; opacity: 0; }
          .focus-intercept { position: absolute; top: -1px; left: -1px; height: 1px; width: 1px; opacity: 0; }
          label { position: absolute; left: -9999px; }
        </style>
        <script>
          document.querySelector('input').addEventListener('input', event => {
            const input = event.target;
            if (${JSON.stringify(field)} === 'exp-date') {
              const digits = input.value.replace(/\\D/g, '').slice(0, 4);
              input.value = digits.length > 2 ? digits.slice(0, 2) + '/' + digits.slice(2) : digits;
            }
            parent.postMessage({field: ${JSON.stringify(field)}, valid: input.value === ${JSON.stringify(expected)}}, '*');
          });
        </script>`,
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `
      <main>Order total $25.99</main>
      <template id="hosted-fields">${Object.keys(fields)
        .map(
          (field) =>
            `<iframe name="${provider === "braintree" ? `braintree-hosted-field-${field}` : `__privateStripeFrame${field}`}" src="${origin}/${field}"></iframe>`,
        )
        .join("")}</template>
      <button type="button">Place order</button>
      <script>
        const mountFields = () => document.body.append(document.querySelector('template').content.cloneNode(true));
        if (${mountDelayMs} > 0) {
          const wallet = document.createElement('button');
          wallet.textContent = 'PayPal';
          document.body.append(wallet);
          window.mountHostedFields = () => setTimeout(mountFields, ${mountDelayMs});
        } else mountFields();
        const valid = {};
        addEventListener('message', event => {
          if (event.origin === ${JSON.stringify(origin)}) valid[event.data.field] = event.data.valid;
        });
        document.querySelector('button').onclick = () => {
          if (!${JSON.stringify(Object.keys(fields))}.every(field => valid[field])) return;
          document.body.dataset.charged = 'true';
          fetch('/payments', {method: 'POST'});
          history.pushState({}, '', '/thank-you/hosted');
          document.querySelector('main').textContent = 'Your order is confirmed Confirmation # hosted-123';
        };
      </script>`,
    });
  });
  await page.goto("https://checkout.synthetic.test/checkout");
}
