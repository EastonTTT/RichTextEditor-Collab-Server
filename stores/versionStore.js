// 封装文档版本快照、恢复流程和保留策略。
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
    lastRestoredAt: record.last_restored_at || "",
  };
}

function insertDocumentVersion(store, version) {
  store.run(
    `INSERT INTO document_versions (
      id, document_id, version_no, title, content, room_state, reason, summary, created_by, created_at, last_restored_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      version.lastRestoredAt || "",
    ]
  );
}

// 下一个版本号按“当前最大版本号 + 1”计算，保证单文档内版本号递增。
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

// 自动保存的判定规则：
// 1. 用户对文档仍有访问权
// 2. 距离上次 autosave 已经过去足够久
// 3. 这次文本变化量达到阈值
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

// 自动保存版本会限制保留窗口，避免单篇文档无限累积历史快照。
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

// 基于当前文档记录创建一个完整版本快照。
// 除了 title/content，还会把 room_state 一起保存，方便后续完整恢复。
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
    lastRestoredAt: "",
  };

  insertDocumentVersion(store, version);

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
    last_restored_at: version.lastRestoredAt,
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
    `SELECT * FROM document_versions
     WHERE document_id = ?
     ORDER BY
       COALESCE(NULLIF(last_restored_at, ''), created_at) DESC,
       CASE WHEN NULLIF(last_restored_at, '') IS NOT NULL THEN 1 ELSE 0 END DESC,
       version_no DESC,
       created_at DESC`,
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

// 恢复版本时是否保存当前内容备份由调用方决定。
// 被恢复的目标版本不会复制出新的 restore 记录，而是通过 last_restored_at 提升排序。
export function restoreDocumentVersion(store, versionId, payload = {}, userId) {
  const version = store.getOne(`SELECT * FROM document_versions WHERE id = ?`, [versionId]);
  if (!version) {
    return null;
  }

  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [version.document_id]);
  if (!record || record.owner_id !== userId) {
    return null;
  }

  if (payload?.createBackup !== false) {
    const backupVersion = {
      id: store.createId("ver"),
      documentId: record.id,
      versionNo: getDocumentVersionNumber(store, record.id),
      title:
        typeof payload?.currentTitle === "string" && payload.currentTitle.trim() ? payload.currentTitle.trim() : record.title,
      content: typeof payload?.currentContent === "string" ? payload.currentContent : record.content,
      roomState: store.getRoomState(record.room_name),
      reason: "restore_backup",
      summary: `${payload?.backupSummary || `Backup before restoring version v${version.version_no}`}`.trim(),
      createdBy: userId,
      createdAt: store.now(),
      lastRestoredAt: "",
    };

    insertDocumentVersion(store, backupVersion);
    trimDocumentVersions(store, record.id);
  }

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

  store.run(`UPDATE document_versions SET last_restored_at = ? WHERE id = ?`, [lastModifiedAt, versionId]);

  return store.getDocument(record.id, userId);
}

// 删除版本只影响 document_versions 表中的单条快照记录。
// 为了避免协作者误删历史，当前仍然要求文档所有者本人执行。
export function deleteDocumentVersion(store, versionId, userId) {
  const version = store.getOne(`SELECT * FROM document_versions WHERE id = ?`, [versionId]);
  if (!version) {
    return null;
  }

  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [version.document_id]);
  if (!record || record.owner_id !== userId) {
    return null;
  }

  store.run(`DELETE FROM document_versions WHERE id = ?`, [versionId]);
  return true;
}
