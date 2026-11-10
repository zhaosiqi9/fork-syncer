#!/usr/bin/env node
"use strict";

/*
 * GitHub Fork Auto Sync V2
 *
 * Policy:
 * - Discover repositories owned by the authenticated user.
 * - Process Fork repositories with an accessible parent repository.
 * - Fetch every branch from upstream and fork.
 * - Create upstream branches missing from the fork.
 * - Fast-forward fork branches only when the fork is an ancestor of upstream.
 * - Never force-push; never delete fork-only branches.
 * - Preserve fork-ahead and diverged branches; report them.
 * - Process up to 5 repositories concurrently.
 * - Write a complete log to LOG_FILE, replacing the previous local log.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TOKEN = process.env.FORK_SYNC_TOKEN;
const OWNER = process.env.GITHUB_OWNER;
const API_URL = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const LOG_FILE = process.env.LOG_FILE || "logs/latest-sync.log";
const SUMMARY_FILE = process.env.SUMMARY_FILE;
const API_VERSION = "2022-11-28";
const CONCURRENCY = 5;
const MAX_RETRIES = 4;

const lines = [];
const totals = {
  discovered: 0, forks: 0, archived: 0, processed: 0,
  repoSuccess: 0, repoPartial: 0, repoConflict: 0, repoFailed: 0,
  branchesSynced: 0, branchesCreated: 0, branchesUpToDate: 0,
  branchesAhead: 0, branchesConflict: 0, branchesProtected: 0,
  branchesFailed: 0, branchesSkipped: 0
};

function log(message = "") {
  const line = String(message);
  console.log(line);
  lines.push(line);
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiRequest(url, attempt = 0) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "github-fork-auto-sync-v2"
    }
  });

  if ((response.status === 429 || response.status === 403 || response.status >= 500) &&
      attempt < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    let waitMs = retryAfter > 0 ? retryAfter * 1000 : 0;

    if (!waitMs && response.status === 403 && remaining === "0" && reset > 0) {
      waitMs = Math.max(1000, reset * 1000 - Date.now() + 1000);
    }
    if (!waitMs) waitMs = Math.min(30000, 1000 * (2 ** attempt));

    log(`API retry: HTTP ${response.status}; waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
    return apiRequest(url, attempt + 1);
  }

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`GitHub API HTTP ${response.status}: ${body.slice(0, 800)}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function listOwnedRepositories() {
  const result = [];
  let page = 1;

  while (true) {
    const url = `${API_URL}/user/repos?type=owner&sort=full_name&per_page=100&page=${page}`;
    const response = await apiRequest(url);
    const batch = await response.json();
    result.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return result;
}

function git(args, cwd, token) {
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`
  };
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || "Git command failed").trim());
    error.status = result.status;
    throw error;
  }
  return (result.stdout || "").trim();
}

function tryGit(args, cwd, token) {
  try {
    return { ok: true, output: git(args, cwd, token) };
  } catch (error) {
    return { ok: false, error };
  }
}

function branchRef(remote, branch) {
  return `refs/remotes/${remote}/${branch}`;
}

function isAncestor(cwd, older, newer, token) {
  const result = tryGit(["merge-base", "--is-ancestor", older, newer], cwd, token);
  if (result.ok) return true;
  if (result.error.status === 1) return false;
  throw result.error;
}

function classifyPushError(message) {
  const value = message.toLowerCase();
  if (/protected branch|protected branch hook declined|repository rule|branch protection/.test(value)) {
    return "protected";
  }
  if (/non-fast-forward|fetch first|stale info|rejected/.test(value)) {
    return "conflict";
  }
  return "failed";
}

async function syncRepository(repo) {
  const fullName = repo.full_name;
  totals.processed += 1;
  log("");
  log("================================================================");
  log(`Repository: ${fullName}`);
  log("================================================================");

  if (repo.archived) {
    totals.archived += 1;
    log("SKIP: Repository is archived");
    return { status: "skipped" };
  }
  if (repo.disabled) {
    log("SKIP: Repository is disabled");
    totals.branchesSkipped += 1;
    return { status: "skipped" };
  }
  if (repo.permissions && repo.permissions.push === false) {
    log("SKIP: Token has no push permission for this fork");
    return { status: "failed" };
  }

  const parent = repo.parent;
  if (!parent || !parent.full_name) {
    log("SKIP: Upstream parent metadata is unavailable");
    return { status: "failed" };
  }

  const forkOwner = repo.owner.login;
  const forkName = repo.name;
  const upstreamOwner = parent.owner.login;
  const upstreamName = parent.name;

  log(`Fork: ${fullName}`);
  log(`Upstream: ${parent.full_name}`);

  const tempDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "fork-sync-"));
  const forkUrl = `https://github.com/${forkOwner}/${forkName}.git`;
  const upstreamUrl = `https://github.com/${upstreamOwner}/${upstreamName}.git`;

  const result = {
    status: "success",
    synced: 0, created: 0, upToDate: 0, ahead: 0,
    conflict: 0, protected: 0, failed: 0, skipped: 0
  };

  try {
    git(["init", "--quiet"], tempDir, TOKEN);
    git(["remote", "add", "fork", forkUrl], tempDir, TOKEN);
    git(["remote", "add", "upstream", upstreamUrl], tempDir, TOKEN);

    log("Fetching fork branches...");
    git(["fetch", "--no-tags", "fork", "+refs/heads/*:refs/remotes/fork/*"], tempDir, TOKEN);
    log("Fetching upstream branches...");
    git(["fetch", "--no-tags", "upstream", "+refs/heads/*:refs/remotes/upstream/*"], tempDir, TOKEN);

    const upstreamOutput = git([
      "for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/upstream"
    ], tempDir, TOKEN);
    const forkOutput = git([
      "for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/fork"
    ], tempDir, TOKEN);

    const upstreamBranches = upstreamOutput ? upstreamOutput.split("\n").filter(Boolean) : [];
    const forkBranches = new Set(forkOutput ? forkOutput.split("\n").filter(Boolean) : []);

    log(`Upstream branches: ${upstreamBranches.length}`);
    log(`Fork branches: ${forkBranches.size}`);

    for (const branch of upstreamBranches) {
      const upstreamRef = branchRef("upstream", branch);
      const upstreamSha = git(["rev-parse", upstreamRef], tempDir, TOKEN);

      if (!forkBranches.has(branch)) {
        const pushed = tryGit(
          ["push", "fork", `${upstreamSha}:refs/heads/${branch}`],
          tempDir,
          TOKEN
        );

        if (pushed.ok) {
          result.created += 1;
          totals.branchesCreated += 1;
          log(`CREATE: ${branch} (${upstreamSha.slice(0, 12)})`);
        } else {
          const kind = classifyPushError(errorText(pushed.error));
          result[kind === "protected" ? "protected" : kind === "conflict" ? "conflict" : "failed"] += 1;
          totals[kind === "protected" ? "branchesProtected" : kind === "conflict" ? "branchesConflict" : "branchesFailed"] += 1;
          log(`${kind.toUpperCase()}: ${branch}: ${errorText(pushed.error)}`);
        }
        continue;
      }

      const forkRef = branchRef("fork", branch);
      const forkSha = git(["rev-parse", forkRef], tempDir, TOKEN);

      if (forkSha === upstreamSha) {
        result.upToDate += 1;
        totals.branchesUpToDate += 1;
        log(`UP-TO-DATE: ${branch}`);
        continue;
      }

      // Only fast-forward when the fork tip is an ancestor of the upstream tip.
      if (isAncestor(tempDir, forkSha, upstreamSha, TOKEN)) {
        const pushed = tryGit(
          ["push", "fork", `${upstreamSha}:refs/heads/${branch}`],
          tempDir,
          TOKEN
        );

        if (pushed.ok) {
          result.synced += 1;
          totals.branchesSynced += 1;
          log(`SYNCED: ${branch} (${forkSha.slice(0, 12)} -> ${upstreamSha.slice(0, 12)})`);
        } else {
          const kind = classifyPushError(errorText(pushed.error));
          result[kind === "protected" ? "protected" : kind === "conflict" ? "conflict" : "failed"] += 1;
          totals[kind === "protected" ? "branchesProtected" : kind === "conflict" ? "branchesConflict" : "branchesFailed"] += 1;
          log(`${kind.toUpperCase()}: ${branch}: ${errorText(pushed.error)}`);
        }
        continue;
      }

      if (isAncestor(tempDir, upstreamSha, forkSha, TOKEN)) {
        result.ahead += 1;
        totals.branchesAhead += 1;
        log(`PRESERVED: ${branch} (Fork is ahead; no overwrite)`);
      } else {
        result.conflict += 1;
        totals.branchesConflict += 1;
        log(`CONFLICT: ${branch} (branches have diverged; no overwrite)`);
      }
    }

    // Fork-only branches are intentionally retained.
    const upstreamSet = new Set(upstreamBranches);
    const forkOnly = [...forkBranches].filter(branch => !upstreamSet.has(branch));
    if (forkOnly.length) {
      result.skipped += forkOnly.length;
      totals.branchesSkipped += forkOnly.length;
      log(`PRESERVED FORK-ONLY BRANCHES (${forkOnly.length}): ${forkOnly.join(", ")}`);
    }

    const problemCount = result.conflict + result.protected + result.failed;
    if (result.failed > 0) result.status = "failed";
    else if (problemCount > 0 || result.ahead > 0) result.status = "partial";
    else result.status = "success";

    log(`Repository result: ${result.status.toUpperCase()} | synced=${result.synced}, created=${result.created}, upToDate=${result.upToDate}, ahead=${result.ahead}, conflicts=${result.conflict}, protected=${result.protected}, failed=${result.failed}, forkOnly=${result.skipped}`);
    return result;
  } catch (error) {
    log(`REPOSITORY FAILED: ${errorText(error)}`);
    result.status = "failed";
    result.failed += 1;
    totals.branchesFailed += 1;
    return result;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runPool(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      try {
        const result = await worker(items[current]);
        if (result.status === "success") totals.repoSuccess += 1;
        else if (result.status === "partial") totals.repoPartial += 1;
        else if (result.status === "failed") totals.repoFailed += 1;
      } catch (error) {
        totals.repoFailed += 1;
        log(`UNHANDLED REPOSITORY ERROR: ${errorText(error)}`);
      }
    }
  });
  await Promise.all(workers);
}

function buildSummary() {
  return [
    "# GitHub Fork Sync V2",
    "",
    `- Discovered repositories: **${totals.discovered}**`,
    `- Forks found: **${totals.forks}**`,
    `- Processed: **${totals.processed}**`,
    `- Archived: **${totals.archived}**`,
    "",
    "## Repository results",
    `- Success: ${totals.repoSuccess}`,
    `- Partial: ${totals.repoPartial}`,
    `- Failed: ${totals.repoFailed}`,
    "",
    "## Branch results",
    `- Fast-forward synced: ${totals.branchesSynced}`,
    `- New branches created: ${totals.branchesCreated}`,
    `- Already up-to-date: ${totals.branchesUpToDate}`,
    `- Fork-ahead preserved: ${totals.branchesAhead}`,
    `- Diverged conflicts: ${totals.branchesConflict}`,
    `- Protected branches: ${totals.branchesProtected}`,
    `- Failed: ${totals.branchesFailed}`,
    `- Fork-only preserved: ${totals.branchesSkipped}`,
    ""
  ].join("\n");
}

async function main() {
  if (!TOKEN) throw new Error("FORK_SYNC_TOKEN secret is missing.");
  log("GITHUB FORK AUTO SYNC V2");
  log(`Started: ${new Date().toISOString()}`);

  // Determine the actual token owner. The central workflow repository may
  // itself belong to an organization, so github.repository_owner is not
  // necessarily the authenticated user's login.
  const userResponse = await apiRequest(`${API_URL}/user`);
  const authenticatedUser = (await userResponse.json()).login;
  log(`Authenticated GitHub user: ${authenticatedUser}`);
  log(`Repository concurrency: ${CONCURRENCY}`);
  log("Policy: fast-forward only; no force push; no branch deletion.");

  const repos = await listOwnedRepositories();
  totals.discovered = repos.length;
  const forks = repos.filter(repo =>
    repo.fork === true &&
    repo.owner &&
    repo.owner.login.toLowerCase() === authenticatedUser.toLowerCase()
  );
  totals.forks = forks.length;

  log(`Discovered repositories: ${repos.length}`);
  log(`Forks found: ${forks.length}`);

  await runPool(forks, CONCURRENCY, syncRepository);

  log("");
  log("================================================================");
  log("SYNC SUMMARY");
  log("================================================================");
  for (const [key, value] of Object.entries(totals)) log(`${key}: ${value}`);
  log(`Finished: ${new Date().toISOString()}`);

  const outputPath = path.resolve(LOG_FILE);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");

  const summary = buildSummary();
  if (SUMMARY_FILE) {
    fs.writeFileSync(SUMMARY_FILE, summary, "utf8");
  }

  if (totals.repoFailed > 0 || totals.branchesFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  log(`FATAL: ${errorText(error)}`);
  const outputPath = path.resolve(LOG_FILE);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");
  if (SUMMARY_FILE) {
    fs.writeFileSync(SUMMARY_FILE, `# GitHub Fork Sync V2\n\n**Fatal error:** ${errorText(error)}\n`, "utf8");
  }
  process.exitCode = 1;
});
