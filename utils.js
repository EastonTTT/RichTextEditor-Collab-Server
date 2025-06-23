// 导入相关的库和模块
import * as Y from "yjs"; // 导入Yjs库，用于协作文档管理
import * as syncProtocol from "y-protocols/sync"; // 导入同步协议
import * as awarenessProtocol from "y-protocols/awareness"; // 导入意识协议

import * as encoding from "lib0/encoding"; // 导入编码模块
import * as decoding from "lib0/decoding"; // 导入解码模块
import * as map from "lib0/map"; // 导入map模块

import * as eventloop from "lib0/eventloop"; // 导入事件循环模块

import { callbackHandler, isCallbackSet } from "./callback.js"; // 导入回调处理相关模块

// 回调防抖的相关配置
const CALLBACK_DEBOUNCE_WAIT = parseInt(
  process.env.CALLBACK_DEBOUNCE_WAIT || "2000"
);
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(
  process.env.CALLBACK_DEBOUNCE_MAXWAIT || "10000"
);

// 创建防抖器
const debouncer = eventloop.createDebouncer(
  CALLBACK_DEBOUNCE_WAIT,
  CALLBACK_DEBOUNCE_MAXWAIT
);

// WebSocket连接状态定义
const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2; // eslint-disable-line
const wsReadyStateClosed = 3; // eslint-disable-line

// 配置GC（垃圾回收）选项
const gcEnabled = process.env.GC !== "false" && process.env.GC !== "0";

// 持久化层相关定义
let persistence = null;

/**
 * 设置持久化层，传入持久化层对象
 * @param {{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise<any>, provider: any}|null} persistence_
 */
export const setPersistence = (persistence_) => {
  persistence = persistence_;
};

/**
 * 获取当前使用的持久化层
 * @return {null|{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise<any>}|null}
 */
export const getPersistence = () => persistence;

// 存储所有文档的Map
export const docs = new Map();

// 消息类型定义
const messageSync = 0;
const messageAwareness = 1;

/**
 * 处理文档更新同步
 * @param {Uint8Array} update - 要同步的更新数据
 * @param {any} _origin - 更新来源（在此不使用）
 * @param {WSSharedDoc} doc - 当前文档
 * @param {any} _tr - 事务（在此不使用）
 */
const updateHandler = (update, _origin, doc, _tr) => {
  const encoder = encoding.createEncoder(); // 创建编码器
  encoding.writeVarUint(encoder, messageSync); // 写入消息类型
  syncProtocol.writeUpdate(encoder, update); // 将更新写入编码器
  const message = encoding.toUint8Array(encoder); // 转换为Uint8Array
  doc.conns.forEach((_, conn) => send(doc, conn, message)); // 将消息发送给所有连接
};

// 初始化内容的函数（默认什么都不做）
let contentInitializor = (_ydoc) => Promise.resolve();

/**
 * 设置初始化内容的函数，文档创建时会调用
 * @param {(ydoc: Y.Doc) => Promise<void>} f - 初始化函数
 */
export const setContentInitializor = (f) => {
  contentInitializor = f;
};

/**
 * WSSharedDoc 类继承自 Y.Doc，用于管理文档和 WebSocket 连接
 */
export class WSSharedDoc extends Y.Doc {
  /**
   * 构造函数
   * @param {string} name - 文档名称
   */
  constructor(name) {
    super({ gc: gcEnabled }); // 创建文档实例并启用/禁用GC
    this.name = name;
    this.conns = new Map(); // 存储所有连接
    this.awareness = new awarenessProtocol.Awareness(this); // 创建意识对象
    this.awareness.setLocalState(null); // 初始化本地状态为空

    // 定义意识状态更新的处理函数
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed); // 合并状态变化的客户端
      console.log(
        `[AWARENESS] Awareness update from ${
          conn?.remoteAddress || "unknown"
        } - Added: ${added}, Updated: ${updated}, Removed: ${removed}`
      );
      if (conn !== null) {
        const connControlledIDs =
          /** @type {Set<number>} */
          this.conns.get(conn); // 获取连接控制的客户端ID集合
        if (connControlledIDs !== undefined) {
          added.forEach((clientID) => {
            connControlledIDs.add(clientID); // 将新添加的客户端ID加入
          });
          removed.forEach((clientID) => {
            connControlledIDs.delete(clientID); // 删除移除的客户端ID
          });
        }
      }
      // 广播意识状态更新
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness); // 写入消息类型
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients) // 编码意识更新
      );
      const buff = encoding.toUint8Array(encoder);
      this.conns.forEach((_, c) => {
        send(this, c, buff); // 向所有连接广播更新
      });
      console.log(
        `[AWARENESS STATE] Current states:`,
        this.awareness.getStates()
      );
    };

    // 监听意识状态的更新
    this.awareness.on("update", awarenessChangeHandler);

    // 监听文档的更新并处理
    this.on("update", /** @type {any} */ (updateHandler));

    // 如果设置了回调，则进行防抖处理
    if (isCallbackSet) {
      this.on("update", (_update, _origin, doc) => {
        debouncer(() => callbackHandler(/** @type {WSSharedDoc} */ (doc)));
      });
    }

    // 初始化文档内容
    this.whenInitialized = contentInitializor(this);
  }
}

/**
 * 根据文档名称获取文档，如果文档不存在则创建
 * @param {string} docname - 文档名称
 * @param {boolean} gc - 是否启用GC（仅在创建时生效）
 * @return {WSSharedDoc} 返回文档实例
 */
export const getYDoc = (docname, gc = true) =>
  map.setIfUndefined(docs, docname, () => {
    const doc = new WSSharedDoc(docname);
    console.log(
      `[GETDOC FUNC] Created new document "${docname}", GC enabled: ${gc}`
    );
    doc.gc = gc;
    if (persistence !== null) {
      persistence.bindState(docname, doc); // 绑定文档状态到持久化层
      console.log(
        `[GETDOC FUNC] Binding document "${docname}" to persistence layer`
      );
    }
    docs.set(docname, doc); // 将文档添加到docs中
    return doc;
  });

/**
 * 处理 WebSocket 消息
 * @param {any} conn - WebSocket 连接
 * @param {WSSharedDoc} doc - 文档实例
 * @param {Uint8Array} message - 接收到的消息
 */
const messageListener = (conn, doc, message) => {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message); // 解码接收到的消息
    const messageType = decoding.readVarUint(decoder); // 读取消息类型
    console.log(
      `[MSG HANDLER] Received message type ${messageType} from ${conn.remoteAddress}`
    );
    switch (messageType) {
      case messageSync: // 如果是同步消息
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn); // 处理同步消息

        // 如果编码器中只包含消息类型而没有消息本身，则不发送消息
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder)); // 发送同步消息
        }
        break;
      case messageAwareness: {
        // 如果是意识消息
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
        break;
      }
      default:
        console.warn(`[MSG] Unknown message type ${messageType}`);
    }
  } catch (err) {
    console.error(`[ERROR] messageListener: ${err}`); // 错误处理
    // @ts-ignore
    doc.emit("error", [err]); // 发出错误事件
  }
};

/**
 * 关闭WebSocket连接并清理相关资源
 * @param {WSSharedDoc} doc - 文档实例
 * @param {any} conn - WebSocket连接
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    console.warn(
      `[CLOSECONN FUNC] Connection closed from ${conn.remoteAddress}, cleaning up doc "${doc.name}"`
    );
    const controlledIds = doc.conns.get(conn); // 获取当前连接控制的客户端ID集合
    doc.conns.delete(conn); // 从连接Map中移除连接
    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(controlledIds),
      null
    );
    if (doc.conns.size === 0 && persistence !== null) {
      // 如果没有其他连接，且启用了持久化，则将文档状态保存
      persistence.writeState(doc.name, doc).then(() => {
        doc.destroy(); // 销毁文档
      });
      docs.delete(doc.name); // 从docs中删除文档
      console.warn(
        `[CLOSECONN FUNC] Destroyed document "${doc.name}" due to no remaining connections`
      );
    }
  }
  conn.close(); // 关闭WebSocket连接
};

/**
 * 向WebSocket连接发送消息
 * @param {WSSharedDoc} doc - 文档实例
 * @param {import('ws').WebSocket} conn - WebSocket连接
 * @param {Uint8Array} m - 要发送的消息
 */
const send = (doc, conn, m) => {
  if (
    conn.readyState !== wsReadyStateConnecting &&
    conn.readyState !== wsReadyStateOpen
  ) {
    closeConn(doc, conn); // 如果连接不在打开状态，则关闭连接
    console.warn(
      `[SEND FUNC] Connection not open. Closing connection for doc "${doc.name}"`
    );
  }
  try {
    conn.send(m, {}, (err) => {
      if (err != null) {
        closeConn(doc, conn); // 发送失败时关闭连接
        console.error(
          `[SEND ERROR] Failed to send message to ${conn.remoteAddress}`
        );
      } else {
        console.log(
          `[SEND] Message sent to ${conn.remoteAddress} for doc "${doc.name}"`
        );
      }
    });
  } catch (e) {
    closeConn(doc, conn); // 发送失败时关闭连接
    console.error(`[SEND EXCEPTION] ${e}`);
  }
};

// 定义ping超时时间
const pingTimeout = 30000;

/**
 * 设置WebSocket连接
 * @param {import('ws').WebSocket} conn - WebSocket连接
 * @param {import('http').IncomingMessage} req - 请求对象
 * @param {any} opts - 配置选项
 */
export const setupWSConnection = (
  conn,
  req,
  { docName = (req.url || "").slice(1).split("?")[0], gc = true } = {}
) => {
  conn.remoteAddress = req.socket.remoteAddress + ":" + req.socket.remotePort;
  console.log("docName :", docName);
  conn.binaryType = "arraybuffer"; // 设置二进制类型
  const doc = getYDoc(docName, gc); // 获取文档实例
  doc.conns.set(conn, new Set()); // 将连接添加到文档的连接集合中
  conn.on(
    "message",
    /** @param {ArrayBuffer} message */ (message) =>
      messageListener(conn, doc, new Uint8Array(message)) // 监听消息并处理
  );

  // 定时检查连接是否存活
  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      console.warn(
        `[PING TIMEOUT] No pong received from ${conn.remoteAddress}, closing connection`
      );
      if (doc.conns.has(conn)) {
        closeConn(doc, conn); // 如果未收到pong响应，关闭连接
      }
      clearInterval(pingInterval);
    } else if (doc.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping(); // 向连接发送ping请求
      } catch (e) {
        closeConn(doc, conn); // 发送ping失败时关闭连接
        clearInterval(pingInterval);
      }
    }
  }, pingTimeout);

  conn.on("close", () => {
    closeConn(doc, conn); // 连接关闭时清理资源
    clearInterval(pingInterval); // 清理ping检查定时器
  });

  conn.on("pong", () => {
    pongReceived = true; // 收到pong响应时设置标志
    console.log(`[PING] Received pong from ${conn.remoteAddress}`);
  });

  // 发送同步步骤1的消息
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc); // 写入同步步骤1
    send(doc, conn, encoding.toUint8Array(encoder)); // 发送消息
    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          doc.awareness,
          Array.from(awarenessStates.keys())
        )
      );
      send(doc, conn, encoding.toUint8Array(encoder)); // 发送意识状态更新
    }
  }
};
