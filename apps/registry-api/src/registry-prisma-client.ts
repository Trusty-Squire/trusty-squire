import { createRequire } from "node:module";

export interface RegistryPrismaClient {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<T>(fn: (tx: RegistryPrismaTransaction) => Promise<T>): Promise<T>;
  adapterManifestRecord: AdapterManifestDelegate;
  skillRecord: SkillRecordDelegate;
  skillReplayRecord: SkillReplayDelegate;
  skillCaptureRecord: SkillCaptureDelegate;
  extractFailureSnapshot: ExtractFailureSnapshotDelegate;
}

export type RegistryPrismaTransaction = Omit<
  RegistryPrismaClient,
  "$connect" | "$disconnect" | "$transaction"
>;

interface AdapterManifestDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown | null>;
  findMany(args: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
  }): Promise<unknown[]>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
}

interface SkillRecordDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown | null>;
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<unknown | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<unknown[]>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

interface SkillReplayDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<unknown[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

interface SkillCaptureDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Array<Record<string, unknown>>;
  }): Promise<unknown[]>;
}

interface ExtractFailureSnapshotDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<unknown | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<unknown[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

export function createRegistryPrismaClient(): RegistryPrismaClient {
  const req = createRequire(import.meta.url);
  type Ctor = new () => RegistryPrismaClient;
  const mod = req("../node_modules/.prisma/registry-client/index.js") as {
    PrismaClient: Ctor;
  };
  return new mod.PrismaClient();
}
