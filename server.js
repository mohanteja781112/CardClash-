const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors()); 

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// --- MONGODB CLOUD CONNECTION ---
const MONGO_URI = "mongodb+srv://doddimohanteja711_db_user:doddi781112@cluster0.m9ljo9u.mongodb.net/cardclash?appName=Cluster0"; 

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Atlas Connected Successfully!'))
    .catch(err => {
        console.log('------------------------------------------------');
        console.log('⚠️  MONGODB CONNECTION FAILED');
        console.log('❌  Message:', err.message);
        console.log('------------------------------------------------');
    });

// Schema for Game History
const GameResultSchema = new mongoose.Schema({
    roomId: String,
    winner: String,
    playedAt: { type: Date, default: Date.now }
});
const GameResult = mongoose.model('GameResult', GameResultSchema);

// --- NEW LEADERBOARD API ---
app.get('/api/leaderboard', async (req, res) => {
    try {
        // Aggregation Pipeline: Group by winner name -> Count wins -> Sort Descending -> Take Top 10
        const leaderboard = await GameResult.aggregate([
            { $group: { _id: "$winner", wins: { $sum: 1 } } },
            { $sort: { wins: -1 } },
            { $limit: 10 }
        ]);
        res.json(leaderboard);
    } catch (e) {
        console.error(e);
        res.status(500).json([]);
    }
});

// --- GAME STATE MANAGEMENT ---
const rooms = {}; 
const COLORS = ['red', 'blue', 'green', 'yellow'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function createDeck() {
    let deck = [];
    for (let c of COLORS) {
        for (let v of VALUES) {
            deck.push({ color: c, value: v });
        }
    }
    return deck.sort(() => Math.random() - 0.5); 
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Join Room
    socket.on('joinRoom', ({ roomId, playerName }) => {
        socket.join(roomId);
        
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: createDeck(),
                discardPile: [],
                currentTurnIndex: 0,
                gameStarted: false
            };
            rooms[roomId].discardPile.push(rooms[roomId].deck.pop());
        }

        const room = rooms[roomId];
        
        if (!room.gameStarted && room.players.length < 4) {
            const existing = room.players.find(p => p.id === socket.id);
            if (!existing) {
                room.players.push({ id: socket.id, name: playerName, hand: [] });
                // Deal 5 cards
                const player = room.players.find(p => p.id === socket.id);
                for(let i=0; i<5; i++) {
                    if(room.deck.length > 0) player.hand.push(room.deck.pop());
                }
            }
        }
        broadcastState(roomId);
    });

    // 2. Play Card
    socket.on('playCard', ({ roomId, cardIndex }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        
        const playerIndex = room.players.indexOf(player);
        if (playerIndex !== room.currentTurnIndex) return;

        const card = player.hand[cardIndex];
        const topCard = room.discardPile[0];

        if (card.color === topCard.color || card.value === topCard.value) {
            room.discardPile.unshift(card); 
            player.hand.splice(cardIndex, 1);

            if (player.hand.length === 0) {
                io.to(roomId).emit('gameOver', { winner: player.name });
                saveGameResult(roomId, player.name);
                delete rooms[roomId]; 
                return;
            }

            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
            broadcastState(roomId);
        }
    });

    // 3. Draw Card
    socket.on('drawCard', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (room.players.indexOf(player) !== room.currentTurnIndex) return;

        if (room.deck.length > 0) {
            player.hand.push(room.deck.pop());
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
            broadcastState(roomId);
        }
    });

    socket.on('disconnect', () => {
        // Cleanup logic would go here
    });
});

function broadcastState(roomId) {
    const room = rooms[roomId];
    if(!room) return;

    const publicState = {
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.hand.length, 
        })),
        discardPile: [room.discardPile[0]], 
        currentTurn: room.players[room.currentTurnIndex].id
    };
    io.to(roomId).emit('gameState', publicState);

    room.players.forEach(p => {
        io.to(p.id).emit('yourHand', p.hand);
    });
}

async function saveGameResult(roomId, winnerName) {
    try {
        if (mongoose.connection.readyState === 1) {
            await GameResult.create({ roomId, winner: winnerName });
            console.log('🏆 Game Saved to DB');
        }
    } catch(e) { console.log('DB Error', e); }
}

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 CardClash Server running on port ${PORT}`));