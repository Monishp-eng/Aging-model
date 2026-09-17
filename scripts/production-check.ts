import { execSync } from "child_process";

interface GateStep {
  name: string;
  command: string;
  critical: boolean;
}

const RELEASE_GATE_STEPS: GateStep[] = [
  {
    name: "1. Code Quality & Lint Gate",
    command: "npm run lint",
    critical: true,
  },
  {
    name: "2. TypeScript Static Type Safety Gate",
    command: "npx tsc --noEmit",
    critical: true,
  },
  {
    name: "3. Static Security & Secret Leakage Gate",
    command: "npx tsx scripts/security-scan.ts",
    critical: true,
  },
  {
    name: "4. Fresh-Database Migration Gate (Zero-to-Current)",
    command: "npm run db:test-zero",
    critical: true,
  },
  {
    name: "5. Comprehensive Test Pyramid (Unit, Integration, Security, Invariants, Concurrency, Abuse)",
    command: "npx vitest run",
    critical: true,
  },
  {
    name: "6. Production Build Artifact Compilation",
    command: "npm run build",
    critical: true,
  },
];

async function runProductionGate() {
  console.log("=======================================================");
  console.log("   AUTOMATED PRODUCTION RELEASE GATE — EXTRA POLATE    ");
  console.log("=======================================================\n");

  const startTime = Date.now();
  const failedSteps: string[] = [];

  const baseEnv = {
    ...process.env,
    APP_ENV: process.env.APP_ENV || "test",
    DATABASE_URL: process.env.DATABASE_URL || "file:./data/release-gate.db",
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ci-mock.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "ci-mock-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "ci-mock-service-role-key",
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "sk_test_ci_mock",
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "whsec_ci_mock",
    REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN || "r8_ci_mock",
    REPLICATE_WEBHOOK_SECRET: process.env.REPLICATE_WEBHOOK_SECRET || "whsec_ci_mock",
    CRON_SECRET: process.env.CRON_SECRET || "ci_cron_secret_mock",
    CI: "true",
  };

  for (const step of RELEASE_GATE_STEPS) {
    console.log(`\n>>> Executing [${step.name}]...`);
    console.log(`    Command: ${step.command}\n`);

    try {
      execSync(step.command, {
        stdio: "inherit",
        env: baseEnv,
      });
      console.log(`\n[PASS] ${step.name}`);
    } catch (err: any) {
      console.error(`\n[FAIL] ${step.name} failed with exit code ${err.status || 1}`);
      failedSteps.push(step.name);
      if (step.critical) {
        break; // Zero tolerance release blocker!
      }
    }
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  console.log("\n=======================================================");
  if (failedSteps.length > 0) {
    console.error(`\nPRODUCTION GATE: BLOCKED (${durationSec}s)`);
    console.error(`Release candidate rejected due to ${failedSteps.length} failed gate(s):`);
    for (const f of failedSteps) {
      console.error(`  - ${f}`);
    }
    console.error("Zero tolerance release blockers must be resolved before deployment.\n");
    process.exit(1);
  } else {
    console.log(`\nPRODUCTION GATE: PASS (${durationSec}s)`);
    console.log("All code quality, type, security, migration, concurrency, and build gates passed.");
    console.log("Commit is certified production-grade and ready for deployment.\n");
    console.log("=======================================================\n");
    process.exit(0);
  }
}

runProductionGate();
