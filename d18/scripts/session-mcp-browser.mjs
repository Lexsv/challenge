// Runs in the catalog browser test's disposable Chrome profile, API and SQLite database.
import assert from "node:assert/strict";

export async function verifySessionMcpSelection({
  api,
  db,
  command,
  evaluate,
  waitFor,
}) {
  const root = "http://127.0.0.1:" + api.address().port + "/api/week3/sessions";
  async function makeChat(title) {
    const response = await fetch(root, { method: "POST" });
    assert.equal(response.status, 201);
    const { id } = await response.json();
    const rename = await fetch(root + "/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    assert.equal(rename.status, 200);
    return id;
  }
  const first = await makeChat("Alpha chat");
  await makeChat("Beta chat");
  const writes = [];
  const observe = (req) => {
    if (req.method !== "GET") writes.push(req.method + " " + req.url);
  };
  api.on("request", observe);
  const group =
    "document.querySelector('#labs-chat-panel [aria-label=\"Session MCP connections\"]')";
  const add = group + ".querySelector('button')";
  const options =
    "[...document.querySelectorAll('[role=\"menuitemcheckbox\"]')]";
  const chips = group + ".querySelectorAll('.MuiChip-root')";
  async function click(expression) {
    await waitFor(
      () =>
        evaluate(
          `Boolean((el => el?.checkVisibility() && !el.disabled && el.getAttribute('aria-disabled') !== 'true')(${expression}))`,
        ),
      expression,
    );
    await evaluate(
      `(${expression}).dispatchEvent(new MouseEvent("click", {bubbles:true, cancelable:true, view:window}))`,
    );
  }
  const byId = (id) => "document.getElementById(" + JSON.stringify(id) + ")";
  async function selectChat(title) {
    await click(
      `[...document.querySelectorAll('#labs-chat-panel [aria-label="Session list"] [role="button"]')].find(el=>el.querySelector('[title='+CSS.escape(${JSON.stringify(title)})+']'))`,
    );
  }
  async function enterWeek4() {
    await click(byId("tab-lab"));
    await click(byId("labs-week4-tab"));
  }
  async function saved(expected) {
    await waitFor(
      () =>
        evaluate(
          `${group}?.getAttribute('aria-busy') === 'false' && JSON.stringify(Array.from(${chips},el=>el.textContent)) === ${JSON.stringify(JSON.stringify(expected))}`,
        ),
      "persisted chips " + expected.join(", "),
    );
  }
  const item = (name) =>
    options + ".find(el=>el.textContent===" + JSON.stringify(name) + ")";
  async function menu(expected) {
    await click(add);
    await waitFor(
      () =>
        evaluate(
          `${options}.length===2 && ${group}.getAttribute('aria-busy')==='false'`,
        ),
      "loaded MCP menu",
    );
    assert.deepEqual(
      await evaluate(
        options +
          ".map(el=>[el.textContent,el.getAttribute('aria-checked')==='true'])",
      ),
      expected,
    );
  }
  async function closeMenu() {
    await command("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await command("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await waitFor(
      () => evaluate(options + ".length===0"),
      "closed selection menu",
    );
  }

  try {
    await command("Page.reload", { ignoreCache: true });
    await enterWeek4();
    await selectChat("Alpha chat");
    await saved([]);
    assert.ok(
      await evaluate(
        `(() => {const g=${group}, header=g.previousElementSibling;return header.querySelector('h3').textContent==='Alpha chat' && header.getBoundingClientRect().bottom<=g.getBoundingClientRect().top;})()`,
      ),
    );
    await menu([
      ["Catalog fixture", false],
      ["Second fixture", false],
    ]);
    await click(item("Catalog fixture"));
    await saved(["Catalog fixture"]);
    await click(item("Second fixture"));
    await saved(["Catalog fixture", "Second fixture"]);
    await closeMenu();
    await menu([
      ["Catalog fixture", true],
      ["Second fixture", true],
    ]);
    await closeMenu();
    await click(group + ".querySelector('.MuiChip-deleteIcon')");
    await saved(["Second fixture"]);
    await selectChat("Beta chat");
    await saved([]);
    await selectChat("Alpha chat");
    await saved(["Second fixture"]);
    await click(byId("labs-week3-tab"));
    assert.equal(await evaluate("!!" + group), false);
    await click(byId("labs-week4-tab"));
    await saved(["Second fixture"]);
    await command("Page.reload", { ignoreCache: true });
    await enterWeek4();
    await saved(["Second fixture"]);
    db.exec(
      "CREATE TRIGGER fixture_fail_detach BEFORE DELETE ON session_mcp_connections BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    await click(group + ".querySelector('.MuiChip-deleteIcon')");
    await waitFor(
      () => evaluate(group + ".innerText.includes('Could not confirm')"),
      "save failure message",
    );
    await saved(["Second fixture"]);
    db.exec("DROP TRIGGER fixture_fail_detach");
    await menu([
      ["Catalog fixture", false],
      ["Second fixture", true],
    ]);
    await click(item("Second fixture"));
    await saved([]);
    await click(item("Catalog fixture"));
    await saved(["Catalog fixture"]);
    await closeMenu();
    assert.deepEqual(
      db
        .prepare("SELECT session_id FROM session_mcp_connections")
        .all()
        .map((r) => r.session_id),
      [first],
    );
    assert.ok(
      writes.every((path) =>
        /^(PUT|DELETE) \/api\/week4\/sessions\/[^/]+\/mcp-connections\/[^/]+$/.test(
          path,
        ),
      ),
      "Only session membership writes expected",
    );
    await click(byId("tab-tools"));
  } finally {
    api.off("request", observe);
  }
  console.log(
    "Week 4 selection, failure recovery, session switching, reload and Week 3 isolation verified",
  );
}
