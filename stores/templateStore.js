export function serializeTemplate(store, record) {
  const owner = store.resolveOwner(record.owner_id);
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    preview: record.preview,
    content: record.content,
    sourceDocumentId: record.source_document_id,
    ownerId: owner.id,
    ownerName: store.getDisplayName(owner),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function listDocumentTemplates(store, userId) {
  return store
    .getAll(`SELECT * FROM document_templates WHERE owner_id = ? ORDER BY updated_at DESC`, [userId])
    .map((record) => serializeTemplate(store, record));
}

export function createDocumentTemplate(store, documentId, payload, userId) {
  const source = store.getOne(`SELECT * FROM documents WHERE id = ?`, [documentId]);
  if (!source || source.owner_id !== userId) {
    return null;
  }

  const id = store.createId("tpl");
  const title = payload.title?.trim() || `${source.title} \u6a21\u677f`;
  const description =
    payload.description?.trim() || `\u57fa\u4e8e\u300a${source.title}\u300b\u4fdd\u5b58\u7684\u53ef\u590d\u7528\u6a21\u677f`;
  const template = {
    id,
    ownerId: userId,
    title,
    description,
    preview: store.normalizeTextPreview(source.content) || source.preview,
    content: source.content,
    sourceDocumentId: source.id,
    createdAt: store.now(),
    updatedAt: store.now(),
  };

  store.run(
    `INSERT INTO document_templates (
      id, owner_id, title, description, preview, content, source_document_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      template.id,
      template.ownerId,
      template.title,
      template.description,
      template.preview,
      template.content,
      template.sourceDocumentId,
      template.createdAt,
      template.updatedAt,
    ]
  );

  return serializeTemplate(store, {
    id: template.id,
    owner_id: template.ownerId,
    title: template.title,
    description: template.description,
    preview: template.preview,
    content: template.content,
    source_document_id: template.sourceDocumentId,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  });
}

export function createDocumentFromTemplate(store, templateId, payload, userId) {
  const template = store.getOne(`SELECT * FROM document_templates WHERE id = ? AND owner_id = ?`, [templateId, userId]);
  if (!template) {
    return null;
  }

  const documentTitle = payload.title?.trim() || `${template.title} \u6587\u6863`;

  return store.createDocument(
    {
      title: documentTitle,
      author: payload.author,
      content: template.content,
      visibility: "private",
    },
    userId
  );
}

export function deleteDocumentTemplate(store, id, userId) {
  const template = store.getOne(`SELECT id FROM document_templates WHERE id = ? AND owner_id = ?`, [id, userId]);
  if (!template) {
    return false;
  }

  store.run(`DELETE FROM document_templates WHERE id = ?`, [id]);
  return true;
}
