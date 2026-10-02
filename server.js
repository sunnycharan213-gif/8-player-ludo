const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

const rooms = {};

function createRoomCode() {
    let code;

    do {
        code = Math.random()
            .toString(36)
            .substring(2, 7)
            .toUpperCase();
    } while (rooms[code]);

    return code;
}

function createGameState() {
    const pawns = {};

    for (let player = 1; player <= 8; player++) {
        pawns[player] = [0, 0, 0, 0];
    }

    return {
        currentPlayer: 1,
        dice: null,
        pawns,
        winners: []
    };
}

const SAFE_CELLS = [1, 8, 15, 22, 29, 36, 43, 50];

function isSafeCell(position) {
    return SAFE_CELLS.includes(position);
}

function getPlayerNumber(room, socketId) {
    const index = room.players.indexOf(socketId);
    return index === -1 ? null : index + 1;
}

function sendRoomState(roomCode) {
    const room = rooms[roomCode];

    if (!room) return;

    io.to(roomCode).emit("playersUpdate", {
        count: room.players.length,
        maxPlayers: 8
    });

    io.to(roomCode).emit("gameState", {
        currentPlayer: room.gameState.currentPlayer,
        dice: room.gameState.dice,
        pawns: room.gameState.pawns,
        winners: room.gameState.winners
    });
}

function sendTurn(roomCode) {
    const room = rooms[roomCode];

    if (!room) return;

    io.to(roomCode).emit("turnChanged", {
        currentPlayer: room.gameState.currentPlayer,
        dice: null
    });
}

function nextTurn(roomCode) {
    const room = rooms[roomCode];

    if (!room || room.players.length === 0) return;

    let next = room.gameState.currentPlayer;

    for (let i = 0; i < 8; i++) {
        next++;

        if (next > room.players.length) {
            next = 1;
        }

        if (!room.gameState.winners.includes(next)) {
            break;
        }
    }

    room.gameState.currentPlayer = next;
    room.gameState.dice = null;

    sendTurn(roomCode);
    sendRoomState(roomCode);
}

function hasValidMove(roomCode, playerNumber, dice) {
    const room = rooms[roomCode];

    if (!room) return false;

    const pawns = room.gameState.pawns[playerNumber];

    for (let i = 0; i < 4; i++) {
        const position = pawns[i];

        if (position === 0 && dice === 6) {
            return true;
        }

        if (
            position >= 1 &&
            position < 60 &&
            position + dice <= 60
        ) {
            return true;
        }
    }

    return false;
}

function captureOpponents(roomCode, movingPlayer, movingPosition) {
    const room = rooms[roomCode];

    if (!room) return [];

    const captured = [];

    if (movingPosition >= 57) return captured;

    if (isSafeCell(movingPosition)) return captured;

    for (let player = 1; player <= 8; player++) {
        if (player === movingPlayer) continue;

        const pawns = room.gameState.pawns[player];

        if (!pawns) continue;

        for (let pawn = 0; pawn < 4; pawn++) {
            if (pawns[pawn] === movingPosition) {
                pawns[pawn] = 0;

                captured.push({
                    player,
                    pawnIndex: pawn
                });
            }
        }
    }

    return captured;
}

function checkWinner(roomCode, playerNumber) {
    const room = rooms[roomCode];

    if (!room) return false;

    const pawns = room.gameState.pawns[playerNumber];

    const finished = pawns.every(position => position === 60);

    if (
        finished &&
        !room.gameState.winners.includes(playerNumber)
    ) {
        room.gameState.winners.push(playerNumber);

        io.to(roomCode).emit("playerWon", {
            player: playerNumber,
            winners: room.gameState.winners
        });

        return true;
    }

    return false;
}

function joinRoom(socket, roomCode) {
    const room = rooms[roomCode];

    if (!room) return;

    room.players.push(socket.id);

    socket.join(roomCode);
    socket.roomCode = roomCode;

    const playerNumber = room.players.length;

    socket.emit("playerJoined", {
        playerNumber
    });

    socket.emit("roomJoined", {
        roomCode
    });

    socket.emit("gameState", {
        currentPlayer: room.gameState.currentPlayer,
        dice: room.gameState.dice,
        pawns: room.gameState.pawns,
        winners: room.gameState.winners
    });

    sendRoomState(roomCode);
    sendTurn(roomCode);

    console.log(
        `Player ${playerNumber} joined room ${roomCode}`
    );
}

io.on("connection", socket => {
    console.log("Connected:", socket.id);

    socket.on("createRoom", () => {
        const roomCode = createRoomCode();

        rooms[roomCode] = {
            players: [],
            gameState: createGameState()
        };

        joinRoom(socket, roomCode);

        socket.emit("roomCreated", {
            roomCode
        });

        console.log("Room created:", roomCode);
    });

    socket.on("joinRoom", data => {
        const roomCode = String(data?.roomCode || "")
            .trim()
            .toUpperCase();

        if (!roomCode) {
            socket.emit("roomError", {
                message: "Enter a room code."
            });
            return;
        }

        if (!rooms[roomCode]) {
            socket.emit("roomError", {
                message: "Room not found."
            });
            return;
        }

        if (rooms[roomCode].players.length >= 8) {
            socket.emit("roomError", {
                message: "Room is full."
            });
            return;
        }

        joinRoom(socket, roomCode);
    });

    socket.on("rollDice", () => {
        const roomCode = socket.roomCode;

        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];

        const playerNumber = getPlayerNumber(
            room,
            socket.id
        );

        if (!playerNumber) return;

        if (
            playerNumber !==
            room.gameState.currentPlayer
        ) {
            return;
        }

        if (room.gameState.dice !== null) return;

        if (
            room.gameState.winners.includes(
                playerNumber
            )
        ) {
            return;
        }

        const dice =
            Math.floor(Math.random() * 6) + 1;

        room.gameState.dice = dice;

        io.to(roomCode).emit("diceRolled", {
            player: playerNumber,
            dice
        });

        sendRoomState(roomCode);

        if (
            !hasValidMove(
                roomCode,
                playerNumber,
                dice
            )
        ) {
            io.to(roomCode).emit("moveRejected", {
                message:
                    "No valid move. Next player's turn."
            });

            setTimeout(() => {
                if (rooms[roomCode]) {
                    nextTurn(roomCode);
                }
            }, 1000);
        }
    });

    socket.on("movePawn", data => {
        const roomCode = socket.roomCode;

        if (!roomCode || !rooms[roomCode]) return;

        const room = rooms[roomCode];

        const playerNumber = getPlayerNumber(
            room,
            socket.id
        );

        if (!playerNumber) return;

        if (
            playerNumber !==
            room.gameState.currentPlayer
        ) {
            return;
        }

        if (room.gameState.dice === null) return;

        const pawnIndex = Number(data?.pawnIndex);

        if (
            !Number.isInteger(pawnIndex) ||
            pawnIndex < 0 ||
            pawnIndex > 3
        ) {
            return;
        }

        const dice = room.gameState.dice;

        const currentPosition =
            room.gameState
                .pawns[playerNumber][pawnIndex];

        if (currentPosition === 0) {
            if (dice !== 6) {
                socket.emit("moveRejected", {
                    message:
                        "This pawn needs 6 to enter."
                });
                return;
            }

            room.gameState
                .pawns[playerNumber][pawnIndex] = 1;
        } else {
            const newPosition =
                currentPosition + dice;

            if (newPosition > 60) {
                socket.emit("moveRejected", {
                    message:
                        "Exact number required."
                });
                return;
            }

            room.gameState
                .pawns[playerNumber][pawnIndex] =
                newPosition;
        }

        const newPosition =
            room.gameState
                .pawns[playerNumber][pawnIndex];

        const captured =
            captureOpponents(
                roomCode,
                playerNumber,
                newPosition
            );

        room.gameState.dice = null;

        io.to(roomCode).emit("pawnMoved", {
            player: playerNumber,
            pawnIndex,
            position: newPosition,
            dice,
            captured
        });

        if (captured.length > 0) {
            io.to(roomCode).emit(
                "captureMessage",
                {
                    player: playerNumber,
                    captured
                }
            );
        }

        if (newPosition === 60) {
            io.to(roomCode).emit(
                "pawnFinished",
                {
                    player: playerNumber,
                    pawnIndex
                }
            );
        }

        const won =
            checkWinner(
                roomCode,
                playerNumber
            );

        sendRoomState(roomCode);

        if (won) {
            sendTurn(roomCode);
            return;
        }

        if (dice === 6) {
            room.gameState.currentPlayer =
                playerNumber;

            room.gameState.dice = null;

            sendTurn(roomCode);
            sendRoomState(roomCode);
        } else {
            nextTurn(roomCode);
        }
    });

    socket.on("disconnect", () => {
        const roomCode = socket.roomCode;

        if (
            !roomCode ||
            !rooms[roomCode]
        ) {
            return;
        }

        const room = rooms[roomCode];

        const index =
            room.players.indexOf(socket.id);

        if (index !== -1) {
            room.players.splice(index, 1);
        }

        if (room.players.length === 0) {
            delete rooms[roomCode];

            console.log(
                "Room deleted:",
                roomCode
            );

            return;
        }

        room.gameState.dice = null;

        if (
            room.gameState.currentPlayer >
            room.players.length
        ) {
            room.gameState.currentPlayer = 1;
        }

        sendRoomState(roomCode);
        sendTurn(roomCode);
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "online",
        game: "8 Player Ludo"
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(
        `🎲 Ludo server running on port ${PORT}`
    );

    console.log(
        "🌐 Server ready for online hosting."
    );
});