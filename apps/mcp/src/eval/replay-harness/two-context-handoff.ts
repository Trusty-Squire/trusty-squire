import { OperatorRecipeSchema, type OperatorRecipe } from "../../bot/operator-recipe.js";

function checkoutStepIndex(recipe: OperatorRecipe): number {
  const index = recipe.trace.findIndex(({ action }) => {
    if (action.kind !== "click") return false;
    const target = action.target;
    return (
      target?.dom_hint?.id === "checkout" ||
      target?.dom_hint?.name === "checkout" ||
      target?.css === "#checkout" ||
      /check\s*out/i.test(target?.visible_text ?? "")
    );
  });
  if (index < 1)
    throw new Error(`operator recipe ${recipe.name} has no storefront-to-checkout boundary`);
  const prefix = recipe.trace.slice(0, index);
  if (
    prefix.some(({ action }) =>
      ["type", "select", "set_phone_country", "operate_pay"].includes(action.kind),
    )
  ) {
    throw new Error(
      `operator recipe ${recipe.name} crosses into checkout before its declared checkout boundary`,
    );
  }
  return index;
}

function recipeSegment(recipe: OperatorRecipe, start: number, end?: number): OperatorRecipe {
  return OperatorRecipeSchema.parse({
    ...recipe,
    entry_url: undefined,
    entry_mode: "runtime_service_url",
    trace: recipe.trace.slice(start, end),
  });
}

/**
 * A fresh cart permalink has already crossed the checkout boundary. The live
 * leg must therefore begin at the first post-checkout action, while the frozen
 * context stays restricted to the storefront prefix.
 */
export function splitTwoContextReplay(recipe: OperatorRecipe): {
  storefront: OperatorRecipe;
  checkout: OperatorRecipe;
} {
  const boundary = checkoutStepIndex(recipe);
  return {
    storefront: recipeSegment(recipe, 0, boundary),
    checkout: recipeSegment(recipe, boundary + 1),
  };
}
