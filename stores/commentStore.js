export function normalizeCommentThreads(value, now) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((thread) => {
      const comments = Array.isArray(thread?.comments)
        ? thread.comments
            .map((comment) => ({
              id: `${comment?.id || ""}`.trim(),
              authorId: `${comment?.authorId || ""}`.trim(),
              authorName: `${comment?.authorName || ""}`.trim() || "Unknown",
              content: `${comment?.content || ""}`.trim(),
              createdAt: `${comment?.createdAt || now()}`.trim() || now(),
            }))
            .filter((comment) => comment.id && comment.content)
        : [];

      const createdAt = `${thread?.createdAt || now()}`.trim() || now();
      const updatedAt = `${thread?.updatedAt || createdAt}`.trim() || createdAt;

      return {
        id: `${thread?.id || ""}`.trim(),
        excerpt: `${thread?.excerpt || ""}`.trim(),
        createdAt,
        updatedAt,
        comments,
      };
    })
    .filter((thread) => thread.id);
}

export function getDocumentCommentThreads(store, id, userId) {
  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [id]);
  if (!store.canAccessDocumentRecord(record, userId)) {
    return null;
  }

  const result = store.getOne(`SELECT threads_json FROM document_comment_threads WHERE document_id = ?`, [id]);
  const parsed = store.safeJsonParse(result?.threads_json || "[]", []);
  return normalizeCommentThreads(parsed, store.now);
}

export function setDocumentCommentThreads(store, id, threads, userId) {
  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [id]);
  if (!store.canAccessDocumentRecord(record, userId)) {
    return null;
  }

  const normalizedThreads = normalizeCommentThreads(threads, store.now);
  const updatedAt = store.now();
  store.run(
    `INSERT INTO document_comment_threads (document_id, threads_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       threads_json = excluded.threads_json,
       updated_at = excluded.updated_at`,
    [id, JSON.stringify(normalizedThreads), updatedAt]
  );

  return normalizedThreads;
}
