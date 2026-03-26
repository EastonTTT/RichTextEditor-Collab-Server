export function serializeDocumentVersion(store, record) {
  const createdBy = store.resolveOwner(record.created_by);
  const roomState =
    record.room_state instanceof Uint8Array
      ? record.room_state
      : record.room_state
        ? new Uint8Array(record.room_state)
        : null;

  return {
    id: record.id,
    documentId: record.document_id,
    versionNo: Number(record.version_no),
    title: record.title,
    content: record.content,
    roomState,
    reason: record.reason,
    summary: record.summary,
    createdById: createdBy.id,
    createdByName: createdBy.nickname || createdBy.name,
    createdAt: record.created_at,
  };
}

export function getDocumentVersionNumber(store, documentId) {
  const row = store.getOne(`SELECT COALESCE(MAX(version_no), 0) AS version_no FROM document_versions WHERE document_id = ?`, [
    documentId,
  ]);
  return Number(row?.version_no || 0) + 1;
}

export function getLatestDocumentVersion(store, documentId, reason = null) {
  const params = [documentId];
  let sql = `SELECT * FROM document_versions WHERE document_id = ?`;

  if (reason) {
    sql += ` AND reason = ?`;
    params.push(reason);
  }

  sql += ` ORDER BY version_no DESC, created_at DESC LIMIT 1`;
  return store.getOne(sql, params);
}

export function shouldCreateAutosaveVersion(store, documentId, nextContent, userId) {
  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [documentId]);
  if (!store.canAccessDocumentRecord(record, userId) || typeof nextContent !== "string") {
    return false;
  }

  const latestAutosave = getLatestDocumentVersion(store, documentId, store.AUTOSAVE_VERSION_REASON);
  if (latestAutosave?.created_at) {
    const elapsedMs = Date.now() - new Date(latestAutosave.created_at).getTime();
    if (!Number.isNaN(elapsedMs) && elapsedMs < store.AUTOSAVE_MIN_INTERVAL_MS) {
      return false;
    }
  }

  const baselineContent = latestAutosave?.content || record.content || "";
  return store.measureTextDelta(baselineContent, nextContent) >= store.AUTOSAVE_MIN_TEXT_DELTA;
}

export function trimDocumentVersions(store, documentId) {
  if (store.MAX_AUTOSAVE_VERSIONS_PER_DOCUMENT < 1) {
    return;
  }

  const autosaveVersions = store.getAll(
    `SELECT id FROM document_versions
     WHERE document_id = ? AND reason = ?
     ORDER BY version_no DESC, created_at DESC`,
    [documentId, store.AUTOSAVE_VERSION_REASON]
  );

  const staleVersions = autosaveVersions.slice(store.MAX_AUTOSAVE_VERSIONS_PER_DOCUMENT);
  if (staleVersions.length === 0) {
    return;
  }

  store.db.run("BEGIN");
  try {
    staleVersions.forEach((version) => {
      store.db.run(`DELETE FROM document_versions WHERE id = ?`, [version.id]);
    });
    store.db.run("COMMIT");
    store.persistDb();
  } catch (error) {
    store.db.run("ROLLBACK");
    throw error;
  }
}

export function createDocumentVersionFromRecord(store, record, payload = {}, userId) {
  if (!record || !store.canAccessDocumentRecord(record, userId)) {
    return null;
  }

  const version = {
    id: store.createId("ver"),
    documentId: record.id,
    versionNo: getDocumentVersionNumber(store, record.id),
    title: record.title,
    content: record.content,
    roomState: store.getRoomState(record.room_name),
    reason: `${payload.reason || "manual_save"}`.trim() || "manual_save",
    summary: `${payload.summary || ""}`.trim(),
    createdBy: userId,
    createdAt: store.now(),
  };

  store.run(
    `INSERT INTO document_versions (
      id, document_id, version_no, title, content, room_state, reason, summary, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      version.id,
      version.documentId,
      version.versionNo,
      version.title,
      version.content,
      version.roomState,
      version.reason,
      version.summary,
      version.createdBy,
      version.createdAt,
    ]
  );

  trimDocumentVersions(store, record.id);

  return serializeDocumentVersion(store, {
    id: version.id,
    document_id: version.documentId,
    version_no: version.versionNo,
    title: version.title,
    content: version.content,
    room_state: version.roomState,
    reason: version.reason,
    summary: version.summary,
    created_by: version.createdBy,
    created_at: version.createdAt,
  });
}

export function createDocumentVersion(store, documentId, payload = {}, userId) {
  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [documentId]);
  return createDocumentVersionFromRecord(store, record, payload, userId);
}

export function listDocumentVersions(store, documentId, userId) {
  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [documentId]);
  if (!store.canAccessDocumentRecord(record, userId)) {
    return null;
  }

  return store.getAll(
    `SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_no DESC, created_at DESC`,
    [documentId]
  ).map((version) => serializeDocumentVersion(store, version));
}

export function getDocumentVersion(store, versionId, userId) {
  const version = store.getOne(`SELECT * FROM document_versions WHERE id = ?`, [versionId]);
  if (!version) {
    return null;
  }

  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [version.document_id]);
  if (!store.canAccessDocumentRecord(record, userId)) {
    return null;
  }

  return serializeDocumentVersion(store, version);
}

export function restoreDocumentVersion(store, versionId, userId) {
  const version = store.getOne(`SELECT * FROM document_versions WHERE id = ?`, [versionId]);
  if (!version) {
    return null;
  }

  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [version.document_id]);
  if (!record || record.owner_id !== userId) {
    return null;
  }

  createDocumentVersionFromRecord(
    store,
    record,
    {
      reason: "restore_backup",
      summary: `Backup before restoring version v${version.version_no}`,
    },
    userId
  );

  const lastModifiedAt = store.now();
  const preview = store.normalizeTextPreview(version.content) || "Empty document";

  store.run(
    `UPDATE documents SET title = ?, content = ?, preview = ?, last_modified_at = ? WHERE id = ?`,
    [version.title, version.content, preview, lastModifiedAt, record.id]
  );
  store.setRoomState(
    record.room_name,
    version.room_state ? (version.room_state instanceof Uint8Array ? version.room_state : new Uint8Array(version.room_state)) : null
  );

  createDocumentVersion(
    store,
    record.id,
    {
      reason: "restore",
      summary: `Restored from version v${version.version_no}`,
    },
    userId
  );

  return store.getDocument(record.id, userId);
}
