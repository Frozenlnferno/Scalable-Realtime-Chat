const { createServer } = require('node:http');
const { Server } = require('socket.io');

async function startFixture(mode = 'ok') {
  const users = Array.from({ length: 4 }, (_, i) => ({ id: `user${i}`, token: `fixture${i}` }));
  const calls = [];
  let io, messageCount = 0, connected = 0;
  const server = createServer(async (req, res) => {
    try {
      const sender = users.find(u => `Bearer ${u.token}` === req.headers.authorization);
      res.setHeader('Content-Type', 'application/json');
      if (!sender) { res.statusCode = 401; res.end('{}'); return; }
      let input = '';
      for await (const chunk of req) input += chunk;
      calls.push({ path: req.url, sender: sender.id, method: req.method });
      if (req.url === '/api/users') return res.end(JSON.stringify({ currentUser: sender, users: users.filter(u => u.id !== sender.id).map(({ id }) => ({ id })) }));
      if (req.url === '/api/conversations/direct') {
        const other = JSON.parse(input).recipientUserId;
        return res.end(JSON.stringify({ conversation: { id: [sender.id, other].sort().join('_') } }));
      }
      if (!input) return res.end('{"messages":[]}');
      if (mode === 'http-error') { res.statusCode = 503; return res.end('{}'); }
      const conversationId = req.url.split('/')[3];
      const message = { id: `message${++messageCount}`, conversationId, senderId: sender.id, body: JSON.parse(input).body };
      for (const participant of conversationId.split('_')) {
        if (mode === 'drop' && participant !== sender.id) continue;
        io.to(`user:${participant}`).emit('message:created', message);
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ message }));
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  io = new Server(server);
  io.use((socket, next) => {
    const user = users.find(u => u.token === socket.handshake.auth.token);
    if (!user) return next(new Error('unauthorized'));
    socket.user = user; next();
  });
  io.on('connection', socket => {
    connected++; socket.join(`user:${socket.user.id}`);
    socket.on('disconnect', () => connected--);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { users, calls, target: `http://127.0.0.1:${server.address().port}`,
    connected: () => connected, close: () => new Promise(resolve => io.close(resolve)) };
}
module.exports = { startFixture };
