// 创建协同 WebSocket 服务使用的 HTTP 回调入口。
import http from "http";
import * as number from "lib0/number";

// 这是一个可选扩展点：
// 如果配置了 CALLBACK_URL，协同文档更新后会把指定共享对象序列化后 POST 出去。
const CALLBACK_URL = process.env.CALLBACK_URL
  ? new URL(process.env.CALLBACK_URL)
  : null;
const CALLBACK_TIMEOUT = number.parseInt(
  process.env.CALLBACK_TIMEOUT || "5000"
);
const CALLBACK_OBJECTS = process.env.CALLBACK_OBJECTS
  ? JSON.parse(process.env.CALLBACK_OBJECTS)
  : {};

export const isCallbackSet = !!CALLBACK_URL;

// 把当前房间里指定的共享对象提取出来，组装成统一的回调载荷。
/**
 * @param {import('./utils.js').WSSharedDoc} doc
 */
export const callbackHandler = (doc) => {
  const room = doc.name;
  const dataToSend = {
    room,
    data: {},
  };
  const sharedObjectList = Object.keys(CALLBACK_OBJECTS);
  sharedObjectList.forEach((sharedObjectName) => {
    const sharedObjectType = CALLBACK_OBJECTS[sharedObjectName];
    dataToSend.data[sharedObjectName] = {
      type: sharedObjectType,
      content: getContent(sharedObjectName, sharedObjectType, doc).toJSON(),
    };
  });
  CALLBACK_URL && callbackRequest(CALLBACK_URL, CALLBACK_TIMEOUT, dataToSend);
};

// 使用最基础的 http.request 发 POST，
// 避免为了一个简单回调再额外引入第三方请求库。
/**
 * @param {URL} url
 * @param {number} timeout
 * @param {Object} data
 */
const callbackRequest = (url, timeout, data) => {
  data = JSON.stringify(data);
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    timeout,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    },
  };
  const req = http.request(options);
  req.on("timeout", () => {
    console.warn("Callback request timed out.");
    req.destroy();
  });
  req.on("error", (e) => {
    console.error("Callback request error.", e);
    req.destroy();
  });
  req.write(data);
  req.end();
};

// 根据共享对象类型从 Y.Doc 中取出目标对象。
// 只有配置在 CALLBACK_OBJECTS 中的对象才会被序列化并回调出去。
/**
 * @param {string} objName
 * @param {string} objType
 * @param {import('./utils.js').WSSharedDoc} doc
 */
const getContent = (objName, objType, doc) => {
  switch (objType) {
    case "Array":
      return doc.getArray(objName);
    case "Map":
      return doc.getMap(objName);
    case "Text":
      return doc.getText(objName);
    case "XmlFragment":
      return doc.getXmlFragment(objName);
    case "XmlElement":
      return doc.getXmlElement(objName);
    default:
      return {};
  }
};
