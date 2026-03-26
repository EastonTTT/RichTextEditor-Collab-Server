import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function createStore(testName) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `collabserver-${testName}-`));
  process.env.WORKSPACE_DATA_DIR = dataDir;

  const storageUrl = `${pathToFileURL(path.join(serverRoot, "storage.js")).href}?t=${Date.now()}-${Math.random()}`;
  const { LocalWorkspaceStore } = await import(storageUrl);
  const store = await LocalWorkspaceStore.create();

  return {
    dataDir,
    store,
    cleanup() {
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.WORKSPACE_DATA_DIR;
    },
  };
}

test("document version restore brings back content and room state", async () => {
  const fixture = await createStore("restore");
  try {
    const owner = fixture.store.createUser("alice", "pass1234").user;
    assert.ok(owner);

    const document = fixture.store.createDocument(
      {
        title: "Spec",
        content: "<p>first draft</p>",
      },
      owner.id
    );

    fixture.store.setRoomState(document.roomName, new Uint8Array([1, 2, 3, 4]));
    const baselineVersion = fixture.store.createDocumentVersion(
      document.id,
      { reason: "manual_snapshot", summary: "baseline" },
      owner.id
    );
    assert.equal(baselineVersion?.reason, "manual_snapshot");

    fixture.store.updateDocument(document.id, { content: "<p>second draft</p>" }, owner.id);
    fixture.store.setRoomState(document.roomName, new Uint8Array([7, 8, 9]));

    const restored = fixture.store.restoreDocumentVersion(baselineVersion.id, owner.id);
    assert.equal(restored?.content, "<p>first draft</p>");
    assert.deepEqual(Array.from(fixture.store.getRoomState(document.roomName) || []), [1, 2, 3, 4]);

    const versions = fixture.store.listDocumentVersions(document.id, owner.id) || [];
    assert.ok(versions.some((version) => version.reason === "restore_backup"));
    assert.ok(versions.some((version) => version.reason === "restore"));
  } finally {
    fixture.cleanup();
  }
});

test("autosave versions are trimmed to the latest retention window", async () => {
  const fixture = await createStore("autosave-trim");
  try {
    const owner = fixture.store.createUser("bob", "pass1234").user;
    assert.ok(owner);

    const document = fixture.store.createDocument(
      {
        title: "Roadmap",
        content: "<p>seed</p>",
      },
      owner.id
    );

    for (let index = 0; index < 25; index += 1) {
      fixture.store.updateDocument(document.id, { content: `<p>autosave-${index}</p>` }, owner.id);
      fixture.store.createDocumentVersion(
        document.id,
        { reason: "autosave", summary: `autosave-${index}` },
        owner.id
      );
    }

    const versions = fixture.store.listDocumentVersions(document.id, owner.id) || [];
    const autosaves = versions.filter((version) => version.reason === "autosave");
    assert.equal(autosaves.length, 20);
    assert.equal(autosaves[0]?.summary, "autosave-24");
    assert.equal(autosaves.at(-1)?.summary, "autosave-5");
  } finally {
    fixture.cleanup();
  }
});

test("autosave guard rejects tiny changes and immediate repeat snapshots", async () => {
  const fixture = await createStore("autosave-guard");
  try {
    const owner = fixture.store.createUser("carol", "pass1234").user;
    assert.ok(owner);

    const document = fixture.store.createDocument(
      {
        title: "Notes",
        content: "<p>short text</p>",
      },
      owner.id
    );

    assert.equal(
      fixture.store.shouldCreateAutosaveVersion(document.id, "<p>short text with one more word</p>", owner.id),
      false
    );

    const substantialContent = `<p>${"Long paragraph ".repeat(12)}</p>`;
    assert.equal(fixture.store.shouldCreateAutosaveVersion(document.id, substantialContent, owner.id), true);

    fixture.store.updateDocument(document.id, { content: substantialContent }, owner.id);
    fixture.store.createDocumentVersion(
      document.id,
      { reason: "autosave", summary: "substantial autosave" },
      owner.id
    );

    assert.equal(
      fixture.store.shouldCreateAutosaveVersion(document.id, `<p>${"Long paragraph ".repeat(12)}tail</p>`, owner.id),
      false
    );
  } finally {
    fixture.cleanup();
  }
});
