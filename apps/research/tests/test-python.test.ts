import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative as relative_ } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./ensure-built.js";
import { resolveTestPython, testEnv } from "./python.js";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));

async function fakeInterpreter(path: string, mode = 0o755) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, mode);
  return path;
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sourcesql-python-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("test-python prefers SOURCESQL_TEST_PYTHON over SOURCESQL_PYTHON over .venv", async () => {
  await withRoot(async (root) => {
    const first = await fakeInterpreter(join(root, "a/python"));
    const second = await fakeInterpreter(join(root, "b/python"));
    const venv = await fakeInterpreter(join(root, ".venv/bin/python"));
    assert.deepEqual(
      resolveTestPython(
        { SOURCESQL_TEST_PYTHON: first, SOURCESQL_PYTHON: second },
        root,
      ),
      { python: first },
    );
    assert.deepEqual(resolveTestPython({ SOURCESQL_PYTHON: second }, root), {
      python: second,
    });
    assert.deepEqual(resolveTestPython({}, root), { python: venv });
  });
});

test("test-python uses the uv-created .venv when no variable is set", async () => {
  await withRoot(async (root) => {
    const venv = await fakeInterpreter(join(root, ".venv/bin/python"));
    assert.deepEqual(resolveTestPython({ SOURCESQL_PYTHON: "" }, root), {
      python: venv,
    });
  });
});

test("test-python names every location and the fix when nothing is found", async () => {
  await withRoot(async (root) => {
    const result = resolveTestPython({}, root);
    assert.ok("message" in result);
    assert.match(result.message, /none was found/);
    assert.match(result.message, /SOURCESQL_TEST_PYTHON\s+\(not set\)/);
    assert.match(result.message, /SOURCESQL_PYTHON\s+\(not set\)/);
    assert.ok(
      result.message.includes(`${join(root, ".venv/bin/python")}  (missing)`),
    );
    assert.match(result.message, /`uv sync --frozen`/);
    assert.match(result.message, /SOURCESQL_PYTHON to the path/);
  });
});

test("test-python reports a set variable whose path is missing, without falling back", async () => {
  await withRoot(async (root) => {
    await fakeInterpreter(join(root, ".venv/bin/python"));
    const result = resolveTestPython(
      { SOURCESQL_PYTHON: "/nope/python" },
      root,
    );
    assert.ok("message" in result);
    assert.match(
      result.message,
      /SOURCESQL_PYTHON\s+\/nope\/python  \(missing\)/,
    );
    assert.match(result.message, /\(not checked\)/);
  });
});

test("test-python reports a non-executable interpreter", async () => {
  await withRoot(async (root) => {
    const plain = await fakeInterpreter(join(root, "plain/python"), 0o644);
    const result = resolveTestPython({ SOURCESQL_TEST_PYTHON: plain }, root);
    assert.ok("message" in result);
    assert.ok(result.message.includes(`${plain}  (not executable)`));
  });
});

test("preflight prints one message and exits 1 before any test runs", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/preflight.ts"],
    {
      cwd: appDirectory,
      env: { ...process.env, SOURCESQL_TEST_PYTHON: "/nonexistent/python" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.match(/none was found/g)?.length, 1);
  assert.match(result.stderr, /\/nonexistent\/python {2}\(missing\)/);
  assert.doesNotMatch(result.stderr, /ENOENT|\n\s+at /);
});

test("preflight is silent when the interpreter resolves", async () => {
  await withRoot(async (root) => {
    const python = await fakeInterpreter(join(root, "python"));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/preflight.ts"],
      {
        cwd: appDirectory,
        env: { ...process.env, SOURCESQL_TEST_PYTHON: python },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, "");
  });
});

test("no test or script falls back to the removed interpreter path", async () => {
  // Built from parts so this file does not match itself.
  const removed = ["local", "python312"].join("/");
  for (const directory of ["tests", "scripts"]) {
    for (const entry of await readdir(join(appDirectory, directory), {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const text = await readFile(
        join(appDirectory, directory, entry.name),
        "utf8",
      );
      assert.ok(
        !text.includes(removed),
        `${directory}/${entry.name} still uses ${removed}`,
      );
    }
  }
});

test("ensureBuilt builds once when dist is missing and passes the build status on", async () => {
  await withRoot(async (root) => {
    const logged: string[] = [];
    let builds = 0;
    const missing = join(root, "dist/research.html");
    assert.equal(
      ensureBuilt(
        missing,
        () => (builds++, 0),
        (line) => logged.push(line),
      ),
      0,
    );
    assert.equal(builds, 1);
    assert.match(
      logged.join("\n"),
      /dist\/research\.html is missing; running npm run build once/,
    );
    assert.equal(
      ensureBuilt(
        missing,
        () => 3,
        () => {},
      ),
      3,
    );
  });
});

test("ensureBuilt does nothing when dist already exists", async () => {
  await withRoot(async (root) => {
    const dist = join(root, "dist/research.html");
    await mkdir(join(root, "dist"));
    await writeFile(dist, "<html></html>");
    let builds = 0;
    assert.equal(
      ensureBuilt(
        dist,
        () => (builds++, 0),
        () => assert.fail("no message"),
      ),
      0,
    );
    assert.equal(builds, 0);
  });
});

test("a directory is not an interpreter, but a symlink to one is", async () => {
  await withRoot(async (root) => {
    const real = await fakeInterpreter(join(root, "real/python"));
    await symlink(real, join(root, "link"));
    assert.deepEqual(
      resolveTestPython({ SOURCESQL_TEST_PYTHON: join(root, "link") }, root),
      {
        python: join(root, "link"),
      },
    );
    const refused = resolveTestPython({ SOURCESQL_TEST_PYTHON: root }, root);
    assert.ok("message" in refused);
    assert.match(
      refused.message,
      /SOURCESQL_TEST_PYTHON +.*\(not executable\)/,
    );
  });
});

test("the environment handed to a real engine pins the interpreter the resolver chose", async () => {
  await withRoot(async (root) => {
    const first = await fakeInterpreter(join(root, "a/python"));
    const env = testEnv(
      {
        SOURCESQL_TEST_PYTHON: first,
        SOURCESQL_PYTHON: join(root, "missing"),
        KEEP: "1",
      },
      root,
    );
    assert.equal(env.SOURCESQL_PYTHON, first);
    assert.equal(env.KEEP, "1");
    assert.throws(
      () => testEnv({ SOURCESQL_PYTHON: join(root, "missing") }, root),
      /SOURCESQL_PYTHON +.*\(missing\)/,
    );
  });
});

test("a relative interpreter path is returned absolute, so a child started elsewhere finds it", async () => {
  await withRoot(async (root) => {
    const real = await fakeInterpreter(join(root, "env/bin/python"));
    const link = join(root, "env/bin/python-link");
    await symlink(real, link);
    const relative = relative_(process.cwd(), link);
    for (const variable of ["SOURCESQL_TEST_PYTHON", "SOURCESQL_PYTHON"]) {
      // The link is kept as the user named it: resolving it would pick another environment.
      const resolved = resolveTestPython({ [variable]: relative }, root);
      assert.ok("python" in resolved);
      assert.ok(isAbsolute(resolved.python));
      assert.equal(basename(resolved.python), "python-link");
      assert.equal(
        realpathSync.native(resolved.python),
        realpathSync.native(link),
      );
    }
    assert.ok(
      isAbsolute(
        testEnv({ SOURCESQL_PYTHON: relative }, root).SOURCESQL_PYTHON!,
      ),
    );
  });
});

test("a relative interpreter path through a symlinked directory and '..' keeps meaning what the OS says", async () => {
  await withRoot(async (root) => {
    // link/.. is the symlink target's parent, not root. Lexical cleanup would pick root/bin/python.
    const real = join(root, "real/inner");
    await fakeInterpreter(join(root, "real/bin/python"));
    await fakeInterpreter(join(root, "bin/python"));
    await mkdir(real, { recursive: true });
    await symlink(real, join(root, "link"));
    const unnormalized = `${relative_(process.cwd(), root)}/link/../bin/python`;
    const resolved = resolveTestPython(
      { SOURCESQL_PYTHON: unnormalized },
      root,
    );
    assert.ok("python" in resolved);
    assert.equal(
      realpathSync.native(resolved.python),
      realpathSync(join(root, "real/bin/python")),
    );
  });
});
