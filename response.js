// 统一 API 层返回的成功与错误响应结构。
// 统一 REST API 的成功响应结构，前端可以稳定读取 `code`、`msg`、`data`。
export function sendSuccess(res, data, msg = "ok", code = 200) {
  res.status(code).json({
    code: 200,
    msg,
    data,
  });
}

// 错误响应同样保持统一结构，避免前端为不同接口写不同分支。
export function sendError(res, statusCode, msg) {
  res.status(statusCode).json({
    code: statusCode,
    msg,
    data: null,
  });
}
