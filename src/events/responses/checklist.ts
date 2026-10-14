import type { EmitterWebhookEvent } from "@octokit/webhooks/types";
import { assertDefined } from "ts-extras";
import type { Client } from "../../client.ts";

type PullPayload = EmitterWebhookEvent<"pull_request">["payload"];
type PullRef = { owner: string; repo: string; number: number };
type ListedCommit = {
  sha: string;
  parents?: readonly unknown[];
  commit: { message: string };
};
type SyncPull = PullRef & {
  author: string | undefined;
  commitCount: number | undefined;
};

const refreshActions = new Set<string>([
  "opened",
  "synchronize",
  "ready_for_review",
  "reopened",
  "converted_to_draft",
]);

const genericAreas = new Set(["bug", "fix", "refactor"]);
const summaryLimit = 72;
const subjectPattern =
  /^(?<area>[0-9a-z]+(?:[\-\/_][0-9a-z]+)*(?: [0-9a-z]+(?:[\-\/_][0-9a-z]+)*)?): (?<summary>.+)$/v;
const sentencePattern = /^[A-Z].+\.$/v;
// A git trailer, or a line that only points at an issue, is not the
// description. A sentence that starts with "Fixes" and then explains
// the change still is.
const trailerKey =
  /^(?:signed-off-by|co-authored-by|acked-by|reviewed-by|helped-by|reported-by|tested-by|suggested-by|debugged-by):/iv;
const closingKeyword =
  /^(?:fix(?:e[ds])?|clos(?:e|es|ed)|resolv(?:e|es|ed))\b:?\s*/iv;
const issueReference =
  /^(?:#\d+|gh-\d+|[\w\-.]+(?:\/[\w\-.]+)+#\d+|https?:\/\/\S+)/iv;

const commitLabel =
  "Each commit uses an area prefix, a summary sentence, and a description.";
const commitGuide =
  "https://zulip.readthedocs.io/en/latest/contributing/commit-discipline.html#commit-messages";
const truncatedLine =
  "  - The commit list was truncated, so later commits were not checked.";

const refreshQueue = new Map<string, Promise<void>>();

function isEnabled(this: Client) {
  return this.cfg.checklist.commits;
}

function shouldRefresh(payload: PullPayload) {
  if (payload.pull_request.state === "closed") return false;
  // Retargeting the base changes the commits without a synchronize event.
  return (
    refreshActions.has(payload.action) ||
    (payload.action === "edited" && "base" in payload.changes)
  );
}

function listedCommitCount(payload: PullPayload) {
  const pullRequest = payload.pull_request;
  // A missing count cannot prove the list was short.
  return "commits" in pullRequest ? pullRequest.commits : undefined;
}

export const run = async function (this: Client, payload: PullPayload) {
  // A missing username hides the comment we post, so the next event
  // would post another one and email subscribers again.
  if (
    !isEnabled.call(this) ||
    this.cfg.auth.username === undefined ||
    this.cfg.auth.username.length === 0 ||
    !shouldRefresh(payload)
  ) {
    return;
  }

  await refresh.call(this, {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    number: payload.pull_request.number,
    author: payload.pull_request.user?.login,
    commitCount: listedCommitCount(payload),
  });
};

async function refresh(this: Client, pull: SyncPull) {
  // Two events for one pull request can be in flight together. The later
  // read has to win, or a stale snapshot is the last comment written.
  const key = `${pull.owner}/${pull.repo}#${pull.number}`;
  const previous = refreshQueue.get(key) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(async () => writeChecklist.call(this, pull));
  refreshQueue.set(key, queued);
  try {
    await queued;
  } finally {
    if (refreshQueue.get(key) === queued) refreshQueue.delete(key);
  }
}

async function writeChecklist(this: Client, pull: SyncPull) {
  await publish.call(
    this,
    pull,
    pull.author,
    commitBlock(await commitDetails.call(this, pull)),
  );
}

async function publish(
  this: Client,
  pull: PullRef,
  author: string | undefined,
  checks: string,
) {
  const template = this.templates.get("prChecklist");
  assertDefined(template);
  const comments = await template.getComments({
    owner: pull.owner,
    repo: pull.repo,
    issue_number: pull.number,
  });
  const [current, ...extra] = comments;
  // `checks` is substituted after `greeting`, so a commit subject that
  // contains `{greeting}` is left as the author wrote it.
  const fresh = template.format({
    greeting: author === undefined ? "Hello" : `@${author}`,
    checks,
  });
  // Keep the greeting line. Adding an @mention in an edit emails that person.
  const body =
    typeof current?.body === "string"
      ? keepGreeting(current.body, fresh)
      : fresh;

  if (current === undefined) {
    // Creating a comment emails subscribers. Later changes edit this one.
    await this.issues.createComment({
      owner: pull.owner,
      repo: pull.repo,
      issue_number: pull.number,
      body,
    });
  } else if (current.body?.trimEnd() !== body.trimEnd()) {
    await this.issues.updateComment({
      owner: pull.owner,
      repo: pull.repo,
      comment_id: current.id,
      body,
    });
  }

  for (const comment of extra) {
    await this.issues.deleteComment({
      owner: pull.owner,
      repo: pull.repo,
      comment_id: comment.id,
    });
  }
}

function keepGreeting(existing: string, next: string) {
  const [previousLine] = existing.split("\n", 1);
  const breakAt = next.indexOf("\n");
  // The greeting is the only @mention. An edit leaves that line alone,
  // so it cannot mention someone new.
  return breakAt === -1 || previousLine === undefined
    ? existing
    : `${previousLine}${next.slice(breakAt)}`;
}

function commitBlock(details: readonly string[]) {
  const mark = details.length === 0 ? "x" : " ";
  const guide = details.length === 0 ? [] : [`  See ${commitGuide}`];
  return [`- [${mark}] ${commitLabel}`, ...details, ...guide].join("\n");
}

async function commitDetails(this: Client, pull: SyncPull) {
  const lines: string[] = [];
  let hasCommit = false;
  let seen = 0;

  // Keep failures oldest-first so the list matches the pull request.
  for await (const response of this.paginate.iterator(this.pulls.listCommits, {
    owner: pull.owner,
    repo: pull.repo,
    pull_number: pull.number,
  })) {
    for (const commit of response.data) {
      seen += 1;
      if (isMerge(commit)) continue;
      hasCommit = true;
      const problem = commitProblem(commit.commit.message);
      if (problem === undefined) continue;
      lines.push(
        failureLine(commit.sha, firstLine(commit.commit.message), problem),
      );
    }
  }

  if (pull.commitCount !== undefined && seen < pull.commitCount) {
    lines.push(truncatedLine);
  }

  if (hasCommit || lines.length > 0) return lines;
  const note = seen > 0 ? "Every commit is a merge." : "No commits were found.";
  return [`  - ${note}`];
}

// A merge from the base branch is not an author commit.
function isMerge(commit: ListedCommit) {
  return commit.parents === undefined
    ? firstLine(commit.commit.message).startsWith("Merge ")
    : commit.parents.length > 1;
}

function failureLine(sha: string, subject: string, problem: string) {
  const shown = subject.replaceAll("`", "'");
  const id = sha.length === 0 ? "" : `\`${sha.slice(0, 7)}\` `;
  return `  - ${id}\`${shown}\` ${problem}.`;
}

function firstLine(message: string) {
  return message.replaceAll("\r\n", "\n").split("\n", 1)[0] ?? "";
}

function commitProblem(message: string) {
  const normalized = message.replaceAll("\r\n", "\n");
  const problems = subjectProblems(firstLine(normalized));
  const description = descriptionProblem(normalized);
  if (description !== undefined) problems.push(description);
  return problems.length === 0 ? undefined : needs(problems);
}

function subjectProblems(subject: string) {
  const problems: string[] = [];
  const parsed = parsedSubject(subject);
  if (parsed === undefined) {
    problems.push("an area prefix and a summary sentence");
  } else {
    if (parsed.lowercaseArea) problems.push("a lowercase area prefix");

    if (
      parsed.area
        .split(" ")
        .some((word) => genericAreas.has(word.toLowerCase()))
    ) {
      problems.push(`a specific area instead of \`${parsed.area}\``);
    }

    if (!sentencePattern.test(parsed.summary)) {
      problems.push("a summary sentence");
    }
  }

  if (subject.length > summaryLimit) {
    problems.push("a summary of at most 72 characters");
  }

  return problems;
}

function parsedSubject(subject: string) {
  const direct = readSubject(subject);
  if (direct !== undefined) return { ...direct, lowercaseArea: false };

  const separator = subject.indexOf(": ");
  if (separator <= 0) return undefined;
  const lowered = `${subject.slice(0, separator).toLowerCase()}${subject.slice(separator)}`;
  const retry = readSubject(lowered);
  if (retry === undefined) return undefined;
  return {
    area: subject.slice(0, separator),
    summary: retry.summary,
    lowercaseArea: true,
  };
}

function readSubject(subject: string) {
  const match = subjectPattern.exec(subject);
  if (match === null) return undefined;
  return {
    area: match.groups?.["area"] ?? "",
    summary: match.groups?.["summary"] ?? "",
  };
}

function descriptionProblem(message: string) {
  const lines = message.split("\n").slice(1);
  const prose = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !isIgnoredBodyLine(trimmed);
  });
  if (prose.length === 0) return "a description";
  return lines[0]?.trim() === ""
    ? undefined
    : "a blank line before the description";
}

function isIgnoredBodyLine(line: string) {
  return trailerKey.test(line) || isClosingReference(line);
}

function isClosingReference(line: string) {
  let rest = line.endsWith(".") ? line.slice(0, -1) : line;
  rest = eat(/^(?:[*\-]|\d+\.)\s+/v, rest) ?? rest;
  rest = eat(/^(?:partially|partly)\s+/iv, rest) ?? rest;
  const afterKeyword = eat(closingKeyword, rest);
  if (afterKeyword === undefined) return false;
  rest = eat(/^part of\s+/iv, afterKeyword) ?? afterKeyword;
  const afterReference = eat(issueReference, rest);
  if (afterReference === undefined) return false;
  rest = afterReference;

  while (rest.length > 0) {
    const separated = eat(/^(?:,\s*|\s+and\s+|\s+)/v, rest);
    if (separated === undefined) return false;
    const afterAnotherKeyword = eat(closingKeyword, separated) ?? separated;
    const afterPart =
      eat(/^part of\s+/iv, afterAnotherKeyword) ?? afterAnotherKeyword;
    const consumed = eat(issueReference, afterPart);
    if (consumed === undefined) return false;
    rest = consumed;
  }

  return true;
}

function eat(pattern: RegExp, value: string) {
  const match = pattern.exec(value);
  if (match?.index !== 0) return undefined;
  const [whole] = match;
  return value.slice(whole.length);
}

function needs(problems: readonly string[]) {
  const [first] = problems;
  assertDefined(first);
  if (problems.length === 1) return `needs ${first}`;
  const last = problems.at(-1);
  assertDefined(last);
  return `needs ${problems.slice(0, -1).join(", ")} and ${last}`;
}
