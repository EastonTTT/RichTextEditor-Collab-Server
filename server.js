import express from "express";
import cors from "cors";
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

setPersistence(store.createPersistence());

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

async function importFileToHtml(file) {
  const extension = file.originalname.toLowerCase().split(".").pop();

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

app.get("/metrics", (_req, res) => {
  sendSuccess(res, {
    stats: store.getStats(),
    activeRooms: Array.from(wss.clients).length,
  });
});

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

app.post("/api/documents/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    sendError(res, 400, "File is required");
    return;
  }

  try {
    const html = await importFileToHtml(req.file);
    if (!html) {
      sendError(res, 400, "Only .doc, .docx and .pdf files are supported");
      return;
    }

    const title = `${req.body?.title || req.file.originalname.replace(/\.[^.]+$/, "")}`.trim() || "导入文档";
    const author = `${req.body?.author || ""}`.trim();
    const record = store.createDocument(
      {
        title,
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

  const record = store.restoreDocumentVersion(req.params.id, req.userId);
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

server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
