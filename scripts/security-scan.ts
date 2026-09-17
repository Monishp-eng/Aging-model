import fs from "fs";
import path from "path";
import { checkSecretLeakage } from "../lib/config/schema";

interface Violation {
  file: string;
  line: number;
  type: string;
  match: string;
  snippet: string;
}

const VIOLATION_RULES = [
  {
    type: "Live Stripe Secret Key",
    regex: /sk_live_[0-9a-zA-Z]{24,}/g,
  },
  {
    type: "Live Replicate Token",
    regex: /r8_[0-9a-zA-Z]{32,}/g,
  },
  {
    type: "Live Webhook Secret",
    regex: /whsec_[0-9a-zA-Z]{32,}/g,
  },
  {
    type: "Private RSA / PEM Key",
    regex: /-----BEGIN (?:RSA )?PRIVATE KEY-----/g,
  },
  {
    type: "Dynamic Code Execution (eval)",
    regex: /\beval\s*\(/g,
  },
  {
    type: "Dynamic Code Execution (new Function)",
    regex: /new\s+Function\s*\(/g,
  },
  {
    type: "Unsafe SQL String Interpolation",
    regex: /\.execute\s*\(\s*`(?!\s*VACUUM\s+INTO)[^`]*\$\{[^`]*\}[^`]*`\s*\)/gi,
  },
];

const SCAN_DIRS = ["app", "lib", "components", "scripts"];
const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".jsx"];

function scanDirectory(dir: string, violations: Violation[]): number {
  if (!fs.existsSync(dir)) return 0;

  let fileCount = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "data") {
        continue;
      }
      fileCount += scanDirectory(fullPath, violations);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!SCAN_EXTENSIONS.includes(ext)) continue;

      fileCount++;
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      for (const rule of VIOLATION_RULES) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip comments or test files if evaluating mock patterns
          if (rule.regex.test(line)) {
            violations.push({
              file: path.relative(process.cwd(), fullPath),
              line: i + 1,
              type: rule.type,
              match: rule.type,
              snippet: line.trim(),
            });
          }
          // Reset regex state for global regexes
          rule.regex.lastIndex = 0;
        }
      }
    }
  }

  return fileCount;
}

export function runSecurityScan(): { pass: boolean; violations: Violation[]; filesScanned: number } {
  const violations: Violation[] = [];
  let filesScanned = 0;

  // 1. Scan source code tree
  for (const dir of SCAN_DIRS) {
    const fullDir = path.resolve(process.cwd(), dir);
    filesScanned += scanDirectory(fullDir, violations);
  }

  // 2. Audit process.env for public secret leaks
  const envLeaks = checkSecretLeakage(process.env);
  for (const leak of envLeaks) {
    violations.push({
      file: "process.env",
      line: 0,
      type: "Public Secret Leakage in Environment",
      match: leak,
      snippet: leak,
    });
  }

  return {
    pass: violations.length === 0,
    violations,
    filesScanned,
  };
}

if (require.main === module) {
  console.log("Starting static application security scan...");
  const result = runSecurityScan();

  console.log(`Scanned ${result.filesScanned} source files across: ${SCAN_DIRS.join(", ")}`);

  if (!result.pass) {
    console.error(`\n[SECURITY SCAN: FAILED] Found ${result.violations.length} security violation(s):`);
    for (const v of result.violations) {
      console.error(`  - [${v.type}] ${v.file}:${v.line} -> ${v.snippet}`);
    }
    process.exit(1);
  }

  console.log("[SECURITY SCAN: PASS] No hardcoded secrets or prohibited dynamic patterns detected.");
  process.exit(0);
}
