import express from "express";
import cors from "cors";
// 承载 REST API、导入流程、AI 接口和 WebSocket 协同服务。
import http from "http";
import { WebSocketServer } from "ws";
import multer from "multer";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import WordExtractor from "word-extractor";
import {
  RESOURCE_KIND_DOCUMENT,
  RESOURCE_KIND_KNOWLEDGE,
  LocalWorkspaceStore,
} from "./storage.js";
import { sendError, sendSuccess } from "./response.js";
import { docs as activeDocs, setPersistence, setupWSConnection } from "./utils.js";

// 这是整个后端的总入口：
// - Express 负责普通 HTTP / REST API
// - ws + Yjs 负责协同编辑 WebSocket
// - storage.js 负责把业务数据和房间状态落到本地 SQLite
const HOST = process.env.HOST || "localhost";
const PORT = Number(process.env.PORT || "8888");
const app = express();
const store = await LocalWorkspaceStore.create();
const wss = new WebSocketServer({ noServer: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});
const AI_API_URL = process.env.AI_API_URL || "https://api.openai.com/v1/chat/completions";
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

// 把 storage 暴露成 Yjs 需要的持久化适配器。
// 这样协同编辑产生的房间状态就能自动写进 SQLite。
setPersistence(store.createPersistence());

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// 这个项目的 token 非常轻量：
// 前端只要传 `Bearer user-xxx` 或 `Bearer local-xxx`，
// 这里就会提取出真正的用户 id `xxx`。
function parseUserId(req) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  if (!token) {
    const currentUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const queryToken = currentUrl.searchParams.get("token") || "";
    if (queryToken) {
      return queryToken.replace(/^(local|user)-/, "") || null;
    }
  }

  if (!token) {
    return null;
  }

  return token.replace(/^(local|user)-/, "") || null;
}

// 统一的接口鉴权中间件。
// 从这里之后的 `/api/*` 路由都必须先拿到合法 userId。
function requireAuth(req, res, next) {
  const userId = parseUserId(req);
  if (!userId || !store.getUserById(userId)) {
    sendError(res, 401, "Unauthorized");
    return;
  }

  req.userId = userId;
  next();
}

function logRequest(resource, action, id) {
  console.log(`[API] ${resource} ${action}${id ? ` -> ${id}` : ""}`);
}

// 当文档权限变更后，把当前房间里已经失去访问权的连接主动踢下线。
// 否则前端虽然已经无权访问，旧的 WebSocket 连接还会继续保留。
function disconnectUnauthorizedRoomClients(roomName) {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) {
      return;
    }

    if (client.roomName !== roomName || !client.userId) {
      return;
    }

    if (store.canAccessRoom(roomName, client.userId)) {
      return;
    }

    client.close(4001, "permission-updated");
  });
}

// 用于“整个房间需要重置”的场景，比如恢复版本。
// 关闭后前端会重新进入房间，从而拿到新的协同状态。
function disconnectRoomClients(roomName, code = 4002, reason = "room-reset") {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) {
      return;
    }

    if (client.roomName !== roomName) {
      return;
    }

    client.close(code, reason);
  });
}

// 下面几个工具函数主要服务于文件导入和 AI 摘要：
// 文档里的内容统一会被整理成 HTML，再给前端编辑器使用。
function escapeHtml(value = "") {
  return `${value}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(text = "") {
  return `${text}`
    .split(/\r?\n\r?\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\r?\n/g, "<br />")}</p>`)
    .join("");
}

function stripHtml(html = "") {
  return `${html}`.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUploadFileName(fileName = "") {
  const rawName = `${fileName || ""}`.trim();
  if (!rawName) {
    return "";
  }

  try {
    const decodedName = Buffer.from(rawName, "latin1").toString("utf8").trim();
    if (!decodedName) {
      return rawName;
    }

    const rawCjkCount = (rawName.match(/[\u4e00-\u9fff]/g) || []).length;
    const decodedCjkCount = (decodedName.match(/[\u4e00-\u9fff]/g) || []).length;
    const rawLooksMojibake = /[ÃÂÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞãæçèéêëìíîïðñòóôõöøùúûüýþ]/.test(rawName);

    if (decodedCjkCount > rawCjkCount || rawLooksMojibake) {
      return decodedName;
    }
  } catch {
    // Fall back to the raw upload name if charset conversion fails.
  }

  return rawName;
}

// 导入流程统一把不同格式的文件转换成 HTML。
// 这样存到数据库后，前端富文本编辑器可以直接展示和编辑。
async function importFileToHtml(file) {
  const normalizedFileName = normalizeUploadFileName(file.originalname);
  const extension = normalizedFileName.toLowerCase().split(".").pop();

  if (extension === "docx") {
    const { value } = await mammoth.convertToHtml({ buffer: file.buffer });
    return value || "<p></p>";
  }

  if (extension === "doc") {
    const extractor = new WordExtractor();
    const document = await extractor.extract(file.buffer);
    return textToHtml(document.getBody());
  }

  if (extension === "pdf") {
    const parser = new PDFParse({ data: file.buffer });
    try {
      const parsed = await parser.getText();
      return textToHtml(parsed.text || "");
    } finally {
      await parser.destroy();
    }
  }

  return null;
}

// AI 功能的统一封装：
// - `summary` 模式：做文档总结
// - `question` 模式：基于文档内容回答问题
// 这里没有做复杂检索，直接把文档内容拼进 prompt。
async function askAiAboutDocument({ title, content, prompt, mode }) {
  if (!AI_API_KEY) {
    throw new Error("AI API is not configured. Please set AI_API_KEY or OPENAI_API_KEY in CollabServer.");
  }

  const documentText = stripHtml(content);
  const task =
    mode === "summary"
      ? "You are an assistant for document summarization. Summarize the document clearly in Chinese, focusing on structure, key conclusions, action items, and risks."
      : "You are an assistant for document question answering. Answer the user's question in Chinese using only the provided document. If the answer is not in the document, say so clearly.";

  const userMessage =
    mode === "summary"
      ? `Document title: ${title}\n\nDocument content:\n${documentText}`
      : `Document title: ${title}\n\nQuestion: ${prompt}\n\nDocument content:\n${documentText}`;

  const response = await fetch(AI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: task,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "AI request failed");
  }

  const result = await response.json();
  return result?.choices?.[0]?.message?.content?.trim() || "AI did not return a valid answer.";
}

function createRuntimeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 新评论结构是 thread -> comments，
// 但旧前端接口使用扁平评论列表，所以这里做一次兼容转换。
function flattenThreadsToLegacyComments(threads = []) {
  const comments = [];

  threads.forEach((thread) => {
    const rootCommentId = thread?.comments?.[0]?.id || null;
    thread.comments.forEach((comment, index) => {
      const user = store.getUserById(comment.authorId);
      comments.push({
        id: comment.id,
        parentId: index === 0 ? null : rootCommentId,
        uid: comment.authorId,
        content: comment.content,
        createTime: comment.createdAt,
        user: {
          username: user?.nickname || user?.name || comment.authorName || "Unknown",
          avatar: user?.avatar || "",
        },
        reply: null,
      });
    });
  });

  return comments.sort((left, right) => new Date(right.createTime).getTime() - new Date(left.createTime).getTime());
}

// 旧评论发布接口只传 parentId/content，
// 这里把它包装成新的评论线程结构后再落库。
function appendLegacyCommentToThreads(threads = [], { parentId, authorId, content }) {
  const createdAt = new Date().toISOString();
  const author = store.getUserById(authorId);
  const nextComment = {
    id: createRuntimeId("comment"),
    authorId,
    authorName: author?.nickname || author?.name || "Unknown",
    content,
    createdAt,
  };

  if (!parentId) {
    return {
      comment: nextComment,
      threads: [
        {
          id: createRuntimeId("thread"),
          excerpt: stripHtml(content).slice(0, 120),
          createdAt,
          updatedAt: createdAt,
          comments: [nextComment],
        },
        ...threads,
      ],
    };
  }

  const nextThreads = threads.map((thread) => {
    const containsParent = thread.comments.some((comment) => comment.id === parentId);
    if (!containsParent) {
      return thread;
    }

    return {
      ...thread,
      updatedAt: createdAt,
      comments: [...thread.comments, nextComment],
    };
  });

  return {
    comment: nextComment,
    threads: nextThreads,
  };
}

app.get("/status", (_req, res) => {
  sendSuccess(res, {
    status: "ok",
    stats: store.getStats(),
  });
});

// 运行时指标接口，比 `/status` 额外多返回当前活跃连接数。
app.get("/metrics", (_req, res) => {
  sendSuccess(res, {
    stats: store.getStats(),
    activeRooms: Array.from(wss.clients).length,
  });
});

// 认证相关接口：
// 当前是本地用户体系，适合单机开发和演示环境。
app.post("/api/auth/register", (req, res) => {
  const name = `${req.body?.name || req.body?.username || ""}`.trim();
  const password = `${req.body?.password || ""}`;

  if (!name || !password) {
    sendError(res, 400, "Name and password are required");
    return;
  }

  const result = store.createUser(name, password);
  if (result.error || !result.user) {
    sendError(res, 409, result.error || "Unable to register");
    return;
  }

  sendSuccess(
    res,
    {
      token: `user-${result.user.id}`,
      user: result.user,
    },
    "registered"
  );
});

app.post("/api/auth/login", (req, res) => {
  const name = `${req.body?.name || req.body?.username || ""}`.trim();
  const password = `${req.body?.password || ""}`;

  if (!name || !password) {
    sendError(res, 400, "Name and password are required");
    return;
  }

  const user = store.loginUser(name, password);
  if (!user) {
    sendError(res, 401, "Invalid credentials");
    return;
  }

  sendSuccess(
    res,
    {
      token: `user-${user.id}`,
      user,
    },
    "logged-in"
  );
});

// 从这里开始统一要求登录态。
app.use("/api", requireAuth);

app.get("/api/auth/me", (req, res) => {
  const user = store.getUserById(req.userId);
  if (!user) {
    sendError(res, 401, "Unauthorized");
    return;
  }

  sendSuccess(res, user);
});

app.patch("/api/auth/user/profile", (req, res) => {
  const user = store.updateUserProfile(req.userId, req.body || {});
  if (!user) {
    sendError(res, 404, "User not found");
    return;
  }

  sendSuccess(res, user, "updated");
});

app.get("/api/users", (req, res) => {
  sendSuccess(res, store.listUsers(req.userId));
});

// 文档接口是前端最常调用的一组接口：
// 列表、详情、创建、保存、版本、评论基本都围绕这部分展开。
app.get("/api/documents", (req, res) => {
  logRequest("documents", "list");
  sendSuccess(res, store.listDocuments(req.userId));
});

app.get("/api/documents/recent", (req, res) => {
  const limit = Number(req.query.limit || 5);
  sendSuccess(res, store.listRecent(req.userId, RESOURCE_KIND_DOCUMENT, limit));
});

app.get("/api/knowledge-bases/:id/documents", (req, res) => {
  const knowledgeBase = store.getKnowledgeBase(req.params.id, req.userId);
  if (!knowledgeBase) {
    sendError(res, 404, "Knowledge base item not found");
    return;
  }

  sendSuccess(res, store.listDocumentsByKnowledgeBase(req.params.id, req.userId));
});

app.post("/api/documents", (req, res) => {
  const record = store.createDocument(req.body || {}, req.userId);
  logRequest("documents", "create", record.id);
  sendSuccess(res, record, "created");
});

// 文件导入接口的输出仍然是一个普通文档记录，
// 前端后续的编辑和保存流程与普通文档保持一致。
app.post("/api/documents/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    sendError(res, 400, "File is required");
    return;
  }

  try {
    const normalizedFileName = normalizeUploadFileName(req.file.originalname);
    const html = await importFileToHtml(req.file);
    if (!html) {
      sendError(res, 400, "Only .doc, .docx and .pdf files are supported");
      return;
    }

    const title = `${req.body?.title || req.file.originalname.replace(/\.[^.]+$/, "")}`.trim() || "导入文档";
    const author = `${req.body?.author || ""}`.trim();
    const normalizedTitle = `${req.body?.title || normalizedFileName.replace(/\.[^.]+$/, "")}`.trim() || "导入文档";
    const record = store.createDocument(
      {
        title: normalizedTitle,
        author,
        content: html,
        visibility: "private",
      },
      req.userId
    );

    logRequest("documents", "import", record.id);
    sendSuccess(res, record, "imported");
  } catch (error) {
    sendError(res, 500, error.message || "Import failed");
  }
});

app.get("/api/documents/:id", (req, res) => {
  const record = store.getDocument(req.params.id, req.userId);
  if (!record) {
    sendError(res, 404, "Document not found");
    return;
  }

  sendSuccess(res, record);
});

app.get("/api/documents/:id/comment-threads", (req, res) => {
  const threads = store.getDocumentCommentThreads(req.params.id, req.userId);
  if (!threads) {
    sendError(res, 404, "Document not found");
    return;
  }

  sendSuccess(res, threads);
});

app.patch("/api/documents/:id/comment-threads", (req, res) => {
  const threads = Array.isArray(req.body?.threads) ? req.body.threads : [];
  const updated = store.setDocumentCommentThreads(req.params.id, threads, req.userId);
  if (!updated) {
    sendError(res, 404, "Document not found");
    return;
  }

  sendSuccess(res, updated, "updated");
});

app.delete("/api/documents/:id/comment-threads/:threadId/comments/:commentId", (req, res) => {
  const result = store.deleteDocumentComment(req.params.id, req.params.threadId, req.params.commentId, req.userId);
  if (result?.status === "document_not_found") {
    sendError(res, 404, "Document not found");
    return;
  }

  if (result?.status === "forbidden") {
    sendError(res, 403, "Only document owner can delete comments");
    return;
  }

  if (result?.status === "comment_not_found") {
    sendError(res, 404, "Comment not found");
    return;
  }

  sendSuccess(res, result?.threads || [], "deleted");
});

// 这是“手动保存文档”的核心接口。
// 它更新 documents 表中的 HTML 内容，并在合适时机补一份版本快照。
app.patch("/api/documents/:id", (req, res) => {
  const existing = store.getDocument(req.params.id, req.userId);
  if (!existing) {
    sendError(res, 404, "Document not found");
    return;
  }

  const nextContent = typeof req.body?.content === "string" ? req.body.content : null;
  const contentChanged = typeof nextContent === "string" && nextContent !== existing.content;
  const versionReason = `${req.body?.versionReason || "manual_save"}`.trim() || "manual_save";
  const versionSummary = `${req.body?.versionSummary || ""}`.trim();
  const shouldCreateVersion =
    contentChanged &&
    req.body?.createVersion !== false &&
    (versionReason !== "autosave" || store.shouldCreateAutosaveVersion(req.params.id, nextContent, req.userId));

  const record = store.updateDocument(req.params.id, req.body || {}, req.userId);
  if (!record) {
    sendError(res, 404, "Document not found");
    return;
  }

  if (shouldCreateVersion) {
    store.createDocumentVersion(
      req.params.id,
      {
        reason: versionReason,
        summary: versionSummary,
      },
      req.userId
    );
  }

  disconnectUnauthorizedRoomClients(record.roomName);
  logRequest("documents", "update", record.id);
  sendSuccess(res, record, "updated");
});

// 版本系统接口：
// 支持列出版本、创建版本、查看单个版本、恢复版本和删除版本。
app.get("/api/documents/:id/versions", (req, res) => {
  const versions = store.listDocumentVersions(req.params.id, req.userId);
  if (versions === null) {
    sendError(res, 404, "Document not found");
    return;
  }

  sendSuccess(
    res,
    versions.map(({ roomState, ...version }) => version)
  );
});

app.post("/api/documents/:id/versions", (req, res) => {
  const version = store.createDocumentVersion(req.params.id, req.body || {}, req.userId);
  if (!version) {
    sendError(res, 404, "Document not found");
    return;
  }

  const { roomState, ...versionData } = version;
  sendSuccess(res, versionData, "version-created");
});

app.get("/api/document-versions/:id", (req, res) => {
  const version = store.getDocumentVersion(req.params.id, req.userId);
  if (!version) {
    sendError(res, 404, "Version not found");
    return;
  }

  const { roomState, ...versionData } = version;
  sendSuccess(res, versionData);
});

app.post("/api/document-versions/:id/restore", (req, res) => {
  const version = store.getDocumentVersion(req.params.id, req.userId);
  if (!version) {
    sendError(res, 404, "Version not found");
    return;
  }

  const record = store.restoreDocumentVersion(req.params.id, req.body || {}, req.userId);
  if (!record) {
    sendError(res, 403, "You are not allowed to restore this version");
    return;
  }

  disconnectRoomClients(record.roomName, 4002, "version-restored");
  activeDocs.delete(record.roomName);
  setTimeout(() => {
    store.setRoomState(record.roomName, version.roomState);
  }, 100);

  sendSuccess(res, record, "restored");
});

app.delete("/api/document-versions/:id", (req, res) => {
  const version = store.getDocumentVersion(req.params.id, req.userId);
  if (!version) {
    sendError(res, 404, "Version not found");
    return;
  }

  const removed = store.deleteDocumentVersion(req.params.id, req.userId);
  if (!removed) {
    sendError(res, 403, "You are not allowed to delete this version");
    return;
  }

  sendSuccess(res, true, "deleted");
});

app.delete("/api/documents/:id", (req, res) => {
  const removed = store.deleteDocument(req.params.id, req.userId);
  if (!removed) {
    sendError(res, 404, "Document not found");
    return;
  }

  logRequest("documents", "delete", req.params.id);
  sendSuccess(res, true, "deleted");
});

app.post("/api/documents/:id/duplicate", (req, res) => {
  const record = store.duplicateDocument(req.params.id, req.body || {}, req.userId);
  if (!record) {
    sendError(res, 404, "Document not found");
    return;
  }

  logRequest("documents", "duplicate", record.id);
  sendSuccess(res, record, "duplicated");
});

app.post("/api/documents/:id/open", (req, res) => {
  const record = store.getDocument(req.params.id, req.userId);
  if (!record) {
    sendError(res, 404, "Document not found");
    return;
  }

  store.recordRecent(req.userId, RESOURCE_KIND_DOCUMENT, record.id, record.title);
  sendSuccess(res, true, "opened");
});

// 文档 AI 问答 / 摘要接口。
// 适合前端在“问 AI”面板中直接调用。
app.post("/api/documents/:id/ai", async (req, res) => {
  const record = store.getDocument(req.params.id, req.userId);
  if (!record) {
    sendError(res, 404, "Document not found");
    return;
  }

  const mode = req.body?.mode === "summary" ? "summary" : "question";
  const prompt = `${req.body?.prompt || ""}`.trim();

  if (mode === "question" && !prompt) {
    sendError(res, 400, "Prompt is required");
    return;
  }

  try {
    const answer = await askAiAboutDocument({
      title: record.title,
      content: record.content,
      prompt,
      mode,
    });
    sendSuccess(res, { answer }, "answered");
  } catch (error) {
    const message = error.message || "AI request failed";
    const status = message.includes("AI API is not configured") ? 503 : 500;
    sendError(res, status, message);
  }
});

// 这个接口不依赖文档 id，前端可以把当前编辑器内容直接传过来做摘要。
app.post("/api/editor/summary", async (req, res) => {
  const content = `${req.body?.content || ""}`.trim();
  if (!content) {
    sendError(res, 400, "Content is required");
    return;
  }

  try {
    const answer = await askAiAboutDocument({
      title: "Untitled Document",
      content,
      prompt: "",
      mode: "summary",
    });
    res.status(200).send(answer);
  } catch (error) {
    const message = error.message || "AI request failed";
    const status = message.includes("AI API is not configured") ? 503 : 500;
    sendError(res, status, message);
  }
});

// 旧评论接口：
// 路由名字保留旧格式，但底层已经切换成新的 thread 存储结构。
app.get("/api/comment/commentLists", (req, res) => {
  const documentId = `${req.query.textId || ""}`.trim();
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.max(1, Number(req.query.pageSize || 10));

  if (!documentId) {
    sendError(res, 400, "textId is required");
    return;
  }

  const threads = store.getDocumentCommentThreads(documentId, req.userId);
  if (!threads) {
    sendError(res, 404, "Document not found");
    return;
  }

  const comments = flattenThreadsToLegacyComments(threads);
  const start = (page - 1) * pageSize;
  const list = comments.slice(start, start + pageSize);
  sendSuccess(res, { list, total: comments.length });
});

app.post("/api/comment/publish", (req, res) => {
  const documentId = `${req.body?.textId || ""}`.trim();
  const content = `${req.body?.content || ""}`.trim();
  const parentId = req.body?.parentId ? `${req.body.parentId}`.trim() : null;

  if (!documentId || !content) {
    sendError(res, 400, "textId and content are required");
    return;
  }

  const currentThreads = store.getDocumentCommentThreads(documentId, req.userId);
  if (!currentThreads) {
    sendError(res, 404, "Document not found");
    return;
  }

  const { comment, threads } = appendLegacyCommentToThreads(currentThreads, {
    parentId,
    authorId: req.userId,
    content,
  });
  const updated = store.setDocumentCommentThreads(documentId, threads, req.userId);
  if (!updated) {
    sendError(res, 500, "Unable to persist comment");
    return;
  }

  sendSuccess(
    res,
    {
      id: comment.id,
      createTime: comment.createdAt,
    },
    "published"
  );
});

// 模板接口：
// 支持把现有文档沉淀成模板，再由模板快速创建新文档。
app.get("/api/document-templates", (req, res) => {
  sendSuccess(res, store.listDocumentTemplates(req.userId));
});

app.post("/api/documents/:id/template", (req, res) => {
  const template = store.createDocumentTemplate(req.params.id, req.body || {}, req.userId);
  if (!template) {
    sendError(res, 404, "Document not found");
    return;
  }

  sendSuccess(res, template, "template-created");
});

app.post("/api/document-templates/:id/create-document", (req, res) => {
  const record = store.createDocumentFromTemplate(req.params.id, req.body || {}, req.userId);
  if (!record) {
    sendError(res, 404, "Template not found");
    return;
  }

  sendSuccess(res, record, "created");
});

app.delete("/api/document-templates/:id", (req, res) => {
  const removed = store.deleteDocumentTemplate(req.params.id, req.userId);
  if (!removed) {
    sendError(res, 404, "Template not found");
    return;
  }

  sendSuccess(res, true, "deleted");
});

// 知识库接口：
// 和文档类似，但多了 description/tags/关联关系等字段。
app.get("/api/knowledge-bases", (req, res) => {
  logRequest("knowledge-bases", "list");
  sendSuccess(res, store.listKnowledgeBases(req.userId));
});

app.get("/api/knowledge-bases/recent", (req, res) => {
  const limit = Number(req.query.limit || 5);
  sendSuccess(res, store.listRecent(req.userId, RESOURCE_KIND_KNOWLEDGE, limit));
});

app.post("/api/knowledge-bases", (req, res) => {
  const record = store.createKnowledgeBase(req.body || {}, req.userId);
  logRequest("knowledge-bases", "create", record.id);
  sendSuccess(res, record, "created");
});

app.get("/api/knowledge-bases/:id", (req, res) => {
  const record = store.getKnowledgeBase(req.params.id, req.userId);
  if (!record) {
    sendError(res, 404, "Knowledge base item not found");
    return;
  }

  sendSuccess(res, record);
});

app.patch("/api/knowledge-bases/:id", (req, res) => {
  const record = store.updateKnowledgeBase(req.params.id, req.body || {}, req.userId);
  if (!record) {
    sendError(res, 404, "Knowledge base item not found");
    return;
  }

  logRequest("knowledge-bases", "update", record.id);
  sendSuccess(res, record, "updated");
});

app.delete("/api/knowledge-bases/:id", (req, res) => {
  const removed = store.deleteKnowledgeBase(req.params.id, req.userId);
  if (!removed) {
    sendError(res, 404, "Knowledge base item not found");
    return;
  }

  logRequest("knowledge-bases", "delete", req.params.id);
  sendSuccess(res, true, "deleted");
});

app.post("/api/knowledge-bases/:id/duplicate", (req, res) => {
  const record = store.duplicateKnowledgeBase(req.params.id, req.body || {}, req.userId);
  if (!record) {
    sendError(res, 404, "Knowledge base item not found");
    return;
  }

  logRequest("knowledge-bases", "duplicate", record.id);
  sendSuccess(res, record, "duplicated");
});

app.post("/api/knowledge-bases/:id/open", (req, res) => {
  const record = store.getKnowledgeBase(req.params.id, req.userId);
  if (!record) {
    sendError(res, 404, "Knowledge base item not found");
    return;
  }

  store.recordRecent(req.userId, RESOURCE_KIND_KNOWLEDGE, record.id, record.title);
  sendSuccess(res, true, "opened");
});

const server = http.createServer(app);

// WebSocket 握手阶段就先校验权限：
// 用户必须存在，且必须有权访问对应 room，才允许升级成功。
server.on("upgrade", (req, socket, head) => {
  const userId = parseUserId(req);
  const roomName = (req.url || "").slice(1).split("?")[0];

  if (!userId || !store.getUserById(userId) || !store.canAccessRoom(roomName, userId)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  req.userId = userId;
  console.log(`[WS] Upgrading request for room ${roomName} by user ${userId}`);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// 握手完成后，真正把连接交给协同层处理。
// 之后这条连接的同步、心跳、房间状态都由 utils.js 接管。
wss.on("connection", (ws, req) => {
  ws.userId = req.userId || null;
  ws.roomName = (req.url || "").slice(1).split("?")[0] || null;
  setupWSConnection(ws, req);
  console.log(
    `[WS] Connected ${req.socket.remoteAddress}:${req.socket.remotePort} user=${req.userId || "unknown"} room=${req.url}`
  );

  ws.on("close", (code, reason) => {
    console.log(
      `[WS] Closed ${req.socket.remoteAddress}:${req.socket.remotePort} code=${code} reason=${reason.toString()}`
    );
  });

  ws.on("error", (err) => {
    console.error(
      `[WS] Error from ${req.socket.remoteAddress}:${req.socket.remotePort}`
    );
    console.error(err);
  });
});

// 启动后，一个端口同时承载 REST 和 WebSocket 两种通信。
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
