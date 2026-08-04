export type CorpusBucket = "repeat" | "novel";

export interface ShoppingAddress {
  country: string;
  postal_code: string;
  region?: string;
}

export interface ExpectedEndState {
  line_items: Array<{ title_contains: string; qty: number }>;
  total_cents: number;
  reached: string;
}

export interface CostSample {
  turns: number;
  tokens: number;
  wall_clock_ms: number;
}

export interface ColdBaseline extends CostSample {
  end_state: ExpectedEndState;
}

export interface ShoppingTaskRecord {
  task_id: string;
  verb: "purchase";
  domain: string;
  entry_url: string;
  params: {
    product_query: string;
    address: ShoppingAddress;
    card_ref: string;
  };
  expected_end_state: ExpectedEndState;
  har: string;
  bucket: CorpusBucket;
  cold_baseline: ColdBaseline;
  capture: {
    status: "captured" | "skipped";
    captured_at?: string;
    skip_reason?: string;
  };
}

export interface TaskObservation {
  task_id: string;
  bucket: CorpusBucket;
  cold: CostSample;
  recipe_applied: boolean;
  warm?: CostSample;
  end_state_matches: boolean;
  fallbacks: number;
  total_steps: number;
}

export type DriftMutationName =
  | "rename-button"
  | "swap-testid"
  | "remove-field"
  | "change-price"
  | "out-of-stock"
  | "overlay";

export interface DriftObservation {
  task_id: string;
  mutation: DriftMutationName;
  money_affecting: boolean;
  guard_action: "clean" | "fallback" | "abort" | "missed";
  end_state_matches: boolean;
}

export interface HarnessThresholds {
  net_speedup: number;
  clean_replay_correctness: number;
  task_success: number;
  drift_catch_rate: number;
  money_escape: number;
}

export interface HarnessMetrics {
  speedup_on_hit: {
    turns: number;
    tokens: number;
    wall_clock: number;
  };
  hit_rate: number;
  net_speedup: {
    turns: number;
    tokens: number;
    wall_clock: number;
  };
  clean_replay_correctness: number;
  task_success: number;
  fallback_rate: number;
  money_escape: number;
  drift_catch_rate: number;
  recipe_survival: { t7d: number | null; t30d: number | null };
}

export interface HarnessReport {
  schema_version: 1;
  mode: "all-cold-baseline" | "replay-eval";
  generated_at: string;
  corpus: {
    tasks: number;
    repeat: number;
    novel: number;
    drift_trials: number;
  };
  cold_baseline: {
    tasks: number;
    median: CostSample;
    total: CostSample;
  };
  thresholds: HarnessThresholds;
  metrics: HarnessMetrics;
  decision: "SHIP" | "NO-SHIP";
  reasons: string[];
}
