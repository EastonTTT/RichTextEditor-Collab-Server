// 处理评论线程标准化及持久化辅助逻辑。
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

function buildThreadExcerpt(content) {
  return `${content || ""}`.trim().replace(/\s+/g, " ").slice(0, 60);
}

// 读取文档评论线程前，先复用文档权限判断，确保无权用户拿不到评论内容。
export function getDocumentCommentThreads(store, id, userId) {
  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [id]);
  if (!store.canAccessDocumentRecord(record, userId)) {
    return null;
  }

  const result = store.getOne(`SELECT threads_json FROM document_comment_threads WHERE document_id = ?`, [id]);
  const parsed = store.safeJsonParse(result?.threads_json || "[]", []);
  return normalizeCommentThreads(parsed, store.now);
}

// 评论线程整体以 JSON 的形式存储在单独的表里，适合当前项目规模和结构。
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

export function deleteDocumentComment(store, id, threadId, commentId, userId) {
  const record = store.getOne(`SELECT * FROM documents WHERE id = ?`, [id]);
  if (!record) {
    return { status: "document_not_found" };
  }

  if (!store.canAccessDocumentRecord(record, userId)) {
    return { status: "document_not_found" };
  }

  if (record.owner_id !== userId) {
    return { status: "forbidden" };
  }

  const currentThreads = getDocumentCommentThreads(store, id, userId) || [];
  let removed = false;
  const updatedAt = store.now();
  const nextThreads = currentThreads
    .map((thread) => {
      if (thread.id !== threadId) {
        return thread;
      }

      const nextComments = thread.comments.filter((comment) => {
        const shouldKeep = comment.id !== commentId;
        if (!shouldKeep) {
          removed = true;
        }
        return shouldKeep;
      });

      if (nextComments.length === 0) {
        return null;
      }

      return {
        ...thread,
        excerpt: buildThreadExcerpt(nextComments[0]?.content || thread.excerpt),
        updatedAt,
        comments: nextComments,
      };
    })
    .filter(Boolean);

  if (!removed) {
    return { status: "comment_not_found" };
  }

  store.run(
    `INSERT INTO document_comment_threads (document_id, threads_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       threads_json = excluded.threads_json,
       updated_at = excluded.updated_at`,
    [id, JSON.stringify(nextThreads), updatedAt]
  );

  return {
    status: "ok",
    threads: nextThreads,
  };
}
