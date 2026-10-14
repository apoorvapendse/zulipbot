import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmitterWebhookEvent } from "@octokit/webhooks/types";
import nock from "nock";
import { partialMock } from "partial-mock";
import client from "../../../../src/client.ts";
import * as checklist from "../../../../src/events/responses/checklist.ts";

nock.disableNetConnect();

client.cfg.auth.username = "zulipbot";

const good =
  "compose: Fix the send button.\n\nThe button ignored the Enter key.";
const commitLabel =
  "Each commit uses an area prefix, a summary sentence, and a description.";

type PullAction = EmitterWebhookEvent<"pull_request">["payload"]["action"];
type CommitInput = {
  sha: string;
  message: string;
  parents?: readonly unknown[];
};

function payload(
  number: number,
  action: PullAction,
  pull: Record<string, unknown> = {},
  changes?: Record<string, unknown>,
): EmitterWebhookEvent<"pull_request">["payload"] {
  return partialMock({
    action,
    ...(changes !== undefined && { changes }),
    pull_request: {
      number,
      draft: false,
      state: "open",
      title: "compose: Fix the send button.",
      user: { login: "octocat" },
      body: null,
      ...pull,
    },
    repository: {
      owner: { login: "zulip" },
      name: "zulip",
    },
  });
}

function commitsReply(commits: readonly CommitInput[]) {
  return commits.map((commit) => ({
    sha: commit.sha,
    parents: commit.parents ?? [{}],
    commit: { message: commit.message },
  }));
}

async function postedFor(
  number: number,
  commits: readonly CommitInput[],
  pull: Record<string, unknown> = {},
) {
  let posted = "";
  const scope = nock("https://api.github.com")
    .get(`/repos/zulip/zulip/pulls/${number}/commits`)
    .reply(200, commitsReply(commits))
    .get(`/repos/zulip/zulip/issues/${number}/comments`)
    .reply(200, [])
    .post(
      `/repos/zulip/zulip/issues/${number}/comments`,
      (body: { body: string }) => {
        posted = body.body;
        return body.body.includes("<!-- prChecklist -->");
      },
    )
    .reply(201);

  await checklist.run.call(client, payload(number, "opened", pull));
  scope.done();
  return posted;
}

void test("checklist: Names the commit that misses the message structure", async () => {
  const body = await postedFor(801, [
    { sha: "a".repeat(40), message: "Fix all the bugs" },
  ]);

  assert.match(body, /- \[ \] Each commit uses an area prefix/v);
  assert.match(body, /`aaaaaaa` `Fix all the bugs` needs an area prefix/v);
  assert.match(body, /and a summary sentence and a description/v);
  assert.match(
    body,
    /https:\/\/zulip\.readthedocs\.io\/en\/latest\/contributing\/commit-discipline\.html#commit-messages/v,
  );
  assert.equal(body.includes("compose: Fix the send button."), false);
  assert.match(body, /<!-- prChecklist -->\s*$/v);
});

void test("checklist: Checks the box when every commit follows the structure", async () => {
  const body = await postedFor(802, [
    { sha: "b".repeat(40), message: good },
    {
      sha: "c".repeat(40),
      message:
        "left sidebar: Move the icons.\n\nThe icons overlapped the topic list.",
    },
  ]);

  assert.equal(body.includes(`- [x] ${commitLabel}`), true);
  assert.equal(body.includes("bbbbbbb"), false);
  assert.equal(body.includes("needs "), false);
  assert.equal(body.includes("commit-discipline.html"), false);
});

void test("checklist: Lists only the commit that still fails", async () => {
  const body = await postedFor(803, [
    { sha: "d".repeat(40), message: good },
    { sha: "e".repeat(40), message: "update foo" },
  ]);

  assert.match(body, /`eeeeeee` `update foo`/v);
  assert.equal(body.includes("ddddddd"), false);
});

void test("checklist: Reports each missing part of the commit message", async () => {
  const tooLong = `compose: ${"A".repeat(63)}.\n\nBecause the line was too long.`;
  const cases: Array<[string, RegExp]> = [
    [
      "fix: Fix the bug.\n\nThe button did nothing.",
      /specific area instead of `fix`/v,
    ],
    [
      "bug: Fix the bug.\n\nThe button did nothing.",
      /specific area instead of `bug`/v,
    ],
    [
      "refactor: Extract the helper.\n\nThe helper was copied.",
      /specific area instead of `refactor`/v,
    ],
    [
      "compose: fix the bug.\n\nThe button did nothing.",
      /needs a summary sentence/v,
    ],
    ["compose: Fix the bug\n\nThe button did nothing.", /summary sentence/v],
    [
      "compose: Fix the bug.\n\nFixes #12.",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\n\nFixes: #12.",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\n\nFix #123.",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\n\nFixes part of #1234.",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\n\nFixes #12 and #13.",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\n\nFixes #12, fixes #13.",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\n\n- Fixes #123.",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\n\nPartially fixes #1234.",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\n\nSigned-off-by: Ada <ada@example.com>",
      /`compose: Fix the bug\.` needs a description/v,
    ],
    [
      "compose: Fix the bug.\nThe button did nothing.",
      /blank line before the description/v,
    ],
    [
      "CSS: fix the color.\n\nThe swatch was wrong.",
      /lowercase area prefix and a summary sentence/v,
    ],
    [tooLong, /at most 72 characters/v],
  ];

  const misses: string[] = [];
  for (const [index, [message, pattern]] of cases.entries()) {
    const body = await postedFor(900 + index, [
      { sha: "f".repeat(40), message },
    ]);
    if (!pattern.test(body) || !body.includes("- [ ]")) {
      misses.push(`${message}\n${body}`);
    }
  }

  assert.deepEqual(misses, []);
});

void test("checklist: A sentence that starts with Fixes is a description", async () => {
  const fixes = await postedFor(870, [
    {
      sha: "9".repeat(40),
      message:
        "compose: Fix the bug.\n\nFixes the case where the Enter key did not send.",
    },
  ]);
  const closes = await postedFor(871, [
    {
      sha: "8".repeat(40),
      message:
        "compose: Fix the bug.\n\nCloses the popover after a successful send.",
    },
  ]);
  const explains = await postedFor(872, [
    {
      sha: "7".repeat(40),
      message:
        "compose: Fix the bug.\n\nFixes #12 and the related crash in the picker.",
    },
  ]);
  const continues = await postedFor(873, [
    {
      sha: "6".repeat(40),
      message:
        "compose: Fix the bug.\n\nClose zulip/zulip#123 in the type checker by teaching it about drafts.",
    },
  ]);

  assert.match(fixes, /- \[x\] Each commit uses an area prefix/v);
  assert.equal(fixes.includes("9999999"), false);
  assert.match(closes, /- \[x\] Each commit uses an area prefix/v);
  assert.equal(closes.includes("8888888"), false);
  assert.match(explains, /- \[x\] Each commit uses an area prefix/v);
  assert.equal(explains.includes("7777777"), false);
  assert.match(continues, /- \[x\] Each commit uses an area prefix/v);
  assert.equal(continues.includes("6666666"), false);
});

void test("checklist: Ignores a merge commit", async () => {
  const body = await postedFor(820, [
    {
      sha: "1".repeat(40),
      message: "Merge branch 'main' into send-button",
      parents: [{}, {}],
    },
    { sha: "2".repeat(40), message: good },
  ]);

  assert.match(body, /- \[x\]/v);
  assert.equal(body.includes("Merge branch"), false);
});

void test("checklist: Edits the same comment after a later push", async () => {
  let updated = "";
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/821/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/821/comments")
    .reply(200, [
      {
        id: 11,
        body: "old checklist\n\n<!-- prChecklist -->",
        user: { login: "zulipbot" },
      },
      {
        id: 12,
        body: "duplicate\n\n<!-- prChecklist -->",
        user: { login: "zulipbot" },
      },
    ])
    .patch(
      "/repos/zulip/zulip/issues/comments/11",
      (body: { body: string }) => {
        updated = body.body;
        return body.body.includes("- [x]");
      },
    )
    .reply(200)
    .delete("/repos/zulip/zulip/issues/comments/12")
    .reply(200);

  await checklist.run.call(
    client,
    payload(821, "synchronize", { draft: false, state: "open" }),
  );

  scope.done();
  assert.match(updated, /- \[x\] Each commit uses an area prefix/v);
  assert.match(updated, /<!-- prChecklist -->\s*$/v);
});

void test("checklist: Leaves an unchanged comment in place", async () => {
  const template = client.templates.get("prChecklist");
  assert.ok(template);
  const body = template.format({
    greeting: "@octocat",
    checks: `- [x] ${commitLabel}`,
  });
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/822/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/822/comments")
    .reply(200, [
      {
        id: 21,
        body,
        user: { login: "zulipbot" },
      },
    ]);

  await checklist.run.call(client, payload(822, "opened"));

  scope.done();
});

void test("checklist: Posts the checklist when a draft is opened", async () => {
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/823/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/823/comments")
    .reply(200, [])
    .post("/repos/zulip/zulip/issues/823/comments", (body: { body: string }) =>
      body.body.includes("<!-- prChecklist -->"),
    )
    .reply(201);

  await checklist.run.call(client, payload(823, "opened", { draft: true }));
  scope.done();
});

void test("checklist: Keeps the comment when a pull request becomes a draft", async () => {
  let updated = "";
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/824/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/824/comments")
    .reply(200, [
      {
        id: 31,
        body: "old\n\n<!-- prChecklist -->",
        user: { login: "zulipbot" },
      },
    ])
    .patch(
      "/repos/zulip/zulip/issues/comments/31",
      (body: { body: string }) => {
        updated = body.body;
        return true;
      },
    )
    .reply(200);

  await checklist.run.call(
    client,
    payload(824, "converted_to_draft", { draft: true }),
  );

  scope.done();
  assert.match(updated, /<!-- prChecklist -->/v);
});

void test("checklist: Posts when a draft is marked ready", async () => {
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/825/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/825/comments")
    .reply(200, [])
    .post("/repos/zulip/zulip/issues/825/comments", (body: { body: string }) =>
      body.body.includes("- [x]"),
    )
    .reply(201);

  await checklist.run.call(client, payload(825, "ready_for_review"));

  scope.done();
});

void test("checklist: An edit keeps the person already mentioned", async () => {
  let updated = "";
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/891/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/891/comments")
    .reply(200, [
      {
        id: 91,
        body: "@octocat, this checklist updates as the pull request changes.\n\nold\n\n<!-- prChecklist -->",
        user: { login: "zulipbot" },
      },
    ])
    .patch(
      "/repos/zulip/zulip/issues/comments/91",
      (body: { body: string }) => {
        updated = body.body;
        return true;
      },
    )
    .reply(200);

  await checklist.run.call(
    client,
    payload(891, "synchronize", { user: { login: "someoneelse" } }),
  );

  scope.done();
  assert.match(updated, /^@octocat,/v);
  assert.equal(updated.includes("@someoneelse"), false);
});

void test("checklist: An edit does not add a mention", async () => {
  let updated = "";
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/892/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/892/comments")
    .reply(200, [
      {
        id: 92,
        body: "Hello, this checklist updates as the pull request changes.\n\nold\n\n<!-- prChecklist -->",
        user: { login: "zulipbot" },
      },
    ])
    .patch(
      "/repos/zulip/zulip/issues/comments/92",
      (body: { body: string }) => {
        updated = body.body;
        return true;
      },
    )
    .reply(200);

  await checklist.run.call(
    client,
    payload(892, "synchronize", { user: { login: "someoneelse" } }),
  );

  scope.done();
  assert.match(updated, /^Hello,/v);
  assert.equal(updated.includes("@"), false);
});

void test("checklist: Keeps a named person inside the commit subject", async () => {
  const body = await postedFor(893, [
    {
      sha: "a".repeat(40),
      message: "Thanks @timabbott for the report",
    },
  ]);

  assert.match(body, /`Thanks @timabbott for the report`/v);
  assert.match(body, /^@octocat,/v);
});

void test("checklist: Does not post before it can recognize its own comment", async () => {
  const auth = { ...client.cfg.auth };
  delete auth.username;
  const isolated = Object.create(client) as typeof client;
  isolated.cfg = { ...client.cfg, auth };
  const scope = nock("https://api.github.com");
  await checklist.run.call(isolated, payload(889, "opened"));
  scope.done();
});

void test("checklist: Does not post when its username is blank", async () => {
  const isolated = Object.create(client) as typeof client;
  isolated.cfg = {
    ...client.cfg,
    auth: { ...client.cfg.auth, username: "" },
  };
  const scope = nock("https://api.github.com");
  await checklist.run.call(isolated, payload(894, "opened"));
  scope.done();
});

void test("checklist: Stays quiet when the checklist is off", async () => {
  const wasCheckingCommits = client.cfg.checklist.commits;
  client.cfg.checklist.commits = false;
  try {
    const scope = nock("https://api.github.com");
    await checklist.run.call(client, payload(826, "opened"));
    scope.done();
  } finally {
    client.cfg.checklist.commits = wasCheckingCommits;
  }
});

void test("checklist: A push to a closed pull request keeps the comment", async () => {
  const scope = nock("https://api.github.com");
  await checklist.run.call(
    client,
    payload(829, "synchronize", { state: "closed" }),
  );
  scope.done();
});

void test("checklist: Edits the same comment when a pull request is reopened", async () => {
  let updated = "";
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/883/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/883/comments")
    .reply(200, [
      {
        id: 83,
        body: "old\n\n<!-- prChecklist -->",
        user: { login: "zulipbot" },
      },
    ])
    .patch(
      "/repos/zulip/zulip/issues/comments/83",
      (body: { body: string }) => {
        updated = body.body;
        return true;
      },
    )
    .reply(200);

  await checklist.run.call(client, payload(883, "reopened"));

  scope.done();
  assert.match(updated, /<!-- prChecklist -->/v);
});

void test("checklist: Refreshes when the base branch changes", async () => {
  let updated = "";
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/882/commits")
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: "update foo" }]))
    .get("/repos/zulip/zulip/issues/882/comments")
    .reply(200, [
      {
        id: 91,
        body: "old\n\n<!-- prChecklist -->",
        user: { login: "zulipbot" },
      },
    ])
    .patch(
      "/repos/zulip/zulip/issues/comments/91",
      (body: { body: string }) => {
        updated = body.body;
        return true;
      },
    )
    .reply(200);

  await checklist.run.call(
    client,
    payload(
      882,
      "edited",
      {},
      { base: { ref: { from: "main" }, sha: { from: "abc" } } },
    ),
  );

  scope.done();
  assert.match(updated, /update foo/v);
});

void test("checklist: Asks for a lowercase area when the summary already fits", async () => {
  const body = await postedFor(885, [
    {
      sha: "c".repeat(40),
      message: "Compose: Fix the bug.\n\nThe button did nothing.",
    },
  ]);

  assert.match(
    body,
    /`Compose: Fix the bug\.` needs a lowercase area prefix\./v,
  );
});

void test("checklist: Accepts a slash in the area prefix", async () => {
  const body = await postedFor(886, [
    {
      sha: "d".repeat(40),
      message:
        "webhooks/github: Ignore unlabeled events.\n\nLabel deletion sends no name.",
    },
    {
      sha: "e".repeat(40),
      message:
        "importer/slack: Collapse extra whitespace.\n\nThread names kept blank lines.",
    },
  ]);

  assert.match(body, /- \[x\] Each commit uses an area prefix/v);
  assert.equal(body.includes("commit-discipline"), false);
});

void test("checklist: Leaves the box open when the commit list is truncated", async () => {
  const visible = await postedFor(
    880,
    [{ sha: "a".repeat(40), message: good }],
    { commits: 251 },
  );
  const failing = await postedFor(
    881,
    [{ sha: "b".repeat(40), message: "update foo" }],
    { commits: 3 },
  );

  assert.match(visible, /- \[ \] Each commit uses an area prefix/v);
  assert.match(visible, /commit list was truncated/v);
  assert.equal(visible.includes("aaaaaaa"), false);
  assert.match(visible, /commit-discipline\.html#commit-messages/v);
  assert.match(failing, /`bbbbbbb` `update foo`/v);
  assert.match(failing, /commit list was truncated/v);
});

void test("checklist: Says when every commit is a merge", async () => {
  const body = await postedFor(884, [
    {
      sha: "1".repeat(40),
      message: "Merge branch 'main' into send-button",
      parents: [{}, {}],
    },
  ]);

  assert.match(body, /- \[ \] Each commit uses an area prefix/v);
  assert.match(body, /Every commit is a merge/v);
  assert.equal(body.includes("No commits were found"), false);
});

void test("checklist: A title edit does not refresh the comment", async () => {
  const scope = nock("https://api.github.com");
  await checklist.run.call(
    client,
    payload(827, "edited", {}, { title: { from: "old" } }),
  );
  scope.done();
});

void test("checklist: A label event does not refresh the comment", async () => {
  const scope = nock("https://api.github.com");
  await checklist.run.call(client, payload(848, "labeled"));
  scope.done();
});

void test("checklist: A description edit does not refresh the comment", async () => {
  const scope = nock("https://api.github.com");
  await checklist.run.call(
    client,
    payload(847, "edited", {}, { body: { from: "old" } }),
  );
  scope.done();
});

void test("checklist: Overlapping refreshes publish the later read", async () => {
  let updated = "";
  const scope = nock("https://api.github.com")
    .get("/repos/zulip/zulip/pulls/850/commits")
    .delay(50)
    .reply(200, commitsReply([{ sha: "a".repeat(40), message: "update foo" }]))
    .get("/repos/zulip/zulip/issues/850/comments")
    .reply(200, [])
    .post("/repos/zulip/zulip/issues/850/comments", () => true)
    .reply(201)
    .get("/repos/zulip/zulip/pulls/850/commits")
    .reply(200, commitsReply([{ sha: "b".repeat(40), message: good }]))
    .get("/repos/zulip/zulip/issues/850/comments")
    .reply(200, [
      {
        id: 71,
        body: "first\n\n<!-- prChecklist -->",
        user: { login: "zulipbot" },
      },
    ])
    .patch(
      "/repos/zulip/zulip/issues/comments/71",
      (body: { body: string }) => {
        updated = body.body;
        return true;
      },
    )
    .reply(200);

  await Promise.all([
    checklist.run.call(client, payload(850, "opened")),
    checklist.run.call(client, payload(850, "synchronize")),
  ]);

  scope.done();
  assert.match(updated, /- \[x\] Each commit uses an area prefix/v);
  assert.equal(updated.includes("update foo"), false);
});

void test("checklist: Says when the pull request has no commits", async () => {
  const body = await postedFor(828, []);
  assert.match(body, /- \[ \] Each commit uses an area prefix/v);
  assert.match(body, /No commits were found/v);
  assert.match(body, /commit-discipline\.html#commit-messages/v);
});
