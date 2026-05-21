# @trusty-squire/adapter-sdk

Type-checked SDK for authoring [Trusty Squire](https://github.com/Trusty-Squire/trusty-squire) adapter manifests and consuming the Tier-2 Learned Skill schema.

## Install

```bash
npm install @trusty-squire/adapter-sdk
```

## What's in here

Two parallel surfaces, both used by the Trusty Squire registry:

### Adapter manifest (`defineAdapter`)

Hand-authored Tier-3 manifests describing how to talk to a SaaS API — auth, plans, capabilities, request shapes. Validated at registry publish time.

```ts
import { defineAdapter } from "@trusty-squire/adapter-sdk";

export default defineAdapter({
  // … manifest body
});
```

### Skill schema (`parseSkill`, `Skill` types)

Zod schema for Tier-2 Learned Skills — structured replay graphs the universal bot promotes from successful onboarding runs.

```ts
import { parseSkill, type Skill, SkillSchema } from "@trusty-squire/adapter-sdk";

const skill: Skill = parseSkill(raw);
```

## Status

Pre-1.0. The schema may evolve; pin a caret range and watch CHANGELOG for breaking changes.

## License

MIT
