import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  PROJECT_REGISTRY,
  assertValidProjectConfig,
  resolveProjectByName,
  resolveProjectByRepoRoot,
  requireProjectByName,
  hasTicketReference,
  planOptionsForProject,
  gate2OptionsForProject,
  UnknownProjectError,
  InvalidProjectConfigError,
  type ProjectConfig,
} from "../src/project-config.js";

const SEEDED_NAMES = ["agent-gateway", "control-plane", "frontend", "atlan-plugins", "infrastructure"];

test("PROJECT_REGISTRY: seeds all five Agent Registry projects, each resolvable by name", () => {
  assert.equal(PROJECT_REGISTRY.length, 5);
  for (const name of SEEDED_NAMES) {
    const project = resolveProjectByName(name);
    assert.ok(project, `expected ${name} to be registered`);
    assert.ok(path.isAbsolute(project!.repoRoot), `${name}.repoRoot must be absolute`);
    assert.equal(project!.linearTeam, "atlan-epd");
    assert.match("AGENT-1234", project!.ticketPattern);
  }
});

test("PROJECT_REGISTRY: infrastructure honestly has no validation commands", () => {
  const project = requireProjectByName("infrastructure");
  assert.deepEqual(project.validationCommands, []);
});

test("PROJECT_REGISTRY: frontend carries all five observed validation commands in order", () => {
  const project = requireProjectByName("frontend");
  assert.deepEqual(
    project.validationCommands.map((v) => v.command),
    ["pnpm typecheck", "pnpm test", "pnpm lint", "pnpm format:check", "pnpm check:secrets"],
  );
});

test("resolveProjectByRepoRoot: matches an absolute repoRoot exactly", () => {
  const project = requireProjectByName("agent-gateway");
  const found = resolveProjectByRepoRoot(project.repoRoot);
  assert.equal(found?.name, "agent-gateway");
});

test("resolveProjectByRepoRoot: returns undefined for an unregistered repoRoot", () => {
  assert.equal(resolveProjectByRepoRoot("/tmp/some/other/repo"), undefined);
});

test("requireProjectByName: unknown project name fails loudly and lists known projects", () => {
  assert.throws(() => requireProjectByName("mothership"), (err: unknown) => {
    assert.ok(err instanceof UnknownProjectError);
    assert.match((err as Error).message, /unknown project "mothership"/);
    for (const name of SEEDED_NAMES) {
      assert.match((err as Error).message, new RegExp(name));
    }
    return true;
  });
});

test("assertValidProjectConfig: rejects a relative repoRoot", () => {
  const bad: ProjectConfig = {
    name: "bad",
    repoRoot: "relative/path",
    ticketPattern: /X-\d+/,
    branchNameSource: "linear-git-branch-name",
    validationCommands: [],
    defaultFileAllowlist: [],
  };
  assert.throws(() => assertValidProjectConfig(bad), InvalidProjectConfigError);
});

test("assertValidProjectConfig: rejects an unknown branchNameSource", () => {
  const bad = {
    name: "bad",
    repoRoot: "/abs/path",
    ticketPattern: /X-\d+/,
    branchNameSource: "made-up-source",
    validationCommands: [],
    defaultFileAllowlist: [],
  } as unknown as ProjectConfig;
  assert.throws(() => assertValidProjectConfig(bad), InvalidProjectConfigError);
});

test("assertValidProjectConfig: rejects an empty-command validationCommands entry", () => {
  const bad: ProjectConfig = {
    name: "bad",
    repoRoot: "/abs/path",
    ticketPattern: /X-\d+/,
    branchNameSource: "linear-git-branch-name",
    validationCommands: [{ command: "  " }],
    defaultFileAllowlist: [],
  };
  assert.throws(() => assertValidProjectConfig(bad), InvalidProjectConfigError);
});

test("hasTicketReference: true when description matches the project's ticketPattern, false otherwise", () => {
  const project = requireProjectByName("agent-gateway");
  assert.equal(hasTicketReference(project, "AGENT-4821: fix the retry loop"), true);
  assert.equal(hasTicketReference(project, "fix the retry loop, no ticket"), false);
});

test("planOptionsForProject: produces {repoRoot, description} from the project + a description", () => {
  const project = requireProjectByName("control-plane");
  const opts = planOptionsForProject(project, "AGENT-1: do the thing");
  assert.equal(opts.repoRoot, project.repoRoot);
  assert.equal(opts.description, "AGENT-1: do the thing");
});

test("gate2OptionsForProject: carries repoRoot, fileAllowlist, and brief overrides (undefined when project declares none)", () => {
  const project = requireProjectByName("atlan-plugins");
  const opts = gate2OptionsForProject(project);
  assert.equal(opts.repoRoot, project.repoRoot);
  assert.deepEqual(opts.fileAllowlist, project.defaultFileAllowlist);
  assert.equal(opts.agentBriefPath, undefined);
  assert.equal(opts.reviewSkillPath, undefined);
});

test("gate2OptionsForProject: threads through a project's custom brief paths when declared", () => {
  const project: ProjectConfig = {
    ...requireProjectByName("frontend"),
    agentBriefPath: "tools/claude/scoped-fixer.md",
    reviewSkillPath: "tools/claude/review.md",
  };
  const opts = gate2OptionsForProject(project);
  assert.equal(opts.agentBriefPath, "tools/claude/scoped-fixer.md");
  assert.equal(opts.reviewSkillPath, "tools/claude/review.md");
});

test("Mothership test: adding a new project is exactly one more PROJECT_REGISTRY entry -- a caller-supplied registry works identically to the module-level default", () => {
  const mothership: ProjectConfig = {
    name: "mothership",
    repoRoot: "/tmp/mothership",
    linearTeam: "atlan-epd",
    ticketPattern: /AGENT-\d+/,
    branchNameSource: "linear-git-branch-name",
    validationCommands: [{ command: "pnpm test" }],
    defaultFileAllowlist: [],
  };
  const registry = [...PROJECT_REGISTRY, mothership];
  assert.equal(resolveProjectByName("mothership", registry)?.name, "mothership");
  // Every pre-existing project still resolves unchanged in the extended registry.
  for (const name of SEEDED_NAMES) {
    assert.equal(resolveProjectByName(name, registry)?.name, name);
  }
});
