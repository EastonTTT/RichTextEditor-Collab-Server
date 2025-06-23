# 文件结构

server.js 启动入口
↓
core/ws-server.js 封装 socket server 初始化逻辑，监听连接并调用相应消息机制
↓
core/message-router.js 解析客户端消息，分发到相应处理器
↓
core/doc-manager.js 管理所有 Y.Doc
↓ ↘
utils/encoding.js callbacks/index.js
编解码服务介绍 插件式钩子
