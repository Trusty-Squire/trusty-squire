# registry

Skill registry service.

## Local dev

From the repository root:

```bash
pnpm --filter @trusty-squire/registry dev
pnpm --filter @trusty-squire/registry build
pnpm --filter @trusty-squire/registry test
```

The dev server listens on port `3001` by default; set `REGISTRY_API_PORT` to override it. Without `REGISTRY_DATABASE_URL`, it uses in-memory stores that reset on restart.

For the current contracts and operations, see:

- [Skill schema](../../packages/skill-schema/src/skill.ts)
- [Registry deployment](../../docs/DEPLOY-registry.md)
