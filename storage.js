import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import * as Y from "yjs";

const DATA_DIR = path.join(process.cwd(), "data");
const ROOMS_DIR = path.join(DATA_DIR, "rooms");
const METADATA_FILE = path.join(DATA_DIR, "metadata.json");
const DB_FILE = path.join(DATA_DIR, "workspace.sqlite");
const ROOM_WRITE_DEBOUNCE_MS = 300;
const RESOURCE_KIND_DOCUMENT = "document";
const RESOURCE_KIND_KNOWLEDGE = "knowledgeBase";
const DEFAULT_DOCUMENT_CONTENT = "<h1>Welcome</h1><p>Start writing here...</p>";
const DEFAULT_KNOWLEDGE_CONTENT =
  "<h1>Knowledge Note</h1><p>Capture reusable notes, links, and references here.</p>";

function ensureStorage() {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });

  if (!fs.existsSync(METADATA_FILE)) {
    fs.writeFileSync(
      METADATA_FILE,
      JSON.stringify(
        {
          version: 1,
          users: {},
          documents: {},
          knowledgeBases: {},
          recent: {},
        },
        null,
        2
      )
    );
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeTextPreview(value) {
  return `${value}`.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function normalizeVisibility(value) {
  return value === "shared" ? "shared" : "private";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeRoomFileName(roomName) {
  return encodeURIComponent(roomName).replace(/%/g, "_");
}

function decodeRoomFileName(fileName) {
  const stem = fileName.replace(/\.bin$/, "");
  return decodeURIComponent(stem.replace(/_/g, "%"));
}

function readStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => `${item}`.trim()).filter(Boolean)
    : [];
}

function jsonArray(value) {
  return JSON.stringify(readStringArray(value));
}

export class LocalWorkspaceStore {
  static async create() {
    ensureStorage();

    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
    });

    const db = fs.existsSync(DB_FILE)
      ? new SQL.Database(fs.readFileSync(DB_FILE))
      : new SQL.Database();

    const store = new LocalWorkspaceStore(SQL, db);
    store.initializeSchema();

    if (!fs.existsSync(DB_FILE)) {
      store.migrateFromLegacyFiles();
      store.persistDb();
    }

    return store;
  }

  constructor(SQL, db) {
    this.SQL = SQL;
    this.db = db;
    this.roomTimers = new Map();
  }

  initializeSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        last_modified_at TEXT NOT NULL,
        preview TEXT NOT NULL,
        visibility TEXT NOT NULL,
        room_name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        related_document_ids_json TEXT NOT NULL,
        related_knowledge_base_ids_json TEXT NOT NULL,
        last_modified_at TEXT NOT NULL,
        preview TEXT NOT NULL,
        visibility TEXT NOT NULL,
        room_name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recent_items (
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        title TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        PRIMARY KEY (user_id, kind, resource_id)
      );

      CREATE TABLE IF NOT EXISTS document_permissions (
        document_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (document_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS document_templates (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        preview TEXT NOT NULL,
        content TEXT NOT NULL,
        source_document_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_states (
        room_name TEXT PRIMARY KEY,
        state BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  persistDb() {
    fs.writeFileSync(DB_FILE, Buffer.from(this.db.export()));
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    this.persistDb();
  }

  getOne(sql, params = []) {
    const result = this.db.exec(sql, params)[0];
    if (!result || result.values.length === 0) {
      return null;
    }

    return Object.fromEntries(result.columns.map((column, index) => [column, result.values[0][index]]));
  }

  getAll(sql, params = []) {
    const result = this.db.exec(sql, params)[0];
    if (!result) {
      return [];
    }

    return result.values.map((row) =>
      Object.fromEntries(result.columns.map((column, index) => [column, row[index]]))
    );
  }

  listUsers(userId) {
    return this.getAll(`SELECT id, name, color FROM users WHERE id != ? ORDER BY lower(name) ASC`, [userId]).map((user) =>
      this.serializeUser(user)
    );
  }

  getDocumentPermissionUsers(documentId) {
    return this.getAll(
      `SELECT users.id, users.name, users.color
       FROM document_permissions
       JOIN users ON users.id = document_permissions.user_id
       WHERE document_permissions.document_id = ?
       ORDER BY lower(users.name) ASC`,
      [documentId]
    ).map((user) => this.serializeUser(user));
  }

  syncDocumentPermissions(documentId, userIds = []) {
    const uniqueUserIds = Array.from(new Set(readStringArray(userIds)));

    this.db.run(`DELETE FROM document_permissions WHERE document_id = ?`, [documentId]);
    uniqueUserIds.forEach((userId) => {
      this.db.run(
        `INSERT OR REPLACE INTO document_permissions (document_id, user_id, created_at) VALUES (?, ?, ?)`,
        [documentId, userId, now()]
      );
    });
  }

  canAccessDocumentRecord(record, userId) {
    if (!record) {
      return false;
    }

    if (record.owner_id === userId) {
      return true;
    }

    if (record.visibility !== "shared") {
      return false;
    }

    return Boolean(
      this.getOne(`SELECT user_id FROM document_permissions WHERE document_id = ? AND user_id = ?`, [record.id, userId])
    );
  }

  migrateFromLegacyFiles() {
    const metadata = readJsonFile(METADATA_FILE, {
      users: {},
      documents: {},
      knowledgeBases: {},
      recent: {},
    });

    this.db.run("BEGIN");
    try {
      Object.values(metadata.users || {}).forEach((user) => {
        this.db.run(
          `INSERT OR REPLACE INTO users (id, name, password, color, created_at) VALUES (?, ?, ?, ?, ?)` ,
          [user.id, user.name, user.password || "pass1234", user.color || "#1677ff", user.createdAt || now()]
        );
      });

      Object.values(metadata.documents || {}).forEach((document) => {
        this.db.run(
          `INSERT OR REPLACE INTO documents (id, owner_id, title, author, last_modified_at, preview, visibility, room_name, content)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            document.id,
            document.ownerId,
            document.title,
            document.author,
            document.lastModifiedAt,
            document.preview,
            normalizeVisibility(document.visibility),
            document.roomName || `document:${document.id}`,
            document.content || DEFAULT_DOCUMENT_CONTENT,
          ]
        );
      });

      Object.values(metadata.knowledgeBases || {}).forEach((knowledgeBase) => {
        this.db.run(
          `INSERT OR REPLACE INTO knowledge_bases (
            id, owner_id, title, author, description, tags_json, related_document_ids_json,
            related_knowledge_base_ids_json, last_modified_at, preview, visibility, room_name, content
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            knowledgeBase.id,
            knowledgeBase.ownerId,
            knowledgeBase.title,
            knowledgeBase.author,
            knowledgeBase.description || "",
            jsonArray(knowledgeBase.tags),
            jsonArray(knowledgeBase.relatedDocumentIds),
            jsonArray(knowledgeBase.relatedKnowledgeBaseIds),
            knowledgeBase.lastModifiedAt,
            knowledgeBase.preview,
            normalizeVisibility(knowledgeBase.visibility),
            knowledgeBase.roomName || `knowledge:${knowledgeBase.id}`,
            knowledgeBase.content || DEFAULT_KNOWLEDGE_CONTENT,
          ]
        );
      });

      Object.entries(metadata.recent || {}).forEach(([userId, bucket]) => {
        const documentItems = Array.isArray(bucket.documents) ? bucket.documents : [];
        const knowledgeItems = Array.isArray(bucket.knowledgeBases) ? bucket.knowledgeBases : [];

        documentItems.forEach((item, index) => {
          this.db.run(
            `INSERT OR REPLACE INTO recent_items (user_id, kind, resource_id, title, opened_at) VALUES (?, ?, ?, ?, ?)`,
            [userId, RESOURCE_KIND_DOCUMENT, item.id, item.title, new Date(Date.now() - index).toISOString()]
          );
        });

        knowledgeItems.forEach((item, index) => {
          this.db.run(
            `INSERT OR REPLACE INTO recent_items (user_id, kind, resource_id, title, opened_at) VALUES (?, ?, ?, ?, ?)`,
            [userId, RESOURCE_KIND_KNOWLEDGE, item.id, item.title, new Date(Date.now() - index).toISOString()]
          );
        });
      });

      if (fs.existsSync(ROOMS_DIR)) {
        fs.readdirSync(ROOMS_DIR)
          .filter((file) => file.endsWith('.bin'))
          .forEach((file) => {
            const roomName = decodeRoomFileName(file);
            const state = fs.readFileSync(path.join(ROOMS_DIR, file));
            this.db.run(
              `INSERT OR REPLACE INTO room_states (room_name, state, updated_at) VALUES (?, ?, ?)`,
              [roomName, state, now()]
            );
          });
      }

      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  serializeUser(user) {
    return {
      id: user.id,
      name: user.name,
      color: user.color,
    };
  }

  resolveOwner(ownerId) {
    return this.getUserById(ownerId) || {
      id: ownerId,
      name: "Unknown",
      color: "#1677ff",
    };
  }

  createUser(name, password) {
    const normalizedName = `${name}`.trim();
    const existing = this.getOne(`SELECT id, name, color FROM users WHERE lower(name) = lower(?)`, [normalizedName]);
    if (existing) {
      return { error: "User already exists", user: null };
    }

    const id = createId("user");
    const palette = ["#1677ff", "#ef4444", "#0f766e", "#ca8a04", "#7c3aed", "#db2777"];
    const count = this.getOne(`SELECT COUNT(*) AS count FROM users`)?.count || 0;
    const user = {
      id,
      name: normalizedName,
      password,
      color: palette[Number(count) % palette.length],
      createdAt: now(),
    };

    this.run(
      `INSERT INTO users (id, name, password, color, created_at) VALUES (?, ?, ?, ?, ?)`,
      [user.id, user.name, user.password, user.color, user.createdAt]
    );

    return { error: null, user: this.serializeUser(user) };
  }

  loginUser(name, password) {
    const user = this.getOne(`SELECT * FROM users WHERE lower(name) = lower(?)`, [`${name}`.trim()]);
    if (!user || user.password !== password) {
      return null;
    }

    return this.serializeUser(user);
  }

  getUserById(id) {
    const user = this.getOne(`SELECT id, name, color FROM users WHERE id = ?`, [id]);
    return user ? this.serializeUser(user) : null;
  }

  serializeDocument(record) {
    const owner = this.resolveOwner(record.owner_id);
    const sharedWithUsers = this.getDocumentPermissionUsers(record.id);
    return {
      id: record.id,
      title: record.title,
      author: record.author,
      ownerId: owner.id,
      ownerName: owner.name,
      sharedWithUserIds: sharedWithUsers.map((user) => user.id),
      sharedWithUsers,
      lastModifiedAt: record.last_modified_at,
      preview: record.preview,
      visibility: record.visibility,
      roomName: record.room_name,
      content: record.content,
    };
  }

  serializeKnowledgeBase(record) {
    const owner = this.resolveOwner(record.owner_id);
    return {
      id: record.id,
      title: record.title,
      author: record.author,
      ownerId: owner.id,
      ownerName: owner.name,
      description: record.description,
      tags: JSON.parse(record.tags_json || "[]"),
      relatedDocumentIds: JSON.parse(record.related_document_ids_json || "[]"),
      relatedKnowledgeBaseIds: JSON.parse(record.related_knowledge_base_ids_json || "[]"),
      lastModifiedAt: record.last_modified_at,
      preview: record.preview,
      visibility: record.visibility,
      roomName: record.room_name,
      content: record.content,
    };
  }

  listDocuments(userId) {
    return this.getAll(
      `SELECT * FROM documents
       WHERE owner_id = ?
          OR (
            visibility = 'shared'
            AND id IN (SELECT document_id FROM document_permissions WHERE user_id = ?)
          )
       ORDER BY last_modified_at DESC`,
      [userId, userId]
    ).map((record) => this.serializeDocument(record));
  }

  getDocument(id, userId) {
    const record = this.getOne(`SELECT * FROM documents WHERE id = ?`, [id]);
    return this.canAccessDocumentRecord(record, userId) ? this.serializeDocument(record) : null;
  }

  createDocument(payload, userId) {
    const createdAt = now();
    const id = createId("doc");
    const title = payload.title?.trim() || "Untitled Document";
    const content = payload.content || DEFAULT_DOCUMENT_CONTENT;
    const record = {
      id,
      ownerId: userId,
      title,
      author: payload.author?.trim() || "Guest",
      lastModifiedAt: createdAt,
      preview: normalizeTextPreview(content) || "New document",
      visibility: normalizeVisibility(payload.visibility),
      roomName: `document:${id}`,
      content,
    };

    this.run(
      `INSERT INTO documents (id, owner_id, title, author, last_modified_at, preview, visibility, room_name, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.ownerId, record.title, record.author, record.lastModifiedAt, record.preview, record.visibility, record.roomName, record.content]
    );

    if (record.visibility === "shared") {
      this.db.run("BEGIN");
      try {
        this.syncDocumentPermissions(record.id, payload.sharedWithUserIds);
        this.db.run("COMMIT");
        this.persistDb();
      } catch (error) {
        this.db.run("ROLLBACK");
        throw error;
      }
    }

    return this.getDocument(record.id, userId);
  }

  updateDocument(id, payload, userId) {
    const existing = this.getOne(`SELECT * FROM documents WHERE id = ?`, [id]);
    if (!this.canAccessDocumentRecord(existing, userId)) {
      return null;
    }

    const isOwner = existing.owner_id === userId;
    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : existing.title;
    const author = typeof payload.author === 'string' && payload.author.trim() ? payload.author.trim() : existing.author;
    const content = typeof payload.content === 'string' ? payload.content : existing.content;
    const preview = typeof payload.content === 'string' ? normalizeTextPreview(payload.content) || 'Empty document' : existing.preview;
    const visibility = isOwner && payload.visibility ? normalizeVisibility(payload.visibility) : existing.visibility;
    const lastModifiedAt = now();

    this.run(
      `UPDATE documents SET title = ?, author = ?, content = ?, preview = ?, visibility = ?, last_modified_at = ? WHERE id = ?`,
      [title, author, content, preview, visibility, lastModifiedAt, id]
    );

    if (isOwner && Array.isArray(payload.sharedWithUserIds)) {
      this.db.run("BEGIN");
      try {
        this.syncDocumentPermissions(id, visibility === "shared" ? payload.sharedWithUserIds : []);
        this.db.run("COMMIT");
        this.persistDb();
      } catch (error) {
        this.db.run("ROLLBACK");
        throw error;
      }
    } else if (visibility !== "shared") {
      this.db.run(`DELETE FROM document_permissions WHERE document_id = ?`, [id]);
      this.persistDb();
    }

    if (visibility !== existing.visibility) {
      this.clearRoomState(existing.room_name);
    }

    return this.serializeDocument({
      ...existing,
      title,
      author,
      content,
      preview,
      visibility,
      last_modified_at: lastModifiedAt,
    });
  }

  deleteDocument(id, userId) {
    const record = this.getOne(`SELECT * FROM documents WHERE id = ?`, [id]);
    if (!record || record.owner_id !== userId) {
      return false;
    }

    this.db.run('BEGIN');
    try {
      this.db.run(`DELETE FROM documents WHERE id = ?`, [id]);
      this.db.run(`DELETE FROM recent_items WHERE kind = ? AND resource_id = ?`, [RESOURCE_KIND_DOCUMENT, id]);
      this.db.run(`DELETE FROM document_permissions WHERE document_id = ?`, [id]);
      this.db.run(`DELETE FROM room_states WHERE room_name = ?`, [record.room_name]);
      this.db.run('COMMIT');
      this.persistDb();
      return true;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  duplicateDocument(id, payload, userId) {
    const source = this.getOne(`SELECT * FROM documents WHERE id = ?`, [id]);
    if (!this.canAccessDocumentRecord(source, userId)) {
      return null;
    }

    return this.createDocument({
      author: payload.author || source.author,
      title: payload.title?.trim() || `${source.title} Copy`,
      visibility: source.visibility,
      sharedWithUserIds: source.owner_id === userId ? this.getDocumentPermissionUsers(id).map((user) => user.id) : [],
      content: source.content,
    }, userId);
  }

  serializeTemplate(record) {
    const owner = this.resolveOwner(record.owner_id);
    return {
      id: record.id,
      title: record.title,
      description: record.description,
      preview: record.preview,
      content: record.content,
      sourceDocumentId: record.source_document_id,
      ownerId: owner.id,
      ownerName: owner.name,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  listDocumentTemplates(userId) {
    return this.getAll(
      `SELECT * FROM document_templates WHERE owner_id = ? ORDER BY updated_at DESC`,
      [userId]
    ).map((record) => this.serializeTemplate(record));
  }

  createDocumentTemplate(documentId, payload, userId) {
    const source = this.getOne(`SELECT * FROM documents WHERE id = ?`, [documentId]);
    if (!source || source.owner_id !== userId) {
      return null;
    }

    const id = createId("tpl");
    const template = {
      id,
      ownerId: userId,
      title: payload.title?.trim() || `${source.title} 模板`,
      description: payload.description?.trim() || `基于《${source.title}》保存的模板`,
      preview: normalizeTextPreview(source.content) || source.preview,
      content: source.content,
      sourceDocumentId: source.id,
      createdAt: now(),
      updatedAt: now(),
    };

    this.run(
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

    return this.serializeTemplate({
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

  createDocumentFromTemplate(templateId, payload, userId) {
    const template = this.getOne(`SELECT * FROM document_templates WHERE id = ? AND owner_id = ?`, [templateId, userId]);
    if (!template) {
      return null;
    }

    return this.createDocument(
      {
        title: payload.title?.trim() || `${template.title} 文档`,
        author: payload.author,
        content: template.content,
        visibility: "private",
      },
      userId
    );
  }

  deleteDocumentTemplate(id, userId) {
    const template = this.getOne(`SELECT id FROM document_templates WHERE id = ? AND owner_id = ?`, [id, userId]);
    if (!template) {
      return false;
    }

    this.run(`DELETE FROM document_templates WHERE id = ?`, [id]);
    return true;
  }

  listKnowledgeBases(userId) {
    return this.getAll(
      `SELECT * FROM knowledge_bases WHERE owner_id = ? OR visibility = 'shared' ORDER BY last_modified_at DESC`,
      [userId]
    ).map((record) => this.serializeKnowledgeBase(record));
  }

  getKnowledgeBase(id, userId) {
    const record = this.getOne(
      `SELECT * FROM knowledge_bases WHERE id = ? AND (owner_id = ? OR visibility = 'shared')`,
      [id, userId]
    );
    return record ? this.serializeKnowledgeBase(record) : null;
  }

  createKnowledgeBase(payload, userId) {
    const createdAt = now();
    const id = createId('kb');
    const title = payload.title?.trim() || 'Untitled Knowledge Note';
    const description = payload.description?.trim() || 'Reusable note for your local knowledge base.';
    const content = payload.content || DEFAULT_KNOWLEDGE_CONTENT;
    const record = {
      id,
      ownerId: userId,
      title,
      author: payload.author?.trim() || 'Guest',
      description,
      tags: readStringArray(payload.tags).slice(0, 12),
      relatedDocumentIds: readStringArray(payload.relatedDocumentIds),
      relatedKnowledgeBaseIds: readStringArray(payload.relatedKnowledgeBaseIds).filter((relatedId) => relatedId !== id),
      lastModifiedAt: createdAt,
      preview: normalizeTextPreview(content) || description,
      visibility: normalizeVisibility(payload.visibility),
      roomName: `knowledge:${id}`,
      content,
    };

    this.run(
      `INSERT INTO knowledge_bases (
        id, owner_id, title, author, description, tags_json, related_document_ids_json,
        related_knowledge_base_ids_json, last_modified_at, preview, visibility, room_name, content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.title,
        record.author,
        record.description,
        JSON.stringify(record.tags),
        JSON.stringify(record.relatedDocumentIds),
        JSON.stringify(record.relatedKnowledgeBaseIds),
        record.lastModifiedAt,
        record.preview,
        record.visibility,
        record.roomName,
        record.content,
      ]
    );

    return this.getKnowledgeBase(record.id, userId);
  }

  updateKnowledgeBase(id, payload, userId) {
    const existing = this.getOne(`SELECT * FROM knowledge_bases WHERE id = ?`, [id]);
    if (!existing || (existing.owner_id !== userId && existing.visibility !== 'shared')) {
      return null;
    }

    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : existing.title;
    const author = typeof payload.author === 'string' && payload.author.trim() ? payload.author.trim() : existing.author;
    const description = typeof payload.description === 'string' ? payload.description.trim() || existing.description : existing.description;
    const tags = Array.isArray(payload.tags) ? readStringArray(payload.tags).slice(0, 12) : JSON.parse(existing.tags_json || '[]');
    const relatedDocumentIds = Array.isArray(payload.relatedDocumentIds)
      ? readStringArray(payload.relatedDocumentIds)
      : JSON.parse(existing.related_document_ids_json || '[]');
    const relatedKnowledgeBaseIds = Array.isArray(payload.relatedKnowledgeBaseIds)
      ? readStringArray(payload.relatedKnowledgeBaseIds).filter((relatedId) => relatedId !== id)
      : JSON.parse(existing.related_knowledge_base_ids_json || '[]');
    const content = typeof payload.content === 'string' ? payload.content : existing.content;
    const preview = typeof payload.content === 'string' ? normalizeTextPreview(payload.content) || description : existing.preview;
    const visibility = payload.visibility ? normalizeVisibility(payload.visibility) : existing.visibility;
    const lastModifiedAt = now();

    this.run(
      `UPDATE knowledge_bases SET
         title = ?, author = ?, description = ?, tags_json = ?, related_document_ids_json = ?,
         related_knowledge_base_ids_json = ?, content = ?, preview = ?, visibility = ?, last_modified_at = ?
       WHERE id = ?`,
      [
        title,
        author,
        description,
        JSON.stringify(tags),
        JSON.stringify(relatedDocumentIds),
        JSON.stringify(relatedKnowledgeBaseIds),
        content,
        preview,
        visibility,
        lastModifiedAt,
        id,
      ]
    );

    return this.serializeKnowledgeBase({
      ...existing,
      title,
      author,
      description,
      tags_json: JSON.stringify(tags),
      related_document_ids_json: JSON.stringify(relatedDocumentIds),
      related_knowledge_base_ids_json: JSON.stringify(relatedKnowledgeBaseIds),
      content,
      preview,
      visibility,
      last_modified_at: lastModifiedAt,
    });
  }

  deleteKnowledgeBase(id, userId) {
    const record = this.getOne(`SELECT * FROM knowledge_bases WHERE id = ?`, [id]);
    if (!record || record.owner_id !== userId) {
      return false;
    }

    this.db.run('BEGIN');
    try {
      this.db.run(`DELETE FROM knowledge_bases WHERE id = ?`, [id]);
      this.db.run(`DELETE FROM recent_items WHERE kind = ? AND resource_id = ?`, [RESOURCE_KIND_KNOWLEDGE, id]);
      this.db.run(`DELETE FROM room_states WHERE room_name = ?`, [record.room_name]);
      this.db.run('COMMIT');
      this.persistDb();
      return true;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  duplicateKnowledgeBase(id, payload, userId) {
    const source = this.getOne(`SELECT * FROM knowledge_bases WHERE id = ?`, [id]);
    if (!source || (source.owner_id !== userId && source.visibility !== 'shared')) {
      return null;
    }

    return this.createKnowledgeBase({
      author: payload.author || source.author,
      title: payload.title?.trim() || `${source.title} Copy`,
      description: payload.description || source.description,
      tags: payload.tags || JSON.parse(source.tags_json || '[]'),
      relatedDocumentIds: payload.relatedDocumentIds || JSON.parse(source.related_document_ids_json || '[]'),
      relatedKnowledgeBaseIds:
        payload.relatedKnowledgeBaseIds || JSON.parse(source.related_knowledge_base_ids_json || '[]'),
      visibility: source.visibility,
      content: source.content,
    }, userId);
  }

  recordRecent(userId, kind, id, title) {
    this.db.run(
      `INSERT OR REPLACE INTO recent_items (user_id, kind, resource_id, title, opened_at) VALUES (?, ?, ?, ?, ?)`,
      [userId, kind, id, title, now()]
    );
    this.db.run(
      `DELETE FROM recent_items WHERE rowid IN (
        SELECT rowid FROM recent_items WHERE user_id = ? AND kind = ? ORDER BY opened_at DESC LIMIT -1 OFFSET 10
      )`,
      [userId, kind]
    );
    this.persistDb();
  }

  listRecent(userId, kind, limit = 5) {
    const rows = this.getAll(
      `SELECT resource_id AS id FROM recent_items WHERE user_id = ? AND kind = ? ORDER BY opened_at DESC LIMIT 50`,
      [userId, kind]
    );
    const visibleItems = [];
    const staleIds = [];

    rows.forEach((row) => {
      const record =
        kind === RESOURCE_KIND_DOCUMENT
          ? this.getDocument(row.id, userId)
          : this.getKnowledgeBase(row.id, userId);

      if (!record) {
        staleIds.push(row.id);
        return;
      }

      if (visibleItems.length < Number(limit)) {
        visibleItems.push({
          id: record.id,
          title: record.title,
          ownerId: record.ownerId,
          ownerName: record.ownerName,
          visibility: record.visibility,
        });
      }
    });

    if (staleIds.length > 0) {
      this.db.run("BEGIN");
      try {
        staleIds.forEach((id) => {
          this.db.run(`DELETE FROM recent_items WHERE user_id = ? AND kind = ? AND resource_id = ?`, [userId, kind, id]);
        });
        this.db.run("COMMIT");
        this.persistDb();
      } catch (error) {
        this.db.run("ROLLBACK");
        throw error;
      }
    }

    return visibleItems;
  }

  canAccessRoom(roomName, userId) {
    const [resourcePrefix, id] = `${roomName}`.split(':');
    if (!resourcePrefix || !id) {
      return false;
    }

    if (resourcePrefix === 'document') {
      return this.canAccessDocumentRecord(this.getOne(`SELECT * FROM documents WHERE id = ?`, [id]), userId);
    }

    if (resourcePrefix === 'knowledge') {
      return Boolean(
        this.getOne(`SELECT id FROM knowledge_bases WHERE id = ? AND (owner_id = ? OR visibility = 'shared')`, [id, userId])
      );
    }

    return false;
  }

  getStats() {
    return {
      users: Number(this.getOne(`SELECT COUNT(*) AS count FROM users`)?.count || 0),
      documents: Number(this.getOne(`SELECT COUNT(*) AS count FROM documents`)?.count || 0),
      knowledgeBases: Number(this.getOne(`SELECT COUNT(*) AS count FROM knowledge_bases`)?.count || 0),
      roomsPersisted: Number(this.getOne(`SELECT COUNT(*) AS count FROM room_states`)?.count || 0),
    };
  }

  loadRoomState(roomName, doc) {
    const row = this.getOne(`SELECT state FROM room_states WHERE room_name = ?`, [roomName]);
    if (!row?.state) {
      return;
    }

    const state = row.state instanceof Uint8Array ? row.state : new Uint8Array(row.state);
    if (state.length > 0) {
      Y.applyUpdate(doc, state);
    }
  }

  persistRoomState(roomName, doc) {
    const state = Y.encodeStateAsUpdate(doc);
    this.db.run(
      `INSERT OR REPLACE INTO room_states (room_name, state, updated_at) VALUES (?, ?, ?)`,
      [roomName, state, now()]
    );
    this.persistDb();
  }

  scheduleRoomWrite(roomName, doc) {
    const existingTimer = this.roomTimers.get(roomName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.persistRoomState(roomName, doc);
      this.roomTimers.delete(roomName);
    }, ROOM_WRITE_DEBOUNCE_MS);

    this.roomTimers.set(roomName, timer);
  }

  clearRoomState(roomName) {
    const timer = this.roomTimers.get(roomName);
    if (timer) {
      clearTimeout(timer);
      this.roomTimers.delete(roomName);
    }

    this.run(`DELETE FROM room_states WHERE room_name = ?`, [roomName]);
  }

  createPersistence() {
    return {
      bindState: (roomName, doc) => {
        this.loadRoomState(roomName, doc);
        doc.on('update', () => {
          this.scheduleRoomWrite(roomName, doc);
        });
      },
      writeState: async (roomName, doc) => {
        this.persistRoomState(roomName, doc);
      },
      provider: {
        name: 'sqlite-storage',
      },
    };
  }
}

export { RESOURCE_KIND_DOCUMENT, RESOURCE_KIND_KNOWLEDGE, DB_FILE };
