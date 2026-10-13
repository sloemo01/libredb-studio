/**
 * Fork-only probe for issue #1726 (never part of an upstream PR).
 *
 * Runs the R-S10 hostile set under Bun and Node exactly the way the real test's beforeAll does, and prints
 * one JSON line per invocation with every peer's label, ms and openAfter. The point is to measure the two
 * runners that fail intermittently (windows-latest, macos-latest) instead of guessing which stop a peer came
 * to or whether its socket closes late or never.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { makeCertificates } from "./node-transport-fixtures";
import { runHostileSet } from "./rabbitmq-fake-peer";
import type { HostileOutcome } from "./rabbitmq-fake-peer";

const HELPER = join(import.meta.dir, "rabbitmq-fake-peer.ts");

const pair = makeCertificates().local;
const certificate = { key: pair.key, cert: pair.cert };

const slim = (outcomes: readonly HostileOutcome[]) =>
  outcomes.map((o) => ({ n: o.name, l: o.label, ms: Math.round(o.ms), oa: o.openAfter }));

let uncaught = 0;
process.on("uncaughtException", () => {
  uncaught += 1;
});
process.on("unhandledRejection", () => {
  uncaught += 1;
});

const bunOutcomes = await runHostileSet(certificate);

const work = mkdtempSync(join(tmpdir(), "r10-probe-"));
try {
  writeFileSync(
    join(work, "child.ts"),
    [
      'import { readFileSync } from "node:fs";',
      `import { runHostileSet } from ${JSON.stringify(HELPER)};`,
      "let uncaught = 0;",
      'process.on("uncaughtException", () => { uncaught += 1; });',
      'process.on("unhandledRejection", () => { uncaught += 1; });',
      'const certificate = JSON.parse(readFileSync(process.argv[2], "utf8"));',
      "const outcomes = await runHostileSet(certificate);",
      'process.stdout.write(JSON.stringify({ runtime: process.version, outcomes, uncaught }) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  writeFileSync(join(work, "certificate.json"), JSON.stringify(certificate));
  const build = await Bun.build({
    entrypoints: [join(work, "child.ts")],
    target: "node",
    format: "esm",
    outdir: work,
  });
  if (!build.success) throw new Error(`bundle failed: ${build.logs.map(String).join("; ")}`);
  const listed = process.env.NODE_TRANSPORT_NODES;
  const nodeBin = listed ? listed.split(delimiter).filter(Boolean)[0] : "node";
  const child = Bun.spawn([nodeBin as string, join(work, "child.js"), join(work, "certificate.json")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const nodeRun = JSON.parse(stdout.trim().split("\n").at(-1) as string) as {
    runtime: string;
    uncaught: number;
    outcomes: HostileOutcome[];
  };
  console.log(
    JSON.stringify({
      iter: Number(process.env.PROBE_ITER ?? 0),
      bun: { runtime: `bun ${Bun.version}`, uncaught, outcomes: slim(bunOutcomes) },
      node: {
        runtime: nodeRun.runtime,
        uncaught: nodeRun.uncaught,
        outcomes: slim(nodeRun.outcomes),
        exitCode,
        stderr: stderr.slice(0, 300),
      },
    }),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
