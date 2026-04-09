// 统一 API 层返回的成功与错误响应结构。
export function sendSuccess(res, data, msg = "ok", code = 200) {
  res.status(code).json({
    code: 200,
    msg,
    data,
  });
}

export function sendError(res, statusCode, msg) {
  res.status(statusCode).json({
    code: statusCode,
    msg,
    data: null,
  });
}
