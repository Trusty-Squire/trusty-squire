import type { Page } from "playwright";

// Claims survive registry disposal while the Page is reachable: a different
// controller must never acquire an old session's page by registering it again.
const owners = new WeakMap<Page, symbol>();

/** Session-local page ownership; context membership is never ownership proof. */
export class OwnedPages {
  private readonly owner = Symbol("browser-session");
  private readonly pages = new Map<Page, () => void>();

  constructor(private readonly onPopup: (page: Page) => void) {}

  /** Only call for a known primary/recovery page, or a proven popup below. */
  register(page: Page): void {
    const owner = owners.get(page);
    if (owner !== undefined && owner !== this.owner) {
      throw new Error("Browser page already belongs to another session");
    }
    if (page.isClosed() || this.pages.has(page)) return;
    owners.set(page, this.owner);
    // Playwright emits this on the opener using lineage captured when the
    // target was created. Do not resolve page.opener() later: it can disappear
    // when the opener closes. No event/proven opener means no assignment.
    const popup = (child: Page): void => {
      if (!this.has(page) || child.context() !== page.context()) return;
      if (owners.has(child)) return; // duplicate/foreign attribution fails closed
      this.register(child);
      if (this.has(child)) this.onPopup(child);
    };
    const dispose = (): void => {
      page.off("popup", popup);
      page.off("close", dispose);
      this.pages.delete(page);
    };
    this.pages.set(page, dispose);
    page.on("popup", popup);
    page.on("close", dispose);
  }

  has(page: Page): boolean {
    return this.pages.has(page) && !page.isClosed();
  }

  /** True only when a DIFFERENT registry has positively claimed the page. */
  claimedByAnother(page: Page): boolean {
    const owner = owners.get(page);
    return owner !== undefined && owner !== this.owner;
  }

  live(): Page[] {
    return [...this.pages.keys()].filter((page) => this.has(page));
  }

  dispose(): void {
    for (const dispose of this.pages.values()) dispose();
  }
}
