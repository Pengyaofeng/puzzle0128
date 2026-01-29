const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static('public'));
app.use('/admin', express.static('admin'));
app.use('/uploads', express.static('uploads'));

// 游戏状态
const gameState = {
  status: 'waiting', // waiting, ready, playing, finished
  image: null,
  imageUrl: null,
  players: new Map(), // playerId -> { id, name, status, time, steps, startTime, finishTime }
  correctRotation: [0, 0, 0, 0, 0, 0, 0, 0, 0], // 每个格子的正确旋转角度 (0度)
  gameStartTime: null
};

// 生成随机玩家名称
function generateRandomName() {
  const adjectives = ['快乐', '勇敢', '聪明', '闪电', '彩虹', '星星', '月亮', '太阳', '幸运', '神秘'];
  const animals = ['熊猫', '老虎', '狮子', '兔子', '猫咪', '小狗', '狐狸', '熊猫', '龙', '凤凰'];
  const number = Math.floor(Math.random() * 1000);
  return adjectives[Math.floor(Math.random() * adjectives.length)] +
         animals[Math.floor(Math.random() * animals.length)] +
         number;
}

// 打乱拼图 - 为每个格子生成随机旋转角度 (0-3, 代表 0度/90度/180度/270度)
function shufflePuzzle() {
  const rotations = [];
  for (let i = 0; i < 9; i++) {
    // 随机旋转 0-3 次 (0度/90度/180度/270度)
    rotations.push(Math.floor(Math.random() * 4));
  }
  // 确保至少有一个格子是旋转过的，避免一开始就是完成状态
  if (rotations.every(r => r === 0)) {
    rotations[Math.floor(Math.random() * 9)] = 1;
  }
  return rotations;
}

function arraysEqual(a, b) {
  return a.every((val, i) => val === b[i]);
}

// 广播消息给所有客户端
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// 向特定玩家发送消息
function sendToPlayer(playerId, data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.playerId === playerId) {
      client.send(JSON.stringify(data));
    }
  });
}

// 广播排行榜
function broadcastLeaderboard() {
  const players = Array.from(gameState.players.values())
    .map(p => ({
      id: p.id,
      name: p.name,
      status: p.status,
      time: p.time,
      steps: p.steps,
      finishTime: p.finishTime
    }))
    .sort((a, b) => {
      // 完成的玩家按时间排序
      if (a.status === 'finished' && b.status === 'finished') {
        return a.time - b.time;
      }
      // 完成的玩家排在前面
      if (a.status === 'finished') return -1;
      if (b.status === 'finished') return 1;
      // 未完成的玩家按步数排序
      return a.steps - b.steps;
    });

  broadcast({
    type: 'leaderboard',
    players
  });
}

// WebSocket 连接处理
wss.on('connection', (ws, req) => {
  const playerId = uuidv4();
  const playerName = generateRandomName();
  const isPlayer = req.url && req.url.includes('player');

  // 存储 playerId 到 ws 对象，用于后续定向发送
  ws.playerId = isPlayer ? playerId : null;

  // 初始化玩家
  if (isPlayer) {
    gameState.players.set(playerId, {
      id: playerId,
      name: playerName,
      status: 'joined',
      time: 0,
      steps: 0,
      startTime: null,
      finishTime: null,
      puzzle: shufflePuzzle()
    });

    ws.send(JSON.stringify({
      type: 'init',
      playerId,
      playerName,
      imageUrl: gameState.imageUrl,
      puzzle: gameState.players.get(playerId).puzzle,
      gameStatus: gameState.status
    }));

    // 通知管理员有新玩家
    broadcastLeaderboard();
  }

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'uploadImage':
        gameState.image = data.imageData;
        gameState.imageUrl = `/uploads/${data.filename}`;
        broadcast({
          type: 'imageUpdate',
          imageUrl: gameState.imageUrl
        });
        break;

      case 'startGame':
        if (gameState.imageUrl) {
          gameState.status = 'playing';
          gameState.gameStartTime = Date.now();

          // 为每个玩家重置状态并生成新的打乱拼图
          gameState.players.forEach(player => {
            player.status = 'playing';
            player.startTime = Date.now();
            player.time = 0;
            player.steps = 0;
            player.finishTime = null;
            player.puzzle = shufflePuzzle();
          });

          broadcast({
            type: 'gameStart',
            startTime: gameState.gameStartTime
          });

          // 向每个玩家发送他们的拼图
          gameState.players.forEach(player => {
            sendToPlayer(player.id, {
              type: 'puzzleUpdate',
              puzzle: player.puzzle
            });
          });

          broadcastLeaderboard();
        }
        break;

      case 'rotate':
        const player = gameState.players.get(data.playerId);
        if (player && player.status === 'playing') {
          const tileIndex = data.tileIndex; // 0-8, 代表九宫格中的位置
          const puzzle = player.puzzle;

          // 顺时针旋转90度 (0->1->2->3->0)
          puzzle[tileIndex] = (puzzle[tileIndex] + 1) % 4;
          player.steps++;

          // 检查是否完成 (所有格子都是0度)
          if (arraysEqual(puzzle, gameState.correctRotation)) {
            player.status = 'finished';
            player.finishTime = Date.now();
            player.time = player.finishTime - player.startTime;

            broadcast({
              type: 'playerFinished',
              playerId: player.id,
              playerName: player.name,
              time: player.time,
              steps: player.steps
            });

            // 检查是否所有玩家都完成了
            const allFinished = Array.from(gameState.players.values())
              .every(p => p.status === 'finished');

            if (allFinished) {
              gameState.status = 'finished';
              broadcast({ type: 'gameEnd' });
            }
          }

          broadcastLeaderboard();
        }
        break;

      case 'resetGame':
        gameState.status = 'waiting';
        gameState.image = null;
        gameState.imageUrl = null;
        gameState.players.clear();
        gameState.gameStartTime = null;

        // 清理上传的图片
        const uploadDir = path.join(__dirname, '../uploads');
        fs.readdirSync(uploadDir).forEach(file => {
          fs.unlinkSync(path.join(uploadDir, file));
        });

        broadcast({
          type: 'gameReset'
        });
        broadcastLeaderboard();
        break;
    }
  });

  ws.on('close', () => {
    if (gameState.players.has(playerId)) {
      gameState.players.delete(playerId);
      broadcastLeaderboard();
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// 上传图片
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const ext = path.extname(req.file.originalname);
  const newPath = path.join(req.file.destination, req.file.filename + ext);
  fs.renameSync(req.file.path, newPath);

  res.json({
    filename: req.file.filename + ext,
    url: `/uploads/${req.file.filename + ext}`
  });
});

// 获取服务器地址（支持云平台和局域网）
function getLocalIP() {
  // 1. 优先使用手动设置的 PUBLIC_URL
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  // 2. Railway 自动提供的域名
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return process.env.RAILWAY_PUBLIC_DOMAIN;
  }

  // 3. Render 提供的域名
  if (process.env.RENDER_SERVICE_URL) {
    return process.env.RENDER_SERVICE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  // 4. 否则获取本机局域网IP
  const interfaces = require('os').networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// 获取协议（云平台通常是 https）
function getProtocol() {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.startsWith('https') ? 'https' : 'http';
  }
  // Railway 和 Render 都是 https
  if (process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_SERVICE_URL) {
    return 'https';
  }
  return 'http';
}

// 生成二维码
app.get('/qrcode', async (req, res) => {
  const protocol = getProtocol();
  const host = getLocalIP();
  const playerUrl = `${protocol}://${host}/player.html`;

  // 调试日志
  console.log('QRCode generation:', { protocol, host, playerUrl });
  console.log('Railway domain:', process.env.RAILWAY_PUBLIC_DOMAIN);

  try {
    const qrCodeDataUrl = await QRCode.toDataURL(playerUrl);
    res.json({ qrCode: qrCodeDataUrl, url: playerUrl });
  } catch (error) {
    console.error('QRCode generation error:', error);
    res.status(500).json({ error: 'Failed to generate QR code', message: error.message });
  }
});

// 获取当前游戏状态
app.get('/game-state', (req, res) => {
  res.json({
    status: gameState.status,
    imageUrl: gameState.imageUrl,
    playerCount: gameState.players.size
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
