import { WebSocketServer } from "ws";
import http from "http";
import { setupWSConnection } from "./utils.js";

const HOST = "localhost";
const PORT = "8888";

const wss = new WebSocketServer({ noServer: true });

const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("WebSocket server is running"); // 返回一个简单的字符串
    console.log("Status request received"); // 记录状态请求
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("message from server");
  }
});

//触发upgrade事件
server.on("upgrade", (req, socket, head) => {
  //TODO:这里可以补充权限校验
  console.log(`Upgrading request to WebSocket for URL: ${req.url}`);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  setupWSConnection(ws, req);
  console.log(
    `WebSocket connection established with client: ${req.socket.remoteAddress},Port: ${req.socket.remotePort}`
  );

  // 监听 WebSocket 层的消息事件
  ws.on("message", (data, isBinary) => {
    const type = isBinary ? "binary" : "text";
    console.log(
      `📨 [WS] Received ${type} message from ${req.socket.remoteAddress}:${req.socket.remotePort}`
    );
  });

  // 监听关闭事件
  ws.on("close", (code, reason) => {
    console.log(
      `❌ [WS] Connection closed from ${req.socket.remoteAddress}:${req.socket.remotePort}`
    );
    console.log(`    ↪ Close code: ${code}, reason: ${reason.toString()}`);
  });

  // 监听错误
  ws.on("error", (err) => {
    console.error(
      `⚠️ [WS] Error from ${req.socket.remoteAddress}:${req.socket.remotePort}`
    );
    console.error(err);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
